// Scraper safety tests: run against a throwaway DB with a stubbed shelter API.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-scraper-')), 'test.db');
process.env.DB_PATH = dbFile;
const db = require('../src/db');
const { runScrape, IMAGES_DIR } = require('../src/scraper');

// What the fake shelter currently "serves".
let listing = [];
let adopted = [];
let detailFails = new Set();
const summaryOverrides = {}; // dog id -> summary HTML, in place of the default 'Nice dog'
const tagsOverrides = {}; // dog id -> tags array, in place of the default ["I'm getting adopted!"]
const videoIdOverrides = {}; // dog id -> youTubeVideoId, as the detail API returns it directly (not embedded in summary)
const photoPaths = {}; // dog id -> ["large" photo paths], like the real /api/photos/:id response
const imageBytes = {}; // path (as it appears in the resolved URL) -> fake image body
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  // One listing per species; this fake shelter has no cats unless a test adds some.
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') return json({ data: JSON.parse(opts.body).species === 'Dog' ? listing : [] });
  if (u.includes('/api/animals/adopted')) return json({ data: adopted.map((id) => ({ shelterBuddyId: id })) });
  const photosMatch = /\/api\/photos\/(\d+)$/.exec(u);
  if (photosMatch) return json({ large: photoPaths[Number(photosMatch[1])] || [] });
  const imgKey = Object.keys(imageBytes).find((k) => u.includes(k));
  if (imgKey) return new Response(imageBytes[imgKey], { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) {
    if (detailFails.has(Number(m[1]))) return json({}, 500);
    return json({ primaryBreed: 'Test Breed', weight: '50 lbs', location: 'Kennel', summary: summaryOverrides[Number(m[1])] || 'Nice dog', tags: tagsOverrides[Number(m[1])] || ["I'm getting adopted!"], sex: 'Male', age: '3 Years', youTubeVideoId: videoIdOverrides[Number(m[1])] || null });
  }
  return realFetch(url, opts);
};

const dogs = (n) => Array.from({ length: n }, (_, i) => ({ shelterBuddyId: 1000 + i, name: `Dog${i}`, sex: 'Male', age: '3 Years', dateInShelter: '2026-08-01T00:00:00' }));
const listed = () => db.prepare('SELECT COUNT(*) c FROM dogs WHERE still_listed = 1').get().c;
const events = (kind) => db.prepare('SELECT COUNT(*) c FROM shelter_events WHERE kind = ?').get(kind).c;

test('first scrape lists dogs and logs new_dog events', async () => {
  listing = dogs(30);
  const r = await runScrape();
  assert.equal(r.ok, true);
  assert.equal(listed(), 30);
  assert.equal(events('new_dog'), 30);
});

test('a truncated listing is ignored, nobody is delisted', async () => {
  listing = dogs(5);
  const r = await runScrape();
  assert.equal(r.ok, false);
  assert.equal(listed(), 30);
});

test('an empty listing is ignored', async () => {
  listing = [];
  const r = await runScrape();
  assert.equal(r.ok, false);
  assert.equal(listed(), 30);
});

test('a dog missing once stays listed; missing twice is delisted (no event, no false return)', async () => {
  listing = dogs(29); // Dog29 disappears
  await runScrape();
  assert.equal(listed(), 30, 'still listed after one miss');
  await runScrape();
  assert.equal(listed(), 29, 'delisted after two misses');
  assert.equal(events('adopted'), 0, 'plain removal is not an adoption');
  listing = dogs(30); // comes back
  await runScrape();
  assert.equal(listed(), 30);
  assert.equal(events('returned'), 1);
  const row = db.prepare("SELECT title, detail FROM shelter_events WHERE kind = 'returned' AND dog_id = 1029").get();
  assert.equal(row.detail, 'floor_return', 'a plain delisting (never confirmed adopted) reads as back on the floor, not a return-after-adoption');
  assert.match(row.title, /back on the adoption floor/);
});

test('a dog on the shelter adopted list is delisted immediately with an adopted event', async () => {
  listing = dogs(28);
  adopted = [1028];
  await runScrape();
  assert.equal(events('adopted'), 1);
  assert.equal(db.prepare('SELECT still_listed s FROM dogs WHERE shelter_buddy_id = 1028').get().s, 0);
  adopted = [];
});

