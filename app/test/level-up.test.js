// The 20-hour level-up offer: a Beginner whose finished walks reach 20 hours
// is asked once whether to move up to Established.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = 4010 + Math.floor(Math.random() * 9);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-levelup-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc;
const ALICE = 'alice.level@example.com';
const BOB = 'bob.level@example.com';
const CAROL = 'carol.level@example.com';

async function call(method, url, { user = ALICE, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await res.json(); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

// Finished walks of the given lengths (hours), one per day in the past.
function addWalks(userId, hours) {
  const db = new Database(dbFile);
  hours.forEach((h, i) => {
    const start = new Date(Date.UTC(2026, 5, 1 + i, 14));
    const end = new Date(start.getTime() + h * 3600000);
    db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (1, ?, ?, ?, ?)')
      .run(userId, start.toISOString(), end.toISOString(), Math.round(h * 3600));
  });
  db.close();
}

const ids = {};
test.before(async () => {
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
  for (const [k, e] of [['alice', ALICE], ['bob', BOB], ['carol', CAROL]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Dog1', '2026-01-01T00:00:00', 1, ?, ?)").run(now, now);
  db.prepare("UPDATE users SET experience_level = 'beginner'").run();
  db.close();
});
test.after(() => { if (proc) proc.kill(); });

const offered = async (user) => (await call('GET', '/api/me', { user })).json.levelUpOffer;

test('offered only once a Beginner passes 20 hours', async () => {
  addWalks(ids.alice, [10, 9.5]);
  assert.equal(await offered(ALICE), false, '19.5 hours is not enough');
  addWalks(ids.alice, [0.5]);
  assert.equal(await offered(ALICE), true, 'exactly 20 hours counts');
});

test('saying yes makes them Established and the offer stops', async () => {
  const res = await call('POST', `/api/users/${ids.alice}/level-up-offer`, { body: { accept: true } });
  assert.equal(res.status, 200);
  assert.equal(res.json.experienceLevel, 'established');
  assert.equal((await call('GET', '/api/me')).json.experienceLevel, 'established');
  assert.equal(await offered(ALICE), false);
});

test('saying no keeps Beginner and is never asked again', async () => {
  addWalks(ids.bob, [25]);
  assert.equal(await offered(BOB), true);
  const res = await call('POST', `/api/users/${ids.bob}/level-up-offer`, { user: BOB, body: { accept: false } });
  assert.equal(res.json.experienceLevel, 'beginner');
  assert.equal(await offered(BOB), false);
  addWalks(ids.bob, [5]);
  assert.equal(await offered(BOB), false, 'more hours later still does not re-ask');
});

test('nobody answers the offer for someone else', async () => {
  assert.equal((await call('POST', `/api/users/${ids.carol}/level-up-offer`, { user: BOB, body: { accept: true } })).status, 403);
});

test('ending the walk that crosses 20 hours carries the offer', async () => {
  addWalks(ids.carol, [20]);
  const db = new Database(dbFile);
  const startedAt = new Date(Date.now() - 5 * 60000).toISOString();
  const walkId = db.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)').run(ids.carol, startedAt).lastInsertRowid;
  db.close();
  const res = await call('PUT', `/api/walks/${walkId}/end`, { user: CAROL, body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.levelUpOffer, true);
});
