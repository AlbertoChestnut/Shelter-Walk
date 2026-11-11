// Backend fixes from audit 2 (2026-11-10): sticker saves, walk ending,
// account safety, privacy, data export, input checks.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const Database = require('better-sqlite3');
const { startServer, shelterDayFromToday } = require('./_helpers');

let server; let base; let dbFile; let stub;
const BEGINNER = 'a2.beginner@example.com';
const EST = 'a2.established@example.com';
const PRIV = 'a2.privileged@example.com';
const OTHER = 'a2.other@example.com';
const ids = {};

async function call(method, url, { user = BEGINNER, staff = false, body, raw, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}), ...headers },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body))
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const db = (fn) => { const c = new Database(dbFile); try { return fn(c); } finally { c.close(); } };
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const dog = async (id, user = BEGINNER) => (await call('GET', `/api/dogs/${id}`, { user })).json.dog;

test.before(async () => {
  stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"deleted":true}'); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  server = await startServer({ prefix: 'sw-a2-be-', env: { DJANGO_INTERNAL_URL: `http://127.0.0.1:${stub.address().port}`, INTERNAL_API_TOKEN: 'tok' } });
  ({ base, dbFile } = server);
  for (const [k, e] of [['beginner', BEGINNER], ['est', EST], ['priv', PRIV], ['other', OTHER]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  db((c) => {
    c.prepare("UPDATE users SET experience_level = 'beginner' WHERE id = ?").run(ids.beginner);
    c.prepare("UPDATE users SET experience_level = 'established' WHERE id IN (?, ?)").run(ids.est, ids.other);
    c.prepare("UPDATE users SET experience_level = 'beginner', is_privileged = 1 WHERE id = ?").run(ids.priv);
    const now = new Date().toISOString();
    const ins = c.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)");
    for (let d = 901; d <= 930; d += 1) ins.run(d, `A2dog${d}`, now, now);
  });
});
test.after(async () => { if (server) await server.stop(); if (stub) stub.close(); });

test('stickers: a stale save is refused with 409 and the current stickers', async () => {
  const opened = await dog(901);
  assert.equal(typeof opened.markersVersion, 'string');
  // Staff add Reactive after the volunteer opened the dog.
  const staff = await call('PUT', '/api/dogs/901/markers', { user: PRIV, body: { patch: { blueMarkers: { add: ['blue_r'] } }, version: opened.markersVersion } });
  assert.equal(staff.status, 200, staff.text);
  assert.deepEqual(staff.json.blueMarkers, ['blue_r']);
  // The volunteer's old screen saves a star: refused, nothing taken off.
  const stale = await call('PUT', '/api/dogs/901/markers', { user: EST, body: { patch: { starFlag: true }, version: opened.markersVersion } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.staleMarkers, true);
  assert.deepEqual(stale.json.markers.blueMarkers, ['blue_r']);
  assert.equal(stale.json.markers.version, staff.json.version);
  assert.match(stale.json.error, /changed this dog's stickers/);
  // A patch without a version only touches its own keys.
  const star = await call('PUT', '/api/dogs/901/markers', { user: EST, body: { patch: { starFlag: true } } });
  assert.equal(star.status, 200);
  assert.deepEqual(star.json.blueMarkers, ['blue_r']);
  assert.equal(star.json.starFlag, true);
  const events = db((c) => c.prepare("SELECT kind, detail FROM shelter_events WHERE dog_id = 901 AND kind LIKE 'sticker_%' ORDER BY id").all());
  assert.deepEqual(events.map((e) => `${e.kind}:${e.detail}`), ['sticker_on:blue_r', 'sticker_on:star']);
});

test('stickers: patches are validated', async () => {
  for (const patch of [[], 'x', { blueMarkers: { add: ['nope'] } }, { pooStatus: 'maybe' }, { starFlag: 'yes' }, { blueMarkers: { add: 'blue_r' } }]) {
    assert.equal((await call('PUT', '/api/dogs/902/markers', { user: PRIV, body: { patch } })).status, 400, JSON.stringify(patch));
  }
  assert.equal((await call('PUT', '/api/dogs/902/markers', { user: PRIV, body: { patch: {}, version: { toString: 1 } } })).status, 400);
  assert.equal((await call('PUT', '/api/dogs/99999/markers', { user: PRIV, body: { patch: {} } })).status, 404);
});

test('stickers: a volunteer below the level a sticker restricts can\'t take it off', async () => {
  await call('PUT', '/api/dogs/903/markers', { user: PRIV, body: { patch: { blueMarkers: { add: ['blue_r', 'blue_evo'] } } } });
  // Beginner: every blue sticker is locked.
  const b = await dog(903, BEGINNER);
  assert.deepEqual(b.lockedMarkers.sort(), ['blue_evo', 'blue_r']);
  const r1 = await call('PUT', '/api/dogs/903/markers', { user: BEGINNER, body: { patch: { blueMarkers: { remove: ['blue_r'] } } } });
  assert.equal(r1.status, 403);
  assert.match(r1.json.error, /Only staff or a privileged volunteer/);
  // The old whole-set form is checked the same way.
  const r2 = await call('PUT', '/api/dogs/903/markers', { user: BEGINNER, body: { blueMarkers: [], pooStatus: 'none', starFlag: false, pbFlag: false } });
  assert.equal(r2.status, 403);
  // Established: only EVO is locked; Reactive can come off.
  assert.deepEqual((await dog(903, EST)).lockedMarkers, ['blue_evo']);
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: EST, body: { patch: { blueMarkers: { remove: ['blue_evo'] } } } })).status, 403);
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: EST, body: { patch: { blueMarkers: { remove: ['blue_r'] } } } })).status, 200);
  // Adding is always fine, and staff (header) or privileged can take anything off.
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: BEGINNER, body: { patch: { blueMarkers: { add: ['blue_j'] } } } })).status, 200);
  assert.deepEqual((await dog(903, PRIV)).lockedMarkers, []);
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: OTHER, staff: true, body: { patch: { blueMarkers: { remove: ['blue_evo'] } } } })).status, 200);
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: PRIV, body: { patch: { blueMarkers: { remove: ['blue_j'] } } } })).status, 200);
  assert.deepEqual(db((c) => JSON.parse(c.prepare('SELECT blue_markers FROM dogs WHERE shelter_buddy_id = 903').get().blue_markers)), []);
  // A beginner can't take PB off (PB keeps beginners off) either.
  await call('PUT', '/api/dogs/903/markers', { user: PRIV, body: { patch: { pbFlag: true } } });
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: BEGINNER, body: { patch: { pbFlag: false } } })).status, 403);
  assert.equal((await call('PUT', '/api/dogs/903/markers', { user: EST, body: { patch: { pbFlag: false } } })).status, 200);
});

