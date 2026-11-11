// Audit 3 (backend, in-process): the scraper (re-stamped photos, failed
// detail runs, late adoptions, short paging, missing fields, a new stay's
// kennel letter, stale stickers, calendar days) and the push TTL of day
// alerts. Throwaway DB and image folder, stubbed shelter API and push.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { isolateEnv } = require('./_helpers');

isolateEnv('sw-a3-inproc-');
const db = require('../src/db');
const push = require('../src/push');
const sent = [];
push.sendPushToUser = async (userId, payload, options) => { sent.push({ userId, options, ...payload }); return 1; };
const { runScrape, IMAGES_DIR } = require('../src/scraper');

const JPEG = (fill) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, fill)]);
const lists = { Dog: [], Cat: [] };
let adopted = [];
let allDetailsFail = false;
let shortPaging = false;
const detailOverride = {}; // id -> detail object
const photoPaths = {};
const images = {}; // url suffix -> { bytes, lastModified }
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') {
    const { species, pageNumber, pageSize } = JSON.parse(opts.body);
    const all = lists[species] || [];
    const total = shortPaging && species === 'Dog' ? all.length + 10 : all.length;
    const rows = shortPaging && pageNumber > 1 ? [] : all.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    return json({ data: rows, paging: { totalRecordCount: total } });
  }
  if (u.includes('/api/animals/adopted')) return json({ data: adopted.map((id) => ({ shelterBuddyId: id })) });
  const p = /\/api\/photos\/(\d+)$/.exec(u);
  if (p) return json({ large: photoPaths[Number(p[1])] || [] });
  const img = Object.keys(images).find((k) => u.endsWith(k));
  if (img) {
    const ims = (opts.headers || {})['If-Modified-Since'];
    if (ims && ims === images[img].lastModified) return new Response(null, { status: 304 });
    return new Response(images[img].bytes, { status: 200, headers: { 'content-type': 'image/jpeg', 'last-modified': images[img].lastModified } });
  }
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) {
    if (allDetailsFail) return json({ error: 'nope' }, 404);
    const id = Number(m[1]);
    return json(detailOverride[id] || { primaryBreed: 'Mix', location: 'Kennel', tags: [], weight: '50 lbs', desexed: 'Yes', summary: 'Nice dog' });
  }
  return realFetch(url, opts);
};

const dogs = (n, from = 4000) => Array.from({ length: n }, (_, i) => ({ shelterBuddyId: from + i, name: `Ace${i}`, dateInShelter: '2026-08-01T00:00:00', sex: 'Male', age: '2 Years' }));
const row = (id) => db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(id);
const eventsFor = (kind, id) => db.prepare('SELECT COUNT(*) c FROM shelter_events WHERE kind = ? AND dog_id = ?').get(kind, id).c;
const lastRun = () => db.prepare('SELECT ok, note FROM scrape_runs ORDER BY id DESC LIMIT 1').get();
const timePasses = () => db.prepare('UPDATE dogs SET last_seen_at = ? WHERE still_listed = 1').run(new Date(Date.now() - 2 * 3600000).toISOString());
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 86400000;

test.before(async () => {
  lists.Dog = dogs(30);
  assert.equal((await runScrape()).ok, true);
});

test('a re-stamped photo with the same bytes keeps its file and mtime; only the sidecar changes', async () => {
  const id = 4001;
  photoPaths[id] = ['../app_data/AnimalImages/4001/Large/4001_1.jpg'];
  images['4001_1.jpg'] = { bytes: JPEG(1), lastModified: 'Mon, 09 Nov 2026 10:00:00 GMT' };
  await runScrape();
  const file = path.join(IMAGES_DIR, `${id}.jpg`);
  assert.ok(fs.existsSync(file));
  const past = new Date(Date.now() - 3 * DAY);
  fs.utimesSync(file, past, past);
  const before = fs.statSync(file).mtimeMs;

  images['4001_1.jpg'].lastModified = 'Tue, 10 Nov 2026 10:00:00 GMT'; // same bytes, new stamp
  await runScrape();
  assert.equal(fs.statSync(file).mtimeMs, before, 'not rewritten, so its ?v= stays and phones keep their copy');
  assert.match(fs.readFileSync(`${file}.lastmod`, 'utf8'), /Tue, 10 Nov 2026/, 'the sidecar has the new date');

  images['4001_1.jpg'] = { bytes: JPEG(2), lastModified: 'Wed, 11 Nov 2026 10:00:00 GMT' }; // a real new photo
  await runScrape();
  assert.notEqual(fs.statSync(file).mtimeMs, before);
  assert.ok(fs.readFileSync(file).equals(JPEG(2)));
});

test('a run where every detail request fails counts as failed, and keeps the data', async () => {
  allDetailsFail = true;
  const r = await runScrape();
  allDetailsFail = false;
  assert.equal(r.ok, false);
  assert.match(lastRun().note, /detail requests failed/);
  assert.equal(row(4002).breed, 'Mix', 'kept');
  assert.equal((await runScrape()).ok, true);
});

test('short paging skips the species instead of delisting the rest', async () => {
  shortPaging = true;
  for (let i = 0; i < 2; i += 1) {
    const r = await runScrape();
    assert.equal(r.ok, false);
    assert.match(r.error, /incomplete/);
    timePasses();
  }
  shortPaging = false;
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dogs WHERE still_listed = 1 AND species = 'dog'").get().c, 30);
});

