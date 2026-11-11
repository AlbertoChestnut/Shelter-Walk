// Audit 3 (backend, 2026-11-11): walks held to the closing time in force when
// they started (plus the quiet grace), shelter alerts that outlive an early
// closing, the Updates badge matching its feed, an End sent with the walk's
// endToken from a shared phone, text-only text fields, the name look-alike
// check, the data export, Playgroup note order and staff rewrites, and the
// production token length.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer, shelterDayFromToday } = require('./_helpers');
const { CLOSING_GRACE_MINUTES } = require('../src/constants');

let server; let base; let dbFile;
const A = 'a3.walker.a@example.com';
const B = 'a3.walker.b@example.com';
const C = 'a3.walker.c@example.com';
const PRIV = 'a3.staff@example.com';
const ids = {};

async function call(method, url, { user = A, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}
const db = (fn) => { const c = new Database(dbFile); try { return fn(c); } finally { c.close(); } };
const MIN = 60000;
const floorMin = (ms) => Math.floor(ms / MIN) * MIN;
// "HH:MM" on the shelter's clock for an instant.
const hhmm = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const iso = (ms) => new Date(ms).toISOString();
const today = () => shelterDayFromToday(0);
const setTodayClose = (ms) => call('PUT', `/api/staff/schedule/days/${today()}`, { user: PRIV, staff: true, body: { mode: 'hours', open: '07:00', close: hhmm(ms) } });
const clearToday = () => call('DELETE', `/api/staff/schedule/days/${today()}`, { user: PRIV, staff: true });

test.before(async () => {
  // Real walking hours (the helper's default is no limit at all).
  server = await startServer({ prefix: 'sw-a3-be-', env: { WALK_HOURS: '07:00-19:00' } });
  ({ base, dbFile } = server);
  for (const [k, e] of [['a', A], ['b', B], ['c', C], ['priv', PRIV]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  db((c) => {
    c.prepare("UPDATE users SET experience_level = 'established' WHERE id IN (?, ?, ?)").run(ids.a, ids.b, ids.c);
    c.prepare("UPDATE users SET experience_level = 'established', is_privileged = 1 WHERE id = ?").run(ids.priv);
    const now = new Date().toISOString();
    const ins = c.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)");
    for (let d = 701; d <= 720; d += 1) ins.run(d, `A3dog${d}`, now, now);
  });
});
test.after(async () => { if (server) await server.stop(); });

// ---------- 1. Closing time and the quiet grace ----------

test("changing today's hours never ends or shortens a walk already out; new starts follow the new hours", async () => {
  const start = await call('POST', '/api/walks/start', { user: A, body: { dogId: 701, userId: ids.a } });
  assert.equal(start.status, 200, start.text);
  assert.ok(start.json.closesAt && new Date(start.json.closesAt) > new Date(), 'held to the closing time in force now');
  assert.equal(typeof start.json.endToken, 'string');
  const stored = db((c) => c.prepare('SELECT closes_at FROM walks WHERE id = ?').get(start.json.walkId).closes_at);
  assert.equal(stored, start.json.closesAt, 'kept on the walk at its start');

  // Staff close the shelter 5 minutes ago.
  assert.equal((await setTodayClose(floorMin(Date.now()) - 5 * MIN)).status, 200);
  const active = await call('GET', '/api/walks/active', { user: A });
  assert.equal(active.json.walk && active.json.walk.id, start.json.walkId, 'still out');
  assert.equal(active.json.walk.closesAt, start.json.closesAt, 'still held to its own closing time');
  assert.equal(new Date(active.json.walk.stopsAt) - new Date(start.json.startedAt), 45 * MIN, 'runs its full time limit');

  const late = await call('POST', '/api/walks/start', { user: B, body: { dogId: 702, userId: ids.b } });
  assert.equal(late.status, 409, 'a new walk follows the new hours');

  assert.equal((await call('DELETE', `/api/walks/${start.json.walkId}`, { user: A })).status, 200);
  await clearToday();
});

test('a walk out at closing runs on quietly (closing + 15 min still open) and stops at closing + 20', async () => {
  // Today closed 14-15 minutes ago; B's walk began 10 minutes before that.
  const t1 = floorMin(Date.now()) - 14 * MIN;
  assert.equal((await setTodayClose(t1)).status, 200);
  const walkB = db((c) => c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (703, ?, ?)').run(ids.b, iso(t1 - 10 * MIN)).lastInsertRowid);
  const b = await call('GET', '/api/walks/active', { user: B });
  assert.equal(b.json.walk && b.json.walk.id, walkB, 'still open about 15 minutes after closing');
  assert.equal(b.json.walk.closesAt, iso(t1), 'the app is told the official closing time');
  assert.equal(b.json.walk.endsBy, iso(t1 + CLOSING_GRACE_MINUTES * MIN));
  assert.equal(b.json.walk.stopsAt, iso(t1 + CLOSING_GRACE_MINUTES * MIN));
  const ext = await call('POST', `/api/walks/${walkB}/extend`, { user: B });
  assert.equal(ext.status, 409, 'no time added past closing');
  assert.match(ext.json.error, /closes at/);
  assert.ok(!/grace|20 min/i.test(ext.json.error), 'the grace is never mentioned');

  // Today closed 21-22 minutes ago; C's walk (held to that closing when it
  // started) began 20 minutes before it: stopped at closing + 20.
  const t2 = floorMin(Date.now()) - 21 * MIN;
  assert.equal((await setTodayClose(t2)).status, 200);
  const walkC = db((c) => c.prepare('INSERT INTO walks (dog_id, user_id, started_at, closes_at) VALUES (704, ?, ?, ?)').run(ids.c, iso(t2 - 20 * MIN), iso(t2)).lastInsertRowid);
  const cc = await call('GET', '/api/walks/active', { user: C });
  assert.equal(cc.json.walk, null, 'stopped');
  assert.equal(cc.json.wrapUp.id, walkC);
  assert.equal(cc.json.wrapUp.ended_at, iso(t2 + CLOSING_GRACE_MINUTES * MIN), 'at closing + 20');
  assert.equal(cc.json.wrapUp.closesAt, iso(t2));
  assert.equal(cc.json.wrapUp.endsBy, iso(t2 + CLOSING_GRACE_MINUTES * MIN), 'the end picker may go up to the grace end');
  const pick = await call('PUT', `/api/walks/${walkC}/end`, { user: C, body: { notes: '', endedAt: iso(t2 + 15 * MIN) } });
  assert.equal(pick.status, 200, 'a picked time inside the grace is fine');
  assert.equal(pick.json.endedAt, iso(t2 + 15 * MIN));

  db((c) => c.prepare('DELETE FROM walks WHERE id IN (?, ?)').run(walkB, walkC));
  await clearToday();
});

// ---------- 2. Shelter alerts ----------

test('an alert sent after closing still shows until the end of the shelter day', async () => {
  const closed = floorMin(Date.now()) - 30 * MIN;
  const day = await call('PUT', `/api/staff/schedule/days/${today()}`, { user: PRIV, staff: true, body: { mode: 'hours', open: '07:00', close: hhmm(closed), notify: true } });
  assert.equal(day.status, 200, day.text);
  assert.ok(new Date(day.json.alert.expiresAt) > new Date(), 'not expired at birth');
  const until = await call('POST', '/api/staff/alerts', { user: PRIV, staff: true, body: { title: 'Show until today', until: today() } });
  assert.equal(until.status, 200, until.text);
  assert.ok(new Date(until.json.expiresAt) > new Date(Date.now() + 60 * MIN) || until.json.expiresAt.slice(0, 10) >= today(), 'lasts the rest of the day');
  const feed = await call('GET', '/api/updates', { user: A });
  const shown = feed.json.updates.map((u) => u.id);
  assert.ok(shown.includes(day.json.alert.id) && shown.includes(until.json.id), 'both show in Updates');
  await clearToday();
});

test("rewording a special day's note keeps its alert; changing the hours retires it", async () => {
  const d = shelterDayFromToday(10);
  const live = (id) => db((c) => {
    const r = c.prepare("SELECT expires_at FROM shelter_events WHERE id = ? AND kind = 'alert'").get(id);
    return !!r && (!r.expires_at || r.expires_at > new Date().toISOString());
  });
  const first = await call('PUT', `/api/staff/schedule/days/${d}`, { user: PRIV, staff: true, body: { mode: 'closed', note: 'Vet day', notify: true } });
  assert.equal(first.status, 200, first.text);
  assert.ok(live(first.json.alert.id));
  await call('PUT', `/api/staff/schedule/days/${d}`, { user: PRIV, staff: true, body: { mode: 'closed', note: 'Vet day (typo fixed)', message: 'Thanks!' } });
  assert.ok(live(first.json.alert.id), 'a reworded note keeps the closure alert');
  await call('PUT', `/api/staff/schedule/days/${d}`, { user: PRIV, staff: true, body: { mode: 'hours', open: '07:00', close: '12:00' } });
  assert.ok(!live(first.json.alert.id), 'open after all: the closure alert is retired');
  await call('DELETE', `/api/staff/schedule/days/${d}`, { user: PRIV, staff: true });
});

// ---------- 3. The Updates badge counts what the feed shows ----------

test('the Updates badge and the feed share one rule', async () => {
  await call('PUT', `/api/users/${ids.b}/updates-seen`, { user: B });
  await call('PUT', `/api/users/${ids.b}/notification-prefs`, { user: B, body: { show_adopted: false } });
  db((c) => {
    c.prepare("INSERT OR REPLACE INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, 'show_adopted', 0)").run(ids.b);
    c.prepare('INSERT OR IGNORE INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, 707, ?)').run(ids.b, iso(Date.now()));
    const at = iso(Date.now() + 1000);
    const ev = c.prepare('INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 4; i += 1) ev.run(i % 2 ? 'sticker_off' : 'sticker_on', 705, 'Good for beginners (star)', 'star', at);
    ev.run('pending_adoption', 705, 'pending', null, at);
    ev.run('new_dog', 705, 'A3dog705 was added', null, at);
    ev.run('adopted', 706, 'A3dog706 was adopted!', null, at); // hidden category
    ev.run('adopted', 707, 'A3dog707 was adopted!', null, at); // hidden, but a favourite
  });
  const badge = await call('GET', '/api/updates/unread-count', { user: B });
  const feed = await call('GET', '/api/updates', { user: B });
  assert.equal(feed.json.unreadCount, 2, 'the new dog and the favourite\'s adoption');
  assert.equal(badge.json.count, feed.json.unreadCount, 'the badge counts the same');
});

// ---------- 4. A queued End from a shared phone ----------

test("a walk's endToken lets an End through from someone else's session, and nothing more", async () => {
  const start = await call('POST', '/api/walks/start', { user: A, body: { dogId: 708, userId: ids.a } });
  assert.equal(start.status, 200, start.text);
  const id = start.json.walkId;
  const tap = iso(Date.now());
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user: B, body: { finishLater: true, endTappedAt: tap } })).status, 403, 'no token: not yours');
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user: B, body: { finishLater: true, endTappedAt: tap, endToken: 'f'.repeat(32) } })).status, 403, 'wrong token');
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user: B, body: { finishLater: true, endTappedAt: tap, endToken: start.json.endToken, notes: 'mine now' } })).status, 403, 'no notes with a token');
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user: B, body: { endToken: start.json.endToken, endedAt: tap } })).status, 403, 'only an End tap');
  const ok = await call('PUT', `/api/walks/${id}/end`, { user: B, body: { finishLater: true, endTappedAt: tap, endToken: start.json.endToken } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.endedAt, tap, 'ended at the tap');
  const row = db((c) => c.prepare('SELECT ended_at, user_id FROM walks WHERE id = ?').get(id));
  assert.ok(row.ended_at, 'ended');
  assert.equal(row.user_id, ids.a, 'still A\'s walk');
  const active = await call('GET', '/api/walks/active', { user: A });
  assert.ok(!('end_token' in (active.json.wrapUp || {})), 'the token is never sent around');
});