// ---- Walk ending ----
// A walk row started `minutesAgo`, for `user`, on `dogId`.
function openWalk(user, dogId, minutesAgo) {
  return db((c) => c.prepare('INSERT INTO walks (dog_id, user_id, started_at, activity) VALUES (?, ?, ?, ?)').run(dogId, user, ago(minutesAgo), 'walk').lastInsertRowid);
}
const walkRow = (id) => db((c) => c.prepare('SELECT * FROM walks WHERE id = ?').get(id));
const clientNow = (offsetMs) => ({ 'x-client-now': String(Date.now() + offsetMs) });

test('a phone running 5 minutes slow: its End tap is moved onto the server clock', async () => {
  const id = openWalk(ids.est, 910, 20);
  // The phone thinks it's 5 minutes earlier, so its tap reads "15 minutes in".
  const tap = new Date(Date.now() - 5 * 60000).toISOString();
  const r = await call('PUT', `/api/walks/${id}/end`, { user: EST, headers: clientNow(-5 * 60000), body: { endTappedAt: tap, finishLater: true } });
  assert.equal(r.status, 200, r.text);
  const secs = r.json.durationSeconds;
  assert.ok(secs >= 20 * 60 - 5 && secs <= 20 * 60 + 5, `about 20 minutes, got ${secs}`);
  // Small differences (network delay) aren't treated as a wrong clock.
  const id2 = openWalk(ids.est, 911, 10);
  const tap2 = new Date(Date.now() - 60000).toISOString();
  const r2 = await call('PUT', `/api/walks/${id2}/end`, { user: EST, headers: clientNow(-5000), body: { endTappedAt: tap2, finishLater: true } });
  assert.ok(Math.abs(r2.json.durationSeconds - 9 * 60) <= 2, `kept as sent, got ${r2.json.durationSeconds}`);
  // Nonsense headers are ignored.
  const id3 = openWalk(ids.est, 912, 10);
  const r3 = await call('PUT', `/api/walks/${id3}/end`, { user: EST, headers: { 'x-client-now': 'soon' }, body: { endTappedAt: new Date(Date.now() - 60000).toISOString(), finishLater: true } });
  assert.equal(r3.status, 200);
  for (const w of [id, id2, id3]) await call('PUT', `/api/walks/${w}`, { user: EST, body: { wrapUpDone: true } });
});

