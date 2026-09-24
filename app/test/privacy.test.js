// Privacy guarantees. The "Together" stats and every other endpoint must never
// make it possible to attribute activity to an individual volunteer, or to
// look at (or change) someone else's records. If one of these fails, treat it
// as a release blocker, not a flaky test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = 3900 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-priv-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc;
const ALICE = 'alice.zebrafish@example.com';
const BOB = 'bob.zebrafish@example.com';
const CAROL = 'carol.zebrafish@example.com';
const STAFF = 'staff.zebrafish@example.com';

async function call(method, url, { user = CAROL, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

const ids = {};
test.before(async () => {
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
  for (const [k, e] of [['alice', ALICE], ['bob', BOB], ['carol', CAROL], ['staff', STAFF]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  for (let d = 1; d <= 6; d += 1) db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(d, `Dog${d}`, now, now);
  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, notes) VALUES (?, ?, ?, ?, 1200, ?)');
  const start = new Date(Date.now() - 3600 * 1000);
  // Alice: 4 walks, Bob: 1 walk, all today. (Bob alone would be a "quiet" contribution.)
  for (let i = 0; i < 4; i += 1) ins.run(1 + i, ids.alice, start.toISOString(), new Date(start.getTime() + 1200000).toISOString(), 'alice private note');
  ins.run(5, ids.bob, start.toISOString(), new Date(start.getTime() + 1200000).toISOString(), 'bob private note');
  db.close();
});
test.after(async () => { if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); } });

test('Together stats contain only totals: no names, emails, ids, or per-person numbers', async () => {
  const r = await call('GET', '/api/impact?days=30');
  assert.equal(r.status, 200);
  const text = r.text.toLowerCase();
  for (const forbidden of ['alice', 'bob', 'carol', 'zebrafish', '@example', 'user', 'volunteer', 'name', 'email']) {
    assert.ok(!text.includes(forbidden), `impact response must not contain "${forbidden}"`);
  }
  // Exact shape: totals only. Adding a field here should be a conscious, reviewed decision.
  assert.deepEqual(Object.keys(r.json).sort(), ['allTime', 'days', 'minCell', 'today']);
  assert.deepEqual(Object.keys(r.json.allTime).sort(), ['dogs', 'seconds', 'since', 'walks']);
  for (const day of r.json.days) {
    assert.deepEqual(Object.keys(day).sort(), ['dateKey', 'dogs', 'seconds', 'sessions', 'walks']);
    for (const s of day.sessions) assert.deepEqual(Object.keys(s).sort(), ['dogs', 'label', 'seconds', 'walks']);
  }
  assert.equal(r.json.allTime.walks, 5, 'everyone\'s walks are combined');
});

test('quiet days and sessions are not listed, so nobody can be singled out', async () => {
  const r = await call('GET', '/api/impact');
  for (const day of r.json.days) {
    assert.ok(day.walks >= r.json.minCell, 'a day below the threshold must not be listed');
    for (const s of day.sessions) assert.ok(s.walks >= r.json.minCell, 'a session below the threshold must not be listed');
  }
  // Remove enough walks that today falls under the threshold: it must vanish from the list but stay in the totals.
  const db = new Database(dbFile);
  db.prepare('DELETE FROM walks WHERE user_id = ?').run(ids.alice);
  db.close();
  const after = await call('GET', '/api/impact');
  assert.equal(after.json.days.length, 0);
  assert.equal(after.json.today, null);
  assert.equal(after.json.allTime.walks, 1, 'totals still include the quiet day');
  const db2 = new Database(dbFile);
  const start = new Date(Date.now() - 3600 * 1000);
  const ins = db2.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, notes) VALUES (?, ?, ?, ?, 1200, ?)');
  for (let i = 0; i < 4; i += 1) ins.run(1 + i, ids.alice, start.toISOString(), new Date(start.getTime() + 1200000).toISOString(), 'alice private note');
  db2.close();
});

