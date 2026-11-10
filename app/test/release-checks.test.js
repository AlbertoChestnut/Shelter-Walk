// Release checks (.ai/RELEASE_CHECKS.md), API level: the items under
// "Security & privacy", "Walk lifecycle", "Stats invariants" and "Scraper,
// images & push" that no other test file already covers. Items that are
// covered elsewhere are listed in RELEASE_CHECKS.md with the file that
// covers them; this file adds:
//   - one seeded fixture with KNOWN answers (several walkers, dogs and cats,
//     walks across ET midnight and both DST changes, an in-progress walk, a
//     misscan, a daycation, play group, POO sticker timing, adopted/returned
//     events, daily species counts), checked with exact numbers across
//     /api/stats, /api/impact, /api/impact/day, /api/staff/live,
//     /api/staff/reports, /api/shelter-trends, walk-stats and walk-history,
//     and for agreement between those screens;
//   - an empty-DB pass (no NaN / Infinity / unexpected null anywhere);
//   - route sweeps (401 without sign-in, 403 for staff routes), internal
//     token, fresh-DB privilege, account deletion across every table,
//     migrating an old-schema DB, image/asset/manifest checks, and that the
//     scraper tests leave app/data alone.
// A check that fails because the app is wrong stays here, marked
// { todo: 'BUG: ...' } so it shows up without failing the run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { startServer, tempDirs, APP_DIR } = require('./_helpers');

const TZ = 'America/New_York';
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
const shiftKey = (key, n) => { const d = new Date(`${key}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hours = (s) => Math.round((s / 3600) * 10) / 10;

function client(base) {
  return async function call(method, url, { user, staff = false, body, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (user) h['x-auth-email'] = user;
    if (staff) h['x-auth-staff'] = '1';
    if (body !== undefined || raw !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text, buf, headers: res.headers };
  };
}

// Every non-finite number or null in a JSON value, as "a.b[2].c" paths.
function badValues(value, at = '') {
  const out = [];
  if (value === null) out.push(`${at} = null`);
  else if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${at} = ${value}`);
  else if (Array.isArray(value)) value.forEach((v, i) => out.push(...badValues(v, `${at}[${i}]`)));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) out.push(...badValues(v, at ? `${at}.${k}` : k));
  return out;
}

// Every route the app registers, read from the source.
function apiRoutes() {
  const files = [
    ...fs.readdirSync(path.join(APP_DIR, 'src')).filter((f) => f.endsWith('.js')).map((f) => path.join(APP_DIR, 'src', f)),
    ...fs.readdirSync(path.join(APP_DIR, 'modules')).map((m) => path.join(APP_DIR, 'modules', m, 'server.js')).filter((f) => fs.existsSync(f))
  ];
  const routes = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /app\.(get|post|put|delete)\(\s*'(\/api\/[^']+)'(.*)$/.exec(line);
      if (m) routes.push({ method: m[1].toUpperCase(), path: m[2], file: `${path.relative(APP_DIR, file)}:${i + 1}`, staffGuard: /requireStaff|requireEditor/.test(m[3]) });
    });
  }
  return routes;
}
const fill = (p) => p.replace(/:(\w+)/g, (all, name) => (name === 'date' ? '2026-11-01' : '1'));

// ---------------------------------------------------------------------------
// The fixture. Every number asserted below is worked out by hand from this.
// ---------------------------------------------------------------------------
const A = 'rc.alice@example.com';
const B = 'rc.bob@example.com';
const C = 'rc.carol@example.com';
const S = 'rc.staff@example.com';
const ids = {};
let srv; let call; let seededAt;
// The shelter's date now, and whether today's seeded walks (started up to
// 170 s before seeding) are all still "today" -- false around ET midnight.
const todayKey = () => dayKey(new Date().toISOString());
const todaySafe = () => dayKey(new Date(seededAt - 170000).toISOString()) === todayKey();

// Dogs 1-7 and cats 21-22.
const DOGS = [
  [1, 'Rex', 'dog', '3 Years', '["Dog"]', 1, null, 'poo'],
  [2, 'Fido', 'dog', '3 Years', '["Dog"]', 1, null, 'none'],
  [3, 'Max', 'dog', '2 Years', '["Dog"]', 1, null, 'none'],
  [4, 'Daisy', 'dog', '5 Years', '["Dog"]', 1, null, 'none'],
  [5, 'Gone', 'dog', '4 Years', '["Dog"]', 0, null, 'none'],
  [6, 'Back', 'dog', '6 Years', '["Dog"]', 1, null, 'none'],
  [7, 'Bo', 'dog', '1 Year', '["Dog"]', 1, 'In Foster', 'none'],
  [21, 'Pip', 'cat', '9 Weeks', '["Cat","Kitten"]', 1, null, 'none'],
  [22, 'Tom', 'cat', '3 Years', '["Cat"]', 1, null, 'none']
];
// [label, dogId, who, startIso, seconds, activity]
const WALKS = [
  // Spring forward (Mar 8, 2am EST -> 3am EDT). 04:30Z is 11:30pm Mar 7.
  ['W10', 3, 'a', '2026-03-08T04:30:00.000Z', 600, 'walk'], // Mar 7
  ['W8', 1, 'a', '2026-03-08T06:30:00.000Z', 1500, 'walk'], // 1:30am EST Mar 8
  ['W9', 2, 'b', '2026-03-08T07:30:00.000Z', 1500, 'walk'], // 3:30am EDT Mar 8
  ['W11', 2, 'a', '2026-03-08T15:00:00.000Z', 600, 'cuddle'],
  // Saturday Oct 31 (EDT). Rex gets POO at 15:00Z.
  ['W1', 1, 'a', '2026-10-31T14:00:00.000Z', 1200, 'walk'], // 1h before POO: non-POO
  ['W12', 1, 'b', '2026-10-31T16:00:00.000Z', 600, 'walk'], // 1h after POO: POO
  ['W2', 2, 'b', '2026-10-31T18:00:00.000Z', 1800, 'walk'],
  ['W3', 3, 'a', '2026-11-01T03:50:00.000Z', 600, 'walk'], // 11:50pm ET Oct 31
  ['W13', 21, 'c', '2026-10-31T19:00:00.000Z', 900, 'cuddle'],
  ['W14', 22, 'c', '2026-10-31T20:00:00.000Z', 600, 'cuddle'],
  // Sunday Nov 1, fall back (2am EDT -> 1am EST).
  ['W4', 1, 'a', '2026-11-01T05:30:00.000Z', 900, 'walk'], // 1:30am EDT
  ['W5', 2, 'b', '2026-11-01T06:30:00.000Z', 900, 'walk'], // 1:30am EST
  ['W6', 4, 'b', '2026-11-01T15:00:00.000Z', 21600, 'daycation'],
  ['W7', 3, 'a', '2026-11-01T17:00:00.000Z', 30, 'walk'], // misscan
  ['W16', 2, 'b', '2026-11-01T20:00:00.000Z', 1800, 'playgroup'],
  ['W15', 22, 'a', '2026-11-01T19:00:00.000Z', 1200, 'matchmaking']
];

