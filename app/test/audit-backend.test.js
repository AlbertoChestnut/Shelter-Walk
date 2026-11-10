// Backend fixes from the 2026-11-10 audit: account ownership, walk integrity,
// privacy of walkers and notes, push subscriptions, errors, caching.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let server; let base; let dbFile; let stub;
const A = 'audit.alpha@example.com';
const B = 'audit.bravo@example.com';
const STAFF = 'audit.staff@example.com';
const ids = {};

async function call(method, url, { user = A, staff = false, body, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const db = (fn) => { const c = new Database(dbFile); try { return fn(c); } finally { c.close(); } };
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();

test.before(async () => {
  // Stand-in for the login system, so account deletion can run.
  stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"deleted":true}'); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  server = await startServer({ prefix: 'sw-audit-be-', env: { DJANGO_INTERNAL_URL: `http://127.0.0.1:${stub.address().port}`, INTERNAL_API_TOKEN: 'tok' } });
  ({ base, dbFile } = server);
  // A fresh database has no users until someone signs in.
  assert.equal(db((c) => c.prepare('SELECT COUNT(*) AS n FROM users').get().n), 0, 'no seeded users');
  for (const [k, e] of [['a', A], ['b', B], ['staff', STAFF]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  db((c) => {
    const now = new Date().toISOString();
    const ins = c.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, summary) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?, '<p>Long story</p>')");
    for (let d = 701; d <= 712; d += 1) ins.run(d, `Audit${d}`, now, now);
  });
});
test.after(async () => { if (server) await server.stop(); if (stub) stub.close(); });

test('/api/users/:id: no case, suffix or encoding trick reaches another account', async () => {
  const b = ids.b;
  assert.equal((await call('PUT', `/api/users/${b}/walk-alerts`, { user: B, body: { minutes: [5] } })).status, 200);
  const variants = [
    `/api/Users/${b}/walk-alerts`, `/api/USERS/${b}/walk-alerts`, `/api/users/${b}x/walk-alerts`,
    `/api/users/${b}.0/walk-alerts`, `/api/users/%20${b}/walk-alerts`, `/api/users/${b}%20/walk-alerts`,
    `/api/users/+${b}/walk-alerts`, `/api/users/0${b}/walk-alerts`, `/api/users/${b}/walk-alerts/`,
    `/api/users/${b}`, `/api/Users/${b}`, `/api/users/${b}x`, `/api/users//${b}/walk-alerts`
  ];
  for (const url of variants) {
    const r = await call('GET', url, { user: A });
    assert.ok(r.status === 403 || r.status === 404, `${url} -> ${r.status}`);
    assert.ok(!r.text.includes('[5]') && !r.text.includes('audit'), `${url} leaked data`);
  }
  for (const url of [`/api/Users/${b}/walk-alerts`, `/api/users/${b}x/walk-alerts`, `/api/users/${b}.0/settings`]) {
    assert.ok([403, 404].includes((await call('PUT', url, { user: A, body: { minutes: [1], experienceLevel: 'expert' } })).status), url);
  }
  assert.ok([403, 404].includes((await call('POST', `/api/USERS/${b}/saved-filters`, { user: A, body: { name: 'x', filter: {} } })).status));
  assert.deepEqual((await call('GET', `/api/users/${b}/walk-alerts`, { user: B })).json.minutes, [5], 'untouched');
  assert.equal(db((c) => c.prepare('SELECT COUNT(*) AS n FROM saved_filters WHERE user_id = ?').get(b).n), 0);
  // Your own still works; staff have no exception (no page needs one).
  assert.equal((await call('GET', `/api/users/${ids.a}/walk-alerts`, { user: A })).status, 200);
  assert.equal((await call('GET', `/api/users/${b}/walk-alerts`, { user: STAFF, staff: true })).status, 403);
  // Permissions keep their own privileged-only check.
  assert.equal((await call('PUT', `/api/users/${b}/permissions`, { user: A, body: { isPrivileged: true } })).status, 403);
});

test('name-based account linking is off unless asked for', async () => {
  db((c) => c.prepare("INSERT INTO users (name, created_at, is_privileged, can_audit) VALUES ('Zedekiah', ?, 1, 1)").run(new Date().toISOString()));
  const me = (await call('GET', '/api/me', { user: 'zedekiah@evil.example' })).json;
  assert.equal(me.isPrivileged, false);
  assert.equal(me.canAudit, false);
  assert.notEqual(me.name, 'Zedekiah');
  assert.equal(typeof me.hideNameWhileWalking, 'boolean');
});

test('the walker on a dog is never sent as an id', async () => {
  const s = await call('POST', '/api/walks/start', { user: B, body: { dogId: 701, userId: ids.b } });
  assert.equal(s.status, 200);
  const asA = (await call('GET', '/api/dogs/701', { user: A })).json.dog.currentWalk;
  assert.ok(asA);
  assert.equal(asA.userId, undefined);
  assert.equal(asA.mine, false);
  assert.equal((await call('GET', '/api/dogs/701', { user: B })).json.dog.currentWalk.mine, true);
  const listed = (await call('GET', '/api/dogs', { user: A })).json.dogs.find((d) => d.id === 701);
  assert.equal(listed.currentWalk.userId, undefined);
  assert.equal(listed.currentWalk.mine, false);
  assert.equal(listed.summary, undefined, 'the list leaves out the long description');
  assert.equal((await call('GET', '/api/dogs/701', { user: A })).json.dog.summary, '<p>Long story</p>');
  // Two open walks on one dog (or one walker) can't happen even by racing.
  const names = db((c) => c.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
  assert.ok(names.includes('idx_walks_one_open_per_user') && names.includes('idx_walks_one_open_per_dog'));
  assert.ok(names.includes('idx_events_dog_kind'));
  assert.throws(() => db((c) => c.prepare('INSERT INTO walks (dog_id, user_id, started_at) VALUES (701, ?, ?)').run(ids.a, new Date().toISOString())), /UNIQUE/);
  // ?ended=1 leaves the walk in progress out.
  const all = (await call('GET', '/api/walks?limit=1000', { user: B })).json.walks;
  const ended = (await call('GET', '/api/walks?limit=1000&ended=1', { user: B })).json.walks;
  assert.ok(all.some((w) => !w.ended_at));
  assert.ok(ended.every((w) => w.ended_at));
  assert.equal(all[0].warned, undefined, 'bookkeeping columns stay out');
  assert.equal((await call('DELETE', `/api/walks/${s.json.walkId}`, { user: B })).status, 200);
});

test('shared notes carry their date, never their time', async () => {
  const m = await call('POST', '/api/walks/manual', { user: B, body: { dogId: 702, userId: ids.b, startedAt: ago(200), endedAt: ago(190), notes: 'Loves the ball' } });
  assert.equal(m.status, 200);
  const plain = await call('POST', '/api/walks/manual', { user: B, body: { dogId: 702, userId: ids.b, startedAt: ago(100), endedAt: ago(90) } });
  assert.equal(plain.status, 200);
  assert.equal((await call('POST', '/api/dogs/702/notes', { user: B, body: { body: 'Treats in pocket' } })).status, 200);
  const dog = (await call('GET', '/api/dogs/702', { user: A })).json;
  // security3: notes are their own list (opaque id, text, date, activity);
  // walk rows carry no notes, no ids, and (not yours) no times.
  const noted = dog.notes.walkNotes.find((n) => n.text === 'Loves the ball');
  assert.match(noted.noteId, /^[\w-]{22}$/, 'still editable, by an opaque id');
  assert.notEqual(noted.noteId, String(m.json.id));
  assert.match(noted.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(noted).sort(), ['activity', 'date', 'noteId', 'text']);
  for (const w of dog.walks) {
    assert.equal(w.notes, undefined);
    assert.equal(w.id, undefined, 'walks have no id to line up with');
    assert.match(w.started_at, /T16:00:00\.000Z$/, "someone else's walk: date only");
  }
  for (const t of dog.notes.sharedTips) assert.match(t.createdAt, /T16:00:00\.000Z$/);
  const all = (await call('GET', '/api/notes', { user: A })).json.dogs.flatMap((g) => g.notes);
  for (const n of all.filter((x) => x.kind !== 'private')) assert.match(n.at, /T16:00:00\.000Z$/);
});

test('walk edits: no reopening, no future start, no stretching', async () => {
  const s = await call('POST', '/api/walks/start', { user: A, body: { dogId: 703, userId: ids.a } });
  assert.equal(s.status, 200);
  const id = s.json.walkId;
  const future = await call('PUT', `/api/walks/${id}`, { user: A, body: { startedAt: new Date(Date.now() + 5 * 3600000).toISOString(), endedAt: null } });
  assert.equal(future.status, 400, 'not in the future');
  // A minute after it really started (within the clock-skew allowance, so
  // only the "not later than the original" rule can stop it).
  const later = await call('PUT', `/api/walks/${id}`, { user: A, body: { startedAt: new Date(new Date(s.json.startedAt).getTime() + 60000).toISOString(), endedAt: null } });
  assert.equal(later.status, 400, 'not later than it really started');
  const earlier = await call('PUT', `/api/walks/${id}`, { user: A, body: { startedAt: ago(10), endedAt: null } });
  assert.equal(earlier.status, 200, 'a late scan can be moved earlier');
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { user: A, body: {} })).status, 200);
  const reopen = await call('PUT', `/api/walks/${id}`, { user: A, body: { endedAt: null } });
  assert.equal(reopen.status, 400, 'a finished walk stays finished');
  assert.ok(db((c) => c.prepare('SELECT ended_at FROM walks WHERE id = ?').get(id).ended_at));
  const long = await call('PUT', `/api/walks/${id}`, { user: A, body: { startedAt: ago(5 * 60), endedAt: ago(1) } });
  assert.equal(long.status, 400, 'a walk is at most 3 hours');
  assert.equal((await call('PUT', `/api/walks/${id}`, { user: A, body: { location: '<b>zzz' } })).status, 400);
  const loc = await call('PUT', `/api/walks/${id}`, { user: A, body: { location: 'c12' } });
  assert.equal(loc.status, 200);
  assert.equal(loc.json.location, 'C');
});

