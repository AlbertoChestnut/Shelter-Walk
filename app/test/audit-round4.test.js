// Round 4 fixes (2026-11-10): a walk deleted on another device is reported
// as missing (walkMissing), shelter-wide walk times are coarse (lastWalkedAt
// to the walk window; others' totals and Together rows to 5 minutes), every
// /api answer carries the server's build, a fast phone clock can't stop End,
// and walker chat allows 6 streams per account and frees a slot when one
// goes away. The browser side (cache wipe, sign-out, build reload, chat
// reconnect, deleted-walk screen) is in smoke/audit-round4.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;
const WALKER = 'walker.r4@example.com';
const OTHER = 'other.r4@example.com';
const THIRD = 'third.r4@example.com';
const STAFF = 'staff.r4@example.com';

async function call(method, url, { user = WALKER, body, staff } = {}) {
  const h = { 'x-auth-email': user };
  if (staff) h['x-auth-staff'] = '1';
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const withDb = (fn) => { const db = new Database(dbFile); try { return fn(db); } finally { db.close(); } };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const shelterParts = (iso) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));

const ids = {};
test.before(async () => {
  server = await startServer({ prefix: 'sw-r4-' });
  ({ base, dbFile } = server);
  for (const [k, e] of [['walker', WALKER], ['other', OTHER], ['third', THIRD]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  ids.staff = (await call('GET', '/api/me', { user: STAFF, staff: true })).json.id;
  withDb((db) => {
    const now = new Date().toISOString();
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, location, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, 'Kennel B', ?, ?)");
    for (let d = 1; d <= 6; d += 1) dog.run(d, `Dog${d}`, now, now);
    db.prepare("UPDATE users SET experience_level = 'expert', onboarding_completed = 1").run();
  });
});
test.after(() => server && server.stop());

const start = (dogId, user = WALKER) => call('POST', '/api/walks/start', { user, body: { dogId, userId: 1, activity: 'walk' } });

// ---- #2 a walk deleted on another device ----
test('#2 /api/walks/active?walkId= says when that walk is gone (deleted, or not yours)', async () => {
  const s = await start(1);
  assert.equal(s.status, 200, s.text);
  const id = s.json.walkId;
  let r = await call('GET', `/api/walks/active?userId=1&walkId=${id}`);
  assert.equal(r.json.walkMissing, false);
  assert.equal(r.json.walk.id, id);
  assert.equal((await call('GET', `/api/walks/active?userId=1&walkId=${id}`, { user: OTHER })).json.walkMissing, true, "someone else's walk is never confirmed");
  assert.equal((await call('DELETE', `/api/walks/${id}`)).status, 200);
  r = await call('GET', `/api/walks/active?userId=1&walkId=${id}`);
  assert.equal(r.json.walkMissing, true);
  assert.equal(r.json.walk, null);
  assert.ok(!('walkMissing' in (await call('GET', '/api/walks/active?userId=1')).json), 'only when asked');
  // End and Save on the finish screen get a 404 for it (the app then clears it).
  assert.equal((await call('PUT', `/api/walks/${id}/end`, { body: { endTappedAt: ago(0), finishLater: true } })).status, 404);
  assert.equal((await call('PUT', `/api/walks/${id}`, { body: { wrapUpDone: true } })).status, 404);
});

// ---- #3 coarse times for everyone else ----
test('#3 lastWalkedAt is the shelter day and walk window, on the list and the dog', async () => {
  // Another volunteer's walk at 10:37 shelter time today (the clock is pinned to midday).
  const today = shelterParts(new Date().toISOString());
  // 10:37 shelter time, whatever the DST offset.
  const t = ['-04:00', '-05:00'].map((off) => new Date(`${today.year}-${today.month}-${today.day}T10:37:00${off}`).getTime())
    .find((ms) => shelterParts(new Date(ms).toISOString()).hour === '10');
  withDb((db) => db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (2, ?, ?, ?, 1337, ?)')
    .run(ids.other, new Date(t).toISOString(), new Date(t + 1337000).toISOString(), 'walk'));
  const list = await call('GET', '/api/dogs');
  const d = (list.json.dogs || list.json).find((x) => x.id === 2);
  const one = (await call('GET', '/api/dogs/2')).json.dog;
  for (const seen of [d.lastWalkedAt, one.lastWalkedAt]) {
    const p = shelterParts(seen);
    assert.equal(`${p.year}-${p.month}-${p.day}`, `${today.year}-${today.month}-${today.day}`, 'same shelter day');
    assert.equal(`${p.hour}:${p.minute}`, '10:00', `the start of the 10-1 window, not the real time (${seen})`);
  }
  assert.ok(!list.text.includes(new Date(t).toISOString()), 'the exact start is nowhere in the list');
});

test('#3 other volunteers\' totals are to 5 minutes (walk-stats and walk-history); your own stay exact', async () => {
  withDb((db) => {
    const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (3, ?, ?, ?, ?, ?)');
    ins.run(ids.walker, ago(300), ago(290), 601, 'walk');
    ins.run(ids.other, ago(200), ago(180), 1234, 'walk');
  });
  const ws = (await call('GET', '/api/dogs/3/walk-stats')).json;
  assert.equal(ws.mine.totalSeconds, 601);
  assert.equal(ws.everyone.count, 2);
  assert.equal(ws.everyone.totalSeconds, 601 + 1200, 'mine exact + the other walk to the nearest 5 minutes');
  const hist = (await call('GET', '/api/dogs/3/walk-history')).json;
  assert.deepEqual(hist.totals, ws.everyone);
  // Subtracting your own gives no exact length of anyone else's.
  assert.equal((ws.everyone.totalSeconds - ws.mine.totalSeconds) % 300, 0);
  const otherView = (await call('GET', '/api/dogs/3/walk-stats', { user: OTHER })).json;
  assert.equal(otherView.everyone.totalSeconds, 1234 + 600, 'the other walker sees theirs exact, mine rounded');
});

test('#3 a Together day: others\' engagements have a session and a rounded length, no clock times', async () => {
  // Yesterday around noon at the shelter, so all three land on one day
  // whatever the clock (TEST_CLOCK=real or any TEST_CLOCK=<ISO>).
  const { shelterClock, shelterTimeToDate } = require('../src/walkHours');
  const c = shelterClock(Date.now() - 86400000);
  const noon = shelterTimeToDate(c.y, c.m, c.d, 12 * 60).getTime();
  const before = (min) => new Date(noon - min * 60000).toISOString();
  withDb((db) => {
    const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(4, ids.walker, before(100), before(90), 607, 'walk');
    ins.run(5, ids.other, before(80), before(60), 1111, 'walk');
    ins.run(6, ids.third, before(70), before(50), 1499, 'walk');
  });
  const day = shelterParts(before(100));
  const date = `${day.year}-${day.month}-${day.day}`;
  const r = await call('GET', `/api/impact/day?date=${date}`);
  assert.equal(r.status, 200, r.text);
  const list = (await call('GET', '/api/impact?days=2')).json.days.find((d) => d.dateKey === date);
  assert.equal(r.json.totals.seconds, list.seconds, 'exact day total = the Together list row');
  assert.equal(r.json.totals.walks, r.json.walks.length);
  for (const w of r.json.walks) {
    if (w.mine) assert.ok(w.startedAt && w.endedAt);
    else {
      assert.ok(!('startedAt' in w) && !('endedAt' in w), 'no times on someone else\'s');
      assert.equal(w.durationSeconds % 300, 0);
      assert.ok(Number.isInteger(w.slot));
    }
  }
  assert.ok(!r.text.includes('1111') && !r.text.includes('1499'), 'no exact length of anyone else\'s');
  assert.ok(r.json.walks.some((w) => w.mine && w.durationSeconds === 607), 'mine stays exact');
});

// ---- #4 build version ----
test('#4 every /api answer says the server build, the same one the page loads its scripts with', async () => {
  const page = await fetch(`${base}/`, { headers: { 'x-auth-email': WALKER } }).then((r) => r.text());
  const v = /\/js\/app\.js\?v=([\w-]+)/.exec(page);
  assert.ok(v, 'app.js has a ?v=');
  for (const url of ['/api/me', '/api/dogs', '/api/walks/active?userId=1']) {
    assert.equal((await call('GET', url)).headers.get('x-app-build'), v[1], url);
  }
  assert.equal((await call('GET', '/api/nope')).headers.get('x-app-build'), v[1], 'errors too');
});

test('#4 the page reloads for a new build only when nothing is under way', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const grab = (re) => { const m = re.exec(src); assert.ok(m, String(re)); return m[0]; };
  const code = [
    grab(/function busyForReload\(\) \{[\s\S]*?\n {2}\}/),
    grab(/function applyNewBuild\(\) \{[\s\S]*?\n {2}\}/)
  ].join('\n');
  const make = ({ phase = 'idle', draft = null, overlay = false, reloadedFor = null } = {}) => {
    const out = { reloads: 0, banner: 0 };
    const session = new Map(reloadedFor ? [['dogwalk_build_reload', reloadedFor]] : []);
    const ctx = {
      state: { walk: { phase } },
      END_DRAFT_KEY: 'dogwalk_end_draft',
      BUILD_RELOAD_KEY: 'dogwalk_build_reload',
      serverBuild: 'new',
      localStorage: { getItem: (k) => (k === 'dogwalk_end_draft' ? draft : null) },
      sessionStorage: { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, v) },
      document: { querySelector: () => (overlay ? {} : null), activeElement: { tagName: 'BODY', isContentEditable: false } },
      window: { location: { reload: () => { out.reloads += 1; } } },
      showNewBuildBanner: () => { out.banner += 1; }
    };
    vm.runInNewContext(`${code}\napplyNewBuild();`, ctx);
    return out;
  };
  assert.deepEqual(make(), { reloads: 1, banner: 0 }, 'idle: reloads');
  assert.deepEqual(make({ phase: 'scanning' }), { reloads: 1, banner: 0 });
  for (const phase of ['active', 'ending', 'confirm', 'summary', 'unlisted']) {
    assert.deepEqual(make({ phase }), { reloads: 0, banner: 1 }, `${phase}: banner, no reload`);
  }
  assert.deepEqual(make({ draft: '{"walkId":1}' }), { reloads: 0, banner: 1 }, 'an unsaved end-of-walk draft');
  assert.deepEqual(make({ overlay: true }), { reloads: 0, banner: 1 }, 'a dialog or sheet open');
  assert.deepEqual(make({ reloadedFor: 'new' }), { reloads: 0, banner: 1 }, 'already reloaded once for it: no loop');
});