test.before(async () => {
  srv = await startServer({ prefix: 'sw-release-' });
  call = client(srv.base);
  for (const [k, e] of [['a', A], ['b', B], ['c', C], ['s', S]]) ids[k] = (await call('GET', '/api/me', { user: e, staff: k === 's' })).json.id;
  const db = new Database(srv.dbFile);
  const now = new Date().toISOString();
  const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, tags, still_listed, location, poo_status,
    date_in_shelter, first_seen_at, last_seen_at, removed_at, kennel_location) VALUES (?, ?, ?, 'Male', ?, ?, ?, ?, ?, '2026-02-01T00:00:00', ?, ?, ?, 'A')`);
  for (const [id, name, sp, age, tags, listed, loc, poo] of DOGS) insDog.run(id, name, sp, age, tags, listed, loc, poo, now, now, listed ? null : '2026-10-31T16:00:00.000Z');
  const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES (?, ?, ?, ?, ?)');
  for (const [id] of DOGS) ev.run('new_dog', id, 'arrived', null, '2026-09-01T15:00:00.000Z'); // before trends start
  ev.run('sticker_on', 1, 'POO: Potty Outside Only', 'poo', '2026-10-31T15:00:00.000Z');
  ev.run('adopted', 5, 'Gone was adopted', null, '2026-10-31T16:00:00.000Z');
  ev.run('returned', 6, 'Back is back', null, '2026-11-01T16:00:00.000Z');
  const cnt = db.prepare("INSERT INTO shelter_species_counts (date_key, species, listed, in_foster, recorded_at) VALUES (?, 'dog', ?, 1, ?)");
  cnt.run('2026-10-31', 5, '2026-11-01T03:00:00.000Z');
  cnt.run('2026-11-01', 6, '2026-11-02T03:00:00.000Z');

  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const end = (iso, s) => new Date(new Date(iso).getTime() + s * 1000).toISOString();
  for (const [, dogId, who, start, s, act] of WALKS) ins.run(dogId, ids[who], start, end(start, s), s, act, 'A');
  // Today: three finished dog walks (90 s each), a finished cat cuddle, and
  // a dog walk and a cat cuddle still going.
  const t = Date.now();
  const ago = (sec) => new Date(t - sec * 1000).toISOString();
  seededAt = t;
  ins.run(1, ids.b, ago(170), ago(80), 90, 'walk', 'A');
  ins.run(2, ids.c, ago(160), ago(70), 90, 'walk', 'B');
  ins.run(4, ids.s, ago(150), ago(60), 90, 'walk', 'B');
  ins.run(21, ids.c, ago(140), ago(50), 90, 'cuddle', null);
  const open = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, activity, location) VALUES (?, ?, ?, ?, ?)');
  open.run(3, ids.a, ago(60), 'walk', 'A');
  open.run(22, ids.b, ago(50), 'cuddle', null);
  db.prepare("UPDATE users SET species_pref = 'both' WHERE id = ?").run(ids.c);
  db.close();
});
test.after(async () => { if (srv) await srv.stop(); });

const as = (user) => ({ user });
const staffAs = { user: S, staff: true };
// A Together day's rows with exact times and lengths: each walker sees only
// their own exactly (round 4), so put every walker's own rows together.
async function exactDay(date, sp) {
  const rows = [];
  for (const who of [as(A), as(B), as(C), staffAs]) {
    const r = await call('GET', `/api/impact/day?date=${date}&species=${sp}`, who);
    if (r.status === 200) rows.push(...r.json.walks.filter((w) => w.mine));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Stats invariants
// ---------------------------------------------------------------------------
test('/api/stats: exact totals per walker; all = dog + cat = bySpecies; breakdowns sum to totals', async () => {
  const expected = {
    // walks, seconds, uniqueDogs, avgSeconds (walk-only, finished, >= 60 s)
    a: { dog: [7, 5430, 3, 960], cat: [1, 1200, 1, 1200], all: [8, 6630, 4, 960] },
    b: { dog: [7, 28290, 3, 978], cat: [0, 0, 0, 0], all: [7, 28290, 3, 978] },
    c: { dog: [1, 90, 1, 90], cat: [3, 1590, 2, 530], all: [4, 1680, 3, 90] }
  };
  for (const [who, email] of [['a', A], ['b', B], ['c', C]]) {
    const r = {};
    for (const sp of ['dog', 'cat', 'all']) {
      r[sp] = (await call('GET', `/api/stats?species=${sp}`, as(email))).json;
      const t = r[sp].totals;
      assert.deepEqual([t.totalWalks, t.totalSeconds, t.uniqueDogs, t.avgSeconds], expected[who][sp], `${who} ${sp}`);
      // byActivity sums to the totals.
      assert.equal(r[sp].byActivity.reduce((s, x) => s + x.count, 0), t.totalWalks, `${who} ${sp} byActivity count`);
      assert.equal(r[sp].byActivity.reduce((s, x) => s + x.totalSeconds, 0), t.totalSeconds, `${who} ${sp} byActivity seconds`);
      assert.deepEqual(badValues(r[sp].totals), []);
    }
    for (const k of ['totalWalks', 'totalSeconds']) assert.equal(r.all.totals[k], r.dog.totals[k] + r.cat.totals[k], `${who} all = dog + cat (${k})`);
    const bySp = Object.fromEntries(r.all.bySpecies.map((x) => [x.species, x]));
    assert.equal((bySp.dog || { count: 0 }).count, r.dog.totals.totalWalks, `${who} bySpecies dog`);
    assert.equal((bySp.cat || { count: 0 }).count, r.cat.totals.totalWalks, `${who} bySpecies cat`);
    assert.equal(r.dog.byPoo.reduce((s, x) => s + x.count, 0), r.dog.totals.totalWalks, `${who} byPoo sums to the dog total`);
    assert.equal(r.cat.byAge.reduce((s, x) => s + x.count, 0), r.cat.totals.totalWalks, `${who} byAge sums to the cat total`);
  }
  const a = (await call('GET', '/api/stats?species=dog', as(A))).json;
  assert.deepEqual(a.byActivity.map((x) => [x.activity, x.count, x.totalSeconds]), [['walk', 6, 4830], ['cuddle', 1, 600]]);
  const c = (await call('GET', '/api/stats?species=cat', as(C))).json;
  assert.deepEqual(c.byAge.map((x) => [x.group, x.count, x.totalSeconds]), [['young', 2, 990], ['adult', 1, 600]]);
});

test('POO split uses the sticker at walk start: 1h before sticker_on is non-POO, 1h after is POO', async () => {
  const a = (await call('GET', '/api/stats?species=dog', as(A))).json.byPoo;
  assert.deepEqual(a.map((x) => [x.status, x.count]), [['poo', 1], ['none', 6]], "Alice: only W4 (after the sticker) is POO; W1 an hour before isn't");
  const b = (await call('GET', '/api/stats?species=dog', as(B))).json.byPoo;
  assert.deepEqual(b.map((x) => [x.status, x.count]), [['poo', 2], ['none', 5]], 'Bob: W12 (an hour after) and today are POO');
  const together = (await call('GET', '/api/impact?days=all&species=dog', as(A))).json.allTime.byPoo;
  assert.deepEqual(together.map((x) => [x.status, x.count]), [['poo', 3], ['none', 13]]);
  // The walk list carries the same answer per walk.
  const walks = (await call('GET', '/api/walks?ended=1', as(A))).json.walks;
  assert.equal(walks.find((w) => w.started_at === '2026-10-31T14:00:00.000Z').poo_then, 'none');
  assert.equal(walks.find((w) => w.started_at === '2026-11-01T05:30:00.000Z').poo_then, 'poo');
});

test('Together all-time: exact totals, walk-only average, suppressed slices still in totals', async () => {
  const dog = (await call('GET', '/api/impact?days=all&species=dog', as(A))).json;
  assert.equal(dog.allTime.walks, 16);
  assert.equal(dog.allTime.seconds, 33900);
  assert.equal(dog.allTime.dogs, 4);
  assert.equal(dog.allTime.avgSeconds, 9870 / 12, 'walk-only, finished, >= 60 s: misscan, daycation, cuddle, play group and in-progress left out');
  assert.equal(dog.allTime.since, '2026-03-08T04:30:00.000Z');
  // Only walk has 3+; cuddle/daycation/play group (1 each) are hidden but counted.
  assert.deepEqual(dog.allTime.byActivity.map((x) => [x.activity, x.count]), [['walk', 13]]);
  assert.ok(dog.allTime.byActivity.reduce((s, x) => s + x.count, 0) < dog.allTime.walks, 'hidden slices stay in the total');
  assert.deepEqual(dog.allTime.bySpecies.map((x) => [x.species, x.count]), [['dog', 16], ['cat', 4]], 'species split covers both');
  const cat = (await call('GET', '/api/impact?days=all&species=cat', as(A))).json;
  assert.equal(cat.allTime.walks, 4);
  assert.equal(cat.allTime.seconds, 2790);
  assert.equal(cat.allTime.avgSeconds, 2790 / 4, 'no walks: the >= 60 s average of every engagement');
  assert.deepEqual(cat.allTime.byAge, [], 'kittens 2, adults 2: both under 3, hidden');
  assert.deepEqual(cat.days, [], 'no cat day reaches 3');
  const all = (await call('GET', '/api/impact?days=all&species=all', as(A))).json;
  assert.equal(all.allTime.walks, dog.allTime.walks + cat.allTime.walks);
  assert.equal(all.allTime.seconds, dog.allTime.seconds + cat.allTime.seconds);
});

test('Together day list: ET midnight and both DST changes land on the right day', async () => {
  const dog = (await call('GET', '/api/impact?days=all&species=dog', as(A))).json;
  const day = (k) => dog.days.find((d) => d.dateKey === k);
  assert.equal(day('2026-03-07'), undefined, 'Mar 7 has one walk: not listed');
  assert.deepEqual(['walks', 'seconds', 'dogs', 'avgSeconds'].map((k) => day('2026-03-08')[k]), [3, 3600, 2, 1500], 'Mar 8 (spring forward): 1:30am EST and 3:30am EDT both count');
  assert.deepEqual(['walks', 'seconds', 'dogs', 'avgSeconds'].map((k) => day('2026-10-31')[k]), [4, 4200, 3, 1050], 'Oct 31 includes the 11:50pm walk (03:50Z Nov 1)');
  assert.deepEqual(['walks', 'seconds', 'dogs', 'avgSeconds'].map((k) => day('2026-11-01')[k]), [5, 25230, 4, 900], 'Nov 1 (fall back): 05:30Z and 06:30Z both count; misscan and daycation not averaged');
  // Listed days plus the one hidden walk = the all-time total (+ today's 3).
  const listed = dog.days.reduce((s, d) => s + d.walks, 0);
  assert.equal(listed + 1, dog.allTime.walks, 'only the quiet Mar 7 walk is unlisted');
  const all = (await call('GET', '/api/impact?days=all', as(A))).json;
  assert.equal(all.days.find((d) => d.dateKey === '2026-10-31').walks, 6, 'both species: + 2 cat cuddles');
  assert.equal(all.days.find((d) => d.dateKey === '2026-11-01').walks, 6, 'both species: + the matchmaking');
});

test('Together list row = /api/impact/day for every listed day and species (count, seconds, average)', async () => {
  for (const sp of ['dog', 'cat', 'all']) {
    const list = (await call('GET', `/api/impact?days=all&species=${sp}`, as(B))).json.days;
    for (const d of list) {
      const r = await call('GET', `/api/impact/day?date=${d.dateKey}&species=${sp}`, as(B));
      assert.equal(r.status, 200, `${sp} ${d.dateKey}`);
      const w = r.json.walks;
      assert.equal(w.length, d.walks, `${sp} ${d.dateKey} count`);
      // Round 4: other volunteers' rows are to the nearest 5 minutes, so
      // the exact day figures come as `totals` (= the list row), and the
      // exact rows are each walker's own.
      assert.deepEqual(r.json.totals, { walks: d.walks, dogs: d.dogs, seconds: d.seconds, avgSeconds: d.avgSeconds, avgActivity: d.avgActivity }, `${sp} ${d.dateKey} totals`);
      const exact = await exactDay(d.dateKey, sp);
      assert.equal(exact.length, d.walks, `${sp} ${d.dateKey} every walk is someone's own`);
      assert.equal(exact.reduce((s, x) => s + x.durationSeconds, 0), d.seconds, `${sp} ${d.dateKey} seconds`);
      const walksOnly = exact.filter((x) => x.activity === 'walk' && x.durationSeconds >= 60);
      const pool = walksOnly.length ? walksOnly : exact.filter((x) => x.durationSeconds >= 60);
      const avg = pool.length ? pool.reduce((s, x) => s + x.durationSeconds, 0) / pool.length : 0;
      assert.equal(avg, d.avgSeconds, `${sp} ${d.dateKey} average`);
      assert.ok(Math.abs(w.reduce((s, x) => s + x.durationSeconds, 0) - d.seconds) <= 150 * w.length, 'rounded rows stay close');
      assert.ok(w.every((x) => (x.mine ? x.endedAt : x.durationSeconds % 300 === 0 && !('startedAt' in x))), 'no walk in progress; others have no times');
    }
  }
  const oct31 = (await call('GET', '/api/impact/day?date=2026-10-31&species=dog', as(A))).json.walks;
  assert.ok(oct31.some((w) => w.startedAt === '2026-11-01T03:50:00.000Z'), '11:50pm ET is on Oct 31');
  const nov1 = (await exactDay('2026-11-01', 'dog')).map((w) => w.startedAt);
  assert.ok(nov1.includes('2026-11-01T05:30:00.000Z') && nov1.includes('2026-11-01T06:30:00.000Z'), 'both 1:30ams are Nov 1');
  assert.equal((await call('GET', '/api/impact/day?date=2026-03-07', as(A))).status, 404, 'a quiet day is not opened up');
  const dogDay = (await call('GET', '/api/impact/day?date=2026-10-31&species=dog', as(A))).json.walks;
  assert.ok(dogDay.every((w) => w.dogId < 20), 'the Dogs day view holds dogs only');
});