// ---------- 5. Security leftovers ----------

test('text fields must be text', async () => {
  const cases = [
    ['POST', '/api/dogs/709/notes', { body: { x: 1 } }],
    ['POST', '/api/dogs/709/playgroup-notes', { body: -1 }],
    ['PUT', '/api/dogs/709/private-note', { body: true }],
    ['POST', '/api/wiki', { title: true, body: 'x' }, PRIV],
    ['POST', '/api/staff/alerts', { title: { a: 1 } }, PRIV],
    ['PUT', `/api/staff/schedule/days/${shelterDayFromToday(5)}`, { mode: 'closed', note: ['x'] }, PRIV],
    ['POST', '/api/staff/saved-reports', { name: 5, sections: [] }, PRIV],
    ['POST', '/api/modules/walker-chat/messages', { body: { t: 'hi' } }],
    ['POST', '/api/feedback', { kind: 'bug', body: 7 }]
  ];
  for (const [method, url, body, user] of cases) {
    const r = await call(method, url, { user: user || A, staff: user === PRIV, body });
    assert.equal(r.status, 400, `${method} ${url}: ${r.status} ${r.text}`);
  }
  assert.equal((await call('POST', '/api/dogs/709/notes', { body: { body: 'A real tip' } })).status, 200, 'text still works');
  const tips = db((c) => c.prepare("SELECT body FROM dog_notes WHERE dog_id = 709").all().map((r) => r.body));
  assert.ok(!tips.some((t) => /object|^-1$|^true$/.test(t)));
});