test('a failed detail fetch keeps the previous good data instead of blanking it', async () => {
  listing = dogs(28);
  await runScrape(); // good detail stored
  detailFails = new Set([1000]);
  await runScrape();
  const row = db.prepare('SELECT breed, summary, tags FROM dogs WHERE shelter_buddy_id = 1000').get();
  assert.equal(row.breed, 'Test Breed');
  assert.equal(row.summary, 'Nice dog');
  assert.ok(row.tags.includes("I'm getting adopted!"));
  detailFails = new Set();
});

test("a PB dog's sticker clears itself (and logs why) once the stray-hold tag drops off the listing", async () => {
  const id = 1000;
  listing = dogs(28);
  tagsOverrides[id] = ['Dog', 'Shelter', 'On Stray Hold'];
  await runScrape();
  db.prepare('UPDATE dogs SET pb_flag = 1 WHERE shelter_buddy_id = ?').run(id);

  // Still on stray hold next scrape: PB is untouched, nothing logged.
  const before = events('sticker_auto_off');
  await runScrape();
  assert.equal(db.prepare('SELECT pb_flag p FROM dogs WHERE shelter_buddy_id = ?').get(id).p, 1);
  assert.equal(events('sticker_auto_off'), before);

  // The hold is lifted: PB clears itself, with an event recording why.
  tagsOverrides[id] = ['Dog', 'Shelter'];
  await runScrape();
  assert.equal(db.prepare('SELECT pb_flag p FROM dogs WHERE shelter_buddy_id = ?').get(id).p, 0, 'PB is no longer needed once the hold is lifted');
  assert.equal(events('sticker_auto_off'), before + 1);
  const ev = db.prepare("SELECT dog_id, detail FROM shelter_events WHERE kind = 'sticker_auto_off' ORDER BY id DESC LIMIT 1").get();
  assert.equal(ev.dog_id, id);
  assert.equal(ev.detail, 'pb');

  delete tagsOverrides[id];
});

test('a dog without the PB sticker leaving stray hold is quiet -- nothing to auto-clear', async () => {
  const id = 1001;
  listing = dogs(28);
  const before = events('sticker_auto_off');
  tagsOverrides[id] = ['Dog', 'Shelter', 'On Stray Hold'];
  await runScrape();
  tagsOverrides[id] = ['Dog', 'Shelter'];
  await runScrape();
  assert.equal(events('sticker_auto_off'), before);
  delete tagsOverrides[id];
});

test('a dog returning after 6+ months is treated as a fresh start: no bonus days, markers reset', async () => {
  // A dog nobody's seen in the current listing, with behavior markers set
  // from before it left, delisted long enough ago that its old stay and
  // notes are stale.
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, removed_at, first_seen_at, last_seen_at, blue_markers, poo_status, star_flag, pb_flag)
    VALUES (1050, 'Patches', 'Male', '3 Years', '2025-01-01T00:00:00.000Z', 0, '2025-03-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z', '["blue_r"]', 'poo', 1, 1)
  `).run();
  listing = [...dogs(28), { shelterBuddyId: 1050, name: 'Patches', sex: 'Male', age: '3 Years', dateInShelter: new Date().toISOString() }];
  const r = await runScrape();
  assert.equal(r.ok, true);
  assert.equal(events('returned') >= 1, true);
  const row = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = 1050').get();
  assert.equal(row.still_listed, 1);
  assert.equal(row.previous_days_in_shelter, 0, 'the old (stale) stay does not shorten their new wait');
  assert.equal(row.blue_markers, '[]', 'behavior markers reset -- last set months ago, no longer trustworthy');
  assert.equal(row.poo_status, 'none');
  assert.equal(row.star_flag, 0);
  assert.equal(row.pb_flag, 0);
});

test('a dog returning within 6 months keeps its markers and gets credit for its prior stay', async () => {
  const recentlyLeft = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
  const arrivedBefore = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // a 30-day stay
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, removed_at, first_seen_at, last_seen_at, blue_markers, star_flag)
    VALUES (1051, 'Biscuit', 'Female', '2 Years', ?, 0, ?, ?, ?, '["blue_p"]', 1)
  `).run(arrivedBefore, recentlyLeft, arrivedBefore, recentlyLeft);
  listing = [...dogs(28), { shelterBuddyId: 1051, name: 'Biscuit', sex: 'Female', age: '2 Years', dateInShelter: new Date().toISOString() }];
  const r = await runScrape();
  assert.equal(r.ok, true);
  const row = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = 1051').get();
  assert.ok(row.previous_days_in_shelter >= 29, 'their recent ~30-day stay is credited');
  assert.equal(row.blue_markers, '["blue_p"]', 'markers from a recent stay are still trusted');
  assert.equal(row.star_flag, 1);
});

