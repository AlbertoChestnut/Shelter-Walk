// Scraper fixes from the 2026-11-10 audit: field renames, floor returns,
// late adoptions, push dedupe and quiet hours, quick re-scrapes, photo
// sidecars and paging. Throwaway DB and image folder, stubbed shelter API.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { isolateEnv } = require('./_helpers');

const tmp = isolateEnv('sw-audit-data-');
const db = require('../src/db');
const push = require('../src/push');
const sent = [];
push.sendPushToUser = async (userId, payload, options) => { sent.push({ userId, options, ...payload }); };
const { runScrape, IMAGES_DIR, testHooks } = require('../src/scraper');

const NOON_ET = new Date('2026-11-10T17:00:00Z');
const TEN_PM_ET = new Date('2026-11-11T03:00:00Z');
testHooks.now = () => NOON_ET;

const PENDING = "I'm getting adopted!";
// Cached photos must start like a real JPEG (scraper.js isJpeg).
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const lists = { Dog: [], Cat: [] };
let adopted = [];
let adoptedFails = false;
let renameIdField = false;
const pendingIds = new Set();
const photoPaths = {};
const imageBytes = {};
const imageLastModified = {};
const conditionalRequests = []; // [url, If-Modified-Since] for image GETs
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') {
    const { species, pageNumber, pageSize } = JSON.parse(opts.body);
    let all = lists[species] || [];
    // The shelter renaming its id field: every row loses shelterBuddyId.
    if (renameIdField) all = all.map(({ shelterBuddyId, ...rest }) => ({ animalId: shelterBuddyId, ...rest }));
    return json({ data: all.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), paging: { totalRecordCount: all.length } });
  }
  if (u.includes('/api/animals/adopted')) return adoptedFails ? json({}, 503) : json({ data: adopted.map((id) => ({ shelterBuddyId: id })) });
  const photosMatch = /\/api\/photos\/(\d+)$/.exec(u);
  if (photosMatch) return json({ large: photoPaths[Number(photosMatch[1])] || [] });
  const imgKey = Object.keys(imageBytes).find((k) => u.endsWith(k));
  if (imgKey) {
    const ims = (opts.headers || {})['If-Modified-Since'];
    conditionalRequests.push([imgKey, ims || null]);
    const lastModified = imageLastModified[imgKey];
    if (ims && ims === lastModified) return new Response(null, { status: 304 });
    return new Response(imageBytes[imgKey], { status: 200, headers: { 'content-type': 'image/jpeg', 'last-modified': lastModified } });
  }
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) return json({ primaryBreed: 'Mix', location: 'Kennel', tags: pendingIds.has(Number(m[1])) ? [PENDING] : [] });
  return realFetch(url, opts);
};

const dogs = (n, from = 3000) => Array.from({ length: n }, (_, i) => ({ shelterBuddyId: from + i, name: `Rex${i}`, dateInShelter: '2026-08-01T00:00:00' }));
const listed = () => db.prepare("SELECT COUNT(*) c FROM dogs WHERE still_listed = 1 AND species = 'dog'").get().c;
const isListed = (id) => db.prepare('SELECT still_listed s FROM dogs WHERE shelter_buddy_id = ?').get(id).s === 1;
const eventsFor = (kind, id) => db.prepare('SELECT COUNT(*) c FROM shelter_events WHERE kind = ? AND dog_id = ?').get(kind, id).c;
const lastRun = () => db.prepare('SELECT ok, dog_count, note FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
// Stands in for the time between two scheduled scrapes (a second miss only
// delists after ~50 minutes unseen).
const timePasses = () => db.prepare('UPDATE dogs SET last_seen_at = ? WHERE still_listed = 1').run(new Date(Date.now() - 2 * 3600000).toISOString());
const yesterday = () => new Date(Date.now() - 24 * 3600000).toISOString();
const now = new Date().toISOString();
const addUser = (name) => db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run(name, now).lastInsertRowid;
const pref = (userId, key) => db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, ?, 1)').run(userId, key);
const heart = (userId, dogId) => db.prepare('INSERT OR IGNORE INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, ?, ?)').run(userId, dogId, now);