test('the name look-alike check folds I/l and rn/m', async () => {
  assert.equal((await call('PUT', '/api/me', { user: PRIV, body: { name: 'Alberto Chestnut' } })).status, 200);
  assert.equal((await call('PUT', '/api/me', { user: C, body: { name: 'AIberto Chestnut' } })).status, 409, 'capital I for l');
  assert.equal((await call('PUT', '/api/me', { user: B, body: { name: 'Kim Smith' } })).status, 200);
  assert.equal((await call('PUT', '/api/me', { user: C, body: { name: 'Kirn Srnith' } })).status, 409, 'rn for m');
  assert.equal((await call('PUT', '/api/me', { user: C, body: { name: 'Lia Brown' } })).status, 200, 'real names still fine');
});

test('the data export has check-offs, queued pushes and permission flags', async () => {
  assert.equal((await call('PUT', '/api/manual-checkoffs', { user: A, body: { dogId: 710, dateKey: today(), slotIndex: 1, checked: true, userId: ids.a } })).status, 200);
  db((c) => c.prepare('INSERT INTO queued_pushes (user_id, payload, queued_at) VALUES (?, ?, ?)').run(ids.a, JSON.stringify({ title: 'Rex was adopted!', body: 'A dog you walked found a home.' }), iso(Date.now())));
  const ex = (await call('GET', '/api/me/export', { user: A })).json;
  assert.equal(ex.profile.isPrivileged, false);
  assert.equal(ex.profile.canAudit, false);
  assert.deepEqual(ex.shiftCheckoffs.map((r) => [r.dog, r.dateKey, r.slotIndex]), [['A3dog710', today(), 1]]);
  assert.deepEqual(ex.queuedPushes.map((q) => q.message.title), ['Rex was adopted!']);
});