test('a dog that was actually adopted, then reappears, is labeled differently than one just back on the floor', async () => {
  const arrivedBefore = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const adoptedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, removed_at, first_seen_at, last_seen_at)
    VALUES (1052, 'Rocky', 'Male', '4 Years', ?, 0, ?, ?, ?)
  `).run(arrivedBefore, adoptedAt, arrivedBefore, adoptedAt);
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('adopted', 1052, 'Rocky was adopted!', ?)").run(adoptedAt);
  listing = [...dogs(28), { shelterBuddyId: 1052, name: 'Rocky', sex: 'Male', age: '4 Years', dateInShelter: new Date().toISOString() }];
  const r = await runScrape();
  assert.equal(r.ok, true);
  const row = db.prepare("SELECT title, detail FROM shelter_events WHERE kind = 'returned' AND dog_id = 1052").get();
  assert.equal(row.detail, 'adopted_return', 'a confirmed adoption during the stay that just ended makes this a return-after-adoption');
  assert.match(row.title, /returned to the shelter after being adopted/);
});

test('a kennel card walked before the listing had the dog: the listing fills it in, walk kept, counted as new', async () => {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, still_listed, awaiting_listing, first_seen_at, last_seen_at, kennel_location, blue_markers)
    VALUES (262999, 'Dog #262999', 0, 1, ?, ?, 'B', '["blue","blue_j"]')`).run(now, now);
  db.prepare("INSERT INTO walks (dog_id, location, started_at, ended_at, duration_seconds) VALUES (262999, 'B', ?, ?, 600)").run(now, now);
  listing = [...dogs(28), { shelterBuddyId: 1052, name: 'Rocky', sex: 'Male', age: '4 Years', dateInShelter: now },
    { shelterBuddyId: 262999, name: 'Biscuit', sex: 'Male', age: '2 Years', dateInShelter: now }];
  const r = await runScrape();
  assert.equal(r.ok, true);
  const dog = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = 262999').get();
  assert.equal(dog.name, 'Biscuit');
  assert.equal(dog.still_listed, 1);
  assert.equal(dog.awaiting_listing, 0);
  assert.equal(dog.previous_days_in_shelter, 0, 'not treated as a returning dog');
  assert.equal(dog.kennel_location, 'B', 'the kennel letter the walker set is kept');
  assert.equal(dog.blue_markers, '["blue","blue_j"]', 'stickers the walker set are kept');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE dog_id = 262999').get().c, 1, "today's walk is on the real dog");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM shelter_events WHERE dog_id = 262999 AND kind = 'new_dog'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM shelter_events WHERE dog_id = 262999 AND kind = 'returned'").get().c, 0);
});

test('scrape runs are recorded for the health check', () => {
  const last = db.prepare('SELECT ok FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(last.ok, 1);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM scrape_runs WHERE ok = 0').get().c >= 2);
});