test('a walk the time limit stopped can be hand-ended only while its end screen waits; note kept, marked edited', async () => {
  const id = openWalk(ids.other, 913, 60);
  const autoEnd = ago(15);
  db((c) => c.prepare("UPDATE walks SET ended_at = ?, duration_seconds = 2700, auto_stopped = 1, wrap_up_pending = 1, notes = 'kept note' WHERE id = ?").run(autoEnd, id));
  // An offline End tapped before the limit, arriving late: still counts.
  const tap = ago(40);
  const r = await call('PUT', `/api/walks/${id}/end`, { user: OTHER, body: { endTappedAt: tap, finishLater: true } });
  assert.equal(r.status, 200, r.text);
  const w = walkRow(id);
  assert.equal(w.notes, 'kept note');
  assert.equal(w.edited, 1);
  assert.equal(w.original_ended_at, autoEnd);
  assert.equal(w.ended_at, new Date(tap).toISOString());
  // Once its end screen is saved, a stray late tap changes nothing.
  await call('PUT', `/api/walks/${id}`, { user: OTHER, body: { wrapUpDone: true } });
  db((c) => c.prepare('UPDATE walks SET auto_stopped = 1 WHERE id = ?').run(id));
  const late = await call('PUT', `/api/walks/${id}/end`, { user: OTHER, body: { endTappedAt: ago(50), finishLater: true } });
  assert.equal(late.status, 409);
  assert.equal(walkRow(id).ended_at, new Date(tap).toISOString());
});

test('a walk moved to another volunteer reads as moved, not deleted, on the old phone', async () => {
  const id = openWalk(ids.est, 914, 5);
  assert.equal((await call('PUT', `/api/walks/${id}/user`, { user: PRIV, body: { targetUserId: ids.priv } })).status, 200);
  const active = await call('GET', `/api/walks/active?walkId=${id}`, { user: EST });
  assert.equal(active.json.walkMissing, true);
  assert.equal(active.json.walkMoved, true);
  const save = await call('PUT', `/api/walks/${id}`, { user: EST, body: { notes: 'x' } });
  assert.equal(save.status, 403);
  assert.equal(save.json.notYourWalk, true);
  // A deleted one is just missing.
  assert.equal((await call('DELETE', `/api/walks/${id}`, { user: PRIV })).status, 200);
  const gone = await call('GET', `/api/walks/active?walkId=${id}`, { user: EST });
  assert.equal(gone.json.walkMissing, true);
  assert.equal(gone.json.walkMoved, false);
});

test('deleting data or the account waits until the walk in progress is ended', async () => {
  const id = openWalk(ids.other, 915, 5);
  for (const url of ['/api/me/data', '/api/me']) {
    const r = await call('DELETE', url, { user: OTHER, body: { confirm: 'DELETE' } });
    assert.equal(r.status, 409, url);
    assert.match(r.json.error, /still out with A2dog915\. End that first/);
  }
  assert.ok(walkRow(id), 'the walk is untouched');
  assert.equal(walkRow(id).user_id, ids.other);
  db((c) => c.prepare('DELETE FROM walks WHERE id = ?').run(id));
});

