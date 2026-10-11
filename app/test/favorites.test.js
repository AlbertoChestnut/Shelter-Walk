// Favorite dogs: the heart, the per-user flag on every dog, and the privacy
// rules around it (only your own favorites, ever).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = 3990 + Math.floor(Math.random() * 9);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-fav-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc;
const ALICE = 'alice.heart@example.com';
const BOB = 'bob.heart@example.com';

async function call(method, url, { user = ALICE, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

const ids = {};
test.before(async () => {
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
  for (const [k, e] of [['alice', ALICE], ['bob', BOB]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  for (let d = 1; d <= 3; d += 1) db.prepare("INSERT INTO dogs (shelter_buddy_id, name, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, '2026-07-01T00:00:00', 1, ?, ?)").run(d, `Dog${d}`, now, now);
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('adopted', 2, 'Dog2 was adopted!', ?)").run(now);
  db.close();
});
test.after(() => { if (proc) proc.kill(); });

const favIds = async (user) => (await call('GET', '/api/dogs', { user })).json.dogs.filter((d) => d.isFavorite).map((d) => d.id);

test('hearting a dog marks it for you only, and can be undone', async () => {
  assert.equal((await call('PUT', `/api/users/${ids.alice}/favorites/2`, { body: { favorite: true } })).status, 200);
  assert.equal((await call('PUT', `/api/users/${ids.alice}/favorites/2`, { body: { favorite: true } })).status, 200, 'twice is harmless');
  assert.deepEqual(await favIds(ALICE), [2]);
  assert.deepEqual(await favIds(BOB), [], "someone else's favorites never show");
  const one = await call('GET', '/api/dogs/2');
  assert.equal(one.json.dog.isFavorite, true);
  assert.equal((await call('PUT', `/api/users/${ids.alice}/favorites/2`, { body: { favorite: false } })).status, 200);
  assert.deepEqual(await favIds(ALICE), []);
});

test("nobody can change someone else's favorites, staff included", async () => {
  assert.equal((await call('PUT', `/api/users/${ids.alice}/favorites/1`, { user: BOB, body: { favorite: true } })).status, 403);
  assert.equal((await call('PUT', `/api/users/${ids.alice}/favorites/1`, { user: BOB, staff: true, body: { favorite: true } })).status, 403);
  assert.deepEqual(await favIds(ALICE), []);
});

test('an unknown dog cannot be hearted', async () => {
  assert.equal((await call('PUT', `/api/users/${ids.alice}/favorites/999`, { body: { favorite: true } })).status, 404);
});

test('favorite notification prefs are opt-in and save', async () => {
  const { prefs } = (await call('GET', `/api/users/${ids.alice}/notification-prefs`)).json;
  assert.equal(prefs.favorite_adopted, false);
  assert.equal(prefs.favorite_pending, false);
  assert.equal(prefs.favorite_returned, false);
  assert.equal((await call('PUT', `/api/users/${ids.alice}/notification-prefs`, { body: { key: 'favorite_adopted', enabled: true } })).status, 200);
  assert.equal((await call('GET', `/api/users/${ids.alice}/notification-prefs`)).json.prefs.favorite_adopted, true);
});

test("a favorite's news shows in Updates even with that category hidden", async () => {
  await call('PUT', `/api/users/${ids.alice}/favorites/2`, { body: { favorite: true } });
  await call('PUT', `/api/users/${ids.alice}/notification-prefs`, { body: { key: 'show_adopted', enabled: false } });
  const mine = (await call('GET', '/api/updates')).json.updates.find((u) => u.dog_id === 2);
  assert.ok(mine && mine.favorite);
  await call('PUT', `/api/users/${ids.bob}/notification-prefs`, { user: BOB, body: { key: 'show_adopted', enabled: false } });
  assert.equal((await call('GET', '/api/updates', { user: BOB })).json.updates.find((u) => u.dog_id === 2), undefined);
});

test('favorites are in your data export', async () => {
  const exp = (await call('GET', '/api/me/export')).json;
  assert.deepEqual(exp.favoriteDogs.map((f) => f.dog), ['Dog2']);
});
