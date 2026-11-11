// Audit 2 (2026-11-10), eng area: the smoke runner kills a timed-out smoke's
// server, Together is cached but never stale, shelter dates are cached per
// UTC hour and still right across DST, Playgroup notes page, the name pickers
// get a slim list, the shared numbers can't drift between app and server,
// impossible dates are refused rather than crashing, and the dead code stays
// gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { startServer, APP_DIR } = require('./_helpers');
const constants = require('../src/constants');
const shelterTime = require('../src/shelterTime');
const asyncRoute = require('../src/asyncRoute');
const { realDateKey } = require('../src/validate');

const read = (rel) => fs.readFileSync(path.join(APP_DIR, rel), 'utf8');
const ALICE = 'alice.eng2@example.com';
const BOB = 'bob.eng2@example.com';
const STAFF = 'staff.eng2@example.com';

let server, base, dbFile;
const ids = {};
async function call(method, url, { user = ALICE, staff = false, body } = {}) {
  const headers = { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) };
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
  return { status: res.status, json, size: buf.length, type: res.headers.get('content-type') || '' };
}
const withDb = (fn) => { const db = new Database(dbFile); try { return fn(db); } finally { db.close(); } };

test.before(async () => {
  server = await startServer({ prefix: 'sw-eng2-' });
  ({ base, dbFile } = server);
  for (const [k, e] of [['alice', ALICE], ['bob', BOB], ['staff', STAFF]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  withDb((db) => {
    const now = new Date().toISOString();
    const dog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, location, kennel_location, previous_names, first_seen_at, last_seen_at)
      VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, 'A', ?, ?, ?)`);
    dog.run(1, 'Rex', 1, 'Shelter', '["Rexy"]', now, now);
    dog.run(2, 'Luna', 1, 'Shelter', '[]', now, now);
    dog.run(3, 'Fido', 0, 'In Foster', '[]', now, now);
    dog.run(4, 'Gone', 0, 'Shelter', '[]', now, now);
    db.prepare("UPDATE users SET name = 'Alice', experience_level = 'expert', onboarding_completed = 1 WHERE id = ?").run(ids.alice);
    // Three finished walks yesterday around noon at the shelter.
    const { shelterClock, shelterTimeToDate } = require('../src/walkHours');
    const c = shelterClock(Date.now() - 86400000);
    const noon = shelterTimeToDate(c.y, c.m, c.d, 12 * 60).getTime();
    const ins = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, 600, 'walk')");
    for (let i = 0; i < 3; i += 1) ins.run(1 + (i % 2), ids.bob, new Date(noon - i * 3600000).toISOString(), new Date(noon - i * 3600000 + 600000).toISOString());
  });
});
test.after(async () => { if (server) await server.stop(); });

// ---- smoke/_run-all.js ----
test('smoke:all kills a timed-out smoke together with the server it started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-eng2-runall-'));
  const pidFile = path.join(dir, 'server.pid');
  // A smoke that boots the real server, says so, then never finishes.
  fs.writeFileSync(path.join(dir, 'hangs.js'), `
    const { startServer } = require(${JSON.stringify(path.join(APP_DIR, 'test', '_helpers.js'))});
    startServer({ prefix: 'sw-eng2-hang-' }).then((s) => {
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(s.proc.pid));
      setInterval(() => {}, 1000);
    });
  `);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
  const runner = spawn(process.execPath, [path.join(APP_DIR, 'smoke', '_run-all.js')], {
    cwd: APP_DIR,
    env: { ...process.env, SMOKE_DIR: dir, SMOKE_TIMEOUT_MS: '20000', SMOKE_JOBS: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  runner.stdout.on('data', (c) => { out += c; });
  runner.stderr.on('data', (c) => { out += c; });
  // The server must actually be up (and alive) before the timeout hits.
  let serverPid = null;
  for (let i = 0; i < 180 && !serverPid; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(pidFile)) serverPid = Number(fs.readFileSync(pidFile, 'utf8'));
  }
  assert.ok(serverPid && alive(serverPid), `the smoke's server started:\n${out}`);
  const code = await new Promise((r) => runner.on('close', r));
  assert.equal(code, 1, 'a timed-out smoke fails the run');
  assert.match(out, /hangs\.js .*timed out/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(serverPid), false, 'the timed-out smoke\'s server was killed with it');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- shared numbers: one source, served, and the app's copies match ----
test('GET /api/config serves src/constants.js, and app.js\'s fallback copies match it exactly', async () => {
  const r = await call('GET', '/api/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, constants.publicConfig());
  assert.deepEqual(r.json.slots.map((s) => s.label), ['7-10a', '10-1p', '1-4p', '4-7p'], 'the last window says 4-7 (it counts to 7:15, never shown)');
  assert.ok(r.json.slots.every((s) => !/7:15|8/.test(s.label)), 'no label mentions 7:15 or 8');
  assert.equal(r.json.activityLimitMinutes.matchmaking, 60);

  const app = read('public/js/app.js');
  const m = /const SHARED_CONFIG = (\{[\s\S]*?\n {2}\});/.exec(app);
  assert.ok(m, 'app.js has its SHARED_CONFIG fallback block');
  const fallback = vm.runInNewContext(`(${m[1]})`);
  assert.deepEqual(JSON.parse(JSON.stringify(fallback)), constants.publicConfig(), 'app.js SHARED_CONFIG drifted from src/constants.js');
  // The copies that used to be typed by hand now read SHARED_CONFIG.
  assert.match(app, /const WALK_SLOTS = SHARED_CONFIG\.slots;/);
  assert.ok(!/startedMs \+ 45 \* 60000/.test(app), 'no 45-minute fallback (matchmaking runs 60)');
  assert.equal((app.match(/'4-7p'/g) || []).length, 1, 'the slot label is typed once in app.js, in SHARED_CONFIG');
  assert.ok(!/'4-[78]p'/.test(read('src/impact.js')), 'impact.js keeps no copy of the slot labels');
  for (const f of ['src/server.js', 'src/impact.js', 'src/staffDashboard.js']) {
    const src = read(f);
    assert.ok(!/const (AUTO_STOP_MINUTES|MAX_TOTAL_MINUTES|DAYCATION_MINUTES|EXTEND_MINUTES) = \d/.test(src), `${f} keeps no copy of the walk limits`);
    assert.ok(!/\{ label: '\d+-\d+[ap]', from: \d+/.test(src), `${f} keeps no copy of the walk windows`);
  }
});

// ---- shelter dates: cached per UTC hour, same answers as Intl ----
test('the per-hour shelter date cache agrees with Intl every 7 minutes across both 2026 DST changes', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const direct = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
  };
  let checked = 0;
  for (const [from, to] of [['2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'], ['2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'], ['2026-12-31T00:00:00Z', '2027-01-02T00:00:00Z']]) {
    for (let ms = Date.parse(from) + 13000; ms < Date.parse(to); ms += 7 * 60000) {
      const iso = new Date(ms).toISOString();
      assert.deepEqual({ ...shelterTime.shelterParts(iso) }, direct(ms), iso);
      // Twice: the second answer comes from the cache.
      assert.deepEqual({ ...shelterTime.shelterParts(iso) }, direct(ms), `${iso} (cached)`);
      checked += 1;
    }
  }
  assert.ok(checked > 1500, String(checked));
  assert.equal(shelterTime.shelterDateKey('2026-11-11T04:59:59.999Z'), '2026-11-10', 'one ms before midnight EST');
  assert.equal(shelterTime.shelterDateKey('2026-11-11T05:00:00.000Z'), '2026-11-11');
  assert.throws(() => shelterTime.shelterParts('not a time'), RangeError);
});

// ---- Together: cached, but a change shows at once ----
test('Together is cached between loads but a walk that ends, changes or arrives shows up at once', async () => {
  const total = async () => (await call('GET', '/api/impact?days=all')).json.allTime;
  const first = await total();
  assert.equal(first.walks, 3);
  assert.deepEqual(await total(), first, 'same answer from the cache');

  // A walk ended through the app.
  const start = await call('POST', '/api/walks/start', { body: { dogId: 2, userId: ids.alice, activity: 'walk' } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal((await total()).walks, 3, 'a walk in progress never counts');
  assert.equal((await call('PUT', `/api/walks/${start.json.walkId}/end`, { body: {} })).status, 200);
  assert.equal((await total()).walks, 4, 'ended: counted on the very next load');

  // A walk's length edited behind the server's back (another connection).
  withDb((db) => db.prepare('UPDATE walks SET duration_seconds = 1200 WHERE id = (SELECT MIN(id) FROM walks)').run());
  const edited = await total();
  assert.equal(edited.seconds, first.seconds + 600 + (await call('GET', '/api/walks')).json.walks.find((w) => w.id === start.json.walkId).duration_seconds);
  // A walk deleted.
  assert.equal((await call('DELETE', `/api/walks/${start.json.walkId}`)).status, 200);
  assert.equal((await total()).walks, 3, 'deleted: gone on the very next load');
  // shelterNow is per viewer, so never cached with the rest.
  assert.ok((await call('GET', '/api/impact?days=all')).json.shelterNow);
});

// ---- Playgroup notes: one query, and pages for the phone ----
test('Playgroup notes page: pages add up to the whole list, with totals per dog', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await call('POST', `/api/dogs/${1 + (i % 2)}/playgroup-notes`, { body: { body: `Session ${i} with @[3]`, noteDate: `2026-10-0${i + 1}` } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const all = (await call('GET', '/api/playgroup-notes')).json;
  assert.equal(all.notes.length, 5);
  assert.equal(all.total, undefined, 'without limit: the whole list, as before (desk, export)');
  const pages = [];
  let offset = 0;
  while (offset != null) {
    const p = (await call('GET', `/api/playgroup-notes?limit=2&offset=${offset}`)).json;
    assert.equal(p.total, 5);
    assert.ok(p.notes.length <= 2);
    for (const n of p.notes) {
      assert.ok(p.dogs[n.dogId], 'every note on the page has its dog');
      for (const t of n.tagged) assert.ok(p.dogs[t], 'and every dog it tags');
      assert.equal(p.dogTotals[n.dogId], all.notes.filter((x) => x.dogId === n.dogId).length, 'the dog\'s notes in all, not just this page');
    }
    pages.push(...p.notes);
    offset = p.nextOffset;
  }
  assert.deepEqual(pages.map((n) => n.id), all.notes.map((n) => n.id), 'newest first, nothing lost or repeated');
  assert.equal(all.dogs[3].name, 'Fido', 'a tagged dog in foster still has its name');
  // A note date that doesn't exist is refused (2026-02-30 used to become March 2).
  assert.equal((await call('POST', '/api/dogs/1/playgroup-notes', { body: { body: 'x', noteDate: '2026-02-30' } })).status, 400);
});

// ---- /api/dogs?fields=names: what the pickers need, nothing more ----
test('/api/dogs?all=true&fields=names is the slim list the name pickers use', async () => {
  const full = await call('GET', '/api/dogs?all=true');
  const slim = await call('GET', '/api/dogs?all=true&fields=names');
  assert.equal(slim.status, 200);
  assert.deepEqual(slim.json.dogs.map((d) => d.id).sort(), full.json.dogs.map((d) => d.id).sort(), 'the same animals');
  for (const d of slim.json.dogs) {
    assert.deepEqual(Object.keys(d).sort(), ['id', 'kennelLocation', 'leftAt', 'location', 'name', 'photoUrl', 'previousNames', 'species', 'stillListed']);
    const f = full.json.dogs.find((x) => x.id === d.id);
    for (const k of Object.keys(d)) if (k !== 'leftAt') assert.deepEqual(d[k], f[k], `${d.name}.${k} as in the full list`);
    // leftAt: only for dogs no longer listed (the @ picker lists recent ones last).
    assert.equal(d.leftAt === null, d.stillListed, `${d.name}.leftAt`);
  }
  assert.ok(slim.size < full.size / 2, `${slim.size} bytes vs ${full.size}`);
  const listed = (await call('GET', '/api/dogs?fields=names')).json.dogs;
  assert.deepEqual(listed.map((d) => d.name).sort(), ['Luna', 'Rex'], 'without all=true: listed only');
  for (const f of ['public/js/app.js', 'public/js/playgroup.js']) {
    assert.ok(!/api\('\/api\/dogs\?all=true'\)/.test(read(f)), `${f}: pickers use fields=names`);
  }
});

// ---- impossible dates and async errors ----
test('impossible dates are refused or ignored, never a 500 or a hang', async () => {
  assert.equal(realDateKey('2026-02-28'), '2026-02-28');
  for (const bad of ['2026-02-30', '2026-13-45', '2026-1-01', '', null, 20260101]) assert.equal(realDateKey(bad), null, String(bad));
  assert.equal((await call('GET', '/api/impact/day?date=2026-13-45')).status, 400);
  assert.equal((await call('GET', '/api/impact/day?date=2026-02-30')).status, 400);
  for (const fmt of ['', '/export.csv', '/export.xlsx', '/export.pdf']) {
    const r = await call('GET', `/api/staff/reports${fmt}?from=2026-13-45&to=2026-02-30`, { user: STAFF, staff: true });
    assert.equal(r.status, 200, `reports${fmt}`);
  }
});

test('asyncRoute hands a rejected promise or a throw to the error handler', async () => {
  const seen = [];
  const next = (err) => seen.push(err && err.message);
  await asyncRoute(async () => { throw new Error('async boom'); })({}, {}, next);
  await new Promise((r) => setImmediate(r));
  asyncRoute(() => { throw new Error('sync boom'); })({}, {}, next);
  asyncRoute(async () => 'fine')({}, {}, next);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['async boom', 'sync boom']);
  for (const f of ['src/staffDashboard.js', 'src/playgroupNotes.js']) {
    assert.ok(!/app\.(get|post|put|delete)\([^\n]*, async \(req, res\)/.test(read(f)), `${f}: every async route is wrapped`);
  }
});

// ---- lazy scanner, cleanup, tooling ----
test('the scanner library loads only when a scan opens', () => {
  assert.ok(!/<script src="\/js\/html5-qrcode\.min\.js">/.test(read('public/index.html')), 'not a blocking script on every page');
  assert.match(read('public/js/app.js'), /function loadScannerLib\(\)/);
});

test('dead code and duplicates stay gone', () => {
  const app = read('public/js/app.js');
  assert.ok(!/\btitleCase\b/.test(app) && !/\blifetimeTerms\b/.test(app));
  assert.ok(!/\bKENNEL_LETTERS\b/.test(read('src/server.js')));
  for (const f of ['src/server.js', 'src/db.js']) assert.ok(!/STICKER_LABELS = \{/.test(read(f)), `${f}: STICKER_LABELS comes from constants.js`);
  const css = read('public/css/style.css');
  for (const c of ['notif-badge', 'notif-celebrate', 'note-item', 'user-pick-btn', 'user-row', 'md-help', 'note-text', 'tip-add', 'pg-add', 'pg-date-label']) {
    assert.ok(!new RegExp(`\\.${c}(?![\\w-])`).test(css), `.${c} is unused`);
  }
  assert.match(read('public/sw.js'), /const clockLabel = [^\n]*timeZone: 'America\/New_York'/, 'notification times on the shelter clock');
});

test('package.json: supported Node range, and `npm run check` covers sw.js, tests and smokes', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.engines && /^>=22/.test(pkg.engines.node), JSON.stringify(pkg.engines));
  for (const p of ['public/sw.js', 'test', 'smoke']) assert.ok(pkg.scripts.check.includes(p), `check covers ${p}`);
});

// Owner, 2026-11-11: the 4-7 window counts anything started before 7:15pm.
test('the 4-7 window runs to 7:15pm at the shelter, to the minute', () => {
  const { shelterTimeOfDay } = require('../src/shelterTime');
  const at = (iso) => constants.slotIndexOfHour(shelterTimeOfDay(iso));
  assert.equal(at('2026-11-10T23:59:00.000Z'), 3, '6:59pm EST');
  assert.equal(at('2026-11-11T00:14:59.000Z'), 3, '7:14:59pm EST');
  assert.equal(at('2026-11-11T00:15:00.000Z'), -1, '7:15pm EST is past it');
  assert.equal(at('2026-07-10T23:14:00.000Z'), 3, '7:14pm EDT');
  assert.equal(at('2026-07-10T23:15:00.000Z'), -1, '7:15pm EDT');
  assert.equal(at('2026-07-10T20:00:00.000Z'), 3, '4pm EDT starts it');
  assert.equal(at('2026-07-10T19:59:00.000Z'), 2, '3:59pm EDT is still 1-4');
});
