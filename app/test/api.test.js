// End-to-end API tests: boots the real server against a throwaway DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer: bootServer, tempDirs } = require('./_helpers');

const { dir, dbFile } = tempDirs('sw-api-');
let base;
let server;

const as = (email, staff) => ({ 'content-type': 'application/json', 'x-auth-email': email, ...(staff ? { 'x-auth-staff': '1' } : {}) });
async function call(method, url, { user = 'walker@example.com', staff = false, body, headers } = {}) {
  const res = await fetch(base + url, { method, headers: { ...as(user, staff), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}
// Restarts reuse the same DB; the port (and so `base`) changes each time.
async function startServer() {
  server = await bootServer({ dir, dbFile });
  base = server.base;
}
async function stopServer() { if (server) { await server.stop(); server = null; } }

test.before(async () => {
  await startServer();
  await call('GET', '/api/me'); // creates the schema + first walker
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?)");
  ins.run(1, 'Listed', 1, now, now);
  ins.run(2, 'Gone', 0, now, now);
  ins.run(3, 'Other', 1, now, now);
  // Own dogs for the tests that insert open walks directly: the database
  // allows only one open walk per dog (and per walker).
  ins.run(43, 'Ender', 1, now, now);
  ins.run(44, 'Wrapper', 1, now, now);
  ins.run(45, 'Alerts', 1, now, now);
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

test('a dog no longer listed (e.g. just returned) can still be walked', async () => {
  const r = await call('POST', '/api/walks/start', { body: { dogId: 2, userId: 1 } });
  assert.equal(r.status, 200);
  const dog = await call('GET', '/api/dogs/2?userId=1');
  assert.equal(dog.json.dog.stillListed, false, 'the app can show the not-on-the-site heads-up');
  assert.equal((await call('DELETE', `/api/walks/${r.json.walkId}`)).status, 200);
});

test('a completed walk counts in stats; a cancelled one does not', async () => {
  const s = await call('POST', '/api/walks/start', { body: { dogId: 3, userId: 1 } });
  assert.equal((await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { notes: 'good boy' } })).status, 200);
  const stats = await call('GET', '/api/stats?userId=1');
  assert.equal(stats.json.totals.totalWalks, 1);
});

test('stats break down by activity, and the average length is walk-only', async () => {
  // A dedicated walker, so earlier tests' walks for the default user don't
  // skew the exact averages this test checks.
  const user = 'activitystats@example.com';
  const userId = (await call('GET', '/api/me', { user })).json.id;
  const now = Date.now();
  // A short cuddle and a much longer walk -- averaging across both would be
  // meaningless, so the average tile must come out exactly as long as the walk.
  const cuddle = await call('POST', '/api/walks/manual', { user, body: {
    dogId: 1, userId, activity: 'cuddle',
    startedAt: new Date(now - 20 * 60000).toISOString(), endedAt: new Date(now - 10 * 60000).toISOString()
  } });
  assert.equal(cuddle.status, 200);
  const walk = await call('POST', '/api/walks/manual', { user, body: {
    dogId: 2, userId,
    startedAt: new Date(now - 90 * 60000).toISOString(), endedAt: new Date(now - 60 * 60000).toISOString()
  } });
  assert.equal(walk.status, 200);

  const stats = await call('GET', `/api/stats?userId=${userId}`, { user });
  assert.equal(stats.status, 200);
  assert.equal(stats.json.totals.avgSeconds, 1800, 'avg length ignores the cuddle entirely');
  const byCuddle = stats.json.byActivity.find((a) => a.activity === 'cuddle');
  const byWalk = stats.json.byActivity.find((a) => a.activity === 'walk');
  assert.equal(byCuddle.count, 1);
  assert.equal(byCuddle.totalSeconds, 600);
  assert.equal(byWalk.count, 1);
  assert.equal(byWalk.totalSeconds, 1800);

  // The by-dog list can be filtered down to just one activity, for the "By
  // Activity" drill-down -- only the cuddle's dog shows up, not the walk's.
  const cuddleOnly = await call('GET', `/api/stats?userId=${userId}&activity=cuddle`, { user });
  assert.equal(cuddleOnly.status, 200);
  assert.ok(cuddleOnly.json.perDog.every((d) => d.id !== 2), "the walk's dog is excluded");
  assert.equal(cuddleOnly.json.totals.totalWalks, byCuddle.count);

  // An unknown activity is just ignored as a filter, not an error.
  assert.equal((await call('GET', `/api/stats?userId=${userId}&activity=nap`, { user })).status, 200);
});

test('a note left at the end of a play group session is tagged "playgroup", not folded into "walk"', async () => {
  const user = 'pgnotes@example.com';
  const userId = (await call('GET', '/api/me', { user })).json.id;
  const now = Date.now();
  // A dog of its own: manual entries can't overlap another walk of the same dog.
  const dogId = 46;
  const seed = new Database(dbFile);
  const ts = new Date().toISOString();
  seed.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, 'Grouper', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(dogId, ts, ts);
  seed.close();
  const pg = await call('POST', '/api/walks/manual', { user, body: {
    dogId, userId, activity: 'playgroup', notes: 'Did great with the group',
    startedAt: new Date(now - 30 * 60000).toISOString(), endedAt: new Date(now - 10 * 60000).toISOString()
  } });
  assert.equal(pg.status, 200);
  const walk = await call('POST', '/api/walks/manual', { user, body: {
    dogId, userId, notes: 'Pulled on leash a bit',
    startedAt: new Date(now - 90 * 60000).toISOString(), endedAt: new Date(now - 60 * 60000).toISOString()
  } });
  assert.equal(walk.status, 200);

  const mine = (await call('GET', '/api/notes?scope=mine', { user })).json.dogs.flatMap((g) => g.notes);
  assert.ok(mine.some((n) => n.kind === 'playgroup' && n.body === 'Did great with the group'));
  assert.ok(mine.some((n) => n.kind === 'walk' && n.body === 'Pulled on leash a bit'));

  const all = (await call('GET', '/api/notes', { user })).json.dogs.flatMap((g) => g.notes);
  assert.ok(all.some((n) => n.kind === 'playgroup' && n.body === 'Did great with the group'));
});

test('Guide: everyone reads, only editors write, images are validated', async () => {
  const list = await call('GET', '/api/wiki');
  assert.equal(list.status, 200);
  assert.ok(list.json.sections.length >= 1, 'starter sections are seeded');
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

test('walks stop automatically at 45 minutes, flagged, and can be extended before that', async () => {
  // (The database seeds two default walkers, so real ids come from /api/me, not from counting.)
  const idOf = async (email) => (await call('GET', '/api/me', { user: email })).json.id;
  const [walkerId, secondId, thirdId] = [await idOf('walker@example.com'), await idOf('second@example.com'), await idOf('third@example.com')];
  const db = new Database(dbFile);
  const now = Date.now();
  const insert = db.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (?, ?, ?)');
  const fresh = insert.run(1, walkerId, new Date(now - 5 * 60000).toISOString()).lastInsertRowid;      // 5 min in: still running
  const nearEnd = insert.run(3, secondId, new Date(now - 44 * 60000).toISOString()).lastInsertRowid;    // 44 min in: about to stop
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
  assert.equal(rows[overdue].duration_seconds, 2700, 'recorded as exactly the limit, not the 90 minutes it sat there');
  assert.equal(new Date(rows[overdue].ended_at).getTime() - new Date(rows[overdue].started_at).getTime(), 45 * 60000);

  // Extending: only the walker, only while running, and it pushes the deadline out.
  assert.equal((await call('POST', `/api/walks/${fresh}/extend`, { user: 'second@example.com' })).status, 403, 'not someone else\'s walk');
  const ext = await call('POST', `/api/walks/${fresh}/extend`);
  assert.equal(ext.status, 200);
  assert.equal(new Date(ext.json.stopsAt).getTime() - new Date(rows[fresh].started_at).getTime(), 55 * 60000);
  assert.equal((await call('POST', `/api/walks/${overdue}/extend`, { user: 'third@example.com' })).status, 409, 'too late to extend a stopped walk');

  // The walker wraps up a stopped walk once (no end time given keeps the
  // time-limit end); after that, ending it again explains itself.
  const late = await call('PUT', `/api/walks/${overdue}/end`, { user: 'third@example.com', body: { notes: 'x' } });
  assert.equal(late.status, 200);
  assert.equal(late.json.autoStopped, true);
  assert.equal(late.json.durationSeconds, 2700);
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
  const insertWalk = (minutesAgo) => { const c = new Database(dbFile); const id = c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (43, ?, ?)').run(userId, new Date(now - minutesAgo * 60000).toISOString()).lastInsertRowid; c.close(); return id; };
  const end = (id, body) => call('PUT', `/api/walks/${id}/end`, { user, body });

  // Round 4: a tap "in the future" on an open walk is a fast phone clock:
  // it ends now (server time) instead of being refused.
  const fast = insertWalk(30);
  const fastEnd = await end(fast, { endTappedAt: new Date(now + 10 * 60000).toISOString() });
  assert.equal(fastEnd.status, 200, 'a fast clock still ends the walk');
  assert.ok(Math.abs(new Date(fastEnd.json.endedAt) - Date.now()) < 5000, 'at the server\'s now');
  const w = insertWalk(25);
  assert.equal((await end(w, { endTappedAt: 'soon' })).status, 400, 'not garbage');
  const tappedAt = new Date(now - 60000).toISOString();
  const r = await end(w, { notes: 'x', endTappedAt: tappedAt, endedAt: new Date(now - 20 * 60000).toISOString() });
  assert.equal(r.status, 200);
  assert.equal(r.json.endedAt, tappedAt, 'a walk ended by hand has no end-time choice');
  assert.equal(r.json.durationSeconds, 24 * 60);
  assert.equal(read(w).edited, 0);

  // End was tapped before the limit, but it ran out while notes were typed:
  // ended by hand at the tapped time, not flagged as auto-stopped.
  const slow = insertWalk(46);
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
  const insertWalk = (minutesAgo) => { const c = new Database(dbFile); const id = c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (44, ?, ?)').run(userId, new Date(now - minutesAgo * 60000).toISOString()).lastInsertRowid; c.close(); return id; };
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
  // One open walk at a time per walker (and per dog), so the two cases run
  // one after the other.
  const insertOpen = (startedAt) => { const c = new Database(dbFile); const id = c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (45, ?, ?)').run(userId, startedAt).lastInsertRowid; c.close(); return id; };
  const remove = (id) => { const d = new Database(dbFile); d.prepare('DELETE FROM walks WHERE id = ?').run(id); d.close(); };
  const read = (id) => { const r = new Database(dbFile, { readonly: true }); const row = r.prepare('SELECT alerted_minutes FROM walks WHERE id = ?').get(id); r.close(); return row.alerted_minutes; };
  const justPast7 = insertOpen(new Date(now - (7 * 60 + 20) * 1000).toISOString());
  await call('GET', '/api/walks/active', { user }); // runs the sweep
  assert.equal(read(justPast7), 7, 'the 7 minute alert went out');
  remove(justPast7);
  const past10Late = insertOpen(new Date(now - 14 * 60000).toISOString());
  await call('GET', '/api/walks/active', { user });
  assert.equal(read(past10Late), 10, 'only the latest due alert counts; 10 min is 4 minutes stale so it is skipped, not resent');
  remove(past10Late);
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

test('a dog not cleared for this level cannot be walked at all -- a hard rule enforced server-side, not just a UI nag', async () => {
  const established = 'established.walker@example.com';
  const beginner = 'beginner.walker@example.com';
  const estId = (await call('GET', '/api/me', { user: established })).json.id;
  const begId = (await call('GET', '/api/me', { user: beginner })).json.id;

  // 103 "PlainBrandNew" (from the test above): 0 days, no PB -- not
  // eligible for anyone yet ('days'), and the walk is refused outright.
  const blocked = await call('POST', '/api/walks/start', { user: established, body: { dogId: 103, userId: estId } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.notEligibleReason, 'days');

  // Marking PB clears the days wait for a level that allows PB dogs, and
  // /api/walks/start reads the dog's current row, so this takes effect
  // immediately -- a change that allows a walk is checked with its own
  // effect already in place, not against the state from before it.
  const marked = await call('PUT', '/api/dogs/103/markers', { user: established, body: { blueMarkers: [], pooStatus: 'none', starFlag: false, pbFlag: true } });
  assert.equal(marked.status, 200);
  const allowed = await call('POST', '/api/walks/start', { user: established, body: { dogId: 103, userId: estId } });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
  assert.equal((await call('DELETE', `/api/walks/${allowed.json.walkId}`, { user: established })).status, 200);

  // But a beginner still can't walk a PB dog at all, even now that it's PB.
  const stillBlocked = await call('POST', '/api/walks/start', { user: beginner, body: { dogId: 103, userId: begId } });
  assert.equal(stillBlocked.status, 403);
  assert.equal(stillBlocked.json.notEligibleReason, 'pb_restricted');
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

test('each sticker that actually changes gets its own timeline event, and the timeline can show or hide them', async () => {
  const now = new Date().toISOString();
  const seed = new Database(dbFile);
  seed.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at)
    VALUES (104, 'Sticky', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)
  `).run(now, now);
  seed.close();

  // Turning on the star and PB in one request logs two events, not one.
  const on = await call('PUT', '/api/dogs/104/markers', { body: { blueMarkers: [], pooStatus: 'none', starFlag: true, pbFlag: true } });
  assert.equal(on.status, 200);
  // Sending the exact same state again is a no-op: nothing changed, nothing logged.
  await call('PUT', '/api/dogs/104/markers', { body: { blueMarkers: [], pooStatus: 'none', starFlag: true, pbFlag: true } });
  const db = new Database(dbFile, { readonly: true });
  const stickerEvents = db.prepare("SELECT kind, title, detail FROM shelter_events WHERE dog_id = 104 AND kind LIKE 'sticker_%' ORDER BY id").all();
  assert.equal(stickerEvents.length, 2, 'one event each for star and pb, nothing for the repeat no-op call');
  assert.deepEqual(stickerEvents.map((e) => e.detail).sort(), ['pb', 'star']);
  assert.ok(stickerEvents.every((e) => e.kind === 'sticker_on'));
  db.close();

  // Turning PB back off the same day cancels out with the earlier "on" --
  // the timeline should show neither. The star stayed on all day, so its
  // lone "on" event still shows when stickers are included.
  const off = await call('PUT', '/api/dogs/104/markers', { body: { blueMarkers: [], pooStatus: 'none', starFlag: true, pbFlag: false } });
  assert.equal(off.status, 200);

  const history = await call('GET', '/api/dogs/104/stay-history');
  assert.equal(history.status, 200);
  assert.equal(history.json.stickerEvents.some((e) => e.detail === 'pb'), false, 'pb was turned on and off the same day -- collapsed out');
  assert.equal(history.json.stickerEvents.filter((e) => e.detail === 'star').length, 1, 'star only ever turned on -- still shown');
});

test("a PB dog's sticker clears itself once they leave stray hold, with a timeline event explaining why", async () => {
  const now = new Date().toISOString();
  const db = new Database(dbFile);
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, tags, pb_flag)
    VALUES (105, 'Sprung', 'Male', '3 Years', '2026-01-01T00:00:00', 1, ?, ?, ?, 1)
  `).run(now, now, JSON.stringify(['Dog', 'Shelter', 'On Stray Hold']));
  db.close();
  const before = (await call('GET', '/api/dogs/105', { user: 'established.walker@example.com' })).json.dog;
  assert.equal(before.notEligibleReason, null, 'PB overrides the hold while it lasts');

  // Directly simulating what the scraper does when a fresh scrape no longer
  // lists the hold tag: clear pb_flag and log the same kind of event a
  // manual toggle would, so this shows up on the timeline too.
  const after = new Database(dbFile);
  after.prepare("UPDATE dogs SET tags = ?, pb_flag = 0 WHERE shelter_buddy_id = 105").run(JSON.stringify(['Dog', 'Shelter']));
  after.prepare("INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES ('sticker_auto_off', 105, 'PB: Potty break OK', 'pb', ?)").run(new Date().toISOString());
  after.close();

  const history = await call('GET', '/api/dogs/105/stay-history');
  const pbEvent = history.json.stickerEvents.find((e) => e.detail === 'pb');
  assert.ok(pbEvent, 'the auto-clear shows up on the timeline');
  assert.equal(pbEvent.kind, 'sticker_auto_off');
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

  // Notes on a finished walk can be added, changed, and cleared from the walk list.
  const noted = await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'walk', notes: '  pulls toward squirrels  ' } });
  assert.equal(noted.json.notes, 'pulls toward squirrels');
  assert.equal(noted.json.edited, false, 'a notes change is not a time edit');
  assert.equal((await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'walk' } })).json.notes, 'pulls toward squirrels', 'left alone when not sent');
  assert.equal((await call('PUT', `/api/walks/${id}`, { user, body: { notes: '' } })).json.notes, null);

  // Hand-logged sessions take an activity too, defaulting to a walk.
  const now = Date.now();
  const manual = await call('POST', '/api/walks/manual', { user, body: { dogId: 60, userId: 1, activity: 'cuddle', startedAt: new Date(now - 3600000).toISOString(), endedAt: new Date(now - 3000000).toISOString() } });
  assert.equal(manual.status, 200);
  const plain = await call('POST', '/api/walks/manual', { user, body: { dogId: 60, userId: 1, startedAt: new Date(now - 7200000).toISOString(), endedAt: new Date(now - 6600000).toISOString() } });
  const all = (await call('GET', '/api/walks', { user })).json.walks;
  assert.equal(all.find((w) => w.id === manual.json.id).activity, 'cuddle');
  assert.equal(all.find((w) => w.id === plain.json.id).activity, 'walk');
});

test('a daycation runs up to 12 hours: no +10 min, no 45 minute stop', async () => {
  const user = 'daycation@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  const seed = new Database(dbFile);
  const ts = new Date().toISOString();
  seed.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (62, 'Roadtrip', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
  seed.close();
  const read = (id) => { const c = new Database(dbFile, { readonly: true }); const r = c.prepare('SELECT * FROM walks WHERE id = ?').get(id); c.close(); return r; };
  const backdate = (id, minutesAgo) => { const c = new Database(dbFile); c.prepare('UPDATE walks SET started_at = ? WHERE id = ?').run(new Date(Date.now() - minutesAgo * 60000).toISOString(), id); c.close(); };

  const s = await call('POST', '/api/walks/start', { user, body: { dogId: 62, userId: me.id, activity: 'daycation' } });
  assert.equal(s.status, 200);
  assert.equal(new Date(s.json.stopsAt) - new Date(s.json.startedAt), 12 * 3600000);
  assert.equal(s.json.autoStopMinutes, 720);
  const id = s.json.walkId;
  assert.equal((await call('POST', `/api/walks/${id}/extend`, { user })).status, 409, 'nothing to extend');

  // Five hours in, it's still going.
  backdate(id, 300);
  const active = await call('GET', '/api/walks/active', { user });
  assert.equal(active.json.walk && active.json.walk.id, id);
  assert.equal(read(id).ended_at, null);
  // Too late to turn it into a walk now; switching while young is fine.
  assert.equal((await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'walk' } })).status, 409);
  backdate(id, 5);
  const toWalk = await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'walk' } });
  assert.equal(toWalk.status, 200);
  assert.equal(new Date(toWalk.json.stopsAt) - new Date(read(id).started_at), 45 * 60000, 'a walk gets the 45 minute limit back');
  const back = await call('PUT', `/api/walks/${id}`, { user, body: { activity: 'daycation' } });
  assert.equal(new Date(back.json.stopsAt) - new Date(read(id).started_at), 12 * 3600000);

  // Past 12 hours it stops by itself, and the real end can be up to 12 hours.
  backdate(id, 13 * 60);
  const after = await call('GET', '/api/walks/active', { user });
  assert.equal(after.json.walk, null);
  assert.equal(after.json.wrapUp.id, id);
  assert.equal(read(id).duration_seconds, 12 * 3600);
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user, body: { endedAt: new Date().toISOString() } })).status, 400, 'no longer than 12 hours');
  const fine = await call('PUT', `/api/walks/${id}/end`, { user, body: { endedAt: new Date(Date.now() - 90 * 60000).toISOString() } });
  assert.equal(fine.status, 200);
  assert.equal(Math.round(fine.json.durationSeconds / 60), 11.5 * 60);

  // Matchmaking: 60 minutes by default, +10 on top, and a switch to a walk
  // past 45 minutes is refused like any other switch past the new limit.
  const m = await call('POST', '/api/walks/start', { user, body: { dogId: 62, userId: me.id, activity: 'matchmaking' } });
  assert.equal(m.status, 200);
  assert.equal(m.json.autoStopMinutes, 60);
  assert.equal(new Date(m.json.stopsAt) - new Date(m.json.startedAt), 60 * 60000, 'matchmaking stops after 60 minutes');
  const mid = m.json.walkId;
  backdate(mid, 50);
  assert.equal((await call('GET', '/api/walks/active', { user })).json.walk.id, mid, 'still going at 50 minutes');
  assert.equal((await call('PUT', `/api/walks/${mid}`, { user, body: { activity: 'walk' } })).status, 409, 'too late to be a walk');
  const ext = await call('POST', `/api/walks/${mid}/extend`, { user });
  assert.equal(new Date(ext.json.stopsAt) - new Date(read(mid).started_at), 70 * 60000, '+10 on top of the 60');
  backdate(mid, 75);
  assert.equal((await call('GET', '/api/walks/active', { user })).json.walk, null, 'stopped at its limit');
  assert.equal(read(mid).duration_seconds, 70 * 60);
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

