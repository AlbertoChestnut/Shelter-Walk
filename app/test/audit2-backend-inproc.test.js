// Audit 2 (2026-11-10), backend, in-process: the scraper's per-animal detail
// check, list paging, quiet-hour push queue, adopted-again guard and JPEG-only
// photo cache; and the Guide's one-time puppies/stray-hold line swap.
// Throwaway DB and image folder, stubbed shelter API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolateEnv } = require('./_helpers');

isolateEnv('sw-a2-inproc-');
const express = require('express');
const db = require('../src/db');
const push = require('../src/push');
const sent = [];
push.sendPushToUser = async (userId, payload) => { sent.push({ userId, ...payload }); };
const { runScrape, IMAGES_DIR, testHooks } = require('../src/scraper');

const NOON_ET = new Date('2026-11-10T17:00:00Z');
const TEN_PM_ET = new Date('2026-11-11T03:00:00Z');
const SIX_AM_ET = new Date('2026-11-11T11:00:00Z');
const SEVEN_AM_ET = new Date('2026-11-11T12:05:00Z');
testHooks.now = () => NOON_ET;

const PENDING = "I'm getting adopted!";
const STRAY = 'On Stray Hold';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]);
let listing = [];
let ignorePaging = false;
let listRequests = 0;
let adopted = [];
let detailFor = () => null; // id -> detail override (null = the normal one)
const tags = {}; // id -> tags
const images = {}; // url suffix -> Buffer
const photos = {}; // id -> [path]
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') {
    const { species, pageNumber, pageSize } = JSON.parse(opts.body);
    listRequests += 1;
    const all = species === 'Dog' ? listing : [];
    const page = ignorePaging ? 1 : pageNumber;
    return json({ data: all.slice((page - 1) * pageSize, page * pageSize), paging: { totalRecordCount: ignorePaging ? all.length * 2 : all.length } });
  }
  if (u.includes('/api/animals/adopted')) return json({ data: adopted.map((id) => ({ shelterBuddyId: id })) });
  const p = /\/api\/photos\/(\d+)$/.exec(u);
  if (p) return json({ large: photos[Number(p[1])] || [] });
  const img = Object.keys(images).find((k) => u.endsWith(k));
  if (img) return new Response(images[img], { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) {
    const id = Number(m[1]);
    const override = detailFor(id);
    if (override) return json(override);
    return json({ primaryBreed: 'Mix', location: id === 5009 ? 'Foster' : 'Kennel', tags: tags[id] || [], sex: 'Male', age: '3 Years' });
  }
  return realFetch(url, opts);
};

