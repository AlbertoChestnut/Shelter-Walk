// Security pass 3 (2026-11-10): walk notes can't be traced to their writer,
// Together's "fewer than 3" can't be undone through per-walk rows, personal
// answers aren't kept for the next person on a shared phone, walker chat has
// limits, nobody (staff included) reads other members' settings, display
// names can't impersonate, CSRF-shaped requests are refused, and a handful
// of smaller hardening items. Each test names the finding it covers.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;
const ALICE = 'alice.sec3@example.com';
const BOB = 'bob.sec3@example.com';
const CAROL = 'carol.sec3@example.com';
const STAFF = 'staff.sec3@example.com';
const PRIV = 'priv.sec3@example.com';

async function call(method, url, { user = ALICE, staff = false, body, headers = {}, raw } = {}) {
  const h = { 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}), ...headers };
  if ((body !== undefined || raw !== undefined) && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const withDb = (fn) => { const db = new Database(dbFile); try { return fn(db); } finally { db.close(); } };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const ids = {};
test.before(async () => {
  server = await startServer({ prefix: 'sw-sec3-' });
  ({ base, dbFile } = server);
  for (const [k, e] of [['alice', ALICE], ['bob', BOB], ['carol', CAROL], ['staff', STAFF], ['priv', PRIV]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  withDb((db) => {
    const now = new Date().toISOString();
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)");
    for (let d = 1; d <= 9; d += 1) dog.run(d, `Dog${d}`, now, now);
    db.prepare('UPDATE users SET is_privileged = 1 WHERE id = ?').run(ids.priv);
  });
});
test.after(() => server && server.stop());

// ---- #1 walk notes can't be traced to their writer ----
test('#1 a dog\'s walk notes are their own list: opaque id, text, date, activity; walk rows have no notes or ids', async () => {
  // Alice walks dog 1 twice (one with a note), Bob once with a note.
  const a1 = await call('POST', '/api/walks/manual', { user: ALICE, body: { dogId: 1, userId: 0, startedAt: ago(200), endedAt: ago(190), notes: 'zz Alice note' } });
  const a2 = await call('POST', '/api/walks/manual', { user: ALICE, body: { dogId: 1, userId: 0, startedAt: ago(150), endedAt: ago(140) } });
  const b1 = await call('POST', '/api/walks/manual', { user: BOB, body: { dogId: 1, userId: 0, startedAt: ago(100), endedAt: ago(90), notes: 'aa Bob note', activity: 'playgroup' } });
  for (const r of [a1, a2, b1]) assert.equal(r.status, 200, r.text);

  const asCarol = await call('GET', '/api/dogs/1', { user: CAROL });
  const notes = asCarol.json.notes.walkNotes;
  assert.deepEqual(notes.map((n) => n.text), ['aa Bob note', 'zz Alice note'], 'same day: ordered by text, not by time');
  for (const n of notes) {
    assert.deepEqual(Object.keys(n).sort(), ['activity', 'date', 'noteId', 'text']);
    assert.match(n.noteId, /^[\w-]{22}$/);
    assert.match(n.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(![a1.json.id, b1.json.id].map(String).includes(n.noteId), 'not the walk id');
  }
  assert.equal(notes.find((n) => n.text === 'aa Bob note').activity, 'playgroup', 'playgroup label survives');
  // Walk rows: no notes, no ids; someone else's have the date only.
  for (const w of asCarol.json.walks) {
    assert.ok(!('notes' in w) && !('id' in w) && !('user_id' in w));
    assert.equal(w.mine, false);
    assert.match(w.started_at, /T16:00:00\.000Z$/);
  }
  // Your own walks keep their times (for the "walked today" hint).
  const asAlice = await call('GET', '/api/dogs/1', { user: ALICE });
  const mine = asAlice.json.walks.filter((w) => w.mine);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((w) => !/T16:00:00\.000Z$/.test(w.started_at)));
  assert.equal(asAlice.json.walks.filter((w) => !w.mine).length, 1);
  // The same list (and ids) from /notes.
  assert.deepEqual((await call('GET', '/api/dogs/1/notes', { user: BOB })).json.walkNotes, notes);
});

test('#1 editing and deleting a walk note takes the opaque id, never a walk id', async () => {
  const { walkNotes } = (await call('GET', '/api/dogs/1/notes', { user: CAROL })).json;
  const target = walkNotes.find((n) => n.text === 'zz Alice note');
  const walkId = withDb((db) => db.prepare("SELECT id FROM walks WHERE notes = 'zz Alice note'").get().id);
  assert.equal((await call('PUT', `/api/dogs/1/walk-notes/${walkId}`, { user: CAROL, body: { body: 'x' } })).status, 404, 'walk id refused');
  assert.equal((await call('PUT', `/api/dogs/2/walk-notes/${target.noteId}`, { user: CAROL, body: { body: 'x' } })).status, 404, 'wrong dog');
  const put = await call('PUT', `/api/dogs/1/walk-notes/${target.noteId}`, { user: CAROL, body: { body: 'zz reworded' } });
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(put.json), ['noteId'], 'no walk id comes back');
  const after = (await call('GET', '/api/dogs/1/notes', { user: CAROL })).json.walkNotes;
  assert.equal(after.find((n) => n.noteId === target.noteId).text, 'zz reworded', 'id is stable across edits');
  assert.equal((await call('PUT', `/api/dogs/1/walk-notes/${target.noteId}`, { user: CAROL, body: { body: 'y'.repeat(1001) } })).status, 400, '#8 capped at 1000');
  assert.equal((await call('DELETE', `/api/dogs/1/walk-notes/${target.noteId}`, { user: CAROL })).status, 200);
  assert.equal((await call('DELETE', `/api/dogs/1/walk-notes/${target.noteId}`, { user: CAROL })).status, 404);
});

test('#1 Stats › Notes and mentions are ordered by date then text, not by time', async () => {
  withDb((db) => {
    const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, notes) VALUES (3, ?, ?, ?, 600, ?)');
    ins.run(ids.alice, `${day}T14:00:00.000Z`, `${day}T14:10:00.000Z`, 'mm second by time');
    ins.run(ids.bob, `${day}T13:00:00.000Z`, `${day}T13:10:00.000Z`, 'yy first by time');
    ins.run(ids.bob, `${day}T15:00:00.000Z`, `${day}T15:10:00.000Z`, 'bb third by time @[4]');
  });
  const all = (await call('GET', '/api/notes', { user: CAROL })).json.dogs.find((g) => g.dog.id === 3);
  assert.deepEqual(all.notes.map((n) => n.body), ['bb third by time @[4]', 'mm second by time', 'yy first by time']);
  assert.ok(all.notes.every((n) => n.id === undefined));
  const mentions = (await call('GET', '/api/dogs/4/notes', { user: CAROL })).json.mentions;
  assert.equal(mentions.length, 1);
  assert.match(mentions[0].at, /T16:00:00\.000Z$/);
});