test('dogs on stray hold can only be walked when marked PB', async () => {
  const user = 'strayhold@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  await call('PUT', `/api/users/${me.id}/settings`, { user, body: { experienceLevel: 'expert' } });
  const db = new Database(dbFile);
  const ts = new Date().toISOString();
  const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, tags, pb_flag) VALUES (?, ?, 'Male', '3 Years', '2026-01-01T00:00:00', 1, ?, ?, ?, ?)");
  ins.run(70, 'Held', ts, ts, JSON.stringify(['Dog', 'Shelter', 'On Stray Hold']), 0);
  ins.run(71, 'HeldPB', ts, ts, JSON.stringify(['Dog', 'Shelter', 'On Stray Hold']), 1);
  ins.run(72, 'Free', ts, ts, JSON.stringify(['Dog', 'Shelter']), 0);
  db.close();
  const held = (await call('GET', '/api/dogs/70', { user })).json.dog;
  assert.equal(held.eligible, false);
  assert.equal(held.notEligibleReason, 'stray_hold');
  assert.equal(held.isStrayHold, true);
  const heldPb = (await call('GET', '/api/dogs/71', { user })).json.dog;
  assert.equal(heldPb.eligible, true, 'PB on stray hold is walkable for a level that allows PB');
  assert.equal(heldPb.notEligibleReason, null);
  const free = (await call('GET', '/api/dogs/72', { user })).json.dog;
  assert.equal(free.eligible, true);
  assert.equal(free.isStrayHold, false);
});

