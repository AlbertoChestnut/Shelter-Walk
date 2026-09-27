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
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: 'ignore' });
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

test('walks stop automatically at 30 minutes, flagged, and can be extended before that', async () => {
  // (The database seeds two default walkers, so real ids come from /api/me, not from counting.)
  const idOf = async (email) => (await call('GET', '/api/me', { user: email })).json.id;
  const [walkerId, secondId, thirdId] = [await idOf('walker@example.com'), await idOf('second@example.com'), await idOf('third@example.com')];
  const db = new Database(dbFile);
  const now = Date.now();
  const insert = db.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (?, ?, ?)');
  const fresh = insert.run(1, walkerId, new Date(now - 5 * 60000).toISOString()).lastInsertRowid;      // 5 min in: still running
  const nearEnd = insert.run(3, secondId, new Date(now - 29 * 60000).toISOString()).lastInsertRowid;    // 29 min in: about to stop
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
  assert.equal(rows[overdue].duration_seconds, 1800, 'recorded as exactly the limit, not the 90 minutes it sat there');
  assert.equal(new Date(rows[overdue].ended_at).getTime() - new Date(rows[overdue].started_at).getTime(), 30 * 60000);

  // Extending: only the walker, only while running, and it pushes the deadline out.
  assert.equal((await call('POST', `/api/walks/${fresh}/extend`, { user: 'second@example.com' })).status, 403, 'not someone else\'s walk');
  const ext = await call('POST', `/api/walks/${fresh}/extend`);
  assert.equal(ext.status, 200);
  assert.equal(new Date(ext.json.stopsAt).getTime() - new Date(rows[fresh].started_at).getTime(), 40 * 60000);
  assert.equal((await call('POST', `/api/walks/${overdue}/extend`, { user: 'third@example.com' })).status, 409, 'too late to extend a stopped walk');

  // The walker wraps up a stopped walk once (no end time given keeps the
  // time-limit end); after that, ending it again explains itself.
  const late = await call('PUT', `/api/walks/${overdue}/end`, { user: 'third@example.com', body: { notes: 'x' } });
  assert.equal(late.status, 200);
  assert.equal(late.json.autoStopped, true);
  assert.equal(late.json.durationSeconds, 1800);
  assert.equal(late.json.edited, false);
  const again = await call('PUT', `/api/walks/${overdue}/end`, { user: 'third@example.com', body: { notes: 'x' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.autoStopped, true);

  // Extending is capped so a walk can't be extended forever.
  const c2 = new Database(dbFile);
  c2.prepare('UPDATE walks SET extend_minutes = 160 WHERE id = ?').run(fresh);
  c2.close();
  assert.equal((await call('POST', `/api/walks/${fresh}/extend`)).status, 409);
});

test('ending a walk by hand uses the moment End Walk was tapped', async () => {
  const user = 'ender@example.com';
  const userId = (await call('GET', '/api/me', { user })).json.id;
  const now = Date.now();
  const read = (id) => { const c = new Database(dbFile, { readonly: true }); const r = c.prepare('SELECT * FROM walks WHERE id = ?').get(id); c.close(); return r; };
  const insertWalk = (minutesAgo) => { const c = new Database(dbFile); const id = c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)').run(userId, new Date(now - minutesAgo * 60000).toISOString()).lastInsertRowid; c.close(); return id; };
  const end = (id, body) => call('PUT', `/api/walks/${id}/end`, { user, body });

  const w = insertWalk(25);
  assert.equal((await end(w, { endTappedAt: new Date(now + 10 * 60000).toISOString() })).status, 400, 'not in the future');
  assert.equal((await end(w, { endTappedAt: 'soon' })).status, 400, 'not garbage');
  const tappedAt = new Date(now - 60000).toISOString();
  const r = await end(w, { notes: 'x', endTappedAt: tappedAt, endedAt: new Date(now - 20 * 60000).toISOString() });
  assert.equal(r.status, 200);
  assert.equal(r.json.endedAt, tappedAt, 'a walk ended by hand has no end-time choice');
  assert.equal(r.json.durationSeconds, 24 * 60);
  assert.equal(read(w).edited, 0);

  // End was tapped before the limit, but it ran out while notes were typed:
  // ended by hand at the tapped time, not flagged as auto-stopped.
  const slow = insertWalk(31);
  await call('GET', '/api/walks/active', { user });
  assert.equal(read(slow).auto_stopped, 1);
  const slowTapped = new Date(now - 2 * 60000).toISOString();
  assert.equal((await end(slow, { notes: 'typed slowly', endTappedAt: slowTapped })).status, 200);
  assert.equal(read(slow).auto_stopped, 0);
  assert.equal(read(slow).ended_at, slowTapped);
  assert.equal(read(slow).wrap_up_pending, 0);
});

test('a walk the time limit stopped asks when it really ended', async () => {
  const user = 'wrapper@example.com';
  const userId = (await call('GET', '/api/me', { user })).json.id;
  const now = Date.now();
  const read = (id) => { const c = new Database(dbFile, { readonly: true }); const r = c.prepare('SELECT * FROM walks WHERE id = ?').get(id); c.close(); return r; };
  const insertWalk = (minutesAgo) => { const c = new Database(dbFile); const id = c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)').run(userId, new Date(now - minutesAgo * 60000).toISOString()).lastInsertRowid; c.close(); return id; };
  const end = (id, body) => call('PUT', `/api/walks/${id}/end`, { user, body });

  // Stopped while the app was closed: opening it again offers the end screen.
  const w = insertWalk(50);
  const active = await call('GET', '/api/walks/active', { user });
  assert.equal(active.json.walk, null);
  assert.equal(active.json.wrapUp && active.json.wrapUp.id, w);
  const limitEnd = read(w).ended_at;

  assert.equal((await end(w, { endedAt: new Date(now + 10 * 60000).toISOString() })).status, 400, 'not in the future');
  assert.equal((await end(w, { endedAt: new Date(now - 60 * 60000).toISOString() })).status, 400, 'not before the start');
  // "Just now": past the time limit is fine, it's what really happened.
  const r = await end(w, { notes: 'lost track of time', endedAt: new Date(now).toISOString() });
  assert.equal(r.status, 200);
  assert.equal(r.json.durationSeconds, 50 * 60);
  const row = read(w);
  assert.equal(row.auto_stopped, 1, 'still shows it hit the limit');
  assert.equal(row.edited, 1);
  assert.equal(row.original_ended_at, limitEnd, 'the time-limit end is kept as the original');
  assert.equal(row.wrap_up_pending, 0);
  assert.equal((await call('GET', '/api/walks/active', { user })).json.wrapUp, null, 'asked only once');

  // No walk runs past the 3 hour maximum.
  const long = insertWalk(200);
  await call('GET', '/api/walks/active', { user });
  assert.equal((await end(long, { endedAt: new Date(now).toISOString() })).status, 400);

  // Starting the next walk moves on: the stopped one keeps its time-limit end.
  assert.equal((await call('GET', '/api/walks/active', { user })).json.wrapUp.id, long);
  const c = new Database(dbFile);
  const stamp = new Date().toISOString();
  c.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (40, 'NextDog', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(stamp, stamp);
  c.close();
  const next = await call('POST', '/api/walks/start', { user, body: { dogId: 40, userId } });
  assert.equal(next.status, 200);
  assert.equal(read(long).wrap_up_pending, 0);
  await call('DELETE', `/api/walks/${next.json.walkId}`, { user });

  // Fixing times later in Stats can't put the end in the future either.
  assert.equal((await call('PUT', `/api/walks/${w}`, { user, body: { endedAt: new Date(now + 60 * 60000).toISOString() } })).status, 400);
});

test('walk length alerts: up to 3, saved per walker, each sent once and never stale', async () => {
  const user = 'alerts@example.com';
  const userId = (await call('GET', '/api/me', { user })).json.id;
  const put = (minutes) => call('PUT', `/api/users/${userId}/walk-alerts`, { user, body: { minutes } });
  assert.deepEqual((await call('GET', `/api/users/${userId}/walk-alerts`, { user })).json.minutes, [], 'none by default');
  assert.equal((await put([1, 2, 3, 4])).status, 400, 'no more than 3');
  assert.equal((await put([0])).status, 400);
  assert.equal((await put([180])).status, 400, 'shorter than the longest walk');
  assert.equal((await put([7.5])).status, 400, 'whole minutes');
  assert.equal((await put('7')).status, 400);
  assert.deepEqual((await put([10, 7, 10])).json.minutes, [7, 10], 'sorted, duplicates dropped');
  assert.deepEqual((await call('GET', `/api/users/${userId}/walk-alerts`, { user })).json.minutes, [7, 10]);
  assert.equal((await call('GET', `/api/users/${userId}/walk-alerts`, { user: 'walker@example.com' })).status, 403, 'not someone else\'s');
  assert.equal((await call('PUT', `/api/users/${userId}/walk-alerts`, { user: 'walker@example.com', body: { minutes: [1] } })).status, 403);

  const now = Date.now();
  const c = new Database(dbFile);
  const insert = c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (1, ?, ?)');
  const justPast7 = insert.run(userId, new Date(now - (7 * 60 + 20) * 1000).toISOString()).lastInsertRowid;
  const past10Late = insert.run(userId, new Date(now - 14 * 60000).toISOString()).lastInsertRowid;
  c.close();
  await call('GET', '/api/walks/active', { user }); // runs the sweep
  const read = (id) => { const r = new Database(dbFile, { readonly: true }); const row = r.prepare('SELECT alerted_minutes FROM walks WHERE id = ?').get(id); r.close(); return row.alerted_minutes; };
  assert.equal(read(justPast7), 7, 'the 7 minute alert went out');
  assert.equal(read(past10Late), 10, 'only the latest due alert counts; 10 min is 4 minutes stale so it is skipped, not resent');
  const d = new Database(dbFile);
  d.prepare('DELETE FROM walks WHERE id IN (?, ?)').run(justPast7, past10Late);
  d.close();
  assert.deepEqual((await put([])).json.minutes, [], 'can be cleared');
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

test('PB clears the days-in-shelter wait, but only for levels allowed PB dogs', async () => {
  const established = 'established.walker@example.com';
  const beginner = 'beginner.walker@example.com';
  const estId = (await call('GET', '/api/me', { user: established })).json.id;
  const begId = (await call('GET', '/api/me', { user: beginner })).json.id;
  await call('PUT', `/api/users/${estId}/settings`, { user: established, body: { experienceLevel: 'established' } });
  await call('PUT', `/api/users/${begId}/settings`, { user: beginner, body: { experienceLevel: 'beginner' } });

  const db = new Database(dbFile);
  const today = new Date().toISOString();
  const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const ins = db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, pb_flag)
    VALUES (?, ?, 'Male', '3 Years', ?, 1, ?, ?, ?)
  `);
  ins.run(101, 'PbBrandNew', today, today, today, 1); // PB, 0 days
  ins.run(102, 'PbSeasoned', twentyDaysAgo, twentyDaysAgo, twentyDaysAgo, 1); // PB, 20 days
  ins.run(103, 'PlainBrandNew', today, today, today, 0); // no PB, 0 days
  db.close();

  const dogAs = async (id, user) => (await call('GET', `/api/dogs/${id}`, { user })).json.dog;

  // PB (brand new, 0 days): cleared for established even inside the wait.
  const pbNewEst = await dogAs(101, established);
  assert.equal(pbNewEst.eligible, true, 'PB excuses the days-in-shelter wait');
  assert.equal(pbNewEst.notEligibleReason, null);
  const pbNewBeg = await dogAs(101, beginner);
  assert.equal(pbNewBeg.eligible, false);
  assert.equal(pbNewBeg.notEligibleReason, 'pb_restricted', 'beginners are not trusted with PB dogs at all');

  // PB (seasoned, 20 days): still off-limits to beginners, whatever the days.
  assert.equal((await dogAs(102, established)).eligible, true);
  assert.equal((await dogAs(102, beginner)).notEligibleReason, 'pb_restricted');

  // No PB, 0 days: the ordinary day threshold applies.
  const plainEst = await dogAs(103, established);
  assert.equal(plainEst.eligible, false);
  assert.equal(plainEst.notEligibleReason, 'days');

  // PB-E is gone: no leftover fields on the dog.
  assert.equal('pbEarlyFlag' in pbNewEst, false);
  assert.equal('pbEarlyExpired' in pbNewEst, false);
});

test('the markers endpoint saves pbFlag and ignores the retired pbEarlyFlag', async () => {
  const r = await call('PUT', '/api/dogs/103/markers', { body: { blueMarkers: [], pooStatus: 'none', starFlag: false, pbFlag: true, pbEarlyFlag: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.pbFlag, true);
  assert.equal('pbEarlyFlag' in r.json, false);
  const db = new Database(dbFile, { readonly: true });
  const row = db.prepare('SELECT pb_flag, pb_early_flag FROM dogs WHERE shelter_buddy_id = 103').get();
  assert.equal(row.pb_flag, 1);
  assert.equal(row.pb_early_flag, 0);
  db.close();
});

test('kennel locations are just the wing letter, and many dogs can share one', async () => {
  const put = (id, location) => call('PUT', `/api/dogs/${id}/location`, { body: { location } });
  const a = await put(101, 'b17');
  assert.equal(a.status, 200);
  assert.equal(a.json.location, 'B', 'a full code comes down to its letter');
  assert.equal('bumpedDog' in a.json, false);
  assert.equal((await put(102, 'B')).json.location, 'B');
  assert.equal((await put(103, 'Da12')).json.location, 'A', 'the kennel-card leading-D quirk');
  assert.equal((await put(101, 'Z')).status, 400);
  assert.equal((await put(101, '')).status, 400);
  const db = new Database(dbFile, { readonly: true });
  const rows = db.prepare('SELECT shelter_buddy_id id, kennel_location loc FROM dogs WHERE shelter_buddy_id IN (101, 102, 103) ORDER BY id').all();
  db.close();
  assert.deepEqual(rows.map((r) => r.loc), ['B', 'B', 'A'], 'setting B on 102 did not clear it from 101');
  assert.equal((await call('GET', '/api/dogs/by-location/B')).status, 404, 'the old one-dog-per-spot lookup is gone');
});

test('finishing a fully scanned wing clears only the unscanned dogs in it', async () => {
  // After the previous test: 101 and 102 are in B, 103 is in A.
  const auditor = 'auditor.walker@example.com';
  const url = '/api/audit/clear-unscanned';
  assert.equal((await call('POST', url, { user: auditor, body: { letter: 'B', scannedIds: [101] } })).status, 403, 'needs audit access');

  const preview = await call('POST', url, { staff: true, body: { letter: 'B', scannedIds: [101], dryRun: true } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.cleared.map((d) => d.id), [102]);
  const db = new Database(dbFile, { readonly: true });
  const loc = (id) => db.prepare('SELECT kennel_location l FROM dogs WHERE shelter_buddy_id = ?').get(id).l;
  assert.equal(loc(102), 'B', 'a dry run changes nothing');

  assert.equal((await call('POST', url, { staff: true, body: { letter: 'B', scannedIds: [] } })).status, 400, 'refuses with nothing scanned');
  assert.equal((await call('POST', url, { staff: true, body: { letter: 'B12', scannedIds: [101] } })).status, 400);

  const done = await call('POST', url, { staff: true, body: { letter: 'B', scannedIds: [101] } });
  assert.deepEqual(done.json.cleared.map((d) => d.id), [102]);
  assert.equal(loc(101), 'B', 'the scanned dog keeps its letter');
  assert.equal(loc(102), null, 'the unscanned one is cleared');
  assert.equal(loc(103), 'A', 'other wings are untouched');
  db.close();

  const put = await call('PUT', '/api/dogs/102/location', { body: { location: 'C' } });
  assert.equal(put.json.name, 'PbSeasoned', 'saving a letter returns the name for the scan list');
});

test('cuddle and matchmaking are timed like walks, switchable mid-session, and editable', async () => {
  const user = 'cuddler@example.com';
  await call('GET', '/api/me', { user });
  const seed = new Database(dbFile);
  const ts = new Date().toISOString();
  seed.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (60, 'Snuggles', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
  seed.close();
  assert.equal((await call('POST', '/api/walks/start', { user, body: { dogId: 60, userId: 1, activity: 'nap' } })).status, 400, 'unknown activity');
  const s = await call('POST', '/api/walks/start', { user, body: { dogId: 60, userId: 1, activity: 'cuddle' } });
  assert.equal(s.status, 200);
  const id = s.json.walkId;
  assert.equal((await call('GET', '/api/walks/active', { user })).json.walk.activity, 'cuddle');
  const out = await call('GET', '/api/dogs/60');
  assert.equal(out.json.dog.currentWalk.activity, 'cuddle', 'the "currently out" badge knows the activity');

  // Switch mid-session: same walk, same start time.
  const sw = await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'matchmaking' } });
  assert.equal(sw.status, 200);
  assert.equal(sw.json.endedAt, null, 'switching does not end it');
  assert.equal(sw.json.edited, false, 'switching is not a time edit');
  assert.equal((await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'nap' } })).status, 400);
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user, body: {} })).status, 200);

  const mine = (await call('GET', '/api/walks', { user })).json.walks.find((w) => w.id === id);
  assert.equal(mine.activity, 'matchmaking');
  const history = await call('GET', '/api/dogs/60/walk-history', { user });
  assert.equal(history.json.walks.find((w) => w.mine).activity, 'matchmaking');
  const stats = await call('GET', '/api/stats', { user });
  assert.equal(stats.json.totals.totalWalks, 1, 'counts exactly like a walk');

  // The dog's profile shows each person only their own walks with it.
  const mineDog = (await call('GET', '/api/dogs/60', { user })).json.dog;
  assert.equal(mineDog.myWalkCount, 1);
  assert.ok(mineDog.myLastWalkedAt);
  const otherDog = (await call('GET', '/api/dogs/60', { user: 'nobody-walked@example.com' })).json.dog;
  assert.equal(otherDog.myWalkCount, 0, 'someone else\'s walks don\'t count as yours');
  assert.equal(otherDog.myLastWalkedAt, null);
  assert.equal(otherDog.walkCount, 1, 'the shelter-wide count is still there');

  // Editing afterwards can change it back.
  assert.equal((await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'walk' } })).json.activity, 'walk');

  // Hand-logged sessions take an activity too, defaulting to a walk.
  const now = Date.now();
  const manual = await call('POST', '/api/walks/manual', { user, body: { dogId: 60, userId: 1, activity: 'cuddle', startedAt: new Date(now - 3600000).toISOString(), endedAt: new Date(now - 3000000).toISOString() } });
  assert.equal(manual.status, 200);
  const plain = await call('POST', '/api/walks/manual', { user, body: { dogId: 60, userId: 1, startedAt: new Date(now - 7200000).toISOString(), endedAt: new Date(now - 6600000).toISOString() } });
  const all = (await call('GET', '/api/walks', { user })).json.walks;
  assert.equal(all.find((w) => w.id === manual.json.id).activity, 'cuddle');
  assert.equal(all.find((w) => w.id === plain.json.id).activity, 'walk');
});

test('the usual activity is saved in Settings and play group is an activity', async () => {
  const user = 'usual@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  assert.equal(me.defaultActivity, 'walk', 'walk until changed');
  assert.equal((await call('PUT', `/api/users/${me.id}/settings`, { user, body: { defaultActivity: 'dance' } })).status, 400);
  const saved = await call('PUT', `/api/users/${me.id}/settings`, { user, body: { defaultActivity: 'playgroup' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.defaultActivity, 'playgroup');
  assert.equal((await call('GET', '/api/me', { user })).json.defaultActivity, 'playgroup');
  // Saving the experience level alone (onboarding) leaves it alone, and vice versa.
  const level = await call('PUT', `/api/users/${me.id}/settings`, { user, body: { experienceLevel: 'expert' } });
  assert.equal(level.json.defaultActivity, 'playgroup');
  assert.equal(level.json.experienceLevel, 'expert');
  assert.equal((await call('PUT', `/api/users/${me.id}/settings`, { user, body: { defaultActivity: 'cuddle' } })).json.experienceLevel, 'expert');
  assert.equal((await call('PUT', `/api/users/${me.id}/settings`, { user, body: {} })).status, 400);
  assert.equal((await call('PUT', `/api/users/${me.id}/settings`, { body: { defaultActivity: 'walk' } })).status, 403, 'not someone else\'s');

  const seed = new Database(dbFile);
  const ts = new Date().toISOString();
  seed.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (61, 'Fetch', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
  seed.close();
  const s = await call('POST', '/api/walks/start', { user, body: { dogId: 61, userId: me.id, activity: 'playgroup' } });
  assert.equal(s.status, 200);
  assert.equal((await call('GET', '/api/walks/active', { user })).json.walk.activity, 'playgroup');
  assert.equal((await call('DELETE', `/api/walks/${s.json.walkId}`, { user })).status, 200);
});
