// Walking hours enforced by the server. Runs its own server with an hour-long
// window that closed 25 minutes ago (shelter time), so "outside walking
// hours" and "stopped at closing time" are testable whenever the suite runs.
// A walk out at closing quietly runs up to CLOSING_GRACE_MINUTES (20) past
// it (owner, audit 3), so the window closed longer ago than that.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

const nyNow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  .formatToParts(new Date()).reduce((acc, p) => (p.type === 'hour' ? acc + Number(p.value) * 60 : p.type === 'minute' ? acc + Number(p.value) : acc), 0);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Too close to midnight to fit the window in today: skip rather than wrap.
const tooEarly = nyNow < 90;
const WALK_HOURS = tooEarly ? '00:00-00:01' : `${hhmm(nyNow - 85)}-${hhmm(nyNow - 25)}`;
const { CLOSING_GRACE_MINUTES } = require('../src/constants');
process.env.WALK_HOURS = WALK_HOURS;
const { walkWindow, HOURS_LABEL, CLOSE_LABEL } = require('../src/walkHours');

let base, dbFile, server;
const USER = 'hours@example.com';

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-auth-email': USER }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

const { opensAt, closesAt } = walkWindow(new Date());
const skip = tooEarly && 'too close to midnight to set up the test window';

test.before(async () => {
  server = await startServer({ prefix: 'sw-hours-', env: { WALK_HOURS } });
  ({ base, dbFile } = server);
  await call('GET', '/api/me');
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Night', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
  db.close();
});
test.after(async () => { if (server) await server.stop(); });

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

test('a walk still going at closing time stops (after the quiet grace), and "just now" can\'t go past it', { skip }, async () => {
  const me = (await call('GET', '/api/me')).json;
  const startedAt = new Date(closesAt.getTime() - 10 * 60000).toISOString(); // 10 minutes before closing
  const db = new Database(dbFile);
  const id = db.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)').run(me.id, startedAt).lastInsertRowid;
  db.close();
  const active = await call('GET', '/api/walks/active');
  assert.equal(active.json.walk, null, 'stopped by the sweep');
  assert.equal(active.json.wrapUp.id, id, 'and the walker is asked when it really ended');
  const cutoff = new Date(closesAt.getTime() + CLOSING_GRACE_MINUTES * 60000).toISOString();
  assert.equal(active.json.wrapUp.ended_at, cutoff, 'at closing time plus the grace, not after 45 minutes');
  assert.equal(active.json.wrapUp.closesAt, closesAt.toISOString(), 'the official closing time is what the app names');
  assert.equal(active.json.wrapUp.endsBy, cutoff, 'the end-time picker may go up to the grace end');
  assert.equal((await call('POST', `/api/walks/${id}/extend`)).status, 409, 'too late to extend');

  const wrap = await call('PUT', `/api/walks/${id}/end`, { notes: '', endedAt: new Date().toISOString() });
  assert.equal(wrap.status, 200);
  assert.equal(wrap.json.endedAt, cutoff, '"just now" after closing means the end of the grace');

  const inGrace = await call('PUT', `/api/walks/${id}`, { endedAt: new Date(closesAt.getTime() + 15 * 60000).toISOString() });
  assert.equal(inGrace.status, 200, 'Stats edits may end it within the grace');
  const edit = await call('PUT', `/api/walks/${id}`, { endedAt: new Date(closesAt.getTime() + (CLOSING_GRACE_MINUTES + 1) * 60000).toISOString() });
  assert.equal(edit.status, 400, 'Stats edits can\'t push the end past closing plus the grace');
  assert.ok(edit.json.error.includes(CLOSE_LABEL), 'and the message names the official closing time');
  assert.ok(!/20 min|grace/i.test(edit.json.error));
});

test('a daycation is not stopped at closing time, and can be logged past it', { skip }, async () => {
  const me = (await call('GET', '/api/me')).json;
  const startedAt = new Date(closesAt.getTime() - 10 * 60000).toISOString(); // 10 minutes before closing
  const db = new Database(dbFile);
  // The earlier tests' walks go: the daycation logged below spans the whole
  // window, and a walker's entries can't overlap.
  db.prepare('DELETE FROM walks WHERE user_id = ?').run(me.id);
  const id = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, activity) VALUES (1, ?, ?, 'daycation')").run(me.id, startedAt).lastInsertRowid;
  db.close();
  const active = await call('GET', '/api/walks/active');
  assert.equal(active.json.walk && active.json.walk.id, id, 'still going after closing');
  assert.equal(active.json.walk.closesAt, null);
  assert.equal(new Date(active.json.walk.stopsAt).getTime() - new Date(startedAt).getTime(), 12 * 3600000);
  assert.equal((await call('DELETE', `/api/walks/${id}`)).status, 200);

  const s = opensAt.getTime() + 60000;
  const manual = await call('POST', '/api/walks/manual', { dogId: 1, userId: me.id, activity: 'daycation', startedAt: new Date(s).toISOString(), endedAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(manual.status, 200, 'a daycation can end after closing');
  const walkPast = await call('POST', '/api/walks/manual', { dogId: 1, userId: me.id, activity: 'walk', startedAt: new Date(s).toISOString(), endedAt: new Date(Date.now() - 60000).toISOString() });
  assert.equal(walkPast.status, 400, 'a walk still can\'t');
});