let fan;
let walker;
test.before(async () => {
  lists.Dog = dogs(30);
  assert.equal((await runScrape()).ok, true);
  fan = addUser('Fan');
  walker = addUser('Walker');
  for (const k of ['favorite_adopted', 'favorite_pending', 'favorite_returned']) pref(fan, k);
  pref(walker, 'adopted_walked_dog');
});

test('images go to IMAGES_DIR, not the real app/data/images', () => {
  assert.equal(IMAGES_DIR, tmp.imagesDir);
});

test('a renamed id field fails the run and delists nobody, however many runs', async () => {
  renameIdField = true;
  for (let i = 0; i < 3; i += 1) {
    const r = await runScrape();
    assert.equal(r.ok, false);
    timePasses();
  }
  renameIdField = false;
  assert.equal(listed(), 30, 'nobody delisted');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM shelter_events WHERE kind = 'removed'").get().c, 0);
  const run = lastRun();
  assert.equal(run.ok, 0, 'recorded as a failed run');
  assert.match(run.note, /none usable/);
});

test('the big-drop check counts usable rows, not raw rows', async () => {
  // 30 rows come back, but 25 of them have no id: really a drop to 5.
  lists.Dog = dogs(30).map((d, i) => (i < 25 ? { ...d, shelterBuddyId: null } : d));
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await runScrape()).ok, false);
    timePasses();
  }
  assert.match(lastRun().note, /dropped from 30 to 5 usable/);
  assert.equal(listed(), 30);
  lists.Dog = dogs(30);
  assert.equal((await runScrape()).ok, true);
});

test('two quick scrapes are not enough to delist a dog', async () => {
  lists.Dog = dogs(29); // Rex29 (3029) goes missing
  await runScrape();
  await runScrape();
  assert.equal(isListed(3029), true, 'still listed: it was seen only minutes ago');
  timePasses();
  await runScrape();
  assert.equal(isListed(3029), false, 'delisted once it has been gone a while');
  lists.Dog = dogs(30);
  db.prepare('UPDATE dogs SET removed_at = ? WHERE shelter_buddy_id = 3029').run(yesterday());
  await runScrape();
});

test("a floor return with the same dateInShelter isn't counted twice and doesn't push", async () => {
  const id = 3010;
  heart(fan, id);
  lists.Dog = dogs(30).filter((d) => d.shelterBuddyId !== id);
  await runScrape();
  timePasses();
  await runScrape();
  assert.equal(isListed(id), false);
  db.prepare('UPDATE dogs SET removed_at = ? WHERE shelter_buddy_id = ?').run(yesterday(), id);

  sent.length = 0;
  lists.Dog = dogs(30); // back, same original dateInShelter
  await runScrape();
  const row = db.prepare('SELECT previous_days_in_shelter p FROM dogs WHERE shelter_buddy_id = ?').get(id);
  assert.equal(row.p, 0, 'the continuing stay is not banked on top of itself');
  assert.equal(eventsFor('returned', id), 1, 'still on the timeline');
  assert.equal(sent.filter((p) => /is back/.test(p.title)).length, 0, 'no "back at the shelter" push');

  // A real new stay: the shelter gives a dateInShelter after they left.
  lists.Dog = dogs(30).filter((d) => d.shelterBuddyId !== id);
  await runScrape();
  timePasses();
  await runScrape();
  db.prepare('UPDATE dogs SET removed_at = ? WHERE shelter_buddy_id = ?').run(yesterday(), id);
  lists.Dog = dogs(30).map((d) => (d.shelterBuddyId === id ? { ...d, dateInShelter: new Date().toISOString() } : d));
  await runScrape();
  assert.ok(db.prepare('SELECT previous_days_in_shelter p FROM dogs WHERE shelter_buddy_id = ?').get(id).p >= 90, 'the earlier stay is banked');
  const pushes = sent.filter((p) => /Rex10 is back/.test(p.title));
  assert.deepEqual(pushes.map((p) => p.userId), [fan]);
  assert.deepEqual(pushes[0].options, { TTL: 86400, urgency: 'normal' }, 'scraper pushes keep for a day');
});