test('a new listing without a name yet is skipped, not a crash, and added once it has one', async () => {
  const before = listed();
  const newDogs = events('new_dog');
  listing = [...listing, { shelterBuddyId: 5000, name: null, sex: 'Male', age: '1 Years', dateInShelter: '2026-10-01T00:00:00' }];
  const r = await runScrape();
  assert.equal(r.ok, true, 'the rest of the dogs still refresh');
  assert.equal(listed(), before);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM dogs WHERE shelter_buddy_id = 5000').get().c, 0);
  const run = db.prepare('SELECT note FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
  assert.match(run.note, /without a name yet/);

  listing = listing.map((d) => (d.shelterBuddyId === 5000 ? { ...d, name: 'Newbie' } : d));
  assert.equal((await runScrape()).ok, true);
  assert.equal(listed(), before + 1);
  assert.equal(events('new_dog'), newDogs + 1);
  assert.equal(db.prepare('SELECT name FROM dogs WHERE shelter_buddy_id = 5000').get().name, 'Newbie');
});

test("a dog's cached photo is replaced once the shelter's photo URL changes (a new photo was uploaded)", async () => {
  const id = 1000;
  const file = path.join(IMAGES_DIR, `${id}.jpg`);
  fs.rmSync(file, { force: true });
  listing = dogs(28);
  // cacheImageIfNeeded refuses anything under 500 bytes (an HTML error page
  // mistaken for a real photo), so these fakes need to clear that bar.
  const fakeJpeg = (tag) => Buffer.from(`${tag}:${'x'.repeat(500)}`);

  photoPaths[id] = ['../app_data/AnimalImages/1000/Large/1000_1.jpg'];
  imageBytes['AnimalImages/1000/Large/1000_1.jpg'] = fakeJpeg('intake-photo');
  await runScrape();
  assert.ok(fs.readFileSync(file).toString().startsWith('intake-photo'), 'first photo gets cached');
  assert.equal(db.prepare('SELECT photo_url u FROM dogs WHERE shelter_buddy_id = 1000').get().u, 'https://pets.wake.gov/app_data/AnimalImages/1000/Large/1000_1.jpg');

  // The shelter uploads a nicer photo; it gets its own URL.
  photoPaths[id] = ['../app_data/AnimalImages/1000/Large/1000_2.jpg'];
  imageBytes['AnimalImages/1000/Large/1000_2.jpg'] = fakeJpeg('better-photo');
  await runScrape();
  assert.ok(fs.readFileSync(file).toString().startsWith('better-photo'), 'the stale cached photo is overwritten once the URL changes');

  delete photoPaths[id];
  delete imageBytes['AnimalImages/1000/Large/1000_1.jpg'];
  delete imageBytes['AnimalImages/1000/Large/1000_2.jpg'];
});

test("a dog with several photos on the shelter's page gets the first one as photo_url", async () => {
  const id = 1000;
  const file = path.join(IMAGES_DIR, `${id}.jpg`);
  fs.rmSync(file, { force: true });
  listing = dogs(28);
  const fakeJpeg = (tag) => Buffer.from(`${tag}:${'x'.repeat(500)}`);

  // The shelter lists three photos for this dog; /api/photos/:id's array
  // order is the only signal of which one is "first".
  photoPaths[id] = [
    '../app_data/AnimalImages/1000/Large/1000_1.jpg',
    '../app_data/AnimalImages/1000/Large/1000_2.jpg',
    '../app_data/AnimalImages/1000/Large/1000_3.jpg'
  ];
  imageBytes['AnimalImages/1000/Large/1000_1.jpg'] = fakeJpeg('photo-one');
  imageBytes['AnimalImages/1000/Large/1000_2.jpg'] = fakeJpeg('photo-two');
  imageBytes['AnimalImages/1000/Large/1000_3.jpg'] = fakeJpeg('photo-three');
  await runScrape();
  assert.equal(db.prepare('SELECT photo_url u FROM dogs WHERE shelter_buddy_id = 1000').get().u, 'https://pets.wake.gov/app_data/AnimalImages/1000/Large/1000_1.jpg', 'photo_url is the first photo in the list, not the last or some other one');
  assert.ok(fs.readFileSync(file).toString().startsWith('photo-one'), 'the cached file is the first photo too');

  delete photoPaths[id];
  delete imageBytes['AnimalImages/1000/Large/1000_1.jpg'];
  delete imageBytes['AnimalImages/1000/Large/1000_2.jpg'];
  delete imageBytes['AnimalImages/1000/Large/1000_3.jpg'];
});

test("a YouTube video embedded in a dog's summary becomes a direct link, and survives a failed detail fetch", async () => {
  listing = dogs(28);
  summaryOverrides[1000] = '<p>Meet me!</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0" frameborder="0"></iframe>';
  summaryOverrides[1001] = '<p>No video here, just a bio.</p>';
  await runScrape();
  assert.equal(db.prepare('SELECT video_url u FROM dogs WHERE shelter_buddy_id = 1000').get().u, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'the embed URL is normalized to a canonical watch link');
  assert.equal(db.prepare('SELECT video_url u FROM dogs WHERE shelter_buddy_id = 1001').get().u, null, 'no video in the summary -> no video_url');

  // A detail fetch failure next run must not blank out a video_url we
  // already have, same as it already protects breed/summary/tags.
  detailFails.add(1000);
  await runScrape();
  assert.equal(db.prepare('SELECT video_url u FROM dogs WHERE shelter_buddy_id = 1000').get().u, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'kept across a failed detail fetch');
  detailFails.delete(1000);

  delete summaryOverrides[1000];
  delete summaryOverrides[1001];
});

test("a YouTube video on the dog's dedicated youTubeVideoId field becomes a direct link, even with no video in the summary", async () => {
  listing = dogs(28);
  videoIdOverrides[1000] = 'dQw4w9WgXcQ';
  summaryOverrides[1000] = '<p>Just a bio, the video lives in its own field now.</p>';
  await runScrape();
  assert.equal(db.prepare('SELECT video_url u FROM dogs WHERE shelter_buddy_id = 1000').get().u, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youTubeVideoId is turned into a canonical watch link');

  delete videoIdOverrides[1000];
  delete summaryOverrides[1000];
});
