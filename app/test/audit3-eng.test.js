// Audit 3 (2026-11-11), engineering:
//   - Together's day view: the server says which rows its average is over
//     (`averaged`) and how many (`totals.avgCount`, `avgSkipped`), so the app
//     no longer re-judges others' lengths, which reach it rounded to 5 minutes
//     (a 90 s walk arrives as 0 and was shown as "under a minute").
//   - bySpecies is gone from /api/stats and /api/impact (nothing showed it).
//   - push.sendPushToUser counts the devices that took it and prunes gone
//     ones (was a regex over push.js in audit2-staff.test.js).
//   - The shelter's time zone and the averages' one-minute rule have one copy
//     each (src/constants.js); the client copies are pinned here.
//   - The test clock's TEST_CLOCK=+<N>d and _helpers.shelterDayFromToday, so
//     no test needs a typed-out future date (npm run test:future in CI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { startServer, shelterDayFromToday, APP_DIR } = require('./_helpers');
const constants = require('../src/constants');

const read = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
// Code without its comments (rough, but enough for string literals and
// comparisons: a "//" inside a URL string follows a ":").
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let base, dbFile, server;
const ME = 'a3e.me@example.com';
const OTHER = 'a3e.other@example.com';
async function call(url, user = ME) {
  const res = await fetch(base + url, { headers: { 'x-auth-email': user } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

const ids = {};
// Shelter noon yesterday plus some minutes: always a finished, whole day.
const DAY = shelterDayFromToday(-1);
test.before(async () => {
  server = await startServer({ prefix: 'sw-audit3-eng-' });
  ({ base, dbFile } = server);
  ids.me = (await call('/api/me')).json.id;
  ids.other = (await call('/api/me', OTHER)).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, species)
    VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?, ?)`);
  insDog.run(1, 'Ace', now, now, 'dog');
  insDog.run(2, 'Bo', now, now, 'dog');
  insDog.run(3, 'Cy', now, now, 'dog');
  insDog.run(4, 'Tom', now, now, 'cat');
  const noon = Date.parse(`${DAY}T17:00:00Z`); // noon EST / 1pm EDT
  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, ?, ?)');
  const walk = (dog, user, offsetMin, seconds, activity = 'walk') => {
    const s = noon + offsetMin * 60000;
    ins.run(dog, user, new Date(s).toISOString(), new Date(s + seconds * 1000).toISOString(), seconds, activity);
  };
  // Someone else's 90 s walk (reaches the app as 0 min), a 30 s mis-scan,
  // two real walks, a cuddle, and a cat cuddle.
  walk(1, ids.other, 0, 90);
  walk(2, ids.other, 10, 30);
  walk(3, ids.other, 20, 1200);
  walk(1, ids.me, 60, 900);
  walk(2, ids.me, 90, 600, 'cuddle');
  walk(4, ids.me, 120, 300, 'cuddle');
  db.close();
});
test.after(() => server && server.stop());

// ---- Together's day view: the server's own averaged rows ----
test('impact/day flags the rows its average is over; a 90 s walk counts though it arrives as 0', async () => {
  const r = await call(`/api/impact/day?date=${DAY}&species=dog`);
  assert.equal(r.status, 200, r.text);
  const { totals, walks } = r.json;
  // Walk-only average: 90 + 1200 + 900 over 3; the 30 s mis-scan is left out.
  assert.equal(totals.avgSeconds, (90 + 1200 + 900) / 3);
  assert.equal(totals.avgActivity, 'walk');
  assert.equal(totals.avgCount, 3);
  assert.equal(totals.avgSkipped, 1, 'one walk under a minute');
  const short = walks.find((w) => !w.mine && w.dogName === 'Ace');
  assert.equal(short.durationSeconds, 0, "someone else's 90 s walk arrives rounded to 0");
  assert.equal(short.averaged, true, '...but is in the average');
  assert.equal(walks.find((w) => !w.mine && w.dogName === 'Bo').averaged, false, 'the 30 s mis-scan is not');
  assert.equal(walks.find((w) => w.mine && w.activity === 'cuddle').averaged, false, 'a cuddle is not in a walk-only average');
  assert.equal(walks.filter((w) => w.averaged).length, totals.avgCount);
  // A day with no walks averages every engagement of a minute or more.
  const cats = (await call(`/api/impact/day?date=${DAY}&species=cat`));
  assert.equal(cats.status, 404, 'one cat cuddle is below MIN_CELL: not opened');
  const all = (await call(`/api/impact/day?date=${DAY}&species=all`)).json;
  assert.equal(all.totals.avgCount, 3);
  assert.equal(all.walks.filter((w) => w.averaged).length, 3);
});

test('the Together list rows carry the same avgCount / avgSkipped as the day view', async () => {
  const list = (await call('/api/impact?days=7&species=dog')).json;
  const row = list.days.find((d) => d.dateKey === DAY);
  assert.ok(row, `${DAY} is listed`);
  const day = (await call(`/api/impact/day?date=${DAY}&species=dog`)).json.totals;
  assert.equal(row.avgCount, day.avgCount);
  assert.equal(row.avgSkipped, day.avgSkipped);
});

test('no bySpecies on /api/stats or /api/impact (computed, never shown)', async () => {
  const stats = (await call(`/api/stats?userId=${ids.me}&species=all`)).json;
  assert.ok(stats.totals && stats.byActivity, 'stats answered');
  assert.equal('bySpecies' in stats, false);
  const impact = (await call('/api/impact?days=all&species=all')).json;
  assert.ok(impact.allTime, 'impact answered');
  assert.equal('bySpecies' in impact.allTime, false);
});

// ---- push.sendPushToUser, run for real (in a child, on its own DB) ----
test('push.sendPushToUser counts devices that took it, prunes gone ones, and is 0 with push off', () => {
  const script = `
    const { isolateEnv } = require('./test/_helpers');
    isolateEnv('sw-a3e-push-');
    const webpush = require('web-push');
    const mode = process.argv[1];
    if (mode === 'on') {
      const k = webpush.generateVAPIDKeys();
      process.env.VAPID_PUBLIC_KEY = k.publicKey; process.env.VAPID_PRIVATE_KEY = k.privateKey;
    } else { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; }
    const sent = [];
    webpush.sendNotification = async (sub) => {
      sent.push(sub.endpoint);
      if (sub.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      if (sub.endpoint.endsWith('/flaky')) { const e = new Error('busy'); e.statusCode = 503; throw e; }
    };
    const db = require('./src/db');
    const push = require('./src/push');
    const now = new Date().toISOString();
    const uid = db.prepare("INSERT INTO users (name, created_at) VALUES ('P', ?)").run(now).lastInsertRowid;
    const add = db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'k', 'a', ?)");
    for (const e of ['ok1', 'ok2', 'gone', 'flaky']) add.run(uid, 'https://push.example/' + e, now);
    push.sendPushToUser(uid, { title: 't' }).then((n) => {
      const left = db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ?').all(uid).map((r) => r.endpoint.split('/').pop());
      console.log(JSON.stringify({ n, tried: sent.length, left }));
    });
  `;
  const run = (mode) => JSON.parse(execFileSync(process.execPath, ['-e', script, mode], {
    cwd: APP_DIR, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'ignore']
  }).trim().split('\n').pop());
  const on = run('on');
  assert.equal(on.n, 2, 'two phones took it');
  assert.equal(on.tried, 4);
  assert.deepEqual(on.left.sort(), ['flaky', 'ok1', 'ok2'], 'a 410 subscription is deleted; a 503 one is kept');
  const off = run('off');
  assert.deepEqual([off.n, off.tried], [0, 0], 'push off: nothing tried, 0 sent');
});

// ---- One copy of each shared number ----
test('/api/config: the last session is 4-7p and counts to 7:15', async () => {
  const cfg = (await call('/api/config')).json;
  assert.deepEqual(cfg.slots[cfg.slots.length - 1], { label: '4-7p', from: 16, to: 19.25 });
  assert.equal(cfg.shelterTz, constants.SHELTER_TZ);
});

// Source checks: these guard against a second copy being typed again, which
// only the source can show.
function jsFiles(dir) {
  const out = [];
  for (const f of fs.readdirSync(path.join(APP_DIR, dir), { withFileTypes: true })) {
    const rel = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== 'node_modules') out.push(...jsFiles(rel)); } else if (f.name.endsWith('.js') && !f.name.endsWith('.min.js')) out.push(rel);
  }
  return out;
}
test('the shelter time zone is typed once on the server (constants.js), once per client script', () => {
  const tz = constants.SHELTER_TZ;
  const quoted = new RegExp(`['"\`]${tz.replace('/', '\\/')}['"\`]`, 'g');
  const serverFiles = [...jsFiles('src'), ...jsFiles('modules')].filter((f) => !f.includes(`${path.sep}public${path.sep}`));
  assert.ok(serverFiles.length > 20, 'found the server code');
  for (const f of serverFiles) {
    if (f === path.join('src', 'constants.js')) continue;
    assert.equal((code(read(f)).match(quoted) || []).length, 0, `${f} types the shelter zone; use constants.SHELTER_TZ`);
  }
  // The browser can't require constants.js: app.js keeps its SHARED_CONFIG
  // fallback (audit2-eng.test.js), staff.js and pg-tags.js one named copy,
  // the service worker (no page, no config) one for its alert clock times.
  const counts = Object.fromEntries(jsFiles('public').map((f) => [f, (code(read(f)).match(quoted) || []).length]));
  assert.deepEqual(Object.entries(counts).filter(([, n]) => n > 0).sort(), [
    [path.join('public', 'js', 'app.js'), 1],
    [path.join('public', 'js', 'pg-tags.js'), 1],
    [path.join('public', 'js', 'staff.js'), 1],
    [path.join('public', 'sw.js'), 1]
  ]);
  assert.match(read('public/js/app.js'), /shelterTz: 'America\/New_York'/);
  for (const f of ['public/js/staff.js', 'public/js/pg-tags.js']) {
    assert.match(read(f), new RegExp(`const SHELTER_TZ = '${tz.replace('/', '\\/')}';`), `${f} names its one copy SHELTER_TZ`);
  }
});

test('the one-minute averages rule is only in constants.js (server) and SHARED_CONFIG (app)', () => {
  for (const f of jsFiles('src')) {
    if (f === path.join('src', 'constants.js')) continue;
    assert.doesNotMatch(code(read(f)), /\bMIN_AVG_SECONDS\s*=\s*\d/, `${f} redefines MIN_AVG_SECONDS`);
    assert.doesNotMatch(code(read(f)), /\b(const|let)\s+TZ\s*=\s*['"]/, `${f} types its own TZ`);
  }
  const app = read('public/js/app.js');
  const start = app.indexOf('function avgPick(');
  assert.ok(start > 0, 'app.js has avgPick');
  const avgPick = app.slice(start, app.indexOf('\n  }\n', start));
  assert.doesNotMatch(avgPick, /\b60\b/, 'avgPick uses SHARED_CONFIG.minAvgSeconds, not a typed 60');
  // The extend button's label comes from extendMinutes (smoke/audit3-eng.js
  // serves 15 and sees "+15 min").
  assert.doesNotMatch(code(app), /＋10 min/);
});

// ---- The test clock ----
test('shelterDayFromToday counts from the shelter date of the test clock', () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: constants.SHELTER_TZ }).format(new Date());
  assert.equal(shelterDayFromToday(0), today);
  const plus = new Date(`${today}T12:00:00Z`);
  plus.setUTCDate(plus.getUTCDate() + 45);
  assert.equal(shelterDayFromToday(45), plus.toISOString().slice(0, 10));
  assert.ok(shelterDayFromToday(-1) < today);
});

test('TEST_CLOCK=+<N>d starts the clock at shelter noon N days ahead', () => {
  const env = { ...process.env, TEST_CLOCK: '+200d' };
  delete env.TEST_CLOCK_OFFSET_MS; // this process's offset would win otherwise
  const out = execFileSync(process.execPath, ['-r', './test/_clock.js', '-e', 'console.log(new Date().toISOString())'], { cwd: APP_DIR, env, encoding: 'utf8' }).trim();
  const realToday = new Intl.DateTimeFormat('en-CA', { timeZone: constants.SHELTER_TZ }).format(new Date(Date.now() - (Number(process.env.TEST_CLOCK_OFFSET_MS) || 0)));
  const want = new Date(`${realToday}T17:00:00Z`);
  want.setUTCDate(want.getUTCDate() + 200);
  assert.ok(Math.abs(Date.parse(out) - want.getTime()) < 60000, `${out} is about ${want.toISOString()}`);
});