test('#1 currentWalk: the start time only on your own walk', async () => {
  const s = await call('POST', '/api/walks/start', { user: BOB, body: { dogId: 5, userId: 0 } });
  assert.equal(s.status, 200, s.text);
  const other = (await call('GET', '/api/dogs/5', { user: CAROL })).json.dog.currentWalk;
  assert.deepEqual(Object.keys(other).sort(), ['activity', 'mine', 'userName']);
  const list = (await call('GET', '/api/dogs', { user: CAROL })).json.dogs.find((d) => d.id === 5).currentWalk;
  assert.equal(list.startedAt, undefined);
  const own = (await call('GET', '/api/dogs/5', { user: BOB })).json.dog.currentWalk;
  assert.equal(own.mine, true);
  assert.equal(own.startedAt, s.json.startedAt);
  assert.equal((await call('DELETE', `/api/walks/${s.json.walkId}`, { user: BOB })).status, 200);
});

// ---- #2 Together's "fewer than 3" can't be undone through per-walk rows ----
test('#2 for-day sends only which walk window each dog was out in', async () => {
  // Minutes before yesterday's shelter noon, so the windows don't depend on
  // the clock (TEST_CLOCK=real or any TEST_CLOCK=<ISO>).
  const { shelterClock, shelterTimeToDate } = require('../src/walkHours');
  const c = shelterClock(Date.now() - 24 * 3600000);
  const noon = shelterTimeToDate(c.y, c.m, c.d, 12 * 60).getTime();
  const before = (min) => new Date(noon - min * 60000).toISOString();
  withDb((db) => {
    const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (6, ?, ?, ?, 600)');
    ins.run(ids.alice, before(60), before(50)); // 11 am: window 1
    ins.run(ids.bob, before(55), before(45)); // same window
    ins.run(ids.bob, before(240), before(230)); // 8 am: window 0
  });
  const r = await call('GET', `/api/walks/for-day?fromUtc=${encodeURIComponent(before(12 * 60))}&toUtc=${encodeURIComponent(before(0))}`);
  assert.equal(r.status, 200);
  const six = r.json.walks.filter((w) => w.dog_id === 6);
  assert.deepEqual(six, [{ dog_id: 6, slotIndex: 0 }, { dog_id: 6, slotIndex: 1 }], 'once per dog and window, no times or counts');
  assert.ok(r.json.walks.every((w) => Object.keys(w).sort().join() === 'dog_id,slotIndex'));
});