test('Playgroup notes sort by date, then text; staff rewording a signed note unsigns it', async () => {
  const date = shelterDayFromToday(-1);
  for (const body of ['Zed played well', 'Abe played well']) {
    assert.equal((await call('POST', '/api/dogs/711/playgroup-notes', { user: A, body: { body, noteDate: date } })).status, 200);
  }
  const list = (await call('GET', '/api/dogs/711/playgroup-notes', { user: B })).json.notes;
  assert.deepEqual(list.map((n) => n.body), ['Abe played well', 'Zed played well'], 'not in the order written');

  const signed = await call('POST', '/api/dogs/712/playgroup-notes', { user: A, body: { body: 'Played gently with Rex', signed: true } });
  const noteId = signed.json.id;
  const reword = await call('PUT', `/api/dogs/712/playgroup-notes/${noteId}`, { user: PRIV, staff: true, body: { body: 'Bit Rex twice' } });
  assert.equal(reword.status, 200, reword.text);
  const after = (await call('GET', '/api/dogs/712/playgroup-notes', { user: B })).json.notes[0];
  assert.equal(after.body, 'Bit Rex twice');
  assert.equal(after.signed, false, 'no longer under the volunteer\'s name');
  assert.equal(after.author, null);
  const own = (await call('GET', '/api/dogs/712/playgroup-notes', { user: A })).json.notes[0];
  assert.equal(own.canSign, false, 'and the writer can\'t sign words they didn\'t write');
});

test('production refuses an INTERNAL_API_TOKEN shorter than 32 characters', async () => {
  await assert.rejects(
    () => startServer({ prefix: 'sw-a3-tok-', env: { NODE_ENV: 'production', INTERNAL_API_TOKEN: 'x', EMAIL_HASH_PEPPER: 'pepper-for-test-0123456789abcdef0123' } }),
    /shorter than 32/
  );
});