// ---- Privacy ----
test('recent walk counts start at shelter midnight, so the count can\'t time a walk', async () => {
  const shelterDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  // 7 days and 1 minute ago (still inside: same shelter day as 7 days ago, noon-ish test clock).
  db((c) => c.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (916, ?, ?, ?, 600)').run(ids.other, ago(7 * 1440 + 1), ago(7 * 1440 - 9)));
  // 8 days ago: outside.
  db((c) => c.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (916, ?, ?, ?, 600)').run(ids.other, ago(8 * 1440), ago(8 * 1440 - 10)));
  const d = await dog(916, EST);
  if (shelterDay(new Date(Date.now() - 7 * 86400000 - 60000)) === shelterDay(new Date(Date.now() - 7 * 86400000))) {
    assert.equal(d.recentWalkCount, 1);
  }
});

test('tip and Playgroup note ids are opaque, and still work for edit and delete', async () => {
  const tip = await call('POST', '/api/dogs/917/notes', { user: EST, body: { body: 'likes squeaky toys' } });
  assert.match(tip.json.id, /^[A-Za-z0-9_-]{22}$/);
  const list = (await call('GET', '/api/dogs/917/notes', { user: OTHER })).json.sharedTips;
  assert.equal(list[0].id, tip.json.id);
  const rowId = db((c) => c.prepare("SELECT id FROM dog_notes WHERE body = 'likes squeaky toys'").get().id);
  assert.equal((await call('PUT', `/api/dogs/917/notes/${rowId}`, { user: OTHER, body: { body: 'x' } })).status, 404, 'the row id is not accepted');
  assert.equal((await call('PUT', `/api/dogs/917/notes/${tip.json.id}`, { user: OTHER, body: { body: 'loves squeaky toys' } })).status, 200);
  assert.equal((await call('DELETE', `/api/dogs/918/notes/${tip.json.id}`, { user: OTHER })).status, 404, 'only on its own dog');
  assert.equal((await call('DELETE', `/api/dogs/917/notes/${tip.json.id}`, { user: OTHER })).status, 200);

  const pg = await call('POST', '/api/dogs/917/playgroup-notes', { user: EST, body: { body: 'played nicely' } });
  assert.match(pg.json.id, /^[A-Za-z0-9_-]{22}$/);
  const pgList = (await call('GET', '/api/dogs/917/playgroup-notes', { user: OTHER })).json.notes;
  assert.equal(pgList[0].id, pg.json.id);
  assert.equal((await call('PUT', `/api/dogs/917/playgroup-notes/${pg.json.id}`, { user: OTHER, body: { body: 'played very nicely' } })).status, 200);
  const pgRow = db((c) => c.prepare("SELECT id FROM playgroup_notes WHERE body = 'played very nicely'").get().id);
  assert.equal((await call('DELETE', `/api/dogs/917/playgroup-notes/${pgRow}`, { user: OTHER })).status, 404);
  assert.equal((await call('DELETE', `/api/dogs/917/playgroup-notes/${pg.json.id}`, { user: OTHER })).status, 200);
});

test('walker chat live events say `mine` per reader and never carry an account id', async () => {
  assert.equal((await call('PUT', '/api/modules/walker-chat', { user: PRIV, staff: true, body: { enabled: true } })).status, 200);
  const listen = async (user) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/modules/walker-chat/stream`, { headers: { 'x-auth-email': user }, signal: ac.signal });
    const reader = res.body.getReader();
    let buf = '';
    const next = async (event) => {
      for (;;) {
        const m = new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`).exec(buf);
        if (m) { buf = buf.slice(m.index + m[0].length); return JSON.parse(m[1]); }
        const { value, done } = await reader.read();
        if (done) return null;
        buf += Buffer.from(value).toString();
      }
    };
    return { next, close: () => ac.abort() };
  };
  const a = await listen(EST);
  const b = await listen(OTHER);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call('POST', '/api/modules/walker-chat/typing', { user: EST, body: {} })).status, 200);
  assert.equal((await call('POST', '/api/modules/walker-chat/messages', { user: EST, body: { body: 'hello' } })).status, 200);
  const typingB = await b.next('typing');
  assert.equal(typingB.userId, undefined);
  assert.equal(typeof typingB.who, 'string');
  const forA = await a.next('message');
  const forB = await b.next('message');
  assert.equal(forA.mine, true);
  assert.equal(forB.mine, false);
  assert.equal(forA.userId, undefined);
  assert.equal(forB.userId, undefined);
  assert.equal(forB.who, typingB.who);
  a.close(); b.close();
});