test('you cannot read anyone else\'s walks or stats, whatever id you send', async () => {
  const mine = await call('GET', '/api/walks', { user: BOB });
  assert.equal(mine.json.walks.length, 1);
  assert.ok(mine.json.walks.every((w) => w.user_id === ids.bob));
  const spoof = await call('GET', `/api/walks?userId=${ids.alice}`, { user: BOB });
  assert.ok(spoof.json.walks.every((w) => w.user_id === ids.bob), 'a userId in the query is ignored');
  assert.equal((await call('GET', `/api/stats?userId=${ids.alice}`, { user: BOB })).json.totals.totalWalks, 1);
  assert.equal((await call('GET', `/api/walks/active?userId=${ids.alice}`, { user: BOB })).status, 200);
});

test('people cannot be looked up, and other accounts\' settings are off limits', async () => {
  assert.equal((await call('GET', '/api/users', { user: CAROL })).status, 404, 'there is no user listing at all');
  assert.equal((await call('GET', `/api/users/${ids.alice}`, { user: CAROL })).status, 403);
  assert.equal((await call('GET', `/api/users/${ids.alice}/notification-prefs`, { user: CAROL })).status, 403);
  assert.equal((await call('PUT', `/api/users/${ids.alice}/settings`, { user: CAROL, body: { experienceLevel: 'expert' } })).status, 403);
  assert.equal((await call('GET', `/api/users/${ids.carol}/notification-prefs`, { user: CAROL })).status, 200, 'your own is fine');
  assert.equal((await call('GET', '/api/users', { user: STAFF, staff: true })).status, 404, 'not even staff can list');
  assert.equal((await call('POST', '/api/internal/accounts/lookup', { user: STAFF, staff: true, body: { emails: ['x'] } })).status, 403, 'internal lookup needs the shared secret');
  assert.equal((await call('PUT', '/api/internal/accounts/permissions', { user: STAFF, staff: true, body: { email: 'x', isPrivileged: true } })).status, 403, 'internal permissions need the shared secret');
});

test('only the walker (or staff) can change or delete a walk', async () => {
  const aliceWalk = (await call('GET', '/api/walks', { user: ALICE })).json.walks[0];
  assert.equal((await call('PUT', `/api/walks/${aliceWalk.id}`, { user: BOB, body: { notes: 'tampered' } })).status, 403);
  assert.equal((await call('DELETE', `/api/walks/${aliceWalk.id}`, { user: BOB })).status, 403);
  assert.equal((await call('PUT', `/api/walks/${aliceWalk.id}/user`, { user: BOB, body: { targetUserId: ids.bob } })).status, 403, 'attribution cannot be reassigned');
  assert.equal((await call('PUT', `/api/walks/${aliceWalk.id}`, { user: ALICE, body: { notes: 'mine to edit' } })).status, 200);
  assert.equal((await call('DELETE', `/api/walks/${aliceWalk.id}`, { user: STAFF, staff: true })).status, 200);
});

