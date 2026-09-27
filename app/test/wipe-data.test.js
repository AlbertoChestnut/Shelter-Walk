// "Delete my data, keep my account" (Privacy & Data): unlike full account
// deletion, this never touches the login system -- only walks/notes get
// disowned, the account itself (and everyone else's data) is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const { hashEmail } = require('../src/emailHash');

const PORT = 4200 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-wipe-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc;

async function call(method, url, { user, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* no json */ }
  return { status: res.status, json, text };
}

test.before(async () => {
  proc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
});
test.after(async () => { if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); } });

const WIPER = 'wiper.narwhal@example.com';
const STAFFER = 'staffer.narwhal@example.com';
const OTHER = 'other.narwhal@example.com';
const ids = {};

test('setup: a walker (and a staff member) with walks and notes', async () => {
  ids.wiper = (await call('GET', '/api/me', { user: WIPER })).json.id;
  ids.staffer = (await call('GET', '/api/me', { user: STAFFER, staff: true })).json.id;
  ids.other = (await call('GET', '/api/me', { user: OTHER })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Fido', 'Male', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (1, ?, ?, ?, 900)');
  for (let i = 0; i < 2; i += 1) ins.run(ids.wiper, new Date(Date.now() - (i + 2) * 3600000).toISOString(), new Date(Date.now() - (i + 2) * 3600000 + 900000).toISOString());
  ins.run(ids.other, new Date(Date.now() - 5 * 3600000).toISOString(), new Date(Date.now() - 5 * 3600000 + 900000).toISOString());
  db.prepare("INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)").run(ids.wiper, now); // in progress
  db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (1, ?, 'public', 'shared tip stays', ?, ?)").run(ids.wiper, now, now);
  db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (1, ?, 'private', 'wiper private note', ?, ?)").run(ids.wiper, now, now);
  db.prepare("INSERT INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, 'walk_started', 1)").run(ids.wiper);
  db.prepare("INSERT INTO saved_filters (user_id, name, filter_json, created_at) VALUES (?, 'mine', '{}', ?)").run(ids.wiper, now);
  db.close();
});

test('will not wipe without the typed confirmation', async () => {
  assert.equal((await call('DELETE', '/api/me/data', { user: WIPER })).status, 400);
  assert.equal((await call('DELETE', '/api/me/data', { user: WIPER, body: { confirm: 'delete' } })).status, 400, 'exact word only');
  const db = new Database(dbFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE user_id = ?').get(ids.wiper).c, 3, 'nothing touched yet');
  db.close();
});

test('staff can wipe their own walk data too (unlike full account deletion)', async () => {
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (1, ?, ?, ?, 60)').run(ids.staffer, now, now);
  db.close();
  const r = await call('DELETE', '/api/me/data', { user: STAFFER, staff: true, body: { confirm: 'DELETE' } });
  assert.equal(r.status, 200);
  const after = new Database(dbFile, { readonly: true });
  assert.equal(after.prepare('SELECT COUNT(*) c FROM walks WHERE user_id = ?').get(ids.staffer).c, 0);
  assert.ok(after.prepare('SELECT 1 FROM users WHERE id = ?').get(ids.staffer), 'staff account itself still exists');
  after.close();
});

test('wiping: walks disowned and reset, account and login untouched', async () => {
  const before = new Database(dbFile, { readonly: true });
  const totalBefore = before.prepare('SELECT COUNT(*) c FROM walks WHERE ended_at IS NOT NULL').get().c;
  // The previous test already left one other walk (the staffer's) unowned,
  // so this checks the CHANGE from here, not an absolute count.
  const unownedBefore = before.prepare('SELECT COUNT(*) c FROM walks WHERE user_id IS NULL AND ended_at IS NOT NULL').get().c;
  before.close();

  const r = await call('DELETE', '/api/me/data', { user: WIPER, body: { confirm: 'DELETE' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);

  const db = new Database(dbFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE ended_at IS NOT NULL').get().c, totalBefore, 'no completed walk was deleted, only disowned');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE user_id = ?').get(ids.wiper).c, 0, 'no walk points at them any more');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE ended_at IS NULL').get().c, 0, 'their unfinished walk was cancelled, not left dangling');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE user_id IS NULL AND ended_at IS NOT NULL').get().c, unownedBefore + 2, 'their 2 completed walks are now unattributed');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dog_notes WHERE body = 'wiper private note'").get().c, 0, 'private note deleted');
  const tip = db.prepare("SELECT user_id FROM dog_notes WHERE body = 'shared tip stays'").get();
  assert.equal(tip.user_id, 0, 'the shared tip stays, owned by nobody');

  // The account itself -- name, email, sign-in -- is completely untouched.
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ids.wiper);
  assert.ok(user, 'account still exists');
  assert.equal(user.auth_email_hash, hashEmail(WIPER));
  assert.ok(user.name, 'name kept');
  db.close();

  const me = await call('GET', '/api/me', { user: WIPER });
  assert.equal(me.status, 200);
  assert.equal(me.json.id, ids.wiper, 'signing in afterward still resolves to the same account');
});

test('other walkers, and the shelter-wide totals, are unaffected', async () => {
  const me = await call('GET', '/api/me', { user: OTHER });
  assert.equal(me.json.id, ids.other);
  assert.equal((await call('GET', '/api/walks', { user: OTHER })).json.walks.length, 1);
});
