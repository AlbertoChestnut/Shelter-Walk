// End-to-end API tests: boots the real server against a throwaway DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = 3400 + Math.floor(Math.random() * 400);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-api-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc;

const as = (email, staff) => ({ 'content-type': 'application/json', 'x-auth-email': email, ...(staff ? { 'x-auth-staff': '1' } : {}) });
async function call(method, url, { user = 'walker@example.com', staff = false, body, headers } = {}) {
  const res = await fetch(base + url, { method, headers: { ...as(user, staff), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}
async function startServer() {
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}
async function stopServer() { if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); proc = null; } }

test.before(async () => {
  await startServer();
  await call('GET', '/api/me'); // creates the schema + first walker
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?)");
  ins.run(1, 'Listed', 1, now, now);
  ins.run(2, 'Gone', 0, now, now);
  ins.run(3, 'Other', 1, now, now);
  db.close();
});
test.after(stopServer);

test('healthz responds and /api/me creates a walker', async () => {
  assert.equal((await call('GET', '/healthz')).json.ok, true);
  const me = await call('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.isPrivileged, false);
  assert.equal(me.json.isStaff, false);
  assert.equal((await fetch(`${base}/api/me`)).status, 401, 'no auth header, no identity');
});

test('malformed input never 500s', async () => {
  assert.equal((await call('GET', '/api/updates?limit=abc')).status, 200);
  assert.equal((await call('GET', '/api/walks?limit=-5')).status, 200);
  const bad = await call('POST', '/api/checkoff', { body: '{bad json' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json && bad.json.error, 'errors come back as JSON');
});

test('permissions cannot be forged with a body field', async () => {
  const r = await call('PUT', '/api/users/1/permissions', { body: { isPrivileged: true, canAudit: true, requestingUserId: 1 } });
  assert.equal(r.status, 403);
  const alumni = await call('PUT', '/api/dogs/1/alumni', { body: { alumni: true, bonusDays: 5, userId: 1 } });
  assert.equal(alumni.status, 403);
});

test('only staff can trigger a scrape', async () => {
  assert.equal((await call('POST', '/api/scrape/run')).status, 403);
});

test('walk lifecycle: start, block duplicates, cancel', async () => {
  const start = await call('POST', '/api/walks/start', { body: { dogId: 1, userId: 1 } });
  assert.equal(start.status, 200);
  const again = await call('POST', '/api/walks/start', { body: { dogId: 3, userId: 1 } });
  assert.equal(again.status, 409, 'one walk at a time per walker');
  const other = await call('POST', '/api/walks/start', { user: 'second@example.com', body: { dogId: 1, userId: 2 } });
  assert.equal(other.status, 409, 'a dog cannot be out with two people');
  assert.equal((await call('DELETE', `/api/walks/${start.json.walkId}`)).status, 200);
  assert.equal((await call('GET', '/api/walks/active?userId=1')).json.walk, null);
});

test('cannot walk a dog that is no longer listed', async () => {
  const r = await call('POST', '/api/walks/start', { body: { dogId: 2, userId: 1 } });
  assert.equal(r.status, 409);
});

test('a completed walk counts in stats; a cancelled one does not', async () => {
  const s = await call('POST', '/api/walks/start', { body: { dogId: 3, userId: 1 } });
  assert.equal((await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { notes: 'good boy' } })).status, 200);
  const stats = await call('GET', '/api/stats?userId=1');
  assert.equal(stats.json.totals.totalWalks, 1);
});

