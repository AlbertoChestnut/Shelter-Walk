// Audit 2 (2026-11-10), staff dashboard & Playgroup desk:
//   - PDF export: every section title starts at the left margin (x = 50),
//     not under the last column of the table above it.
//   - Saved report formats keep their species (dog/cat/all); old rows read as dog.
//   - A week or month the report range cuts into says which days it covers.
//   - The one-animal picker gets ID, kennel and listed so same-name animals differ.
//   - "Alert sent" counts phones that really got the push (0 with push off),
//     both from the alert form and from a special day's "also send an alert".
//   - Playgroup: the writer can't sign a note after someone else edited it.
//   - One shared request helper (js/http-errors.js) on the staff, Playgroup and
//     volunteer pages, used by staff.js, staff-settings.js, playgroup.js and
//     the modules' scripts; it honours userFacing and the session-expired 401.
//   - The tutorial-shots script seeds the in-progress walk from the pinned clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { startServer, shelterDayFromToday } = require('./_helpers');

const APP = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

let base, dbFile, server;
const STAFF = 'a2.staff@example.com';
const ALICE = 'a2.alice@example.com';
const BOB = 'a2.bob@example.com';

async function call(method, url, { user = STAFF, staff = true, body, raw = false } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}

const ids = {};
test.before(async () => {
  server = await startServer({ prefix: 'sw-audit2-staff-' });
  ({ base, dbFile } = server);
  ids.staff = (await call('GET', '/api/me')).json.id;
  ids.alice = (await call('GET', '/api/me', { user: ALICE, staff: false })).json.id;
  ids.bob = (await call('GET', '/api/me', { user: BOB, staff: false })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at, species)
    VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?, ?, ?)`);
  insDog.run(270585, 'Duke', null, 0, now, now, 'dog'); // the delisted Duke
  insDog.run(272583, 'Duke', 'E', 1, now, now, 'dog'); // the current one
  insDog.run(3, 'Pal', 'A', 1, now, now, 'dog');
  const ins = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, 600, 'walk', 'A')");
  const walk = (dogId, startIso) => ins.run(dogId, ids.staff, startIso, new Date(new Date(startIso).getTime() + 600000).toISOString());
  // Oct 1-2, 2026 (a Thursday and Friday; that week starts Mon, Sep 28): 4 walks.
  walk(3, '2026-10-01T14:00:00.000Z'); walk(3, '2026-10-01T15:00:00.000Z');
  walk(272583, '2026-10-02T14:00:00.000Z'); walk(3, '2026-10-02T16:00:00.000Z');
  // Oct 12-14 (a whole week, Mon-Wed): 3 walks.
  walk(3, '2026-10-12T14:00:00.000Z'); walk(3, '2026-10-13T14:00:00.000Z'); walk(272583, '2026-10-14T14:00:00.000Z');
  // A push subscription: the old code said "Pushed to 1" even with push off.
  db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, 'https://push.example/one', 'k', 'a', ?)").run(ids.alice, now);
  db.close();
});
test.after(() => server && server.stop());

// ---- PDF section titles ----
function pdfTexts(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = streamRe.exec(s))) {
    let t;
    try { t = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (e) { continue; }
    const textRe = /1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*\/F\d+ ([\d.]+) Tf\s*\[([^\]]*)\] TJ/g;
    let tm;
    while ((tm = textRe.exec(t))) {
      const text = [...tm[4].matchAll(/<([0-9a-f]*)>/gi)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join('');
      out.push({ x: Number(tm[1]), size: Number(tm[3]), text });
    }
  }
  return out;
}

test('PDF export: every section title is drawn at the left margin', async () => {
  const r = await call('GET', '/api/staff/reports/export.pdf?from=2026-10-01&to=2026-10-31&granularity=week&sections=byActivity,byPeriod,byLocation,byDayOfWeek', { raw: true });
  assert.equal(r.status, 200);
  const titles = pdfTexts(r.buf).filter((t) => t.size === 13);
  const names = titles.map((t) => t.text);
  for (const want of ['Totals', 'By activity', 'By week', 'By location', 'By day of week']) assert.ok(names.includes(want), `PDF has the "${want}" title (got ${names.join(', ')})`);
  for (const t of titles) assert.equal(t.x, 50, `"${t.text}" starts at x=50, not ${t.x}`);
});

// ---- Saved report formats keep their species ----
test('saved report formats store and return the species; old rows read as dogs', async () => {
  const made = await call('POST', '/api/staff/saved-reports', { body: { name: 'Cat cuddles', sections: ['byActivity'], granularity: 'month', species: 'cat', dogIds: [] } });
  assert.equal(made.status, 200);
  assert.equal(made.json.species, 'cat');
  const both = await call('POST', '/api/staff/saved-reports', { body: { name: 'Everyone', sections: ['byActivity'], species: 'all' } });
  assert.equal(both.json.species, 'all');
  const junk = await call('POST', '/api/staff/saved-reports', { body: { name: 'Junk species', sections: [], species: 'hamster' } });
  assert.equal(junk.json.species, 'dog');
  const list = (await call('GET', '/api/staff/saved-reports')).json.reports;
  assert.equal(list.find((r) => r.name === 'Cat cuddles').species, 'cat');
  // A PUT without species keeps it; with one, changes it.
  assert.equal((await call('PUT', `/api/staff/saved-reports/${made.json.id}`, { body: { name: 'Cat cuddles 2' } })).json.species, 'cat');
  assert.equal((await call('PUT', `/api/staff/saved-reports/${made.json.id}`, { body: { species: 'all' } })).json.species, 'all');
  // A row from before the column existed (species defaults to 'dog').
  const db = new Database(dbFile);
  const cols = db.prepare('PRAGMA table_info(saved_staff_reports)').all().map((c) => c.name);
  assert.ok(cols.includes('species'));
  db.prepare("INSERT INTO saved_staff_reports (name, sections, granularity, dog_ids, created_at, updated_at) VALUES ('Legacy', '[]', 'day', '[]', 'x', 'x')").run();
  db.close();
  assert.equal((await call('GET', '/api/staff/saved-reports')).json.reports.find((r) => r.name === 'Legacy').species, 'dog');
  // The page sending and restoring it, and asking before deleting a shared
  // format, is checked in a browser: smoke/audit2-staff.js (audit3: these
  // were regexes over staff.js).
});

// ---- Partial periods ----
test('a week or month cut by the report range is marked with the days it covers', async () => {
  const week = (await call('GET', '/api/staff/reports?from=2026-10-01&to=2026-10-31&granularity=week&sections=byPeriod')).json;
  const labels = week.tables.byPeriod.rows.map((r) => r[0]);
  assert.ok(labels.includes('Week of Mon, Sep 28, 2026 (Oct 1 to Oct 4 only)'), labels.join(' | '));
  assert.ok(labels.includes('Week of Mon, Oct 12, 2026'), 'a whole week keeps its plain label');
  const month = (await call('GET', '/api/staff/reports?from=2026-10-01&to=2026-10-20&granularity=month&sections=byPeriod')).json;
  assert.deepEqual(month.tables.byPeriod.rows.map((r) => r[0]), ['October 2026 (Oct 1 to Oct 20 only)']);
  const whole = (await call('GET', '/api/staff/reports?from=2026-10-01&to=2026-10-31&granularity=month&sections=byPeriod')).json;
  assert.deepEqual(whole.tables.byPeriod.rows.map((r) => r[0]), ['October 2026']);
  const days = (await call('GET', '/api/staff/reports?from=2026-10-01&to=2026-10-02&granularity=day&sections=byPeriod')).json;
  assert.ok(days.tables.byPeriod.rows.every((r) => !/only\)/.test(r[0])), 'days are never partial');
});

// ---- The one-animal picker ----
test('the picker list tells same-name animals apart, and the page matches on ID', async () => {
  const { dogs } = (await call('GET', '/api/staff/dogs')).json;
  const dukes = dogs.filter((d) => d.name === 'Duke');
  assert.equal(dukes.length, 2);
  const current = dukes.find((d) => d.id === 272583);
  const old = dukes.find((d) => d.id === 270585);
  assert.equal(current.kennel, 'E');
  assert.ok(current.listed && !old.listed);
  // The options showing ID and kennel, a bare duplicate name asking which,
  // and picking by ID: smoke/audit2-staff.js, in a browser.
});

// ---- Alerts: real sends, one wording ----
test('"Alert sent" counts phones that really got it (push is off here, so 0)', async () => {
  const r = await call('POST', '/api/staff/alerts', { body: { title: 'Test alert', body: 'Hello' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.pushedTo, 0, 'a subscription is not a send');
  const day = await call('PUT', `/api/staff/schedule/days/${shelterDayFromToday(44)}`, { body: { mode: 'closed', note: 'Holiday', notify: true } });
  assert.equal(day.status, 200);
  assert.equal(day.json.alert.pushedTo, 0);
  // The one wording on both forms is checked in a browser:
  // smoke/audit2-staff.js (alert form), smoke/audit3-eng.js (special day).
  // push.sendPushToUser's count is run for real in test/audit3-eng.test.js.
});

// ---- Playgroup: no signing someone else's words ----
test('Playgroup: the writer cannot sign a note after someone else edited it', async () => {
  const opts = (user) => ({ user, staff: false });
  const made = await call('POST', '/api/dogs/3/playgroup-notes', { ...opts(ALICE), body: { body: 'Alice wrote this', noteDate: '2026-11-01' } });
  assert.equal(made.status, 200);
  const id = made.json.id;
  let mine = (await call('GET', '/api/dogs/3/playgroup-notes', opts(ALICE))).json.notes.find((n) => n.id === id);
  assert.equal(mine.canSign, true);
  // Bob rewrites it (anonymous notes are a whiteboard).
  assert.equal((await call('PUT', `/api/dogs/3/playgroup-notes/${id}`, { ...opts(BOB), body: { body: 'Bob changed this' } })).status, 200);
  mine = (await call('GET', '/api/dogs/3/playgroup-notes', opts(ALICE))).json.notes.find((n) => n.id === id);
  assert.equal(mine.canSign, false);
  const sign = await call('PUT', `/api/dogs/3/playgroup-notes/${id}`, { ...opts(ALICE), body: { body: 'Bob changed this', signed: true } });
  assert.equal(sign.status, 409);
  assert.match(sign.json.error, /someone else has edited/i);
  const after = (await call('GET', '/api/dogs/3/playgroup-notes', opts(BOB))).json.notes.find((n) => n.id === id);
  assert.equal(after.signed, false);
  assert.equal(after.author, null, "Alice's name never goes on Bob's words");
  // Alice can still edit it anonymously.
  assert.equal((await call('PUT', `/api/dogs/3/playgroup-notes/${id}`, { ...opts(ALICE), body: { body: 'Alice again' } })).status, 200);

  // Her own untouched note signs fine; Bob saving the same text changes nothing.
  const own = (await call('POST', '/api/dogs/3/playgroup-notes', { ...opts(ALICE), body: { body: 'All mine', noteDate: '2026-11-01' } })).json.id;
  await call('PUT', `/api/dogs/3/playgroup-notes/${own}`, { ...opts(BOB), body: { body: 'All mine', noteDate: '2026-10-31' } });
  assert.equal((await call('PUT', `/api/dogs/3/playgroup-notes/${own}`, { ...opts(ALICE), body: { body: 'All mine', signed: true } })).status, 200);
  // A signed note: Alice can unsign it any time.
  assert.equal((await call('PUT', `/api/dogs/3/playgroup-notes/${own}`, { ...opts(ALICE), body: { body: 'All mine', signed: false } })).status, 200);
  // The desk hiding the sign box on a locked note: smoke/audit3-eng.js.
});

// ---- One request helper ----
function loadHelper() {
  const win = {};
  const ctx = { window: win, document: { body: null }, navigator: { onLine: true }, setTimeout, clearTimeout, AbortController, fetch: null };
  vm.runInNewContext(read('public/js/http-errors.js'), ctx);
  return { http: win.ShelterHttp, ctx };
}

test('http-errors.js: userFacing 5xx shown, other 5xx plain, 4xx as written', () => {
  const { http } = loadHelper();
  assert.equal(http.errorMessage(400, { error: 'Pick a date.' }), 'Pick a date.');
  assert.equal(http.errorMessage(500, { error: 'SQLITE_BUSY: database is locked' }), 'Something went wrong on our end. Try again in a moment.');
  assert.equal(http.errorMessage(502, { error: 'Your account was NOT deleted.', userFacing: true }), 'Your account was NOT deleted.');
  assert.equal(http.errorMessage(503, null), "The server isn't responding right now. Try again in a minute.");
});

test('http-errors.js: a session-expired 401 or a sign-in page shows the signed-out bar', async () => {
  const { http, ctx } = loadHelper();
  let shown = 0;
  const bodyEl = { prepend: () => { shown += 1; } };
  const el = () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {} });
  ctx.document.body = bodyEl;
  ctx.document.createElement = el;
  const reply = (status, json, extra = {}) => async () => ({
    ok: status < 400, status, redirected: !!extra.redirected,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? (extra.type || 'application/json') : null) },
    json: async () => json
  });
  ctx.fetch = reply(401, { error: 'Your sign-in has expired. Reload the page to sign in again.', sessionExpired: true });
  await assert.rejects(http.request('/api/x'), /sign-in has expired/);
  assert.equal(shown, 1);
  ctx.fetch = reply(200, null, { redirected: true, type: 'text/html; charset=utf-8' });
  await assert.rejects(http.request('/api/x'), /sign-in has expired/);
  assert.equal(shown, 1, 'the bar shows once');
  ctx.fetch = reply(500, { error: 'boom' });
  await assert.rejects(http.request('/api/x'), (e) => e.message === 'Something went wrong on our end. Try again in a moment.' && e.status === 500);
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(http.request('/api/x'), /Couldn't reach the server/);
});

// Kept as a source check: "no script has its own copy of the helper" is
// about the code itself; that the pages load it and it works is in
// smoke/audit2-staff.js (the signed-out bar, ShelterHttp on the desk).
test('every staff/Playgroup page and module script uses the shared helper', () => {
  for (const page of ['public/staff.html', 'public/playgroup.html', 'public/index.html']) {
    const html = read(page);
    assert.match(html, /<script src="\/js\/http-errors\.js"><\/script>/, `${page} loads http-errors.js`);
  }
  // Before the page's own script.
  const staffHtml = read('public/staff.html');
  assert.ok(staffHtml.indexOf('http-errors.js') < staffHtml.indexOf('/js/staff.js'));
  const pgHtml = read('public/playgroup.html');
  assert.ok(pgHtml.indexOf('http-errors.js') < pgHtml.indexOf('/js/playgroup.js'));
  for (const file of ['public/js/staff.js', 'public/js/staff-settings.js', 'public/js/playgroup.js',
    'modules/walker-chat/public/chat.js', 'modules/youtube-channel/public/staff-panel.js']) {
    const src = read(file);
    assert.match(src, /window\.ShelterHttp\.request/, `${file} uses ShelterHttp`);
    assert.doesNotMatch(src, /Request failed \(/, `${file} never shows a raw status`);
    assert.doesNotMatch(src, /function httpErrorMessage/, `${file} has no copy of its own`);
  }
});

// ---- Live board ----
// Fit-to-screen only when wide or in TV mode, no polling while hidden, the
// stale banner, the axis following the data and demo mode per species are
// all checked in a browser: smoke/audit2-staff.js (and the audit-3 widths in
// test/audit3-staff.test.js). Audit3 dropped the regexes over staff.js here.

// ---- Tutorial screenshots script ----
// Kept as a source check: running the screenshot script is the only other
// way to see it, and that's a manual job (it rewrites the Guide's images).
test('tutorial-shots.js seeds the in-progress walk from the pinned clock', () => {
  const src = read('smoke/tutorial-shots.js');
  assert.match(src, /require\('\.\/_harness'\)/, 'this script runs on the pinned clock');
  assert.match(src, /--require=\.\/test\/_clock\.js/, '...and so does the server it starts');
  assert.match(src, /startSmoke\(\{ prefix: 'sw-shots-', env: \{ NODE_OPTIONS: nodeOptions \} \}\)/);
  assert.match(src, /not on the pinned clock/, 'and it refuses to shoot a walk on the wrong clock');
});