test('#2 walk history: your own with times; anyone else\'s with date, window and a rounded length; exact totals', async () => {
  const r = await call('GET', '/api/dogs/6/walk-history', { user: ALICE });
  assert.equal(r.status, 200);
  assert.equal(r.json.walks.length, 3);
  for (const w of r.json.walks) {
    if (w.mine) assert.ok(w.startedAt && w.endedAt && w.durationSeconds === 600);
    else {
      assert.deepEqual(Object.keys(w).sort(), ['activity', 'date', 'durationSeconds', 'mine', 'slot']);
      assert.equal(w.durationSeconds % 300, 0);
    }
  }
  assert.deepEqual(r.json.totals, { count: 3, totalSeconds: 1800 });
  assert.equal((r.text.match(/"startedAt"/g) || []).length, 1, 'only my own walk has a time');
});

// ---- #3 personal answers aren't stored ----
test('#3 personal API answers are no-store; shared ones are not', async () => {
  for (const url of ['/api/me', '/api/me/export', `/api/users/${ids.alice}/notification-prefs`, '/api/notes?scope=mine', '/api/notes',
    '/api/dogs/1', '/api/dogs/1/notes', '/api/dogs/1/walk-history', '/api/walks', '/api/walks/active', '/api/stats', '/api/impact']) {
    const r = await call('GET', url);
    assert.equal(r.status, 200, url);
    assert.match(r.headers.get('cache-control') || '', /no-store/, url);
  }
  assert.doesNotMatch((await call('GET', '/api/dogs')).headers.get('cache-control') || '', /no-store/, 'the dog list still works offline');
});