test('walks started or logged for "someone else" are recorded as you', async () => {
  const r = await call('POST', '/api/walks/manual', { user: CAROL, body: { dogId: 6, userId: ids.alice, startedAt: new Date(Date.now() - 7200000).toISOString(), endedAt: new Date(Date.now() - 6000000).toISOString() } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/walks', { user: CAROL })).json.walks.length, 1);
});

test('shared tips carry no author, private notes are visible only to their writer', async () => {
  const SECRET = 'my-secret-reminder-xyzzy';
  const TIP = 'loves tennis balls, hates cats';
  const made = await call('POST', '/api/dogs/1/notes', { user: ALICE, body: { body: TIP } });
  assert.equal(made.status, 200);
  await call('PUT', '/api/dogs/1/private-note', { user: ALICE, body: { body: SECRET } });

  const asBob = await call('GET', '/api/dogs/1/notes', { user: BOB });
  assert.equal(asBob.json.sharedTips.length, 1);
  assert.equal(asBob.json.sharedTips[0].body, TIP);
  assert.deepEqual(Object.keys(asBob.json.sharedTips[0]).sort(), ['body', 'createdAt', 'id', 'updatedAt'], 'no user fields on a tip, not even "mine"');
  assert.equal(asBob.json.privateNote, null, 'Bob has no private note of his own here');
  const everythingBobCanSee = [asBob.text, (await call('GET', '/api/dogs/1', { user: BOB })).text].join(' ').toLowerCase();
  for (const leak of [SECRET, 'alice', 'zebrafish']) assert.ok(!everythingBobCanSee.includes(leak), `Bob must not see "${leak}"`);

  // Not even staff can read someone's private note.
  const asStaff = await call('GET', '/api/dogs/1', { user: STAFF, staff: true });
  assert.ok(!asStaff.text.includes(SECRET), 'staff cannot read private notes');
  assert.equal(asStaff.json.notes.privateNote, null);

  // Alice sees her own.
  const asAlice = await call('GET', '/api/dogs/1/notes', { user: ALICE });
  assert.equal(asAlice.json.privateNote.body, SECRET);
});

test('tips are a whiteboard: anyone can edit or delete any tip; input is validated', async () => {
  const tipId = (await call('GET', '/api/dogs/1/notes', { user: ALICE })).json.sharedTips[0].id;
  assert.equal((await call('PUT', `/api/dogs/1/notes/${tipId}`, { user: BOB, body: { body: 'Bob fixed this tip' } })).status, 200, 'a different walker can edit it');
  assert.equal((await call('GET', '/api/dogs/1/notes', { user: CAROL })).json.sharedTips.find((t) => t.id === tipId).body, 'Bob fixed this tip');
  assert.equal((await call('DELETE', `/api/dogs/1/notes/${tipId}`, { user: CAROL })).status, 200, 'and a third walker can erase it');
  assert.equal((await call('GET', '/api/dogs/1/notes', { user: ALICE })).json.sharedTips.some((t) => t.id === tipId), false);
  assert.equal((await call('PUT', `/api/dogs/1/notes/${tipId}`, { user: BOB, body: { body: 'x' } })).status, 404);
  // The whiteboard routes can never reach a private note.
  const priv = (await call('PUT', '/api/dogs/3/private-note', { user: ALICE, body: { body: 'alice only' } }));
  assert.equal(priv.status, 200);
  const db = new Database(dbFile, { readonly: true });
  const privId = db.prepare("SELECT id FROM dog_notes WHERE visibility = 'private' AND dog_id = 3").get().id;
  db.close();
  assert.equal((await call('DELETE', `/api/dogs/3/notes/${privId}`, { user: BOB })).status, 404, 'private notes are not on the board');
  assert.equal((await call('PUT', `/api/dogs/3/notes/${privId}`, { user: BOB, body: { body: 'stolen' } })).status, 404);
  assert.equal((await call('GET', '/api/dogs/3/notes', { user: ALICE })).json.privateNote.body, 'alice only');
  assert.equal((await call('POST', '/api/dogs/1/notes', { user: BOB, body: { body: '   ' } })).status, 400);
  assert.equal((await call('POST', '/api/dogs/9999/notes', { user: BOB, body: { body: 'x' } })).status, 404);
  const long = await call('POST', '/api/dogs/1/notes', { user: BOB, body: { body: 'a'.repeat(5000) } });
  assert.equal(long.status, 200);
  assert.equal((await call('GET', '/api/dogs/1/notes', { user: BOB })).json.sharedTips[0].body.length, 1000, 'tips are capped');
});

test('private note: replace, append, and clear', async () => {
  await call('PUT', '/api/dogs/2/private-note', { user: BOB, body: { body: 'first' } });
  await call('PUT', '/api/dogs/2/private-note', { user: BOB, body: { body: 'second', append: true } });
  const n = (await call('GET', '/api/dogs/2/notes', { user: BOB })).json.privateNote.body;
  assert.ok(n.startsWith('first') && n.includes('second'));
  await call('PUT', '/api/dogs/2/private-note', { user: BOB, body: { body: '' } });
  assert.equal((await call('GET', '/api/dogs/2/notes', { user: BOB })).json.privateNote, null);
});

test('a day\'s walks are listed in order with no walker identity; only your own are marked', async () => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 3600 * 1000));
  const asCarol = await call('GET', `/api/impact/day?date=${day}`, { user: CAROL });
  assert.equal(asCarol.status, 200);
  assert.ok(asCarol.json.walks.length >= 3);
  const text = asCarol.text.toLowerCase();
  for (const forbidden of ['alice', 'bob', 'zebrafish', '@example', 'private note', 'user_id', 'userid', 'notes', 'auto', 'edited', 'manual']) {
    assert.ok(!text.includes(forbidden), `day detail must not contain "${forbidden}"`);
  }
  for (const w of asCarol.json.walks) {
    assert.deepEqual(Object.keys(w).sort(), ['blueMarkers', 'dogId', 'dogName', 'durationSeconds', 'endedAt', 'mine', 'order', 'pbFlag', 'photoUrl', 'pooStatus', 'starFlag', 'startedAt']);
  }
  assert.deepEqual(asCarol.json.walks.map((w) => w.order), asCarol.json.walks.map((_, i) => i + 1), 'numbered in order');
  const starts = asCarol.json.walks.map((w) => w.startedAt);
  assert.deepEqual(starts, [...starts].sort(), 'oldest first');
  assert.ok(asCarol.json.walks.filter((w) => w.mine).length <= 1, 'Carol only sees her own walk (the manual one) marked');
  const asAlice = await call('GET', `/api/impact/day?date=${day}`, { user: ALICE });
  const aliceMine = asAlice.json.walks.filter((w) => w.mine).length;
  const aliceCount = (await call('GET', '/api/walks', { user: ALICE })).json.walks.filter((w) => w.ended_at).length;
  assert.equal(aliceMine, aliceCount, 'Alice sees exactly her own walks marked');
  assert.equal(asAlice.json.walks.length, asCarol.json.walks.length, 'everyone sees the same day');
});

