// Scraper safety tests: run against a throwaway DB with a stubbed shelter API.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-scraper-')), 'test.db');
process.env.DB_PATH = dbFile;
const db = require('../src/db');
const { runScrape } = require('../src/scraper');

// What the fake shelter currently "serves".
let listing = [];
let adopted = [];
let detailFails = new Set();
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') return json({ data: listing });
  if (u.includes('/api/animals/adopted')) return json({ data: adopted.map((id) => ({ shelterBuddyId: id })) });
  if (u.includes('/api/photos/')) return json({ large: [] });
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) {
    if (detailFails.has(Number(m[1]))) return json({}, 500);
    return json({ primaryBreed: 'Test Breed', weight: '50 lbs', location: 'Kennel', summary: 'Nice dog', tags: ["I'm getting adopted!"], sex: 'Male', age: '3 Years' });
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

test('scrape runs are recorded for the health check', () => {
  const last = db.prepare('SELECT ok FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(last.ok, 1);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM scrape_runs WHERE ok = 0').get().c >= 2);
});
