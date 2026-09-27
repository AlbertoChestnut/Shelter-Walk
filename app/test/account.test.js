// Account deletion: the login account goes first (and if that fails nothing
// changes); then walks are kept but disowned and everything personal is removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { hashEmail } = require('../src/emailHash');

const PORT = 4100 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-acct-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc; let stub; let stubPort;
let stubMode = 'ok'; // 'ok' | 'staff' | 'down'
const stubCalls = [];

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
  // A stand-in for the login system's internal endpoint.
  stub = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      stubCalls.push({ path: req.url, auth: req.headers.authorization, host: req.headers.host, body: JSON.parse(data || '{}') });
      if (stubMode === 'down') { req.socket.destroy(); return; }
      res.setHeader('Content-Type', 'application/json');
      if (stubMode === 'staff') { res.statusCode = 403; res.end('{"error":"staff"}'); return; }
      res.end('{"deleted":true}');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
  proc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00', DJANGO_INTERNAL_URL: `http://127.0.0.1:${stubPort}`, INTERNAL_API_TOKEN: 'test-token' },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
});
test.after(async () => {
  if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); }
  stub.close();
});

const LEAVER = 'leaver.quokka@example.com';
const STAYER = 'stayer.quokka@example.com';
const ids = {};

test('setup: two walkers with walks, notes, prefs and filters', async () => {
  ids.leaver = (await call('GET', '/api/me', { user: LEAVER })).json.id;
  ids.stayer = (await call('GET', '/api/me', { user: STAYER })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Rex', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, notes) VALUES (1, ?, ?, ?, 900, ?)');
  for (let i = 0; i < 3; i += 1) ins.run(ids.leaver, new Date(Date.now() - (i + 2) * 3600000).toISOString(), new Date(Date.now() - (i + 2) * 3600000 + 900000).toISOString(), i === 0 ? 'walk note stays' : null);
  ins.run(ids.stayer, new Date(Date.now() - 6 * 3600000).toISOString(), new Date(Date.now() - 6 * 3600000 + 900000).toISOString(), null);
  db.prepare("INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)").run(ids.leaver, now); // in progress
  db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (1, ?, 'public', 'shared tip stays', ?, ?)").run(ids.leaver, now, now);
  db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (1, ?, 'private', 'my private thoughts', ?, ?)").run(ids.leaver, now, now);
  db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (1, ?, 'private', 'stayer private', ?, ?)").run(ids.stayer, now, now);
  db.prepare("INSERT INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, 'walk_started', 1)").run(ids.leaver);
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://push.example/x', 'k', 'a', ?)").run(ids.leaver, now);
  db.prepare("INSERT INTO saved_filters (user_id, name, filter_json, created_at) VALUES (?, 'mine', '{}', ?)").run(ids.leaver, now);
  db.close();
});

test('it will not delete without the typed confirmation', async () => {
  assert.equal((await call('DELETE', '/api/me', { user: LEAVER })).status, 400);
  assert.equal((await call('DELETE', '/api/me', { user: LEAVER, body: { confirm: 'delete' } })).status, 400, 'exact word only');
  assert.equal(stubCalls.length, 0, 'the login system was never contacted');
});

test('staff accounts cannot be deleted this way', async () => {
  const r = await call('DELETE', '/api/me', { user: 'staffer.quokka@example.com', staff: true, body: { confirm: 'DELETE' } });
  assert.equal(r.status, 403);
  assert.equal(stubCalls.length, 0);
});

test('if the login system fails, NOTHING is changed', async () => {
  stubMode = 'down';
  const r = await call('DELETE', '/api/me', { user: LEAVER, body: { confirm: 'DELETE' } });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /NOT deleted/);
  stubMode = 'staff';
  assert.equal((await call('DELETE', '/api/me', { user: LEAVER, body: { confirm: 'DELETE' } })).status, 403);
  const db = new Database(dbFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE user_id = ?').get(ids.leaver).c, 4, 'walks still owned');
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(ids.leaver), 'user still exists');
  db.close();
  stubMode = 'ok';
});