test('hand-logged walks: real times, capped length, no overlaps', async () => {
  const post = (body, user = A) => call('POST', '/api/walks/manual', { user, body: { userId: 1, ...body } });
  assert.equal((await post({ dogId: 704, startedAt: 'Nov 9 2026 10:00', endedAt: 'Nov 9 2026 10:30' })).status, 400, 'loose text is not a time');
  const day = new Date(Date.now() - 4 * 86400000);
  day.setUTCMilliseconds(0);
  const noMs = day.toISOString().replace('.000Z', 'Z');
  const ok = await post({ dogId: 704, startedAt: noMs, endedAt: new Date(day.getTime() + 20 * 60000).toISOString() });
  assert.equal(ok.status, 200);
  assert.equal(db((c) => c.prepare('SELECT started_at FROM walks WHERE id = ?').get(ok.json.id).started_at), day.toISOString(), 'stored as toISOString()');
  assert.equal((await post({ dogId: 704, startedAt: noMs, endedAt: new Date(day.getTime() + 20 * 60000).toISOString() })).status, 409, 'not twice');
  assert.equal((await post({ dogId: 705, startedAt: new Date(day.getTime() + 10 * 60000).toISOString(), endedAt: new Date(day.getTime() + 30 * 60000).toISOString() })).status, 409, 'not two at once');
  assert.equal((await post({ dogId: 704, startedAt: new Date(day.getTime() + 5 * 60000).toISOString(), endedAt: new Date(day.getTime() + 15 * 60000).toISOString() }, B)).status, 409, 'not the same dog with someone else');
  const after = await post({ dogId: 705, startedAt: new Date(day.getTime() + 20 * 60000).toISOString(), endedAt: new Date(day.getTime() + 40 * 60000).toISOString() });
  assert.equal(after.status, 200, 'back to back is fine');
  const d2 = new Date(Date.now() - 3 * 86400000);
  assert.equal((await post({ dogId: 706, activity: 'walk', startedAt: d2.toISOString(), endedAt: new Date(d2.getTime() + 181 * 60000).toISOString() })).status, 400, 'walks: 3 hours max');
  assert.equal((await post({ dogId: 706, activity: 'daycation', startedAt: d2.toISOString(), endedAt: new Date(d2.getTime() + 13 * 3600000).toISOString() })).status, 400, 'daycations: 12 hours max');
  assert.equal((await post({ dogId: 706, activity: 'daycation', startedAt: d2.toISOString(), endedAt: new Date(d2.getTime() + 10 * 3600000).toISOString() })).status, 200);
  assert.equal((await post({ dogId: 707, location: 'Q9', startedAt: new Date(d2.getTime() - 3600000).toISOString(), endedAt: new Date(d2.getTime() - 3000000).toISOString() })).status, 400, 'location is a kennel letter');
});

