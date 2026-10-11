// Favorite-dog push notices from the scraper: adopted, someone started
// adopting, back at the shelter. Pushes are captured, not sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-favscrape-')), 'test.db');
const db = require('../src/db');
const push = require('../src/push');
const sent = [];
push.sendPushToUser = async (userId, payload) => { sent.push({ userId, ...payload }); };
const { runScrape } = require('../src/scraper');

const PENDING = "I'm getting adopted!";
let listing = [];
let adopted = [];
const pendingIds = new Set();
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') return json({ data: listing });
  if (u.includes('/api/animals/adopted')) return json({ data: adopted.map((id) => ({ shelterBuddyId: id })) });
  if (u.includes('/api/photos/')) return json({ large: [] });
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) return json({ primaryBreed: 'Mix', tags: pendingIds.has(Number(m[1])) ? [PENDING] : [] });
  return realFetch(url, opts);
};

const dogs = (n) => Array.from({ length: n }, (_, i) => ({ shelterBuddyId: 2000 + i, name: `Pup${i}`, dateInShelter: '2026-08-01T00:00:00' }));
const now = new Date().toISOString();
const addUser = (name) => db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run(name, now).lastInsertRowid;
const pref = (userId, key) => db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, ?, 1)').run(userId, key);
const heart = (userId, dogId) => db.prepare('INSERT INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, ?, ?)').run(userId, dogId, now);

let fan, walker, both, quiet;
test.before(async () => {
  listing = dogs(25);
  await runScrape();
  fan = addUser('Fan');          // hearted Pup0, wants only favorite notices
  walker = addUser('Walker');    // walked Pup0, wants general adoption notices only
  both = addUser('Both');        // hearted AND walked Pup0, wants both
  quiet = addUser('Quiet');      // hearted Pup0, no notices on
  for (const u of [fan, both, quiet]) heart(u, 2000);
  heart(fan, 2001);
  for (const k of ['favorite_adopted', 'favorite_pending', 'favorite_returned']) { pref(fan, k); pref(both, k); }
  pref(walker, 'adopted_walked_dog');
  pref(both, 'adopted_walked_dog');
  for (const u of [walker, both]) db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (2000, ?, ?, ?, 600)').run(u, now, now);
});

test('someone starting to adopt a favorite pushes once, to opted-in fans only', async () => {
  sent.length = 0;
  pendingIds.add(2000);
  await runScrape();
  assert.deepEqual(sent.map((p) => p.userId).sort(), [fan, both].sort());
  assert.match(sent[0].title, /Someone is adopting Pup0/);
  sent.length = 0;
  await runScrape();
  assert.equal(sent.length, 0, 'still pending on the next scrape: no repeat');
});

test('an adopted favorite pushes one notice per person, even if they also walked it', async () => {
  sent.length = 0;
  listing = dogs(25).filter((d) => d.shelterBuddyId !== 2000);
  adopted = [2000];
  await runScrape();
  const byUser = Object.fromEntries(sent.map((p) => [p.userId, p]));
  assert.equal(sent.length, 3);
  assert.match(byUser[fan].body, /favorites/);
  assert.match(byUser[both].body, /favorites/);
  assert.match(byUser[walker].body, /you walked/);
  assert.equal(byUser[quiet], undefined);
  adopted = [];
});

test('a favorite coming back to the shelter pushes to its fans', async () => {
  sent.length = 0;
  pendingIds.delete(2000);
  listing = dogs(25);
  await runScrape();
  assert.deepEqual(sent.map((p) => p.userId).sort(), [fan, both].sort());
  assert.match(sent[0].title, /Pup0 is back/);
});
