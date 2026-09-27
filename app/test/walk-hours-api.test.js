// Walking hours enforced by the server. Runs its own server with an hour-long
// window that closed 5 minutes ago (shelter time), so "outside walking
// hours" and "stopped at closing time" are testable whenever the suite runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const nyNow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  .formatToParts(new Date()).reduce((acc, p) => (p.type === 'hour' ? acc + Number(p.value) * 60 : p.type === 'minute' ? acc + Number(p.value) : acc), 0);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Too close to midnight to fit the window in today: skip rather than wrap.
const tooEarly = nyNow < 70;
const WALK_HOURS = tooEarly ? '00:00-00:01' : `${hhmm(nyNow - 65)}-${hhmm(nyNow - 5)}`;
process.env.WALK_HOURS = WALK_HOURS;
const { walkWindow, HOURS_LABEL, CLOSE_LABEL } = require('../src/walkHours');

const PORT = 3800 + Math.floor(Math.random() * 100);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-hours-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
const USER = 'hours@example.com';
let proc;

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-auth-email': USER }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

const { opensAt, closesAt } = walkWindow(new Date());
const skip = tooEarly && 'too close to midnight to set up the test window';

test.before(async () => {
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', WALK_HOURS }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  await call('GET', '/api/me');
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Night', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
  db.close();
});
test.after(async () => { if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); } });

test('no walks can start, or be logged, outside walking hours', { skip }, async () => {
  const me = (await call('GET', '/api/me')).json;
  const start = await call('POST', '/api/walks/start', { dogId: 1, userId: me.id });
  assert.equal(start.status, 409);
  assert.equal(start.json.error, `Walks can only happen from ${HOURS_LABEL}.`);
  const t = Date.now() - 3 * 3600000;
  const manual = await call('POST', '/api/walks/manual', { dogId: 1, userId: me.id, startedAt: new Date(t).toISOString(), endedAt: new Date(t + 600000).toISOString() });
  assert.equal(manual.status, 400, 'a walk 3 hours ago was before the window opened');
  const inside = await call('POST', '/api/walks/manual', { dogId: 1, userId: me.id, startedAt: new Date(opensAt.getTime() + 60000).toISOString(), endedAt: new Date(opensAt.getTime() + 600000).toISOString() });
  assert.equal(inside.status, 200, 'one inside the window is fine');
});

test('a walk still going at closing time stops then, and "just now" can\'t go past it', { skip }, async () => {
  const me = (await call('GET', '/api/me')).json;
  const startedAt = new Date(closesAt.getTime() - 10 * 60000).toISOString(); // 10 minutes before closing
  const db = new Database(dbFile);
  const id = db.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)').run(me.id, startedAt).lastInsertRowid;
  db.close();
  const active = await call('GET', '/api/walks/active');
  assert.equal(active.json.walk, null, 'stopped by the sweep');
  assert.equal(active.json.wrapUp.id, id, 'and the walker is asked when it really ended');
  assert.equal(active.json.wrapUp.ended_at, closesAt.toISOString(), 'at closing time, not after 30 minutes');
  assert.equal(active.json.wrapUp.closesAt, closesAt.toISOString());
  assert.equal((await call('POST', `/api/walks/${id}/extend`)).status, 409, 'too late to extend');

  const wrap = await call('PUT', `/api/walks/${id}/end`, { notes: '', endedAt: new Date().toISOString() });
  assert.equal(wrap.status, 200);
  assert.equal(wrap.json.endedAt, closesAt.toISOString(), '"just now" after closing means closing time');

  const edit = await call('PUT', `/api/walks/${id}`, { endedAt: new Date(closesAt.getTime() + 60000).toISOString() });
  assert.equal(edit.status, 400, 'Stats edits can\'t push the end past closing');
  assert.ok(edit.json.error.includes(CLOSE_LABEL));
});