test('daycations do not count toward the 20-hour level-up', async () => {
  const user = 'audit.daycation@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  await call('PUT', `/api/users/${me.id}/settings`, { user, body: { experienceLevel: 'beginner' } });
  db((c) => {
    const ins = c.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (708, ?, ?, ?, ?, 'daycation')");
    for (const daysAgo of [10, 11]) { const s = new Date(Date.now() - daysAgo * 86400000); ins.run(me.id, s.toISOString(), new Date(s.getTime() + 12 * 3600000).toISOString(), 12 * 3600); }
  });
  assert.equal((await call('GET', '/api/me', { user })).json.levelUpOffer, false);
});

test('settings save all or nothing', async () => {
  const before = (await call('GET', '/api/me', { user: A })).json.desktop.chosen;
  const r = await call('PUT', `/api/users/${ids.a}/settings`, { user: A, body: { desktopView: 'playgroup', speciesPref: 'zebra' } });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/me', { user: A })).json.desktop.chosen, before);
});

test('for-day only takes a real range of up to 48 hours', async () => {
  const from = new Date(Date.now() - 86400000).toISOString();
  assert.equal((await call('GET', `/api/walks/for-day?fromUtc=${from}&toUtc=${new Date().toISOString()}`)).status, 200);
  assert.equal((await call('GET', `/api/walks/for-day?fromUtc=&toUtc=zzz`)).status, 400);
  assert.equal((await call('GET', `/api/walks/for-day?fromUtc=2000-01-01T00:00:00Z&toUtc=2100-01-01T00:00:00Z`)).status, 400);
});