test('quiet or invalid days are not opened up', async () => {
  assert.equal((await call('GET', '/api/impact/day?date=2020-01-01', { user: CAROL })).status, 404);
  assert.equal((await call('GET', '/api/impact/day?date=nope', { user: CAROL })).status, 400);
  assert.equal((await call('GET', '/api/impact/day', { user: CAROL })).status, 400);
});

test('hide-my-name-while-walking: the live "currently out" name only shows when turned off', async () => {
  const bobName = (await call('GET', '/api/me', { user: BOB })).json.name;
  const started = await call('POST', '/api/walks/start', { user: BOB, body: { dogId: 6, userId: ids.bob } });
  assert.equal(started.status, 200);
  // Brand-new accounts default to hidden (privacy-by-default) -- Bob's test
  // account was created fresh in this file's setup, so this is that default.
  const hidden = await call('GET', '/api/dogs/6', { user: CAROL });
  assert.equal(hidden.json.dog.currentWalk.userName, 'a Volunteer', 'hidden by default for a new account');
  assert.ok(!hidden.text.includes(bobName));
  const clashHidden = await call('POST', '/api/walks/start', { user: ALICE, body: { dogId: 6, userId: ids.alice } });
  assert.ok(clashHidden.json.error.includes('already out with a Volunteer'));
  assert.ok(!clashHidden.text.includes(bobName), 'the "already out" error must not leak the real name either');

  // Turn privacy off, then re-check both of those same places.
  await call('PUT', '/api/me/privacy', { user: BOB, body: { hideNameWhileWalking: false } });
  const seenByCarol = await call('GET', '/api/dogs/6', { user: CAROL });
  assert.equal(seenByCarol.json.dog.currentWalk.userName, bobName, 'shown once turned off');
  const clashOther = await call('POST', '/api/walks/start', { user: ALICE, body: { dogId: 6, userId: ids.alice } });
  assert.ok(clashOther.json.error.includes(`already out with ${bobName}`));

  // Cleanup: end the walk so it doesn't interfere with any other test, and
  // put privacy back the way this test found it.
  await call('DELETE', `/api/walks/${started.json.walkId}`, { user: BOB });
  await call('PUT', '/api/me/privacy', { user: BOB, body: { hideNameWhileWalking: true } });
});

test('the database itself never holds a plaintext email address', async () => {
  // Its derived display name legitimately resembles the local part of the
  // email ("Dave Zebrafish" for dave.zebrafish@...) until someone sets a
  // real name -- that's expected and checked elsewhere, not what this test
  // is about. This checks the actual invariant: no @ sign, and not the
  // exact address, anywhere in the table.
  const dave = 'dave.zebrafish@example.com';
  await call('GET', '/api/me', { user: dave }); // creates the account
  const db = new Database(dbFile, { readonly: true });
  const rows = db.prepare('SELECT * FROM users').all();
  db.close();
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('@'), 'no @ sign anywhere in the users table -- not even a fragment of an address');
  assert.ok(!dump.includes(dave), 'the exact email address is not stored anywhere');
  assert.ok(!Object.keys(rows[0]).includes('auth_email'), 'the old plaintext column is gone, not just empty');
});