test('/api/impact?days=N: never older than today - (N-1), and each day matches days=all', async () => {
  const all = (await call('GET', '/api/impact?days=all&species=all', as(A))).json.days;
  for (const n of [1, 3, 10, 30, 120]) {
    const r = (await call('GET', `/api/impact?days=${n}&species=all`, as(A))).json;
    const oldest = shiftKey(todayKey(), -(n - 1));
    for (const d of r.days) {
      assert.ok(d.dateKey >= oldest, `days=${n}: ${d.dateKey} is older than ${oldest}`);
      assert.deepEqual(d, all.find((x) => x.dateKey === d.dateKey), `days=${n}: ${d.dateKey} matches days=all`);
    }
    assert.equal(r.days.length, all.filter((d) => d.dateKey >= oldest).length, `days=${n} lists every day in its window`);
  }
});

test('a walk in progress never counts: stats, Together, day detail, staff reports, walk-stats', async () => {
  // Alice's open walk is on Max (3); Bob's open cuddle is on Tom (22).
  const a = (await call('GET', '/api/stats?species=all', as(A))).json;
  assert.equal(a.perDog.find((d) => d.id === 3).walkCount, 3, 'Max: W10, W3, W7 only');
  const b = (await call('GET', '/api/stats?species=cat', as(B))).json;
  assert.equal(b.totals.totalWalks, 0, "Bob's open cat cuddle is not a cat engagement yet");
  const ws = (await call('GET', '/api/dogs/3/walk-stats', as(A))).json;
  assert.equal(ws.everyone.count, 3);
  assert.equal(ws.mine.count, 3);
  const report = (await call('GET', `/api/staff/reports?from=${todayKey()}&to=${todayKey()}&species=all&sections=byActivity`, staffAs)).json;
  if (todaySafe()) assert.equal(report.stats.totals.walks, 4, 'today: 3 dog walks + 1 cat cuddle finished');
  const day = await call('GET', `/api/impact/day?date=${todayKey()}`, as(A));
  if (todaySafe() && day.status === 200) assert.ok(day.json.walks.every((w) => (w.mine ? w.endedAt : w.slot !== undefined)));
});