// ---- #4 walker chat limits ----
test('#4 walker chat: message burst and refill, typing gap, stream caps, closed when turned off', async () => {
  assert.equal((await call('PUT', '/api/modules/walker-chat', { user: STAFF, staff: true, body: { enabled: true } })).status, 200);
  const msgs = '/api/modules/walker-chat/messages';
  const sent = [];
  for (let i = 0; i < 7; i += 1) sent.push((await call('POST', msgs, { user: CAROL, body: { body: `hi ${i}` } })).status);
  assert.deepEqual(sent, [200, 200, 200, 200, 200, 429, 429], 'burst of 5');
  assert.equal((await call('POST', msgs, { user: BOB, body: { body: 'bob is fine' } })).status, 200, 'per user');
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal((await call('POST', msgs, { user: CAROL, body: { body: 'after a pause' } })).status, 200, 'refills');

  assert.equal((await call('POST', '/api/modules/walker-chat/typing', { user: CAROL, body: {} })).status, 200);
  assert.equal((await call('POST', '/api/modules/walker-chat/typing', { user: CAROL, body: {} })).status, 429);

  const open = [];
  const stream = async (user) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/modules/walker-chat/stream`, { headers: { 'x-auth-email': user }, signal: ac.signal });
    if (res.status === 200) open.push({ ac, reader: res.body.getReader() });
    else await res.text();
    return res.status;
  };
  // Round 4: the cap is 6 per account (was 3).
  const seven = [];
  for (let i = 0; i < 7; i++) seven.push(await stream(CAROL));
  assert.deepEqual(seven, [200, 200, 200, 200, 200, 200, 429]);
  assert.equal(await stream(BOB), 200, 'another user still gets one');
  // Turning the module off closes every open stream.
  assert.equal((await call('PUT', '/api/modules/walker-chat', { user: STAFF, staff: true, body: { enabled: false } })).status, 200);
  const ended = await Promise.all(open.map(async ({ reader }) => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const { done } = await reader.read();
      if (done) return true;
    }
    return false;
  }));
  assert.ok(ended.every(Boolean), 'all streams ended');
  open.forEach(({ ac }) => ac.abort());
  assert.equal(await stream(CAROL), 404, 'and none reopen');
});

// ---- #5 nobody reads or changes another member's settings ----
test('#5 /api/users/:id is own-id only, for staff and privileged too; /permissions keeps its own rule', async () => {
  for (const who of [{ user: STAFF, staff: true }, { user: PRIV }]) {
    for (const [method, url, body] of [
      ['GET', `/api/users/${ids.alice}`], ['GET', `/api/users/${ids.alice}/notification-prefs`], ['GET', `/api/users/${ids.alice}/walk-alerts`],
      ['GET', `/api/users/${ids.alice}/saved-filters`], ['PUT', `/api/users/${ids.alice}/settings`, { experienceLevel: 'expert' }],
      ['PUT', `/api/users/${ids.alice}/notification-prefs`, { key: 'walk_started', enabled: true }], ['POST', `/api/users/${ids.alice}/onboarding-complete`, {}],
      ['PUT', `/api/users/${ids.alice}/updates-seen`, {}], ['POST', `/api/users/${ids.alice}/level-up-offer`, { accept: true }]
    ]) {
      assert.equal((await call(method, url, { ...who, body })).status, 403, `${who.user} ${method} ${url}`);
    }
  }
  assert.equal((await call('PUT', `/api/users/${ids.carol}/permissions`, { user: PRIV, body: { isPrivileged: false, canAudit: true } })).status, 200, 'privileged can still manage permissions');
  assert.equal((await call('PUT', `/api/users/${ids.carol}/permissions`, { user: STAFF, staff: true, body: { isPrivileged: false, canAudit: false } })).status, 403, 'staff (not privileged) cannot');
  const w = await call('POST', '/api/walks/manual', { user: ALICE, body: { dogId: 7, userId: 0, startedAt: ago(30), endedAt: ago(20) } });
  for (const who of [{ user: STAFF, staff: true }, { user: PRIV }]) {
    assert.equal((await call('PUT', `/api/walks/${w.json.id}`, { ...who, body: { notes: 'x' } })).status, 403);
    assert.equal((await call('DELETE', `/api/walks/${w.json.id}`, who)).status, 403);
  }
  assert.equal((await call('PUT', `/api/walks/${w.json.id}/user`, { user: STAFF, staff: true, body: { targetUserId: ids.bob } })).status, 200, 'reassignment is kept');
});

// ---- #6 display names can't impersonate ----
test('#6 names are NFKC with invisible characters dropped, and look-alikes clash', async () => {
  assert.equal((await call('PUT', '/api/me', { user: ALICE, body: { name: 'Alice Smith' } })).status, 200);
  for (const name of ['Аlice Smith', 'Alіce Smith', 'alice  smith', 'Ali​ce Smith', 'Ａlice Smith', 'Alicé Smith', '‮Alice Smith']) {
    assert.equal((await call('PUT', '/api/me', { user: BOB, body: { name } })).status, 409, JSON.stringify(name));
  }
  const saved = await call('PUT', '/api/me', { user: BOB, body: { name: 'B​o‮b\u0007 Ｂrown' } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.name, 'Bob Brown');
  assert.equal((await call('PUT', '/api/me', { user: BOB, body: { name: '​‍' } })).status, 400, 'nothing visible left');
});

// ---- #7 playgroup notes: date only unless it's your own signed note ----
test('#7 playgroup notes carry their date only, except a signed note to its writer', async () => {
  const anon = await call('POST', '/api/dogs/8/playgroup-notes', { user: ALICE, body: { body: 'anon one' } });
  const signed = await call('POST', '/api/dogs/8/playgroup-notes', { user: ALICE, body: { body: 'signed one', signed: true } });
  assert.equal(anon.status, 200); assert.equal(signed.status, 200);
  const day = /T16:00:00\.000Z$/;
  const forAlice = (await call('GET', '/api/dogs/8/playgroup-notes', { user: ALICE })).json.notes;
  assert.match(forAlice.find((n) => n.body === 'anon one').createdAt, day, 'unsigned: date only, even to its writer');
  assert.doesNotMatch(forAlice.find((n) => n.body === 'signed one').createdAt, day, 'signed: its writer sees the time');
  const forBob = (await call('GET', '/api/dogs/8/playgroup-notes', { user: BOB })).json.notes;
  for (const n of forBob) { assert.match(n.createdAt, day); assert.match(n.updatedAt, day); }
  const desk = (await call('GET', '/api/playgroup-notes', { user: BOB })).json;
  for (const n of desk.notes || []) assert.match(n.createdAt, day);
});

// ---- #8 walk note length ----
test('#8 walk notes over 1000 characters are refused with a clear message', async () => {
  const long = 'n'.repeat(1001);
  const manual = await call('POST', '/api/walks/manual', { user: CAROL, body: { dogId: 9, userId: 0, startedAt: ago(80), endedAt: ago(70), notes: long } });
  assert.equal(manual.status, 400);
  assert.match(manual.json.error, /1000 characters/);
  const ok = await call('POST', '/api/walks/manual', { user: CAROL, body: { dogId: 9, userId: 0, startedAt: ago(80), endedAt: ago(70), notes: 'n'.repeat(1000) } });
  assert.equal(ok.status, 200);
  assert.equal((await call('PUT', `/api/walks/${ok.json.id}`, { user: CAROL, body: { notes: long } })).status, 400);
  const s = await call('POST', '/api/walks/start', { user: CAROL, body: { dogId: 9, userId: 0 } });
  assert.equal(s.status, 200, s.text);
  assert.equal((await call('PUT', `/api/walks/${s.json.walkId}/end`, { user: CAROL, body: { notes: long } })).status, 400);
  assert.equal((await call('PUT', `/api/walks/${s.json.walkId}/end`, { user: CAROL, body: { notes: 'fine' } })).status, 200);
});

// ---- #9 stand-in "Dog #N" rows ----
test('#9 at most 3 stand-ins per walker per day, and a stand-in goes with its only walk', async () => {
  const startUnlisted = (id) => call('POST', '/api/walks/start', { user: BOB, body: { dogId: id, userId: 0, unlisted: true, species: 'dog' } });
  const exists = (id) => withDb((db) => !!db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ?').get(id));
  const first = await startUnlisted(880001);
  assert.equal(first.status, 200, first.text);
  assert.equal((await call('DELETE', `/api/walks/${first.json.walkId}`, { user: BOB })).status, 200);
  assert.equal(exists(880001), false, 'deleted with its only walk');
  const busy = await call('POST', '/api/walks/start', { user: BOB, body: { dogId: 2, userId: 0 } });
  assert.equal(busy.status, 200, busy.text);
  assert.equal((await startUnlisted(880009)).status, 409, 'a walk already going');
  assert.equal(exists(880009), false, 'and no stand-in left behind');
  await call('PUT', `/api/walks/${busy.json.walkId}/end`, { user: BOB, body: {} });
  for (const id of [880002, 880003, 880004]) {
    const s = await startUnlisted(id);
    assert.equal(s.status, 200, s.text);
    assert.equal((await call('PUT', `/api/walks/${s.json.walkId}/end`, { user: BOB, body: {} })).status, 200);
  }
  const fourth = await startUnlisted(880005);
  assert.equal(fourth.status, 429);
  assert.equal(exists(880005), false);
  assert.equal((await call('POST', '/api/walks/start', { user: CAROL, body: { dogId: 880006, userId: 0, unlisted: true } })).status, 200, 'per walker');
});

// ---- #10 CSRF-shaped requests ----
test('#10 state-changing requests must be JSON (bodyless DELETE aside), and cross-site ones are refused', async () => {
  const url = `/api/users/${ids.carol}/saved-filters`;
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await call('POST', url, { user: CAROL, raw: '{"name":"x","filter":{}}', headers: { 'content-type': type } });
    assert.equal(r.status, 415, type);
  }
  const bare = await fetch(`${base}/api/walks/1/extend`, { method: 'POST', headers: { 'x-auth-email': CAROL } });
  assert.equal(bare.status, 415, 'a bodyless no-cors-style POST');
  const made = await call('POST', url, { user: CAROL, body: { name: 'mine', filter: {} } });
  assert.equal(made.status, 200);
  assert.equal((await call('DELETE', `${url}/${made.json.id}`, { user: CAROL })).status, 200, 'a bodyless DELETE is fine');
  const cross = await call('POST', url, { user: CAROL, body: { name: 'x', filter: {} }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  assert.equal((await call('POST', url, { user: CAROL, body: { name: 'y', filter: {} }, headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  // The Guide's image upload wants an image type (after its editor check).
  assert.equal((await call('POST', '/api/wiki/images', { user: STAFF, staff: true, raw: 'abc', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', '/api/wiki/images', { user: CAROL, raw: 'abc', headers: { 'content-type': 'image/png' } })).status, 403);
});

// ---- #12 raw page files ----
test('#12 /staff.html and /playgroup.html are not served raw', async () => {
  for (const [p, to] of [['/staff.html', '/staff'], ['/playgroup.html', '/playgroup'], ['/staff%2Ehtml', '/staff'], ['//staff.html', '/staff']]) {
    const r = await fetch(base + p, { headers: { 'x-auth-email': CAROL }, redirect: 'manual' });
    assert.equal(r.status, 301, p);
    assert.equal(r.headers.get('location'), to, p);
  }
  assert.equal((await call('GET', '/staff', { user: CAROL })).status, 403);
});

// ---- #13 push subscriptions ----
test('#13 at most 10 push subscriptions per account, oldest dropped', async () => {
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
  const auth = Buffer.alloc(16, 9).toString('base64url');
  for (let i = 0; i < 12; i += 1) {
    const r = await call('POST', '/api/push/subscribe', { user: CAROL, body: { subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/sec3-${i}`, keys: { p256dh, auth } } } });
    assert.equal(r.status, 200, r.text);
  }
  const eps = withDb((db) => db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(ids.carol).map((r) => r.endpoint));
  assert.equal(eps.length, 10);
  assert.ok(!eps.includes('https://fcm.googleapis.com/fcm/send/sec3-0') && !eps.includes('https://fcm.googleapis.com/fcm/send/sec3-1'));
});

// ---- #13 internal token ----
test('#13 the internal token still works (constant-time compare), and production refuses "change-me"', async () => {
  const s2 = await startServer({ prefix: 'sw-sec3-int-', env: { INTERNAL_API_TOKEN: 'sec3-token' } });
  try {
    const ok = await fetch(`${s2.base}/api/internal/accounts/lookup`, { method: 'POST', headers: { authorization: 'Bearer sec3-token', 'content-type': 'application/json' }, body: '{"emails":[]}' });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${s2.base}/api/internal/accounts/lookup`, { method: 'POST', headers: { authorization: 'Bearer sec3-tokem', 'content-type': 'application/json', 'x-auth-email': CAROL }, body: '{"emails":[]}' });
    assert.equal(bad.status, 403);
  } finally { await s2.stop(); }
  await assert.rejects(
    () => startServer({ prefix: 'sw-sec3-prod-', env: { NODE_ENV: 'production', INTERNAL_API_TOKEN: 'change-me', EMAIL_HASH_PEPPER: 'pepper-for-test-0123456789abcdef0123' } }),
    /change-me/
  );
});