test('Download my data includes Playgroup notes, chat, walk activity, preferences and push devices', async () => {
  await call('POST', '/api/dogs/919/playgroup-notes', { user: EST, body: { body: 'export me' } });
  const keys = { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 3).toString('base64url') };
  await call('POST', '/api/push/subscribe', { user: EST, body: { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/a2export', keys } } });
  const exp = (await call('GET', '/api/me/export', { user: EST })).json;
  assert.ok(exp.playgroupNotesWritten.some((n) => n.body === 'export me'));
  assert.ok(exp.chatMessages.some((m) => m.body === 'hello'));
  assert.ok(exp.walks.length && exp.walks.every((w) => typeof w.activity === 'string'));
  assert.ok('speciesPref' in exp.profile && 'desktopView' in exp.profile);
  assert.deepEqual(exp.pushSubscriptions.map((s) => s.service), ['fcm.googleapis.com']);
  assert.ok(!JSON.stringify(exp).includes('a2export'), 'not the endpoint itself');
});

// ---- Input checks ----
test('saved filters have size, name and count caps', async () => {
  const url = `/api/users/${ids.other}/saved-filters`;
  assert.equal((await call('POST', url, { user: OTHER, body: { name: 'x'.repeat(61), filter: {} } })).status, 400);
  assert.equal((await call('POST', url, { user: OTHER, body: { name: 'big', filter: { a: 'x'.repeat(5000) } } })).status, 400);
  assert.equal((await call('POST', url, { user: OTHER, body: { name: ['n'], filter: {} } })).status, 400);
  for (let i = 0; i < 30; i += 1) assert.equal((await call('POST', url, { user: OTHER, body: { name: `f${i}`, filter: { i } } })).status, 200);
  assert.equal((await call('POST', url, { user: OTHER, body: { name: 'one more', filter: {} } })).status, 409);
  const first = (await call('GET', url, { user: OTHER })).json.filters[0];
  assert.equal((await call('PUT', `${url}/${first.id}`, { user: OTHER, body: { filter: { a: 'x'.repeat(5000) } } })).status, 400);
});

test('a JSON field shaped like {"toString": …} is a 400, not a 500', async () => {
  const bad = { toString: 'x' };
  for (const [m, u, body] of [
    ['PUT', `/api/walks/1/end`, { notes: bad }],
    ['POST', '/api/dogs/920/notes', { body: bad }],
    ['PUT', '/api/manual-checkoffs', { dogId: 920, dateKey: { valueOf: 1 }, slotIndex: 0 }],
    ['POST', '/api/walks/start', { dogId: 920, location: { nested: { toString: 1 } } }]
  ]) {
    const r = await call(m, u, { user: OTHER, body });
    assert.equal(r.status, 400, `${m} ${u}: ${r.status} ${r.text}`);
  }
});

test('special days: impossible dates are refused; changing or removing one retires its alert', async () => {
  const staff = { user: PRIV, staff: true };
  assert.equal((await call('PUT', '/api/staff/schedule/days/2026-13-45', { ...staff, body: { mode: 'closed' } })).status, 400);
  assert.equal((await call('PUT', '/api/staff/schedule/days/2027-02-30', { ...staff, body: { mode: 'closed' } })).status, 400);
  const day = shelterDayFromToday(120); // relative: a typed-out date expires (audit3)
  const live = (id) => db((c) => {
    const r = c.prepare("SELECT expires_at FROM shelter_events WHERE id = ? AND kind = 'alert'").get(id);
    return !!r && (!r.expires_at || r.expires_at > new Date().toISOString());
  });
  const first = await call('PUT', `/api/staff/schedule/days/${day}`, { ...staff, body: { mode: 'hours', open: '07:00', close: '09:59', notify: true } });
  assert.equal(first.status, 200, first.text);
  assert.ok(live(first.json.alert.id), 'the new alert is in Updates');
  // Changing the day (with or without a new alert) retires what was said before.
  const second = await call('PUT', `/api/staff/schedule/days/${day}`, { ...staff, body: { mode: 'hours', open: '07:00', close: '12:00', notify: true } });
  assert.ok(!live(first.json.alert.id), 'the earlier alert no longer shows');
  assert.ok(live(second.json.alert.id));
  await call('PUT', `/api/staff/schedule/days/${day}`, { ...staff, body: { mode: 'note', note: 'Busy day' } });
  assert.ok(!live(second.json.alert.id));
  // Removing the day retires its alert too.
  const third = await call('PUT', `/api/staff/schedule/days/${day}`, { ...staff, body: { mode: 'closed', notify: true } });
  assert.equal((await call('DELETE', `/api/staff/schedule/days/${day}`, staff)).status, 200);
  assert.ok(!live(third.json.alert.id));
});

test('a photo that can\'t be made into a thumbnail is remembered and the silhouette stands in', async () => {
  const fs = require('fs');
  const path = require('path');
  const imagesDir = path.join(server.dir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const src = path.join(imagesDir, '921.jpg');
  fs.writeFileSync(src, Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${' '.repeat(600)}</svg>`));
  const r = await fetch(`${base}/cached-images/thumbs/921.jpg`, { headers: { 'x-auth-email': EST }, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/dog-silhouettes\//);
  assert.match(r.headers.get('cache-control'), /max-age=3600/);
  const again = await fetch(`${base}/cached-images/thumbs/921.jpg`, { headers: { 'x-auth-email': EST }, redirect: 'manual' });
  assert.equal(again.status, 302);
  assert.ok(!fs.existsSync(path.join(imagesDir, 'thumbs', '921.jpg')));
});

test('production refuses the example pepper and short ones', async () => {
  for (const pepper of ['change-me', 'too-short-pepper']) {
    await assert.rejects(
      () => startServer({ prefix: 'sw-a2-pepper-', env: { NODE_ENV: 'production', INTERNAL_API_TOKEN: 'a-real-token-for-this-test', EMAIL_HASH_PEPPER: pepper } }),
      /EMAIL_HASH_PEPPER is the example value or shorter than 32/
    );
  }
});