test('staff reports: exact totals, = Together for the same range and species, byPeriod hours sum to total', async () => {
  const range = 'from=2026-10-31&to=2026-11-01';
  const sections = 'sections=byActivity,byPeriod,byDayOfWeek,highlights,shelterContext,uniqueDogsServed';
  const dog = (await call('GET', `/api/staff/reports?${range}&${sections}`, staffAs)).json;
  assert.deepEqual(dog.stats.totals, { walks: 9, hours: 8.2, uniqueDogs: 4, volunteerHeadcount: 2 });
  assert.equal(dog.stats.highlights.avgWalkMinutes, 17, '(1200+600+1800+600+900+900)/6 = 1000 s; misscan and daycation left out');
  assert.deepEqual(dog.tables.byDayOfWeek.rows.map((r) => [r[0], r[1]]), [['Sunday', 5], ['Saturday', 4]].sort((x, y) => (x[0] === 'Sunday' ? -1 : 1)), 'the 11:50pm walk is a Saturday');
  const shelter = Object.fromEntries(dog.tables.shelterContext.rows);
  assert.equal(shelter.Adopted, 1);
  assert.equal(shelter.Returned, 1);
  const names = dog.tables.uniqueDogsServed.rows.map((r) => r[0]);
  assert.ok(!names.includes('Pip') && !names.includes('Tom'), 'cats never in dog tiles');
  const periodHours = dog.tables.byPeriod.rows.reduce((s, r) => s + r[2], 0);
  assert.ok(Math.abs(periodHours - dog.stats.totals.hours) <= 0.05 * dog.tables.byPeriod.rows.length, `byPeriod hours ${periodHours} ~ ${dog.stats.totals.hours}`);
  assert.equal(dog.tables.byPeriod.rows.reduce((s, r) => s + r[1], 0), dog.stats.totals.walks, 'both days have 3+, so byPeriod covers every engagement');

  // Same range and species as Together.
  for (const sp of ['dog', 'cat', 'all']) {
    const rep = (await call('GET', `/api/staff/reports?${range}&species=${sp}&sections=highlights`, staffAs)).json;
    let walks = 0; let seconds = 0; const walkSecs = [];
    for (const d of ['2026-10-31', '2026-11-01']) {
      for (const w of await exactDay(d, sp)) {
        walks += 1; seconds += w.durationSeconds;
        if (w.activity === 'walk' && w.durationSeconds >= 60) walkSecs.push(w.durationSeconds);
      }
    }
    const expectWalks = { dog: 9, cat: 3, all: 12 }[sp];
    assert.equal(rep.stats.totals.walks, expectWalks, `${sp} staff total`);
    if (sp !== 'cat') { // cat days are under 3, so Together does not open them
      assert.equal(rep.stats.totals.walks, walks, `${sp}: staff = Together count`);
      assert.equal(rep.stats.totals.hours, hours(seconds), `${sp}: staff = Together hours`);
      assert.equal(rep.stats.highlights.avgWalkMinutes, Math.round(walkSecs.reduce((s, x) => s + x, 0) / walkSecs.length / 60), `${sp}: same walk average`);
    }
  }
  const spring = (await call('GET', '/api/staff/reports?from=2026-03-07&to=2026-03-08', staffAs)).json;
  assert.equal(spring.stats.totals.walks, 4, 'Mar 7 (1) + Mar 8 (3) across spring forward');
});

