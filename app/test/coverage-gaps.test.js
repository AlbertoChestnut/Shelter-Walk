// API endpoints that had no direct tests (audit 2026-11-10, eng "Walker-chat
// and many endpoints have no tests"): push, saved filters, for-day, manual
// checkoffs, QR codes, walk-stats, shelter trends, Guide reordering,
// onboarding/updates-seen, client errors, experience levels and walker chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let server, base, dbFile;
const ALICE = 'alice.gaps@example.com';
const BOB = 'bob.gaps@example.com';
const STAFF = 'staff.gaps@example.com';
const ids = {};

async function call(method, url, { user = ALICE, staff = false, body, raw } = {}) {
  const headers = { 'content-type': 'application/json', ...(user ? { 'x-auth-email': user } : {}), ...(staff ? { 'x-auth-staff': '1' } : {}) };
  const res = await fetch(base + url, { method, headers, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const H = 3600000;
const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

test.before(async () => {
  server = await startServer({ prefix: 'sw-gaps-', env: { DISABLE_MODULE_JOBS: '1' } });
  ({ base, dbFile } = server);
  for (const [k, e] of [['alice', ALICE], ['bob', BOB], ['staff', STAFF]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, location, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?, ?)");
  dog.run(1, 'Rex', 1, 'Shelter', now, now);
  dog.run(2, 'Luna', 1, 'Shelter', now, now);
  dog.run(3, 'Fido', 1, 'In Foster', now, now);
  dog.run(4, 'Gone', 0, 'Shelter', now, now);
  const walk = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, ?, ?)');
  walk.run(1, ids.alice, iso(2 * H), iso(2 * H - 600000), 600, 'walk');
  walk.run(1, ids.alice, iso(30 * H), iso(30 * H - 900000), 900, 'walk');
  walk.run(1, ids.bob, iso(3 * H), iso(3 * H - 1200000), 1200, 'walk');
  walk.run(2, ids.bob, iso(10 * 60000), null, null, 'walk'); // in progress
  db.close();
});
test.after(async () => { if (server) await server.stop(); });

test('push: vapid key, subscribe validation, and unsubscribe only touches your own', async () => {
  const key = await call('GET', '/api/push/vapid-public-key');
  assert.equal(key.status, 200);
  assert.equal(typeof key.json, 'object');

  const p256dh = Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url');
  const auth = crypto.randomBytes(16).toString('base64url');
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(8).toString('hex')}`;
  const sub = (s, user = ALICE) => call('POST', '/api/push/subscribe', { user, body: { subscription: s } });

  assert.equal((await call('POST', '/api/push/subscribe', { body: {} })).status, 400, 'no subscription');
  assert.equal((await sub({ endpoint: 'https://evil.example.com/push', keys: { p256dh, auth } })).status, 400, 'not a push service');
  assert.equal((await sub({ endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: { p256dh, auth } })).status, 400, 'plain http');
  assert.equal((await sub({ endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x', keys: { p256dh, auth } })).status, 400, 'non-default port');
  assert.equal((await sub({ endpoint: 'https://127.0.0.1/x', keys: { p256dh, auth } })).status, 400, 'internal host');
  assert.equal((await sub({ endpoint, keys: { p256dh: 'abc', auth } })).status, 400, 'bad p256dh');
  assert.equal((await sub({ endpoint, keys: { p256dh, auth: 'abc' } })).status, 400, 'bad auth');
  assert.equal((await sub({ endpoint })).status, 400, 'no keys');

  assert.equal((await sub({ endpoint, keys: { p256dh, auth } })).status, 200);
  const otherKeys = { p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  assert.equal((await sub({ endpoint, keys: otherKeys }, BOB)).status, 409, 'knowing the endpoint alone does not take it over');

  const owner = () => { const db = new Database(dbFile, { readonly: true }); const r = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint); db.close(); return r && r.user_id; };
  assert.equal(owner(), ids.alice);
  assert.equal((await call('POST', '/api/push/unsubscribe', { body: {} })).status, 400, 'endpoint required');
  assert.equal((await call('POST', '/api/push/unsubscribe', { user: BOB, body: { endpoint } })).status, 200);
  assert.equal(owner(), ids.alice, "someone else's unsubscribe changes nothing");
  assert.equal((await call('POST', '/api/push/unsubscribe', { body: { endpoint } })).status, 200);
  assert.equal(owner(), undefined, 'your own unsubscribe removes it');
});

test('saved filters: create, list, rename, delete; only your own', async () => {
  const url = `/api/users/${ids.alice}/saved-filters`;
  assert.equal((await call('POST', url, { body: { filter: { male: true } } })).status, 400, 'name required');
  assert.equal((await call('POST', url, { body: { name: '  ', filter: { male: true } } })).status, 400, 'blank name');
  assert.equal((await call('POST', url, { body: { name: 'Boys' } })).status, 400, 'filter required');

  const made = await call('POST', url, { body: { name: ' Boys ', filter: { male: true } } });
  assert.equal(made.status, 200);
  assert.equal(made.json.name, 'Boys');
  const list = await call('GET', url);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.filters.map((f) => [f.name, f.filter]), [['Boys', { male: true }]]);

  const renamed = await call('PUT', `${url}/${made.json.id}`, { body: { name: 'Lads' } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.name, 'Lads');
  assert.deepEqual(renamed.json.filter, { male: true }, 'filter kept when only the name changes');
  assert.equal((await call('PUT', `${url}/999999`, { body: { name: 'x' } })).status, 404);

  // Bob can neither see nor change Alice's presets.
  assert.equal((await call('GET', url, { user: BOB })).status, 403);
  assert.equal((await call('POST', url, { user: BOB, body: { name: 'x', filter: {} } })).status, 403);
  assert.equal((await call('DELETE', `${url}/${made.json.id}`, { user: BOB })).status, 403);
  assert.equal((await call('GET', `/api/users/${ids.bob}/saved-filters`, { user: BOB })).json.filters.length, 0);

  assert.equal((await call('DELETE', `${url}/${made.json.id}`)).status, 200);
  assert.equal((await call('DELETE', `${url}/${made.json.id}`)).status, 404, 'already gone');
  assert.equal((await call('GET', url)).json.filters.length, 0);
});

test('walks/for-day: validated range, finished walks only, plus manual checkoffs', async () => {
  assert.equal((await call('GET', '/api/walks/for-day')).status, 400, 'range required');
  assert.equal((await call('GET', `/api/walks/for-day?fromUtc=yesterday&toUtc=${iso(0)}`)).status, 400, 'not a time');
  assert.equal((await call('GET', `/api/walks/for-day?fromUtc=${iso(0)}&toUtc=${iso(H)}`)).status, 400, 'reversed');
  assert.equal((await call('GET', `/api/walks/for-day?fromUtc=${iso(49 * H)}&toUtc=${iso(0)}`)).status, 400, 'over 48 hours');

  const r = await call('GET', `/api/walks/for-day?fromUtc=${encodeURIComponent(iso(4 * H))}&toUtc=${encodeURIComponent(iso(-H))}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.walks.map((w) => w.dog_id).sort(), [1, 1], 'two finished walks of Rex; the open walk is left out');
  // security3: only { dog_id, slotIndex } (the grid's window), no times.
  assert.ok(r.json.walks.every((w) => Object.keys(w).sort().join() === 'dog_id,slotIndex'), 'no walker, notes or times');
  assert.deepEqual(r.json.manualCheckoffs, [], 'no dateKey, no checkoffs');

  // 30 hours before noon is 6 am, before the first walk window: nothing to draw.
  const old = await call('GET', `/api/walks/for-day?fromUtc=${encodeURIComponent(iso(31 * H))}&toUtc=${encodeURIComponent(iso(29 * H))}`);
  assert.equal(old.json.walks.length, 0);
});

test('manual checkoffs: set, read, clear, and show up in for-day', async () => {
  const key = todayKey();
  assert.equal((await call('GET', '/api/manual-checkoffs?dogId=2')).status, 400, 'dateKey required');
  assert.equal((await call('GET', '/api/manual-checkoffs?dogId=2&dateKey=Nov-10')).status, 400, 'invalid date');
  assert.equal((await call('PUT', '/api/manual-checkoffs', { body: { dogId: 2, dateKey: key, checked: true } })).status, 400, 'slotIndex required');
  assert.equal((await call('PUT', '/api/manual-checkoffs', { body: { dogId: 'x', dateKey: key, slotIndex: 1, checked: true } })).status, 400, 'bad dogId');
  assert.equal((await call('PUT', '/api/manual-checkoffs', { body: { dogId: 2, dateKey: key, slotIndex: 'abc', checked: true } })).status, 400, 'bad slotIndex');

  const put = await call('PUT', '/api/manual-checkoffs', { body: { dogId: 2, dateKey: key, slotIndex: 3, checked: true } });
  assert.equal(put.status, 200);
  assert.equal(put.json.checked, true);
  assert.equal((await call('PUT', '/api/manual-checkoffs', { body: { dogId: 2, dateKey: key, slotIndex: 3, checked: true } })).status, 200, 'idempotent');
  assert.deepEqual((await call('GET', `/api/manual-checkoffs?dogId=2&dateKey=${key}`)).json.slots, [3]);

  const day = await call('GET', `/api/walks/for-day?dateKey=${key}&fromUtc=${encodeURIComponent(iso(4 * H))}&toUtc=${encodeURIComponent(iso(-H))}`);
  assert.deepEqual(day.json.manualCheckoffs, [{ dog_id: 2, slotIndex: 3 }]);

  assert.equal((await call('PUT', '/api/manual-checkoffs', { body: { dogId: 2, dateKey: key, slotIndex: 3, checked: false } })).status, 200);
  assert.deepEqual((await call('GET', `/api/manual-checkoffs?dogId=2&dateKey=${key}`)).json.slots, []);
});

test('dog QR code is an SVG for known dogs only', async () => {
  const r = await call('GET', '/api/dogs/1/qr.svg');
  assert.equal(r.status, 200);
  assert.match(r.type, /^image\/svg\+xml/);
  assert.match(r.text, /^<svg[\s>]/);
  assert.equal((await call('GET', '/api/dogs/999/qr.svg')).status, 404);
});

test('walk-stats: your own finished walks, everyone total, and a userId in the query is ignored', async () => {
  assert.equal((await call('GET', '/api/dogs/999/walk-stats')).status, 404);
  const mine = await call('GET', '/api/dogs/1/walk-stats');
  assert.equal(mine.status, 200);
  assert.equal(mine.json.mine.count, 2);
  assert.equal(mine.json.mine.totalSeconds, 1500);
  assert.equal(mine.json.mine.longestSeconds, 900);
  assert.equal(mine.json.everyone.count, 3);
  assert.equal(mine.json.everyone.totalSeconds, 2700);

  const sneaky = await call('GET', `/api/dogs/1/walk-stats?userId=${ids.bob}`);
  assert.deepEqual(sneaky.json.mine, mine.json.mine, "asking for Bob's id still returns Alice's numbers");

  // Release check: everyone.count equals the rows in walk-history.
  const hist = await call('GET', '/api/dogs/1/walk-history');
  assert.equal(hist.json.walks.length, mine.json.everyone.count);
  // A dog whose only walk is still going has nothing yet.
  const open = await call('GET', '/api/dogs/2/walk-stats', { user: BOB });
  assert.equal(open.json.mine.count, 0);
  assert.equal(open.json.everyone.count, 0);
});

test('shelter-trends: species handling and floor + foster = listed', async () => {
  const dogs = await call('GET', '/api/shelter-trends');
  assert.equal(dogs.status, 200);
  assert.equal(dogs.json.species, 'dog');
  assert.equal((await call('GET', '/api/shelter-trends?species=bogus')).json.species, 'dog', 'unknown species falls back to dogs');
  const cats = await call('GET', '/api/shelter-trends?species=cat');
  assert.equal(cats.json.species, 'cat');
  assert.equal(cats.json.listedNow, 0);

  assert.equal(dogs.json.listedNow, 3, 'three listed dogs (one in foster), the delisted one left out');
  assert.equal(dogs.json.fosterNow, 1);
  assert.equal(dogs.json.floorNow, 2);
  assert.ok(Array.isArray(dogs.json.days) && dogs.json.days.length > 0);
  for (const d of dogs.json.days) {
    if (d.floor != null) assert.equal(d.floor + d.foster, d.listed, `floor + foster = listed on ${d.dateKey}`);
  }
  assert.doesNotMatch(dogs.text, /NaN|Infinity/);
});

test('Guide: moving a section is staff-only and swaps neighbours', async () => {
  const order = async () => (await call('GET', '/api/wiki')).json.sections.map((s) => s.id);
  for (const title of ['Gaps A', 'Gaps B']) {
    assert.equal((await call('POST', '/api/wiki', { staff: true, user: STAFF, body: { title, icon: '📘', body: '<p>x</p>' } })).status, 200);
  }
  const before = await order();
  assert.ok(before.length >= 2);
  const last = before[before.length - 1];
  const first = before[0];

  assert.equal((await call('PUT', `/api/wiki/${last}/move`, { body: { direction: 'up' } })).status, 403, 'volunteers cannot reorder');
  assert.deepEqual(await order(), before);
  assert.equal((await call('PUT', '/api/wiki/999999/move', { staff: true, user: STAFF, body: { direction: 'up' } })).status, 404);

  assert.equal((await call('PUT', `/api/wiki/${last}/move`, { staff: true, user: STAFF, body: { direction: 'up' } })).status, 200);
  const after = await order();
  assert.deepEqual(after.slice(-2), [last, before[before.length - 2]], 'the last section moved up one');
  assert.equal((await call('PUT', `/api/wiki/${first}/move`, { staff: true, user: STAFF, body: { direction: 'up' } })).status, 200);
  assert.deepEqual(await order(), after, 'the first section cannot move further up');
});

test('onboarding-complete and updates-seen: your own account only', async () => {
  assert.equal((await call('POST', `/api/users/${ids.bob}/onboarding-complete`)).status, 403);
  const done = await call('POST', `/api/users/${ids.alice}/onboarding-complete`);
  assert.equal(done.status, 200);
  assert.equal(done.json.onboardingCompleted, true);
  assert.equal((await call('GET', '/api/me')).json.onboardingCompleted, true);
  assert.equal((await call('GET', '/api/me', { user: BOB })).json.onboardingCompleted, false);

  const seenAt = (id) => { const db = new Database(dbFile, { readonly: true }); const r = db.prepare('SELECT updates_last_seen_at AS at FROM users WHERE id = ?').get(id); db.close(); return r.at; };
  const bobBefore = seenAt(ids.bob);
  assert.equal((await call('PUT', `/api/users/${ids.bob}/updates-seen`)).status, 403);
  const seen = await call('PUT', `/api/users/${ids.alice}/updates-seen`);
  assert.equal(seen.status, 200);
  assert.ok(!Number.isNaN(Date.parse(seen.json.seenAt)));
  assert.equal(seenAt(ids.alice), seen.json.seenAt);
  assert.equal(seenAt(ids.bob), bobBefore, "Bob's marker is untouched");
});

test('client-error: accepted without sign-in, answers 204 with no body', async () => {
  const r = await call('POST', '/api/client-error', { user: null, body: { message: 'TypeError: x is undefined', source: 'app.js:1:2', stack: 'at foo' } });
  assert.equal(r.status, 204);
  assert.equal(r.text, '');
  assert.equal((await call('POST', '/api/client-error', { body: { message: 'x'.repeat(5000) } })).status, 204, 'long messages are clipped, not refused');
  assert.equal((await call('POST', '/api/client-error', { user: null, raw: '{bad json' })).status < 500, true, 'bad JSON never 500s');
  assert.equal((await call('POST', '/api/not-a-route', { user: null })).status, 401, 'other routes still need sign-in');
});

test('experience-levels lists every tier with a label', async () => {
  const r = await call('GET', '/api/experience-levels');
  assert.equal(r.status, 200);
  const keys = r.json.levels.map((l) => l.key);
  assert.ok(keys.includes('beginner'));
  assert.equal(new Set(keys).size, keys.length);
  for (const l of r.json.levels) assert.ok(l.label && typeof l.label === 'string', `${l.key} has a label`);
});

test('walker-chat: off by default, then send, read, stream and staff delete', async () => {
  const msgs = '/api/modules/walker-chat/messages';
  assert.equal((await call('GET', msgs)).status, 404, 'disabled module hides its routes');
  assert.equal((await call('PUT', '/api/modules/walker-chat', { staff: true, user: STAFF, body: { enabled: true } })).status, 200);

  assert.deepEqual((await call('GET', msgs)).json.messages, []);
  assert.equal((await call('POST', msgs, { body: { body: '   ' } })).status, 400, 'empty message refused');
  const sent = await call('POST', msgs, { body: { body: `  ${'x'.repeat(1200)}  ` } });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.message.body.length, 1000, 'capped at 1000 characters');
  assert.equal(sent.json.message.mine, true);
  assert.equal((await call('POST', msgs, { body: { body: 'Rex is out' } })).status, 200);

  const bobView = await call('GET', msgs, { user: BOB });
  assert.deepEqual(bobView.json.messages.map((m) => [m.body.slice(0, 10), m.mine]), [['xxxxxxxxxx', false], ['Rex is out', false]]);
  assert.ok(bobView.json.messages.every((m) => !('userId' in m)), 'no user ids in the history');
  assert.equal((await call('POST', '/api/modules/walker-chat/typing')).status, 200);

  // The stream opens as SSE and says hello.
  const ac = new AbortController();
  const res = await fetch(`${base}/api/modules/walker-chat/stream`, { headers: { 'x-auth-email': BOB }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /: connected/);
  ac.abort();

  const id = sent.json.message.id;
  assert.equal((await call('DELETE', `${msgs}/${id}`)).status, 403, 'volunteers cannot delete');
  assert.equal((await call('DELETE', `${msgs}/${id}`, { staff: true, user: STAFF })).status, 200);
  assert.equal((await call('DELETE', `${msgs}/${id}`, { staff: true, user: STAFF })).status, 404);
  assert.equal((await call('GET', msgs)).json.messages.length, 1);
  assert.equal((await call('GET', '/api/modules/walker-chat/stream', { user: null })).status, 401, 'no sign-in, no stream');
});
