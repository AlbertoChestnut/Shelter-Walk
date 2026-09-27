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