test('live board: walks today = Together today (finished only), dogs only by default', async (t) => {
  if (!todaySafe()) { t.skip('seeded "today" walks straddle ET midnight; rerun'); return; }
  const live = (await call('GET', '/api/staff/live', staffAs)).json;
  const together = (await call('GET', '/api/impact?days=1&species=dog', as(A))).json;
  assert.equal(live.species, 'dog');
  assert.equal(live.walksToday, 3);
  assert.equal(together.today.walks, live.walksToday, 'live board = Together for dogs today');
  assert.equal(live.dogsOutToday, 4, 'dogs out today includes the one still out');
  assert.equal(live.activeWalkerCount, 1);
  assert.equal(live.hourlyToday.reduce((s, x) => s + x, 0), live.walksToday);
  const all = (await call('GET', '/api/staff/live?species=all', staffAs)).json;
  const togetherAll = (await call('GET', '/api/impact?days=1&species=all', as(A))).json;
  assert.equal(all.walksToday, 4);
  assert.equal(togetherAll.today.walks, all.walksToday);
  assert.equal(all.activeWalkerCount, 2);
  const cat = (await call('GET', '/api/staff/live?species=cat', staffAs)).json;
  assert.equal(cat.walksToday, 1);
  const outNow = Object.values(live.locations).flat().concat(live.daycation);
  assert.deepEqual(outNow.map((w) => w.dogName), ['Max'], 'only the dog still out; no cats on the dog board');
});

// Was a BUG found by this suite (averages ignored ?species); fixed in
// src/staffDashboard.js computeActivityAverages.
test('live board averages on the dog board come from dog engagements only', async () => {
  const live = (await call('GET', '/api/staff/live?species=dog', staffAs)).json;
  // Dogs: walks >= 60 s average 9870/12 = 822.5; the only dog cuddle is W11
  // (600 s); no dog matchmaking, so it falls back to the walk average.
  assert.equal(live.activityAverages.walk, 823);
  assert.equal(live.activityAverages.cuddle, 600, 'cat cuddles (900, 600, 90 s) must not move the dog cuddle average');
  assert.equal(live.activityAverages.matchmaking, 823, "a cat's matchmaking is not a dog average");
});

test('shelter-trends: exact rebuilt days, floor + foster = listed, floorNow = shelterNow total', async () => {
  const t = (await call('GET', '/api/shelter-trends?species=dog', as(A))).json;
  assert.equal(t.listedNow, 6);
  assert.equal(t.fosterNow, 1);
  assert.equal(t.floorNow, 5);
  assert.equal(t.days[0].dateKey, '2026-10-31', 'starts on the first day with an event since tracking began (2026-09-23)');
  const d = (k) => t.days.find((x) => x.dateKey === k);
  assert.deepEqual(['listed', 'adopted', 'foster', 'floor'].map((k) => d('2026-10-31')[k]), [5, 1, 1, 4]);
  assert.deepEqual(['listed', 'returned', 'broughtIn', 'foster', 'floor'].map((k) => d('2026-11-01')[k]), [6, 1, 1, 1, 5]);
  assert.equal(d('2026-10-30'), undefined, 'the Sep 1 arrivals are before tracking began');
  const gap = t.days.find((x) => x.dateKey > '2026-11-01' && x.dateKey < todayKey());
  if (gap) assert.deepEqual([gap.listed, gap.foster, gap.floor], [6, null, null], 'a day with no count: a gap, not a guess');
  for (const x of t.days) if (x.floor != null) assert.equal(x.floor + x.foster, x.listed, x.dateKey);
  const stats = (await call('GET', '/api/stats?species=dog', as(A))).json.shelterNow.dog;
  const impact = (await call('GET', '/api/impact?species=dog', as(A))).json.shelterNow.dog;
  assert.equal(stats.counts.total, t.floorNow, 'My stats "right now" = trends floorNow');
  assert.equal(impact.counts.total, t.floorNow, 'Together "right now" = trends floorNow');
  assert.equal(stats.inFoster, t.fosterNow);
  const cats = (await call('GET', '/api/shelter-trends?species=cat', as(A))).json;
  assert.equal(cats.listedNow, 2);
  assert.equal(cats.floorNow, (await call('GET', '/api/stats?species=cat', as(A))).json.shelterNow.cat.counts.total);
});

test("walk-stats everyone.count = that dog's walk-history rows, for every animal", async () => {
  for (const [id] of DOGS) {
    const ws = (await call('GET', `/api/dogs/${id}/walk-stats`, as(B))).json;
    const histJson = (await call('GET', `/api/dogs/${id}/walk-history`, as(B))).json;
    const hist = histJson.walks;
    assert.equal(hist.length, ws.everyone.count, `animal ${id}`);
    assert.equal(hist.filter((w) => w.mine).length, ws.mine.count, `animal ${id} (mine)`);
    // Other people's lengths are rounded to 5 minutes (security3), so the
    // exact total rides along as totals.
    assert.equal(histJson.totals.totalSeconds, ws.everyone.totalSeconds, `animal ${id} seconds`);
    assert.equal(histJson.totals.count, ws.everyone.count, `animal ${id} totals`);
    assert.equal(hist.filter((w) => w.mine).reduce((s, w) => s + w.durationSeconds, 0), ws.mine.totalSeconds, `animal ${id} my seconds`);
  }
  assert.equal((await call('GET', '/api/dogs/1/walk-stats', as(A))).json.everyone.count, 5, 'Rex: W8, W1, W12, W4 and today');
});

test('lifetime average (as the chart computes it from /api/walks?ended=1) = the avg tile', async () => {
  for (const [email, sp] of [[A, 'dog'], [B, 'dog'], [A, 'all'], [C, 'cat']]) {
    const tile = (await call('GET', `/api/stats?species=${sp}`, as(email))).json.totals.avgSeconds;
    const walks = (await call('GET', '/api/walks?ended=1', as(email))).json.walks.filter((w) => sp === 'all' || w.species === sp);
    const pool = walks.filter((w) => w.activity === 'walk' && w.duration_seconds >= 60);
    const fallback = walks.filter((w) => w.duration_seconds >= 60);
    const use = pool.length ? pool : fallback;
    const avg = use.length ? use.reduce((s, w) => s + w.duration_seconds, 0) / use.length : 0;
    assert.equal(avg, tile, `${email} ${sp}`);
  }
});