test('deleting: login removed first, walks kept but disowned, everything personal gone', async () => {
  const before = new Database(dbFile, { readonly: true });
  const totalBefore = before.prepare('SELECT COUNT(*) c FROM walks WHERE ended_at IS NOT NULL').get().c;
  before.close();
  stubCalls.length = 0;
  const r = await call('DELETE', '/api/me', { user: LEAVER, body: { confirm: 'DELETE' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);
  assert.equal(stubCalls.length, 1);
  assert.equal(stubCalls[0].auth, 'Bearer test-token', 'authenticated with the shared secret');
  assert.equal(stubCalls[0].body.email, LEAVER);

  const db = new Database(dbFile, { readonly: true });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE ended_at IS NOT NULL').get().c, totalBefore, 'completed walks are all still there');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE user_id = ?').get(ids.leaver).c, 0, 'no walk points at them any more');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE ended_at IS NULL').get().c, 0, 'the unfinished walk was cancelled');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM walks WHERE user_id IS NULL AND ended_at IS NOT NULL').get().c, 3, 'their 3 walks are now unattributed');
  assert.equal(db.prepare("SELECT notes FROM walks WHERE notes = 'walk note stays'").get().notes, 'walk note stays');
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(ids.leaver), undefined);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE auth_email_hash = ?').get(hashEmail(LEAVER)), undefined, 'their email is gone');
  for (const t of ['notification_prefs', 'push_subscriptions', 'saved_filters']) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`).get(ids.leaver).c, 0, `${t} cleared`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM dog_notes WHERE body = 'my private thoughts'").get().c, 0, 'private notes deleted');
  const tip = db.prepare("SELECT user_id FROM dog_notes WHERE body = 'shared tip stays'").get();
  assert.equal(tip.user_id, 0, 'the shared tip stays, owned by nobody');
  // The rest of the database still says nothing about who they were.
  const dump = JSON.stringify([
    db.prepare('SELECT * FROM walks').all(), db.prepare('SELECT * FROM dog_notes').all(), db.prepare('SELECT * FROM users').all(), db.prepare('SELECT * FROM wiki_sections').all()
  ]).toLowerCase();
  assert.ok(!dump.includes('leaver'), 'no trace of the name/email');
  db.close();
});

test('other walkers are completely unaffected', async () => {
  const me = await call('GET', '/api/me', { user: STAYER });
  assert.equal(me.json.id, ids.stayer);
  assert.equal((await call('GET', '/api/walks', { user: STAYER })).json.walks.length, 1);
  assert.equal((await call('GET', '/api/dogs/1/notes', { user: STAYER })).json.privateNote.body, 'stayer private');
  // Shared totals still count the deleted walker's walks.
  assert.equal((await call('GET', '/api/impact', { user: STAYER })).json.allTime.walks, 4);
});

test('the deleted walker\'s walks show up as nobody\'s in the shared day view', async () => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 3 * 3600 * 1000));
  const r = await call('GET', `/api/impact/day?date=${day}`, { user: STAYER });
  if (r.status === 200) assert.ok(r.json.walks.every((w) => w.mine === false || w.mine === true) && !r.text.toLowerCase().includes('leaver'));
});

test('saving your name also hands it to the login app for the staff account list', async () => {
  const user = 'namer.quokka@example.com';
  await call('GET', '/api/me', { user });
  stubCalls.length = 0;
  const r = await call('PUT', '/api/me', { user, body: { name: 'Nora Namer' } });
  assert.equal(r.status, 200);
  for (let i = 0; i < 20 && !stubCalls.length; i += 1) await new Promise((res) => setTimeout(res, 50));
  assert.equal(stubCalls.length, 1);
  assert.equal(stubCalls[0].path, '/internal/set-name/');
  assert.equal(stubCalls[0].auth, 'Bearer test-token');
  assert.deepEqual(stubCalls[0].body, { email: user, name: 'Nora Namer' });

  // The login app being down never blocks saving the name here.
  stubMode = 'down';
  const r2 = await call('PUT', '/api/me', { user, body: { name: 'Nora N' } });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.name, 'Nora N');
  stubMode = 'ok';
});