test('Guide: everyone reads, only editors write, images are validated', async () => {
  const list = await call('GET', '/api/wiki');
  assert.equal(list.status, 200);
  assert.ok(list.json.sections.length >= 5, 'demo sections are seeded');
  assert.equal(list.json.canEdit, false);
  assert.equal((await call('POST', '/api/wiki', { body: { title: 'x' } })).status, 403);

  const created = await call('POST', '/api/wiki', { staff: true, body: { title: 'Test', body: '# hi' } });
  assert.equal(created.status, 200);
  assert.equal((await call('PUT', `/api/wiki/${created.json.id}`, { staff: true, body: { title: 'Renamed', body: 'x' } })).status, 200);
  assert.equal((await call('PUT', `/api/wiki/${created.json.id}`, { staff: true, body: { title: '' } })).status, 400);
  assert.equal((await call('DELETE', `/api/wiki/${created.json.id}`, { staff: true })).status, 200);

  const notImage = await call('POST', '/api/wiki/images', { staff: true, headers: { 'content-type': 'image/png' }, body: Buffer.from('definitely not a picture') });
  assert.equal(notImage.status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const ok = await call('POST', '/api/wiki/images', { staff: true, headers: { 'content-type': 'image/png' }, body: png });
  assert.equal(ok.status, 200);
  const served = await fetch(base + ok.json.url);
  assert.equal(served.status, 200);
});

test('a brand-new walker does not start with a pile of unread updates', async () => {
  const db = new Database(dbFile);
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('new_dog', 1, 'old news', '2026-01-01T00:00:00.000Z')").run();
  db.close();
  await call('GET', '/api/me', { user: 'brandnew@example.com' });
  const me = await call('GET', '/api/me', { user: 'brandnew@example.com' });
  assert.equal((await call('GET', `/api/updates/unread-count?userId=${me.json.id}`)).json.count, 0);
});

test('walks stop automatically at 20 minutes, flagged, and can be extended before that', async () => {
  // (The database seeds two default walkers, so real ids come from /api/me, not from counting.)
  const idOf = async (email) => (await call('GET', '/api/me', { user: email })).json.id;
  const [walkerId, secondId, thirdId] = [await idOf('walker@example.com'), await idOf('second@example.com'), await idOf('third@example.com')];
  const db = new Database(dbFile);
  const now = Date.now();
  const insert = db.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (?, ?, ?)');
  const fresh = insert.run(1, walkerId, new Date(now - 5 * 60000).toISOString()).lastInsertRowid;      // 5 min in: still running
  const nearEnd = insert.run(3, secondId, new Date(now - 19 * 60000).toISOString()).lastInsertRowid;    // 19 min in: about to stop
  const overdue = insert.run(2, thirdId, new Date(now - 90 * 60000).toISOString()).lastInsertRowid;    // forgotten for 90 min
  db.close();
  // A request that touches walk state runs the limit check right away.
  const active = await call('GET', '/api/walks/active');
  assert.ok(active.json.walk, 'a 5 minute old walk is still running');
  assert.ok(active.json.walk.stopsAt, 'the response says when it will stop');

  const check = () => { const c = new Database(dbFile, { readonly: true }); const r = c.prepare('SELECT * FROM walks WHERE id IN (?, ?, ?)').all(fresh, nearEnd, overdue); c.close(); return Object.fromEntries(r.map((w) => [w.id, w])); };
  let rows = check();
  assert.equal(rows[fresh].ended_at, null);
  assert.ok(rows[overdue].ended_at, 'the forgotten walk was stopped');
  assert.equal(rows[overdue].auto_stopped, 1, 'and flagged as automatic');
  assert.equal(rows[overdue].duration_seconds, 1200, 'recorded as exactly the limit, not the 90 minutes it sat there');
  assert.equal(new Date(rows[overdue].ended_at).getTime() - new Date(rows[overdue].started_at).getTime(), 20 * 60000);

  // Extending: only the walker, only while running, and it pushes the deadline out.
  assert.equal((await call('POST', `/api/walks/${fresh}/extend`, { user: 'second@example.com' })).status, 403, 'not someone else\'s walk');
  const ext = await call('POST', `/api/walks/${fresh}/extend`);
  assert.equal(ext.status, 200);
  assert.equal(new Date(ext.json.stopsAt).getTime() - new Date(rows[fresh].started_at).getTime(), 30 * 60000);
  assert.equal((await call('POST', `/api/walks/${overdue}/extend`, { user: 'third@example.com' })).status, 409, 'too late to extend a stopped walk');

  // Ending an auto-stopped walk explains itself instead of failing mysteriously.
  const late = await call('PUT', `/api/walks/${overdue}/end`, { user: 'third@example.com', body: { notes: 'x' } });
  assert.equal(late.status, 409);
  assert.equal(late.json.autoStopped, true);

  // Extending is capped so a walk can't be extended forever.
  const c2 = new Database(dbFile);
  c2.prepare('UPDATE walks SET extend_minutes = 160 WHERE id = ?').run(fresh);
  c2.close();
  assert.equal((await call('POST', `/api/walks/${fresh}/extend`)).status, 409);
});

test('Profile: name is a single field', async () => {
  const user = 'profile.tester@example.com';
  assert.equal((await call('PUT', '/api/me', { user, body: { name: '' } })).status, 400, 'name is required');
  const saved = await call('PUT', '/api/me', { user, body: { name: 'Jamie Smith' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.name, 'Jamie Smith');
  const me = await call('GET', '/api/me', { user });
  assert.equal(me.json.name, 'Jamie Smith');
});

test('PB no longer overrides the days-in-shelter wait; PB-E grants it only until day 7', async () => {
  const established = 'established.walker@example.com';
  const beginner = 'beginner.walker@example.com';
  const estId = (await call('GET', '/api/me', { user: established })).json.id;
  const begId = (await call('GET', '/api/me', { user: beginner })).json.id;
  await call('PUT', `/api/users/${estId}/settings`, { user: established, body: { experienceLevel: 'established' } });
  await call('PUT', `/api/users/${begId}/settings`, { user: beginner, body: { experienceLevel: 'beginner' } });

  const db = new Database(dbFile);
  const today = new Date().toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const ins = db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, pb_flag, pb_early_flag)
    VALUES (?, ?, 'Male', '3 Years', ?, 1, ?, ?, ?, ?)
  `);
  ins.run(101, 'PbBrandNew', today, today, today, 1, 0); // PB, 0 days
  ins.run(102, 'PbSeasoned', twentyDaysAgo, twentyDaysAgo, twentyDaysAgo, 1, 0); // PB, 20 days
  ins.run(103, 'PbeInHold', today, today, today, 0, 1); // PB-E, 0 days (within the 7-day hold)
  ins.run(104, 'PbeExpired', tenDaysAgo, tenDaysAgo, tenDaysAgo, 0, 1); // PB-E, 10 days (past the hold)
  db.close();

  const dogAs = async (id, user) => (await call('GET', `/api/dogs/${id}`, { user })).json.dog;

  // PB (brand new, 0 days): no longer an automatic yes for established --
  // it still has to clear the normal day threshold like anything else.
  const pbNewEst = await dogAs(101, established);
  assert.equal(pbNewEst.eligible, false);
  assert.equal(pbNewEst.notEligibleReason, 'days', 'PB does not excuse the wait any more');
  const pbNewBeg = await dogAs(101, beginner);
  assert.equal(pbNewBeg.eligible, false);
  assert.equal(pbNewBeg.notEligibleReason, 'pb_restricted', 'beginners still are not trusted with PB dogs at all');

  // PB (seasoned, 20 days): eligible for established the ordinary way; the
  // PB flag itself grants nothing here, it's just informational.
  const pbOldEst = await dogAs(102, established);
  assert.equal(pbOldEst.eligible, true);

  // PB-E, still within the 7-day hold: grants early eligibility for
  // established, but never for a level that isn't trusted with PB at all.
  const pbeHoldEst = await dogAs(103, established);
  assert.equal(pbeHoldEst.eligible, true);
  assert.equal(pbeHoldEst.pbEarlyExpired, false);
  const pbeHoldBeg = await dogAs(103, beginner);
  assert.equal(pbeHoldBeg.eligible, false);
  assert.equal(pbeHoldBeg.notEligibleReason, 'pb_restricted');
  assert.equal(pbeHoldBeg.pbEarlyExpired, false, 'expiry is about the dog, not the viewer');

  // PB-E, past day 7: the exception has nothing left to grant -- eligibility
  // reverts to the ordinary day-threshold rule for everyone, and the flag
  // reads as expired regardless of who's looking.
  const pbeExpiredEst = await dogAs(104, established);
  assert.equal(pbeExpiredEst.eligible, true, '10 days clears the established 7-day bar on its own now');
  assert.equal(pbeExpiredEst.pbEarlyExpired, true);
  const pbeExpiredBeg = await dogAs(104, beginner);
  assert.equal(pbeExpiredBeg.eligible, false);
  assert.equal(pbeExpiredBeg.notEligibleReason, 'days', 'not pb_restricted -- the early exception no longer applies past day 7');
  assert.equal(pbeExpiredBeg.pbEarlyExpired, true);
});

test('the markers endpoint saves and returns pbEarlyFlag alongside the rest', async () => {
  const r = await call('PUT', '/api/dogs/101/markers', { body: { blueMarkers: [], pooStatus: 'none', starFlag: false, pbFlag: false, pbEarlyFlag: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.pbEarlyFlag, true);
  const db = new Database(dbFile, { readonly: true });
  assert.equal(db.prepare('SELECT pb_early_flag FROM dogs WHERE shelter_buddy_id = 101').get().pb_early_flag, 1);
  db.close();
});