test('an empty DB: 0, never NaN or Infinity, and null only where the UI shows a dash', async () => {
  const empty = await startServer({ prefix: 'sw-release-empty-' });
  try {
    const c = client(empty.base);
    await c('GET', '/api/me', { user: A });
    const todayK = dayKey(new Date().toISOString());
    // Values that are null on purpose (nothing to show yet): the app and
    // staff page render these as a dash or leave the section out.
    const allowedNull = [/^today$/, /^allTime\.since$/, /^stats\.highlights\.(busiestDay|quietestDay|avgWalksPerVolunteer|avgWalkMinutes)$/, /^shelterNow\.\w+\.today$/, /^days\[\d+\]\.(floor|foster)$/,
      // No single activity behind an average (none yet, or a mix): "Average engagement".
      /(^|\.)avgActivity$/];
    const urls = [
      ['/api/stats?species=all', as(A)], ['/api/stats?species=dog', as(A)], ['/api/stats?species=cat', as(A)],
      ['/api/impact?days=all', as(A)], ['/api/impact?days=30&species=dog', as(A)], ['/api/impact?species=cat', as(A)],
      ['/api/staff/live', staffAs], ['/api/staff/live?species=all', staffAs],
      [`/api/staff/reports?from=${shiftKey(todayK, -6)}&to=${todayK}&sections=byActivity,byPeriod,byLocation,byDayOfWeek,byTimeOfDay,shelterContext,uniqueDogsServed,highlights`, staffAs],
      ['/api/shelter-trends', as(A)], ['/api/shelter-trends?species=cat', as(A)]
    ];
    for (const [url, who] of urls) {
      const r = await c('GET', url, who);
      assert.equal(r.status, 200, url);
      assert.doesNotMatch(r.text, /NaN|Infinity/, url);
      const unexpected = badValues(r.json).filter((p) => !p.endsWith('= null') || !allowedNull.some((re) => re.test(p.replace(/ = null$/, ''))));
      assert.deepEqual(unexpected, [], url);
    }
    const stats = (await c('GET', '/api/stats?species=all', as(A))).json;
    assert.deepEqual([stats.totals.totalWalks, stats.totals.totalSeconds, stats.totals.avgSeconds], [0, 0, 0]);
    const impact = (await c('GET', '/api/impact?days=all', as(A))).json;
    assert.deepEqual([impact.allTime.walks, impact.allTime.seconds, impact.allTime.avgSeconds], [0, 0, 0]);
    const live = (await c('GET', '/api/staff/live', staffAs)).json;
    assert.deepEqual([live.walksToday, live.dogsOutToday, live.activeWalkerCount], [0, 0, 0]);
    const rep = (await c('GET', '/api/staff/reports', staffAs)).json;
    assert.deepEqual(rep.stats.totals, { walks: 0, hours: 0, uniqueDogs: 0, volunteerHeadcount: 0 });
    const tr = (await c('GET', '/api/shelter-trends', as(A))).json;
    assert.deepEqual([tr.listedNow, tr.floorNow, tr.fosterNow], [0, 0, 0]);
  } finally { await empty.stop(); }
});

// ---------------------------------------------------------------------------
// Security & privacy
// ---------------------------------------------------------------------------
test('every /api route answers 401 without x-auth-email (client-error excepted)', async () => {
  const routes = apiRoutes();
  assert.ok(routes.length > 80, `found ${routes.length} routes`);
  const wrong = [];
  for (const r of routes) {
    const url = fill(r.path);
    const res = await call(r.method, url, r.method === 'GET' || r.method === 'DELETE' ? {} : { body: {} });
    const want = r.path === '/api/client-error' ? 204 : 401;
    if (res.status !== want) wrong.push(`${r.method} ${url} (${r.file}) -> ${res.status}, want ${want}`);
    else if (want === 401) assert.ok(res.json && res.json.error, `${url}: JSON error`);
  }
  assert.deepEqual(wrong, []);
  const up = await call('GET', '/uptime');
  assert.match(up.text.trim(), /^(ok|down)$/);
});

test('every staff route is 403 for a signed-in volunteer (and for a body/query "staff" flag)', async () => {
  const routes = apiRoutes().filter((r) => r.staffGuard || r.path.startsWith('/api/staff/') || r.path === '/api/modules' || r.path.startsWith('/api/feedback/') || (r.path === '/api/feedback' && r.method === 'GET') || r.path === '/api/scrape/run');
  assert.ok(routes.length >= 20, `found ${routes.length} staff routes`);
  const wrong = [];
  for (const r of routes) {
    const url = fill(r.path);
    const res = await call(r.method, `${url}${url.includes('?') ? '&' : '?'}staff=1`, { user: C, ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: { staff: true, isStaff: true } }) });
    if (res.status !== 403) wrong.push(`${r.method} ${url} (${r.file}) -> ${res.status}`);
  }
  assert.deepEqual(wrong, []);
  for (const page of ['/staff']) {
    const r = await call('GET', page, { user: C });
    assert.equal(r.status, 403, page);
  }
  assert.equal((await call('GET', '/api/staff/live', { user: C, headers: { 'x-auth-staff': 'true' } })).status, 403, 'only exactly "1" counts');
});

test('/api/internal/*: no token, a wrong token, or a near-miss token is 403', async () => {
  const s2 = await startServer({ prefix: 'sw-release-int-', env: { INTERNAL_API_TOKEN: 'right-token-123' } });
  try {
    const c = client(s2.base);
    const routes = apiRoutes().filter((r) => r.path.startsWith('/api/internal/'));
    assert.ok(routes.length >= 2);
    for (const r of routes) {
      for (const auth of [undefined, 'Bearer wrong', 'Bearer right-token-12', 'bearer right-token-123', 'right-token-123', 'Bearer right-token-1234']) {
        const res = await c(r.method, r.path, { user: C, headers: auth ? { authorization: auth } : {}, body: { emails: ['x@example.com'], email: 'x@example.com', isPrivileged: true } });
        assert.equal(res.status, 403, `${r.method} ${r.path} with ${auth || 'no token'}`);
      }
    }
    const ok = await c('POST', '/api/internal/accounts/lookup', { headers: { authorization: 'Bearer right-token-123' }, body: { emails: ['x@example.com'] } });
    assert.equal(ok.status, 200, 'the right token works');
  } finally { await s2.stop(); }
});