test('a field whose key goes missing keeps its value; an explicit empty one still clears it', async () => {
  const id = 4003;
  assert.equal(row(id).weight, '50 lbs');
  const idx = lists.Dog.findIndex((d) => d.shelterBuddyId === id);
  const { sex, age, ...renamed } = lists.Dog[idx];
  lists.Dog[idx] = { ...renamed, gender: 'Male', ageText: '2 Years' };
  detailOverride[id] = { primaryBreed: 'Mix', location: 'Kennel', tags: [], weightLbs: '50', isDesexed: true, bio: 'x' };
  assert.equal((await runScrape()).ok, true);
  const kept = row(id);
  assert.deepEqual([kept.sex, kept.age, kept.weight, kept.desexed, kept.summary], ['Male', '2 Years', '50 lbs', 'Yes', 'Nice dog']);
  detailOverride[id] = { primaryBreed: 'Mix', location: 'Kennel', tags: [], weight: null, desexed: 'Yes', summary: 'Nice dog' };
  await runScrape();
  assert.equal(row(id).weight, null, 'present but empty: cleared');
  lists.Dog = dogs(30);
  delete detailOverride[id];
});

test('a late adoption rewrites only the latest removal', async () => {
  const id = 4010;
  const without = () => dogs(30).filter((d) => d.shelterBuddyId !== id);
  // First removal, then back on the floor two days later.
  lists.Dog = without();
  await runScrape(); timePasses(); await runScrape();
  assert.equal(eventsFor('removed', id), 1);
  const twoDaysAgo = ago(2 * DAY);
  db.prepare('UPDATE dogs SET removed_at = ? WHERE shelter_buddy_id = ?').run(twoDaysAgo, id);
  db.prepare("UPDATE shelter_events SET occurred_at = ? WHERE kind = 'removed' AND dog_id = ?").run(twoDaysAgo, id);
  lists.Dog = dogs(30);
  await runScrape();
  assert.equal(eventsFor('returned', id), 1);
  // Second removal, then the shelter lists the dog as adopted.
  lists.Dog = without();
  await runScrape(); timePasses(); await runScrape();
  assert.equal(eventsFor('removed', id), 2);
  adopted = [id];
  await runScrape();
  adopted = [];
  assert.equal(eventsFor('adopted', id), 1, 'one adoption');
  assert.equal(eventsFor('removed', id), 1, 'the earlier removal stays a removal');
  lists.Dog = dogs(30);
  await runScrape();
});

test('back after an adoption: calendar days in shelter time, and the old kennel letter is cleared', async () => {
  const id = 4020;
  const leftAt = ago(2 * DAY - 60000); // 47 h 59 min ago: two calendar days at noon
  db.prepare("UPDATE dogs SET still_listed = 0, removed_at = ?, kennel_location = 'C' WHERE shelter_buddy_id = ?").run(leftAt, id);
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('adopted', ?, 'Ace20 was adopted!', ?)").run(id, leftAt);
  await runScrape();
  const ev = db.prepare("SELECT title FROM shelter_events WHERE kind = 'returned' AND dog_id = ? ORDER BY id DESC").get(id);
  assert.match(ev.title, /after being adopted \(2 days\)/);
  assert.equal(row(id).kennel_location, null, 'a new stay starts without the old kennel letter');
});

test('stickers cleared on a return after 6+ months are logged as sticker_off', async () => {
  const id = 4021;
  db.prepare(`UPDATE dogs SET still_listed = 0, removed_at = ?, star_flag = 1, poo_status = 'poo', blue_markers = '["blue_r"]', kennel_location = 'B'
    WHERE shelter_buddy_id = ?`).run(ago(220 * DAY), id);
  await runScrape();
  const r = row(id);
  assert.deepEqual([r.star_flag, r.poo_status, r.blue_markers], [0, 'none', '[]']);
  const off = db.prepare("SELECT detail FROM shelter_events WHERE kind = 'sticker_off' AND dog_id = ? ORDER BY detail").all(id).map((e) => e.detail);
  assert.deepEqual(off, ['blue_r', 'poo', 'star']);
  assert.equal(r.kennel_location, null);
});

test('day alerts are pushed with a TTL that ends when the alert expires', async () => {
  const express = require('express');
  const shelterSchedule = require('../src/shelterSchedule');
  const app = express();
  app.use(express.json());
  shelterSchedule.register(app, { db, push });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const uid = db.prepare("INSERT INTO users (name, created_at) VALUES ('Push Pat', ?)").run(new Date().toISOString()).lastInsertRowid;
    db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://push.example/1', 'k', 'a', ?)").run(uid, new Date().toISOString());
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    sent.length = 0;
    const res = await fetch(`${base}/api/staff/alerts`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-staff': '1' }, body: JSON.stringify({ title: 'Today only', until: today })
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    const pushed = sent.find((s) => s.userId === uid);
    assert.ok(pushed, 'pushed');
    const expected = (new Date(body.expiresAt).getTime() - Date.now()) / 1000;
    assert.ok(Math.abs(pushed.options.TTL - expected) < 30, `TTL ${pushed.options.TTL} ~ ${expected}`);
    assert.ok(pushed.options.TTL < 24 * 3600, 'not the old one-day default');
  } finally {
    srv.close();
  }
});