test('Alumni bonus days and the stray-hold bypass are independent', async () => {
  const user = 'strayhold-alumni@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  await call('PUT', `/api/users/${me.id}/settings`, { user, body: { experienceLevel: 'expert' } });
  const db = new Database(dbFile);
  const ts = new Date().toISOString();
  const ins = db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, tags, pb_flag, alumni_flag, alumni_bypass_stray_hold)
    VALUES (?, ?, 'Male', '3 Years', '2026-01-01T00:00:00', 1, ?, ?, ?, 0, ?, ?)
  `);
  const strayHoldTags = JSON.stringify(['Dog', 'Shelter', 'On Stray Hold']);
  // Bonus days alone: the shelter's own stray hold tag still wins -- Alumni's
  // bonus days only ever moved the day threshold, never this hold.
  ins.run(73, 'HeldBonusOnly', ts, ts, strayHoldTags, 1, 0);
  // The dedicated bypass alone: lifts the hold even with no bonus days set.
  ins.run(74, 'HeldBypassOnly', ts, ts, strayHoldTags, 0, 1);
  db.close();
  const bonusOnly = (await call('GET', '/api/dogs/73', { user })).json.dog;
  assert.equal(bonusOnly.isStrayHold, true);
  assert.equal(bonusOnly.eligible, false, "Alumni's bonus days alone must not lift a real stray hold");
  assert.equal(bonusOnly.notEligibleReason, 'stray_hold');
  const bypassOnly = (await call('GET', '/api/dogs/74', { user })).json.dog;
  assert.equal(bypassOnly.isStrayHold, true);
  assert.equal(bypassOnly.eligible, true, "Alumni's stray-hold bypass lifts the hold on its own, no bonus days needed");
  assert.equal(bypassOnly.notEligibleReason, null);
});

test('/uptime answers only ok or down, with no details', async () => {
  const res = await fetch(`${base}/uptime`); // no sign-in header at all
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), 'ok');
});

test('a kennel card the listing does not have yet can still be walked, filed under its Animal ID', async () => {
  const user = 'unlisted@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  const missing = await call('GET', '/api/dogs/262999', { user });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.notListedYet, true);
  assert.equal(missing.json.id, 262999);
  assert.equal((await call('GET', '/api/dogs/12', { user })).json.notListedYet, false, 'too short to be an Animal ID');
  assert.equal((await call('POST', '/api/walks/start', { user, body: { dogId: 262999, userId: me.id } })).status, 404, 'only when asked for');
  assert.equal((await call('POST', '/api/walks/start', { user, body: { dogId: 12, userId: me.id, unlisted: true } })).status, 404, 'not an Animal ID');
  const start = await call('POST', '/api/walks/start', { user, body: { dogId: 262999, userId: me.id, location: 'C', unlisted: true } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const dog = (await call('GET', '/api/dogs/262999', { user })).json.dog;
  assert.equal(dog.awaitingListing, true);
  assert.equal(dog.name, 'Dog #262999');
  assert.equal(dog.kennelLocation, 'C');
  for (const q of ['', '?all=true']) {
    const list = (await call('GET', `/api/dogs${q}`, { user })).json.dogs;
    assert.ok(!list.some((d) => d.id === 262999), `stand-in kept out of /api/dogs${q}`);
  }
  const end = await call('PUT', `/api/walks/${start.json.walkId}/end`, { user, body: { notes: '' } });
  assert.equal(end.status, 200, JSON.stringify(end.json));
  // A second card scan (or volunteer) gets the stand-in back, still awaiting.
  assert.equal((await call('GET', '/api/dogs/262999', { user })).json.dog.awaitingListing, true);
});

test('a dog with no photo gets its own drawn silhouette, the same every time', async () => {
  const dog = (await call('GET', '/api/dogs/1')).json.dog;
  assert.equal(dog.photoUrl, '/dog-silhouettes/1.svg?v=1');
  const a = await fetch(`${base}/dog-silhouettes/262999.svg?v=1`);
  assert.equal(a.status, 200);
  assert.match(a.headers.get('content-type'), /image\/svg\+xml/);
  const svgA = await a.text();
  assert.match(svgA, /^<svg /);
  assert.equal(await (await fetch(`${base}/dog-silhouettes/262999.svg`)).text(), svgA, 'same ID, same drawing');
  assert.notEqual(await (await fetch(`${base}/dog-silhouettes/262998.svg`)).text(), svgA, 'next ID, different drawing');
  assert.equal((await fetch(`${base}/dog-silhouettes/abc.svg`)).status, 404);
  assert.equal((await fetch(`${base}/dog-silhouettes/1.png`)).status, 404);
});