test('a new stay is banked even when its dateInShelter is not after the removal time', async () => {
  const banked = (id) => db.prepare('SELECT previous_days_in_shelter p FROM dogs WHERE shelter_buddy_id = ?').get(id).p;
  const takeOff = async (id) => {
    lists.Dog = dogs(30).filter((d) => d.shelterBuddyId !== id);
    await runScrape();
    timePasses();
    await runScrape();
    assert.equal(isListed(id), false);
  };

  // Adopted and brought back the same day: the new dateInShelter is that
  // day's midnight, which is *before* the removal.
  const a = 3011;
  const before = banked(a);
  await takeOff(a);
  const removedAt = new Date().toISOString();
  db.prepare('UPDATE dogs SET removed_at = ? WHERE shelter_buddy_id = ?').run(removedAt, a);
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('adopted', ?, 'adopted', ?)").run(a, removedAt);
  const midnight = `${removedAt.slice(0, 10)}T00:00:00`;
  lists.Dog = dogs(30).map((d) => (d.shelterBuddyId === a ? { ...d, dateInShelter: midnight } : d));
  await runScrape();
  assert.ok(banked(a) - before >= 90, 'the stay before the adoption is kept');

  // Removed in the evening (already the next day in UTC), back with a new
  // dateInShelter of that next day: still a new stay.
  const b = 3012;
  const beforeB = banked(b);
  await takeOff(b);
  const evening = new Date(Date.now() - 86400000);
  db.prepare('UPDATE dogs SET removed_at = ? WHERE shelter_buddy_id = ?').run(evening.toISOString(), b);
  const nextDay = `${evening.toISOString().slice(0, 10)}T00:00:00`;
  lists.Dog = dogs(30).map((d) => (d.shelterBuddyId === b ? { ...d, dateInShelter: nextDay } : d));
  await runScrape();
  assert.ok(banked(b) - beforeB >= 90, 'a changed dateInShelter banks the old stay');
  lists.Dog = dogs(30);
});

test('a plain removal becomes an adoption once the shelter lists the dog as adopted, pushed once', async () => {
  const id = 3020;
  heart(fan, id);
  db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, 600)').run(id, walker, now, now);
  lists.Dog = dogs(30).filter((d) => d.shelterBuddyId !== id);
  await runScrape();
  timePasses();
  await runScrape();
  assert.equal(eventsFor('removed', id), 1);
  const twoDaysAgo = new Date(Date.now() - 20 * 3600000).toISOString(); // still news: pushed
  db.prepare("UPDATE shelter_events SET occurred_at = ? WHERE kind = 'removed' AND dog_id = ?").run(twoDaysAgo, id);

  sent.length = 0;
  adopted = [id];
  assert.equal((await runScrape()).ok, true);
  assert.equal(eventsFor('removed', id), 0);
  assert.equal(eventsFor('adopted', id), 1);
  const ev = db.prepare("SELECT title, occurred_at FROM shelter_events WHERE kind = 'adopted' AND dog_id = ?").get(id);
  assert.equal(ev.title, 'Rex20 was adopted!');
  assert.equal(ev.occurred_at, twoDaysAgo, 'dated when they left');
  assert.deepEqual(sent.map((p) => p.userId).sort(), [fan, walker].sort());

  sent.length = 0;
  await runScrape();
  assert.equal(sent.length, 0, 'not pushed again');
  assert.equal(eventsFor('adopted', id), 1);

  // Found out three days later: fixed on the timeline, but no late push.
  const late = 3022;
  heart(fan, late);
  lists.Dog = dogs(30).filter((d) => d.shelterBuddyId !== late && d.shelterBuddyId !== id);
  await runScrape();
  timePasses();
  await runScrape();
  db.prepare("UPDATE shelter_events SET occurred_at = ? WHERE kind = 'removed' AND dog_id = ?").run(new Date(Date.now() - 3 * 86400000).toISOString(), late);
  sent.length = 0;
  adopted = [id, late];
  await runScrape();
  assert.equal(eventsFor('adopted', late), 1);
  assert.equal(sent.length, 0, 'too late to announce');
  adopted = [];
  lists.Dog = dogs(30);
});