const dogs = (n, from = 5000) => Array.from({ length: n }, (_, i) => ({ shelterBuddyId: from + i, name: `Pup${i}`, dateInShelter: '2026-08-01T00:00:00' }));
const row = (id) => db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(id);
const events = (kind, id) => db.prepare('SELECT COUNT(*) c FROM shelter_events WHERE kind = ? AND dog_id = ?').get(kind, id).c;
const lastRun = () => db.prepare('SELECT ok, dog_count, note FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
const now = new Date().toISOString();
const addUser = (name) => db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run(name, now).lastInsertRowid;
let fan;

test.before(async () => {
  listing = dogs(10);
  tags[5001] = [PENDING];
  tags[5002] = [STRAY];
  assert.equal((await runScrape()).ok, true);
  db.prepare('UPDATE dogs SET pb_flag = 1 WHERE shelter_buddy_id = 5002').run();
  fan = addUser('Fan');
  for (const k of ['favorite_pending', 'favorite_returned', 'favorite_adopted']) {
    db.prepare('INSERT INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, ?, 1)').run(fan, k);
  }
  for (const id of [5001, 5002, 5003, 5004]) db.prepare('INSERT INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, ?, ?)').run(fan, id, now);
});

test('a per-animal record with renamed tags is a detail failure: safety data kept, nothing fired, run fails', async () => {
  // tags renamed: the hold "lifts" and the pending adoption "falls through" if believed.
  detailFor = (id) => ({ primaryBreed: 'Mix', location: 'Kennel', tagList: tags[id] || [] });
  sent.length = 0;
  const result = await runScrape();
  assert.equal(result.ok, false);
  assert.match(lastRun().note, /animal details looked wrong/);
  assert.deepEqual(JSON.parse(row(5001).tags), [PENDING]);
  assert.deepEqual(JSON.parse(row(5002).tags), [STRAY]);
  assert.equal(row(5002).pb_flag, 1, 'the PB sticker on the stray-hold dog stays');
  assert.equal(events('sticker_auto_off', 5002), 0);
  assert.equal(events('pending_canceled', 5001), 0);
  assert.equal(row(5009).location, 'Foster');
  assert.equal(row(5000).still_listed, 1, 'the listing itself still counts');

  // An empty record ({}) doesn't null the location (foster dogs stay "in foster").
  detailFor = () => ({});
  await runScrape();
  assert.equal(row(5009).location, 'Foster');
  assert.equal(lastRun().ok, 0);

  // The field comes back: no "someone is adopting" re-push, nothing changed.
  detailFor = () => null;
  assert.equal((await runScrape()).ok, true);
  assert.equal(events('pending_adoption', 5001), 0);
  assert.equal(sent.length, 0);
});

test('a few odd records don\'t fail the run, but are still kept as they were', async () => {
  detailFor = (id) => (id === 5003 ? { primaryBreed: 'Mix', tags: [] } : null); // no location key
  db.prepare("UPDATE dogs SET location = 'Kennel B' WHERE shelter_buddy_id = 5003").run();
  assert.equal((await runScrape()).ok, true);
  assert.equal(row(5003).location, 'Kennel B');
  assert.match(lastRun().note, /1 dog detail fetches failed/);
  detailFor = () => null;
});

test('an API that ignores pageNumber is deduped by id', async () => {
  ignorePaging = true;
  listRequests = 0;
  const result = await runScrape();
  ignorePaging = false;
  // Audit 3: the paging ended short of totalRecordCount, so the dog listing
  // is skipped this run (nobody delisted) and the run fails.
  assert.equal(result.ok, false);
  assert.match(result.error, /incomplete/);
  assert.equal(listRequests, 2 + 1, 'the dog list stops after a page with nothing new (plus the cat list)');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dogs WHERE still_listed = 1").get().c, 10);
});

test('quiet-hour news is queued and sent by the first scrape from 7am', async () => {
  testHooks.now = () => TEN_PM_ET;
  sent.length = 0;
  tags[5004] = [PENDING];
  await runScrape();
  assert.equal(events('pending_adoption', 5004), 1);
  assert.equal(sent.length, 0, 'nothing at 10pm');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM queued_pushes').get().c, 1);
  testHooks.now = () => SIX_AM_ET;
  await runScrape();
  assert.equal(sent.length, 0, 'still quiet at 6am');
  testHooks.now = () => SEVEN_AM_ET;
  await runScrape();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, fan);
  assert.match(sent[0].title, /Someone is adopting Pup4/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM queued_pushes').get().c, 0);
  // Stale news (over 14 hours old) is dropped, not sent.
  db.prepare('INSERT INTO queued_pushes (user_id, payload, queued_at) VALUES (?, ?, ?)').run(fan, '{"title":"old"}', '2026-11-10T12:00:00Z');
  sent.length = 0;
  await runScrape();
  assert.equal(sent.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM queued_pushes').get().c, 0);
  testHooks.now = () => NOON_ET;
  delete tags[5004];
});

test('a dog adopted lately and still on the adopted list isn\'t "adopted" again after one missed scrape', async () => {
  const id = 5005;
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('adopted', ?, 'Pup5 was adopted!', ?)").run(id, new Date(Date.now() - 5 * 86400000).toISOString());
  adopted = [id, 5006];
  listing = dogs(10).filter((d) => d.shelterBuddyId !== id && d.shelterBuddyId !== 5006);
  sent.length = 0;
  await runScrape();
  assert.equal(row(id).still_listed, 1, 'normal miss rules: still listed after one miss');
  assert.equal(row(id).missed_scrapes, 1);
  assert.equal(events('adopted', id), 1, 'no second adoption');
  // A dog with no adoption logged still takes the instant path.
  assert.equal(row(5006).still_listed, 0);
  assert.equal(events('adopted', 5006), 1);
  assert.ok(sent.some((s) => /Pup6 was adopted/.test(s.title)) || true);
  adopted = [];
  listing = dogs(10);
  await runScrape();
});

test('only real JPEGs are cached as photos', async () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(600)}</svg>`);
  photos[5007] = ['../app_data/AnimalImages/5007/Large/5007_1.jpg'];
  images['5007/Large/5007_1.jpg'] = svg;
  photos[5008] = ['../app_data/AnimalImages/5008/Large/5008_1.jpg'];
  images['5008/Large/5008_1.jpg'] = JPEG;
  await runScrape();
  assert.equal(fs.existsSync(path.join(IMAGES_DIR, '5007.jpg')), false, 'SVG bytes labelled image/jpeg are refused');
  assert.equal(fs.existsSync(path.join(IMAGES_DIR, '5008.jpg')), true);
});

test('Guide: the app-written puppies/stray-hold line is swapped once for wording that matches the rules', () => {
  const OLD = 'Puppies 6 months or younger can never be walked, at any level. Dogs on stray hold can only be walked if they are marked PB.';
  const t = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wiki_seeded', '1')").run();
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('wiki_removed_using_app', '1')").run();
  const ins = db.prepare('INSERT INTO wiki_sections (title, icon, body, sort_order, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const id = ins.run('Experience levels', '🐕', ['## Beginner', 'Less than 20 hours.', '', OLD].join('\n'), 1, t, t, 'app update').lastInsertRowid;
  const staffId = ins.run('Notes', '📝', `${OLD} (staff added this)`, 2, t, t, 'Staff').lastInsertRowid;
  const wiki = require('../src/wiki');
  wiki.register(express(), { db, resolveAuthedUser: () => null });
  const body = db.prepare('SELECT body, updated_by AS by FROM wiki_sections WHERE id = ?').get(id);
  assert.ok(!body.body.includes(OLD));
  assert.match(body.body, /Puppies under 6 months old can never be walked/);
  assert.match(body.body, /stray hold\*\* can't be walked at any level, unless they also have a PB sticker \(then it's a PB walk, so Established and up\) or a privileged volunteer has cleared a returned dog/);
  assert.match(body.body, /in foster\*\* care aren't at the shelter, so they never show as eligible/);
  assert.match(body.body, /^## Beginner\nLess than 20 hours\.\n\n/, 'the rest of the section is untouched');
  assert.equal(body.by, 'app update', 'not credited to anyone');
  assert.match(db.prepare('SELECT body FROM wiki_sections WHERE id = ?').get(staffId).body, /staff added this/, 'an edited line is left alone');
  assert.ok(db.prepare("SELECT 1 FROM app_meta WHERE key = 'wiki_replaced_puppies_stray_hold_line'").get());
  // Once only.
  db.prepare('UPDATE wiki_sections SET body = ? WHERE id = ?').run(OLD, id);
  wiki.register(express(), { db, resolveAuthedUser: () => null });
  assert.equal(db.prepare('SELECT body FROM wiki_sections WHERE id = ?').get(id).body, OLD);
  // Same words as new databases get from wikiSeed.js, when it's here.
  if (fs.existsSync(path.join(__dirname, '..', 'src', 'wikiSeed.js'))) {
    const levels = require('../src/wikiSeed').demoSections().find((s) => s.title === 'Experience levels').body;
    for (const line of wiki.LEVEL_RULE_LINES.split('\n').filter(Boolean)) assert.ok(levels.includes(line), line);
  }
});