test('push: only real push services, and only your own subscriptions', async () => {
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') };
  const sub = (endpoint, k = keys, user = A) => call('POST', '/api/push/subscribe', { user, body: { subscription: { endpoint, keys: k } } });
  for (const bad of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/fcm.googleapis.com', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com.evil.example/x']) {
    assert.equal((await sub(bad)).status, 400, bad);
  }
  assert.equal((await sub('https://fcm.googleapis.com/fcm/send/abc', { p256dh: 'short', auth: keys.auth })).status, 400, 'bad keys');
  const ep = 'https://fcm.googleapis.com/fcm/send/audit-1';
  assert.equal((await sub(ep)).status, 200);
  const otherKeys = { ...keys, auth: Buffer.alloc(16, 9).toString('base64url') };
  assert.equal((await sub(ep, otherKeys, B)).status, 409, 'knowing the URL is not enough to take it over');
  assert.equal((await call('POST', '/api/push/unsubscribe', { user: B, body: { endpoint: ep } })).status, 200);
  assert.equal(db((c) => c.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(ep).user_id), ids.a, 'still there, still A\'s');
  assert.equal((await sub('https://updates.push.services.mozilla.com/wpush/v2/x')).status, 200);
  assert.equal((await sub('https://web.push.apple.com/abc')).status, 200);
});