// ---- #6 a phone clock running fast ----
test('#6 End with a tap time in the future ends the walk at the server\'s now; edits still refuse the future', async () => {
  const s = await start(1);
  assert.equal(s.status, 200, s.text);
  withDb((db) => db.prepare('UPDATE walks SET started_at = ? WHERE id = ?').run(ago(20), s.json.walkId));
  const fast = new Date(Date.now() + 5 * 60000).toISOString();
  const r = await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { endTappedAt: fast, finishLater: true } });
  assert.equal(r.status, 200, r.text);
  assert.ok(Math.abs(new Date(r.json.endedAt) - Date.now()) < 5000, 'ended at the server\'s now');
  assert.ok(r.json.durationSeconds >= 19 * 60 && r.json.durationSeconds <= 21 * 60);
  // Picking a future end in an edit is still refused.
  const e = await call('PUT', `/api/walks/${s.json.walkId}`, { body: { endedAt: new Date(Date.now() + 30 * 60000).toISOString() } });
  assert.equal(e.status, 400);
  assert.match(e.json.error, /future/);
  await call('PUT', `/api/walks/${s.json.walkId}`, { body: { wrapUpDone: true } });
});

// ---- #7 walker chat ----
test('#7 walker chat: 6 streams per account, and a closed one frees its slot', async () => {
  assert.equal((await call('PUT', '/api/modules/walker-chat', { user: STAFF, staff: true, body: { enabled: true } })).status, 200);
  const open = [];
  const stream = async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/modules/walker-chat/stream`, { headers: { 'x-auth-email': WALKER }, signal: ac.signal });
    if (res.status === 200) open.push(ac);
    else await res.text();
    return res.status;
  };
  const got = [];
  for (let i = 0; i < 7; i++) got.push(await stream());
  assert.deepEqual(got, [200, 200, 200, 200, 200, 200, 429]);
  open.shift().abort();
  let again = 429;
  for (let i = 0; i < 20 && again === 429; i++) { await new Promise((r) => setTimeout(r, 100)); again = await stream(); }
  assert.equal(again, 200, 'a dropped stream gives its slot back');
  open.forEach((ac) => ac.abort());
});

test('#7 the chat page reconnects with growing waits after any error', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'walker-chat', 'public', 'chat.js'), 'utf8');
  assert.match(src, /es\.onerror = \(\) => \{\s*es\.close\(\);/);
  assert.match(src, /retryMs = Math\.min\(RETRY_MAX_MS, retryMs \* 2\)/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'modules', 'walker-chat', 'server.js'), 'utf8');
  assert.match(server, /const MAX_STREAMS_PER_USER = 6;/);
  assert.match(server, /const HEARTBEAT_MS = 25000;/);
});