test('removals older than a week are left alone', async () => {
  const id = 3021;
  lists.Dog = dogs(30).filter((d) => ![3020, id].includes(d.shelterBuddyId));
  await runScrape();
  timePasses();
  await runScrape();
  db.prepare("UPDATE shelter_events SET occurred_at = ? WHERE kind = 'removed' AND dog_id = ?").run(new Date(Date.now() - 9 * 86400000).toISOString(), id);
  adopted = [id];
  await runScrape();
  assert.equal(eventsFor('removed', id), 1);
  assert.equal(eventsFor('adopted', id), 0);
  adopted = [];
});

test('a failed adopted-list fetch makes the run a failure', async () => {
  adoptedFails = true;
  const r = await runScrape();
  adoptedFails = false;
  assert.equal(r.ok, false);
  assert.match(lastRun().note, /adopted list fetch failed/);
});

test('a pending tag that flips back and forth pushes at most once a day', async () => {
  const id = 3001;
  heart(fan, id);
  sent.length = 0;
  pendingIds.add(id);
  await runScrape();
  pendingIds.delete(id);
  await runScrape();
  pendingIds.add(id);
  await runScrape();
  assert.equal(eventsFor('pending_adoption', id), 2, 'both logged');
  assert.equal(sent.filter((p) => /Someone is adopting/.test(p.title)).length, 1, 'pushed once');
  pendingIds.delete(id);
});

test('scraper news is not pushed overnight, but is still logged', async () => {
  const id = 3002;
  heart(fan, id);
  testHooks.now = () => TEN_PM_ET;
  sent.length = 0;
  pendingIds.add(id);
  await runScrape();
  testHooks.now = () => NOON_ET;
  assert.equal(eventsFor('pending_adoption', id), 1);
  assert.equal(sent.length, 0);
  pendingIds.delete(id);
});

test('a changed photo URL is fetched fresh, never with the old URL\'s Last-Modified', async () => {
  const id = 3003;
  const file = path.join(IMAGES_DIR, `${id}.jpg`);
  const oldKey = 'AnimalImages/3003/Large/3003_1.jpg';
  const newKey = 'AnimalImages/3003/Large/3003_2.jpg';
  const sameDate = 'Mon, 01 Jun 2026 12:00:00 GMT';
  photoPaths[id] = [`../app_data/${oldKey}`];
  imageBytes[oldKey] = Buffer.concat([JPEG_MAGIC, Buffer.from(`old:${'x'.repeat(600)}`)]);
  imageLastModified[oldKey] = sameDate;
  await runScrape();
  assert.ok(fs.readFileSync(file).subarray(JPEG_MAGIC.length).toString().startsWith('old:'));
  assert.match(fs.readFileSync(`${file}.lastmod`, 'utf8'), /3003_1\.jpg\nMon, 01 Jun/);

  // The new photo happens to carry the same Last-Modified: sending it would get a 304.
  photoPaths[id] = [`../app_data/${newKey}`];
  imageBytes[newKey] = Buffer.concat([JPEG_MAGIC, Buffer.from(`new:${'x'.repeat(600)}`)]);
  imageLastModified[newKey] = sameDate;
  conditionalRequests.length = 0;
  await runScrape();
  assert.deepEqual(conditionalRequests.find(([k]) => k === newKey), [newKey, null], 'no If-Modified-Since for a new URL');
  assert.ok(fs.readFileSync(file).subarray(JPEG_MAGIC.length).toString().startsWith('new:'), 'the new photo replaced the old one');

  // Same URL again: now the conditional GET is used.
  conditionalRequests.length = 0;
  await runScrape();
  assert.deepEqual(conditionalRequests.find(([k]) => k === newKey), [newKey, sameDate]);
  delete photoPaths[id];
});

test('a listing longer than one page is followed to the end', async () => {
  // Cats, so the dogs above are untouched: 520 across two pages of 500.
  lists.Cat = Array.from({ length: 520 }, (_, i) => ({ shelterBuddyId: 90000 + i, name: `Cat${i}`, dateInShelter: '2026-08-01T00:00:00' }));
  const r = await runScrape();
  assert.equal(r.counts.cat, 520);
});