test('errors are JSON with no stack, unknown /api paths are JSON 404s', async () => {
  const missing = await call('GET', '/api/no-such-thing');
  assert.equal(missing.status, 404);
  assert.ok(missing.json && missing.json.error);
  const bad = await call('PUT', '/api/staff/schedule/weekly', { user: STAFF, staff: true, raw: '{"days": "nope"' });
  assert.ok(bad.status >= 400);
  assert.ok(bad.json && bad.json.error, 'JSON');
  assert.ok(!/at .*\.js:\d+|node_modules|src\//.test(bad.text), 'no stack trace');
  assert.equal(missing.headers.get('x-powered-by'), null);
});

test('assets: a content-hash ?v= on every script and stylesheet, cached for good', async () => {
  const html = (await call('GET', '/app')).text;
  const v = /theme-init\.js\?v=([0-9a-f]{12})"/.exec(html);
  assert.ok(v, 'theme-init.js is versioned');
  assert.ok(html.includes(`/js/app.js?v=${v[1]}`));
  const staff = (await call('GET', '/staff', { user: STAFF, staff: true })).text;
  assert.ok(staff.includes(`/js/staff-settings.js?v=${v[1]}`));
  const res = await fetch(`${base}/js/app.js?v=${v[1]}`);
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.doesNotMatch((await fetch(`${base}/js/app.js?v=old`)).headers.get('cache-control'), /immutable/);
});

test('/cached-images serves photos only', async () => {
  const dir = path.join(server.dir, 'images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '701.jpg'), 'jpeg');
  fs.writeFileSync(path.join(dir, '701.jpg.lastmod'), 'https://example/x\n2026');
  fs.writeFileSync(path.join(dir, '701.jpg.tmp'), 'partial');
  assert.equal((await fetch(`${base}/cached-images/701.jpg`)).status, 200);
  assert.equal((await fetch(`${base}/cached-images/701.jpg.lastmod`)).status, 404);
  assert.equal((await fetch(`${base}/cached-images/701.jpg.tmp`)).status, 404);
});

test('Together ?days=N lists whole days only', async () => {
  db((c) => {
    const ins = c.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (?, NULL, ?, ?, 600)');
    const s = new Date(Date.now() - 30 * 3600000);
    for (let i = 0; i < 3; i += 1) ins.run(709 + i, new Date(s.getTime() + i * 1000).toISOString(), new Date(s.getTime() + 600000).toISOString());
  });
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const r = await call('GET', '/api/impact?days=1');
  assert.equal(r.status, 200);
  for (const d of r.json.days) assert.equal(d.dateKey, todayKey);
});

test('deleting an account also deletes its walker chat messages', async () => {
  assert.equal((await call('PUT', '/api/modules/walker-chat', { user: STAFF, staff: true, body: { enabled: true } })).status, 200);
  const user = 'audit.leaver@example.com';
  const me = (await call('GET', '/api/me', { user })).json;
  assert.equal((await call('POST', '/api/modules/walker-chat/messages', { user, body: { body: 'bye all' } })).status, 200);
  assert.equal((await call('DELETE', '/api/me', { user, body: { confirm: 'DELETE' } })).status, 200);
  assert.equal(db((c) => c.prepare('SELECT COUNT(*) AS n FROM walker_chat_messages WHERE user_id = ?').get(me.id).n), 0);
});

test('date keys must be real dates', async () => {
  assert.equal((await call('POST', '/api/checkoff', { body: { dogId: 701, dateKey: '2026-13-40' } })).status, 400);
  assert.equal((await call('POST', '/api/checkoff', { body: { dogId: '701abc', dateKey: '2026-11-10' } })).status, 400, 'ids are whole numbers');
  assert.equal((await call('POST', '/api/checkoff', { body: { dogId: 701, dateKey: '2026-11-10' } })).status, 200);
});

test('reassigning a walk follows the same one-at-a-time and no-overlap rules', async () => {
  const [open1, open2, past1, past2] = db((c) => {
    const ins = c.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, ?)');
    return [
      ins.run(709, ids.a, ago(10), null, null).lastInsertRowid,
      ins.run(710, ids.staff, ago(5), null, null).lastInsertRowid,
      ins.run(711, ids.a, ago(300), ago(280), 1200).lastInsertRowid,
      ins.run(712, ids.b, ago(295), ago(285), 600).lastInsertRowid
    ];
  });
  const r1 = await call('PUT', `/api/walks/${open2}/user`, { user: STAFF, staff: true, body: { targetUserId: ids.a } });
  assert.equal(r1.status, 409, 'A already has a walk in progress (not a 500)');
  const r2 = await call('PUT', `/api/walks/${past2}/user`, { user: STAFF, staff: true, body: { targetUserId: ids.a } });
  assert.equal(r2.status, 409, 'overlaps another of A\'s entries');
  const r3 = await call('PUT', `/api/walks/${past2}/user`, { user: STAFF, staff: true, body: { targetUserId: ids.staff } });
  assert.equal(r3.status, 200);
  db((c) => c.prepare('DELETE FROM walks WHERE id IN (?, ?, ?, ?)').run(open1, open2, past1, past2));
});

test("a dog's notes are listed by their shown date, not their real order", async () => {
  db((c) => {
    const ins = c.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, notes) VALUES (708, ?, ?, ?, 600, ?)');
    const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    ins.run(ids.a, `${day}T13:00:00.000Z`, `${day}T13:10:00.000Z`, 'zebra note');
    ins.run(ids.b, `${day}T14:00:00.000Z`, `${day}T14:10:00.000Z`, null);
    ins.run(ids.b, `${day}T21:00:00.000Z`, `${day}T21:10:00.000Z`, 'apple note');
  });
  const { json } = await call('GET', '/api/dogs/708');
  // security3: the notes are their own list, by date then text.
  assert.deepEqual(json.notes.walkNotes.map((n) => n.text), ['apple note', 'zebra note'], 'same-day notes ordered by text');
  // Walk rows: newest shelter day first (your own keep their times, others' are the day only).
  const shelterDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  for (let i = 1; i < json.walks.length; i += 1) assert.ok(shelterDay(json.walks[i - 1].started_at) >= shelterDay(json.walks[i].started_at), 'sorted by day');
  assert.ok(json.walks.every((w) => !('notes' in w) && !('id' in w)));
});

test("ending a walk from a phone whose clock runs a little behind still works", async () => {
  const start = await call('POST', '/api/walks/start', { user: B, body: { dogId: 707, userId: ids.b } });
  assert.equal(start.status, 200, start.text);
  const { walkId } = start.json;
  // The phone thinks it's 40 seconds earlier than the server does.
  const end = await call('PUT', `/api/walks/${walkId}/end`, { user: B, body: { endedAt: ago(0.67) } });
  assert.equal(end.status, 200, end.text);
  const row = db((c) => c.prepare('SELECT started_at, ended_at FROM walks WHERE id = ?').get(walkId));
  assert.ok(row.ended_at >= row.started_at, 'ends at the server\'s now, not before it started');
});