test('a fresh DB: nobody is privileged by name or email (alberto@...)', async () => {
  const s2 = await startServer({ prefix: 'sw-release-fresh-' });
  try {
    const c = client(s2.base);
    for (const email of ['alberto@example.com', 'alberto.chestnut@example.com', 'admin@example.com']) {
      const me = (await c('GET', '/api/me', { user: email })).json;
      assert.equal(me.isPrivileged, false, email);
      assert.equal(me.canAudit, false, email);
    }
    const db = new Database(s2.dbFile, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_privileged = 1 OR can_audit = 1').get().n, 0);
    db.close();
  } finally { await s2.stop(); }
});

test('DELETE /api/me leaves no row pointing at that walker in any table; walks are kept with user_id NULL', async () => {
  const stub = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{"deleted":true}'); }); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const s2 = await startServer({ prefix: 'sw-release-del-', env: { DJANGO_INTERNAL_URL: `http://127.0.0.1:${stub.address().port}`, INTERNAL_API_TOKEN: 'tok' } });
  try {
    const c = client(s2.base);
    const LEAVER = 'rc.leaver.ocelot@example.com';
    const me = (await c('GET', '/api/me', { user: LEAVER })).json;
    await c('PUT', '/api/me', { user: LEAVER, body: { name: 'Ocelot Leaver' } });
    await c('PUT', '/api/modules/walker-chat', { ...staffAs, body: { enabled: true } });
    let db = new Database(s2.dbFile);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Rex', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
    db.close();
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    assert.equal((await c('POST', '/api/walks/manual', { user: LEAVER, body: { dogId: 1, userId: me.id, startedAt: ago(120), endedAt: ago(100), notes: 'good' } })).status, 200);
    assert.equal((await c('POST', '/api/walks/start', { user: LEAVER, body: { dogId: 1, userId: me.id } })).status, 200);
    const seeds = [
      ['POST', '/api/dogs/1/notes', { body: 'shared tip' }],
      ['PUT', '/api/dogs/1/private-note', { body: 'private' }],
      ['POST', '/api/dogs/1/playgroup-notes', { body: 'signed pg note', signed: true }],
      ['PUT', `/api/users/${me.id}/favorites/1`, { favorite: true }],
      ['POST', `/api/users/${me.id}/saved-filters`, { name: 'f', filter: {} }],
      ['PUT', `/api/users/${me.id}/notification-prefs`, { key: 'walk_started', enabled: true }],
      ['POST', '/api/modules/walker-chat/messages', { body: 'hi all' }],
      ['PUT', '/api/manual-checkoffs', { dogId: 1, dateKey: dayKey(now), slotIndex: 0, checked: true, userId: me.id }],
      ['POST', '/api/checkoff', { dogId: 1, dateKey: dayKey(now) }]
    ];
    for (const [m, u, body] of seeds) {
      const r = await c(m, u, { user: LEAVER, body });
      assert.ok(r.status < 300, `seed ${m} ${u} -> ${r.status} ${r.text}`);
    }
    assert.equal((await c('DELETE', '/api/me', { user: LEAVER, body: { confirm: 'DELETE' } })).status, 200);

    db = new Database(s2.dbFile, { readonly: true });
    const left = [];
    for (const { name: t } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((x) => x.name);
      for (const col of cols.filter((x) => /(^|_)user_id$|^(created|updated)_by$|^author/.test(x))) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ? OR ${col} = ?`).get(me.id, 'Ocelot Leaver').n;
        if (n) left.push(`${t}.${col}: ${n}`);
      }
      if (t === 'users') continue;
      const dump = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()).toLowerCase();
      if (dump.includes('ocelot')) left.push(`${t}: mentions the name/email`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(me.id).n, 0);
    assert.deepEqual(left, []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM walks WHERE user_id IS NULL AND ended_at IS NOT NULL').get().n, 1, 'the finished walk is kept, unowned');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM walks WHERE ended_at IS NULL').get().n, 0, 'the open one is gone');
    db.close();
  } finally { await s2.stop(); stub.close(); }
});

test('boot on an old-schema DB: migrations run, rows survive, every index exists, a second boot is clean', async () => {
  const t = tempDirs('sw-release-old-');
  const old = new Database(t.dbFile);
  // The original two tables, before any later column existed.
  old.exec(`
    CREATE TABLE dogs (shelter_buddy_id INTEGER PRIMARY KEY, name TEXT NOT NULL, sex TEXT, age TEXT, breed TEXT, weight TEXT, desexed TEXT,
      location TEXT, date_in_shelter TEXT, summary TEXT, tags TEXT, photo_url TEXT, still_listed INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, removed_at TEXT);
    CREATE TABLE walks (id INTEGER PRIMARY KEY AUTOINCREMENT, dog_id INTEGER NOT NULL REFERENCES dogs(shelter_buddy_id), location TEXT,
      started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER, notes TEXT);
    INSERT INTO dogs (shelter_buddy_id, name, first_seen_at, last_seen_at, tags) VALUES (9, 'Oldie', '2026-01-01', '2026-01-01', '["Dog"]');
    INSERT INTO walks (dog_id, started_at, ended_at, duration_seconds) VALUES (9, '2026-01-02T15:00:00.000Z', '2026-01-02T15:20:00.000Z', 1200);
  `);
  old.close();
  const expectedIdx = new Set(['idx_walks_one_open_per_user', 'idx_walks_one_open_per_dog']);
  for (const m of fs.readFileSync(path.join(APP_DIR, 'src', 'db.js'), 'utf8').matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)) expectedIdx.add(m[1]);
  for (let boot = 1; boot <= 2; boot += 1) {
    const s = await startServer({ dir: t.dir });
    try {
      const c = client(s.base);
      assert.equal((await c('GET', '/api/dogs/9', as(A))).json.dog.name, 'Oldie', `boot ${boot}: old rows readable`);
      assert.doesNotMatch(s.output(), /not creating|Error|SQLITE_/i, `boot ${boot}: clean log`);
      const db = new Database(s.dbFile, { readonly: true });
      const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name));
      assert.deepEqual([...expectedIdx].filter((n) => !have.has(n)), [], `boot ${boot}: every index`);
      const w = db.prepare('SELECT activity, auto_stopped, user_id FROM walks').get();
      assert.deepEqual(w, { activity: 'walk', auto_stopped: 0, user_id: null });
      assert.equal(db.prepare('SELECT species FROM dogs WHERE shelter_buddy_id = 9').get().species, 'dog');
      db.close();
    } finally { await s.stop(); }
  }
  fs.rmSync(t.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Walk lifecycle (the rest is in api.test.js, audit-backend.test.js,
// privacy.test.js, walk-hours*.test.js)
// ---------------------------------------------------------------------------
test('times with an offset are stored as toISOString(); junk is rejected', async () => {
  const s2 = await startServer({ prefix: 'sw-release-iso-' });
  try {
    const c = client(s2.base);
    const me = (await c('GET', '/api/me', as(A))).json;
    const db = new Database(s2.dbFile);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Rex', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
    db.close();
    const d = new Date(Date.now() - 3 * 86400000); d.setUTCHours(16, 0, 0, 0);
    const local = (x) => { const s = new Date(x.getTime() - 5 * 3600000).toISOString().slice(0, 19); return `${s}-05:00`; };
    const r = await c('POST', '/api/walks/manual', { user: A, body: { dogId: 1, userId: me.id, startedAt: local(d), endedAt: local(new Date(d.getTime() + 20 * 60000)) } });
    if (r.status === 200) {
      const row = new Database(s2.dbFile, { readonly: true });
      const w = row.prepare('SELECT started_at, ended_at, duration_seconds FROM walks WHERE id = ?').get(r.json.id);
      row.close();
      assert.deepEqual(w, { started_at: d.toISOString(), ended_at: new Date(d.getTime() + 20 * 60000).toISOString(), duration_seconds: 1200 });
    } else assert.equal(r.status, 400, 'or refused outright');
    for (const bad of ['yesterday', '2026-11-01 10:00', '1730000000000', '']) {
      assert.equal((await c('POST', '/api/walks/manual', { user: A, body: { dogId: 1, userId: me.id, startedAt: bad, endedAt: now } })).status, 400, `"${bad}"`);
    }
  } finally { await s2.stop(); }
});

// ---------------------------------------------------------------------------
// Scraper, images & push
// ---------------------------------------------------------------------------
test('images: photo URLs on /api/dogs answer 200 image/*, no-photo animals get a silhouette, traversal is refused', async () => {
  const imgDir = path.join(srv.dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  fs.writeFileSync(path.join(imgDir, '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const dogs = (await call('GET', '/api/dogs', as(C))).json.dogs; // Carol volunteers with both
  assert.equal(dogs.length, 8, 'every listed dog and cat');
  for (const d of dogs) {
    const url = d.photoUrl;
    assert.ok(url, `${d.name} has an image URL (photo or fallback)`);
    if (!url.startsWith('/')) continue; // the shelter's own URL: not fetched here
    const r = await fetch(srv.base + url);
    assert.equal(r.status, 200, `${d.name}: ${url}`);
    assert.match(r.headers.get('content-type'), /^image\//, `${d.name}: ${url}`);
  }
  const rex = dogs.find((d) => d.id === 1);
  assert.match(rex.photoUrl, /^\/cached-images\/1\.jpg\?v=\d+$/);
  const pip = dogs.find((d) => d.id === 21);
  assert.match(pip.photoUrl, /^\/dog-silhouettes\/cat-21\.svg/, 'a cat without a photo gets the cat silhouette');
  assert.match(dogs.find((d) => d.id === 2).photoUrl, /^\/dog-silhouettes\/2\.svg/, 'a dog without a photo gets its silhouette');
  // The fallback is the same URL in the list and the profile.
  for (const id of [1, 2, 21]) assert.equal((await call('GET', `/api/dogs/${id}`, as(C))).json.dog.photoUrl, dogs.find((d) => d.id === id).photoUrl, `animal ${id}: same image in list and profile`);

  const wiki = path.join(srv.dir, 'wiki-images');
  fs.mkdirSync(wiki, { recursive: true });
  fs.writeFileSync(path.join(wiki, 'abc123.png'), fs.readFileSync(path.join(APP_DIR, 'public', 'icons', 'icon-192.png')));
  const g = await fetch(`${srv.base}/wiki-images/abc123.png`);
  assert.equal(g.status, 200);
  assert.match(g.headers.get('content-type'), /^image\/png/);

  fs.writeFileSync(path.join(srv.dir, 'secret.txt'), 'top-secret');
  const tries = [
    '/cached-images/../secret.txt', '/cached-images/..%2fsecret.txt', '/cached-images/%2e%2e/secret.txt', '/cached-images/..%5csecret.txt',
    '/wiki-images/../secret.txt', '/wiki-images/..%2fsecret.txt', '/wiki-images/%2e%2e%2fsecret.txt', '/wiki-images/..%2f..%2fsrc%2fserver.js',
    '/dog-silhouettes/..%2f..%2fsrc%2fserver.js', '/dog-silhouettes/1.svg%00.js', '/cached-images/1.jpg%2f..%2f..%2fsecret.txt',
    '/css/..%2f..%2fsrc%2fserver.js', '/%2e%2e/src/server.js'
  ];
  for (const u of tries) {
    const r = await call('GET', u, as(A));
    assert.ok([400, 403, 404].includes(r.status), `${u} -> ${r.status}`);
    assert.ok(!r.text.includes('top-secret') && !r.text.includes('require('), `${u} leaked a file`);
  }
});

test('manifest.json and its icons (plus the badge) load without sign-in, at the sizes listed', async () => {
  const m = await fetch(`${srv.base}/manifest.json`);
  assert.equal(m.status, 200);
  const manifest = await m.json();
  const pngSize = (buf) => `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  const icons = [...manifest.icons, ...(manifest.shortcuts || []).flatMap((s) => s.icons || []), { src: '/icons/badge-96.png', sizes: '96x96' }];
  for (const icon of icons) {
    const r = await fetch(srv.base + icon.src);
    assert.equal(r.status, 200, icon.src);
    assert.match(r.headers.get('content-type'), /^image\/png/, icon.src);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(pngSize(buf), icon.sizes, `${icon.src} is really ${icon.sizes}`);
  }
});

test('every local <script>/<link> on /, /staff and /playgroup carries ?v= (sw.js and manifest.json excepted)', async () => {
  for (const [page, who] of [['/', as(A)], ['/app', as(A)], ['/staff', staffAs], ['/playgroup', staffAs]]) {
    const html = (await call('GET', page, who)).text;
    const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((x) => x[1]).filter((u) => u.startsWith('/') && !u.startsWith('//'));
    assert.ok(refs.length >= 3, `${page}: found ${refs.length} refs`);
    const bare = refs.filter((u) => !/[?&]v=[\w.-]+/.test(u) && !/^\/(sw\.js|manifest\.json)$/.test(u) && !/^\/icons\//.test(u));
    assert.deepEqual(bare, [], `${page}: unversioned assets`);
  }
});

test('the scraper tests leave app/data untouched', async () => {
  const dataDir = path.join(APP_DIR, 'data');
  const snap = () => {
    const out = {};
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else { const st = fs.statSync(p); out[path.relative(dataDir, p)] = `${st.size}:${Math.floor(st.mtimeMs)}`; }
      }
    };
    walk(dataDir);
    return out;
  };
  const before = snap();
  const files = fs.readdirSync(path.join(APP_DIR, 'test')).filter((f) => /^(scraper.*|favorites-scraper|sticker-backfill|dog-names|audit-data)\.test\.js$/.test(f)).map((f) => `test/${f}`);
  assert.ok(files.length >= 4, files.join(', '));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.DB_PATH; delete env.IMAGES_DIR; delete env.WIKI_IMAGES_DIR; // each test isolates itself
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: APP_DIR, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `scraper tests failed:\n${(r.stdout || '').slice(-3000)}${r.stderr || ''}`);
  assert.deepEqual(snap(), before, 'app/data changed while the scraper tests ran');
});
