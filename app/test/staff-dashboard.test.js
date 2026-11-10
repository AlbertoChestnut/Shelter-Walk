// Staff dashboard: access is gated on X-Auth-Staff alone (not isPrivileged),
// the live board groups correctly and honors hide_name_while_walking, and
// the report math (including the MIN_CELL privacy floor, same constant
// impact.js uses) is correct and agrees across JSON/CSV/XLSX/PDF.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;

const WALKER_A = 'walker.a@example.com';
const WALKER_B = 'walker.b@example.com';
const PRIVATE_WALKER = 'private.walker@example.com';

async function call(method, url, { user = WALKER_A, staff = false, body, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const ids = {};
test.before(async () => {
  server = await startServer({ prefix: 'sw-staff-' });
  ({ base, dbFile } = server);

  for (const [k, e] of [['a', WALKER_A], ['b', WALKER_B], ['priv', PRIVATE_WALKER]]) {
    ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  }
  const db = new Database(dbFile);
  db.prepare('UPDATE users SET hide_name_while_walking = 1 WHERE id = ?').run(ids.priv);
  const now = new Date().toISOString();
  const insDog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, 1, ?, ?)");
  insDog.run(1, 'Rex', 'A', now, now);
  insDog.run(2, 'Fido', 'B', now, now);
  insDog.run(3, 'Spot', null, now, now);
  for (let d = 4; d <= 20; d += 1) insDog.run(d, `Dog${d}`, null, now, now);
  db.close();
});
test.after(async () => { if (server) { await server.stop(); server = null; } });

test('access is gated on X-Auth-Staff alone', async () => {
  assert.equal((await call('GET', '/staff')).status, 403);
  assert.equal((await call('GET', '/staff', { staff: true })).status, 200);
  assert.equal((await call('GET', '/api/staff/live')).status, 403);
  assert.equal((await call('GET', '/api/staff/live', { staff: true })).status, 200);
  assert.equal((await call('GET', '/api/staff/reports')).status, 403);
  assert.equal((await call('GET', '/api/staff/reports/export.csv')).status, 403);
});

test('opening "/" on desktop sends a staff account straight to /staff, but never a regular walker, and /scan is untouched', async () => {
  const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

  const staffDesktop = await fetch(`${base}/`, { headers: { 'x-auth-email': WALKER_A, 'x-auth-staff': '1', 'user-agent': DESKTOP_UA }, redirect: 'manual' });
  assert.equal(staffDesktop.status, 302);
  assert.equal(staffDesktop.headers.get('location'), '/staff');

  const staffPhone = await fetch(`${base}/`, { headers: { 'x-auth-email': WALKER_A, 'x-auth-staff': '1', 'user-agent': IPHONE_UA }, redirect: 'manual' });
  assert.equal(staffPhone.status, 200, 'staff on a phone still get the volunteer app');

  const walkerDesktop = await fetch(`${base}/`, { headers: { 'x-auth-email': WALKER_A, 'user-agent': DESKTOP_UA }, redirect: 'manual' });
  assert.equal(walkerDesktop.status, 200, 'a non-staff walker is never redirected, even on desktop');

  const scanDesktop = await fetch(`${base}/scan`, { headers: { 'x-auth-email': WALKER_A, 'x-auth-staff': '1', 'user-agent': DESKTOP_UA }, redirect: 'manual' });
  assert.equal(scanDesktop.status, 200, '/scan always opens the scanner, even for staff on desktop');
});

test('a chosen start page on a computer: play group desk, app, staff; /app is never redirected', async () => {
  const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const root = (user, staff, ua = DESKTOP_UA, url = '/') => fetch(base + url, { headers: { 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}), 'user-agent': ua }, redirect: 'manual' });
  const me = async (user, staff) => (await call('GET', '/api/me', { user, staff })).json;

  // What each person may pick: staff get the staff dashboard too.
  assert.deepEqual((await me(WALKER_B, false)).desktop.views.map((v) => v.key), ['app', 'playgroup']);
  assert.deepEqual((await me(WALKER_A, true)).desktop.views.map((v) => v.key), ['app', 'playgroup', 'staff']);
  assert.equal((await me(WALKER_A, true)).desktop.start, 'staff');
  assert.equal((await me(WALKER_B, false)).desktop.start, 'app');

  // Staff picks the play group desk.
  assert.equal((await call('PUT', `/api/users/${ids.a}/settings`, { user: WALKER_A, staff: true, body: { desktopView: 'playgroup' } })).status, 200);
  let r = await root(WALKER_A, true);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/playgroup');
  assert.equal((await root(WALKER_A, true, IPHONE_UA)).status, 200, 'phones still get the app');
  assert.equal((await root(WALKER_A, true, DESKTOP_UA, '/app')).status, 200, '/app is the app, never redirected');
  assert.equal((await root(WALKER_A, true, DESKTOP_UA, '/staff')).status, 200, 'the staff dashboard is still one click away');

  // ...then the app.
  await call('PUT', `/api/users/${ids.a}/settings`, { user: WALKER_A, staff: true, body: { desktopView: 'app' } });
  assert.equal((await root(WALKER_A, true)).status, 200);

  // A walker can pick the desk, not the staff dashboard.
  assert.equal((await call('PUT', `/api/users/${ids.b}/settings`, { user: WALKER_B, body: { desktopView: 'staff' } })).status, 400);
  assert.equal((await call('PUT', `/api/users/${ids.b}/settings`, { user: WALKER_B, body: { desktopView: 'playgroup' } })).status, 200);
  r = await root(WALKER_B, false);
  assert.equal(r.headers.get('location'), '/playgroup');
  assert.equal((await me(WALKER_B, false)).desktop.chosen, 'playgroup');

  // Clearing it goes back to the default.
  await call('PUT', `/api/users/${ids.b}/settings`, { user: WALKER_B, body: { desktopView: null } });
  assert.equal((await root(WALKER_B, false)).status, 200);
  await call('PUT', `/api/users/${ids.a}/settings`, { user: WALKER_A, staff: true, body: { desktopView: null } });
  assert.equal((await root(WALKER_A, true)).headers.get('location'), '/staff');
  // Other settings saved alongside are untouched by this.
  assert.equal((await me(WALKER_B, false)).speciesPref, 'dog');
});

test('live board groups active walks by location and honors hide_name_while_walking', async () => {
  const startA = await call('POST', '/api/walks/start', { user: WALKER_A, body: { dogId: 1, userId: ids.a, location: 'A' } });
  assert.equal(startA.status, 200);
  const startB = await call('POST', '/api/walks/start', { user: WALKER_B, body: { dogId: 2, userId: ids.b } }); // no explicit location: falls back to dog's kennel_location (B)
  assert.equal(startB.status, 200);
  const startPriv = await call('POST', '/api/walks/start', { user: PRIVATE_WALKER, body: { dogId: 3, userId: ids.priv } }); // no location at all: unassigned
  assert.equal(startPriv.status, 200);

  const live = await call('GET', '/api/staff/live', { staff: true });
  assert.equal(live.status, 200);
  assert.equal(live.json.activeWalkerCount, 3);
  assert.equal(live.json.locations.A.length, 1);
  assert.equal(live.json.locations.A[0].dogName, 'Rex');
  assert.ok(live.json.locations.A[0].photoUrl, 'every entry carries a photo URL (cached photo or silhouette fallback)');
  assert.equal(live.json.locations.B.length, 1);
  assert.equal(live.json.locations.B[0].dogName, 'Fido');
  assert.equal(live.json.locations.unassigned.length, 1);
  const privEntry = live.json.locations.unassigned[0];
  assert.equal(privEntry.dogName, 'Spot');
  assert.equal(privEntry.walkerName, 'a volunteer', 'hide_name_while_walking must be honored on the staff board too');

  await call('DELETE', `/api/walks/${startA.json.walkId}`, { user: WALKER_A });
  await call('DELETE', `/api/walks/${startB.json.walkId}`, { user: WALKER_B });
  await call('DELETE', `/api/walks/${startPriv.json.walkId}`, { user: PRIVATE_WALKER });
});

test('daycations are pulled out of the location grid, and outsToday buckets dogs by how many times each went out', async () => {
  const dcStart = await call('POST', '/api/walks/start', { user: WALKER_A, body: { dogId: 1, userId: ids.a, location: 'A', activity: 'daycation' } });
  assert.equal(dcStart.status, 200);

  const live = await call('GET', '/api/staff/live', { staff: true });
  assert.equal(live.status, 200);
  assert.equal(live.json.locations.A.length, 0, 'a daycation never lands in a kennel-wing bucket, even with a location set');
  assert.equal(live.json.daycation.length, 1);
  assert.equal(live.json.daycation[0].dogName, 'Rex');

  await call('DELETE', `/api/walks/${dcStart.json.walkId}`, { user: WALKER_A });

  const db = new Database(dbFile);
  const now = new Date();
  const ins = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, 300, 'walk')");
  // Dog 1: out twice today. Dog 2: out once today.
  ins.run(1, ids.a, new Date(now - 3600000).toISOString(), new Date(now - 3500000).toISOString());
  ins.run(1, ids.a, new Date(now - 1800000).toISOString(), new Date(now - 1700000).toISOString());
  ins.run(2, ids.a, new Date(now - 900000).toISOString(), new Date(now - 800000).toISOString());
  db.close();

  const live2 = await call('GET', '/api/staff/live', { staff: true });
  assert.equal(live2.json.outsToday['2'], 1, 'exactly one dog has gone out twice today (at least)');
  assert.ok(live2.json.outsToday['1'] >= 1, 'at least one dog has gone out once today');
  assert.equal(live2.json.dogsOutToday, Object.entries(live2.json.outsToday).reduce((s, [, n]) => s + n, 0), 'dogsOutToday is the sum of every bucket');
});

test('live board shows a running average per activity instead of a hard time limit, excluding auto-stopped walks', async () => {
  const db = new Database(dbFile);
  // An auto-stopped walk's duration is an artifact of the time limit, not a
  // real walk length -- it must never pull the average up.
  const skewId = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (900, 'Skewer', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, auto_stopped) VALUES (900, ?, ?, ?, 36000, 'walk', 1)")
    .run(ids.a, new Date().toISOString(), new Date().toISOString());
  const row = db.prepare("SELECT AVG(duration_seconds) AS avg FROM walks WHERE activity = 'walk' AND ended_at IS NOT NULL AND auto_stopped = 0").get();
  db.close();
  const expectedWalkAvg = row.avg ? Math.round(row.avg) : 30 * 60; // falls back to a flat default with no history yet

  const start = await call('POST', '/api/walks/start', { user: WALKER_A, body: { dogId: 1, userId: ids.a, location: 'A' } });
  assert.equal(start.status, 200);

  const live = await call('GET', '/api/staff/live', { staff: true });
  assert.equal(live.json.activityAverages.walk, expectedWalkAvg);
  assert.notEqual(live.json.activityAverages.walk, 36000, 'the 10-hour auto-stopped outlier must not dominate the average');
  const entry = live.json.locations.A.find((e) => e.dogId === 1);
  assert.ok(entry, 'the just-started walk shows up on the board');
  assert.equal(entry.stopsAt, undefined, 'no hard time-limit field is sent any more -- there is no concept of overtime');
  assert.equal(entry.closesAt, undefined);

  await call('DELETE', `/api/walks/${start.json.walkId}`, { user: WALKER_A });
});

test('reports: totals/byActivity are correct and byPeriod drops below-MIN_CELL days without dropping them from totals', async () => {
  const db = new Database(dbFile);
  const day1 = '2026-09-01';
  const day2 = '2026-09-02'; // a quiet day: only 1 walk, below MIN_CELL (3)
  const ins = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, ?, ?)");
  // day1: 3 walks, 2 by walker A (walk), 1 by walker B (cuddle) -- at/above MIN_CELL.
  ins.run(4, ids.a, `${day1}T14:00:00.000Z`, `${day1}T14:20:00.000Z`, 1200, 'walk');
  ins.run(5, ids.a, `${day1}T15:00:00.000Z`, `${day1}T15:20:00.000Z`, 1200, 'walk');
  ins.run(6, ids.b, `${day1}T16:00:00.000Z`, `${day1}T16:10:00.000Z`, 600, 'cuddle');
  // day2: 1 walk -- below MIN_CELL, should be suppressed from byPeriod but still counted in totals.
  ins.run(7, ids.a, `${day2}T14:00:00.000Z`, `${day2}T14:20:00.000Z`, 1200, 'walk');
  db.close();

  const report = await call('GET', `/api/staff/reports?from=${day1}&to=${day2}&granularity=day`, { staff: true });
  assert.equal(report.status, 200);
  const totals = report.json.stats.totals;
  assert.equal(totals.walks, 4);
  assert.equal(totals.hours, 1.2); // (1200+1200+600+1200)/3600 = 1.1667, rounded to 1 decimal
  assert.equal(totals.uniqueDogs, 4);
  assert.equal(totals.volunteerHeadcount, 2);
  assert.equal(report.json.stats.highlights, undefined, 'highlights is opt-in, not included by default');

  const byActivityRows = report.json.tables.byActivity.rows;
  assert.deepEqual(byActivityRows.find((r) => r[0] === 'Walk').slice(1), [3, 1], 'dog4, dog5 (day1) + dog7 (day2) are all "walk"');
  assert.ok(!byActivityRows.some((r) => r[0] === 'Cuddle'), 'a single cuddle is below MIN_CELL, so it is left out of the breakdown (audit 2026-11-10)');

  const byPeriodRows = report.json.tables.byPeriod.rows;
  assert.equal(byPeriodRows.length, 1, 'the below-MIN_CELL day is dropped from the breakdown');
  assert.deepEqual(byPeriodRows[0], ['Tue, Sep 1, 2026', 3, 0.8, 3], 'day1: dog4+dog5+dog6, 3000s = 0.8h, 3 distinct dogs');

  // sections= actually trims the response, not just hides it client-side.
  const trimmed = await call('GET', `/api/staff/reports?from=${day1}&to=${day2}&sections=byActivity`, { staff: true });
  assert.deepEqual(Object.keys(trimmed.json.tables), ['byActivity']);
});

test('reports: byLocation, byDayOfWeek, byTimeOfDay, uniqueDogsServed, shelterContext and highlights', async () => {
  const db = new Database(dbFile);
  const day1 = '2026-09-10'; // 4 walks, at/above MIN_CELL
  const day2 = '2026-09-11'; // 1 walk, a quiet day below MIN_CELL
  const ins = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, ?, 'walk', ?)");
  ins.run(8, ids.a, `${day1}T14:00:00.000Z`, `${day1}T14:20:00.000Z`, 1200, 'A'); // 10am EDT -> morning, wing A
  ins.run(9, ids.a, `${day1}T14:30:00.000Z`, `${day1}T14:50:00.000Z`, 1200, 'A'); // 10:30am EDT -> morning, wing A
  ins.run(10, ids.b, `${day1}T16:00:00.000Z`, `${day1}T16:15:00.000Z`, 900, 'B'); // 12pm EDT -> midday, wing B
  ins.run(11, ids.b, `${day1}T17:00:00.000Z`, `${day1}T17:10:00.000Z`, 600, null); // 1pm EDT -> midday, no wing -> unassigned
  ins.run(12, ids.a, `${day2}T14:00:00.000Z`, `${day2}T14:05:00.000Z`, 300, 'C'); // quiet day
  const evt = db.prepare("INSERT INTO shelter_events (kind, dog_id, occurred_at) VALUES (?, ?, ?)");
  evt.run('new_dog', 8, `${day1}T15:00:00.000Z`);
  evt.run('adopted', 9, `${day1}T15:00:00.000Z`);
  evt.run('returned', 10, `${day2}T15:00:00.000Z`);
  db.close();

  const sections = 'byLocation,byDayOfWeek,byTimeOfDay,shelterContext,uniqueDogsServed,highlights';
  const report = await call('GET', `/api/staff/reports?from=${day1}&to=${day2}&sections=${sections}`, { staff: true });
  assert.equal(report.status, 200);
  assert.deepEqual(new Set(Object.keys(report.json.tables)), new Set(['byLocation', 'byDayOfWeek', 'byTimeOfDay', 'shelterContext', 'uniqueDogsServed']));

  const byLocation = Object.fromEntries(report.json.tables.byLocation.rows.map((r) => [r[0], r[1]]));
  assert.deepEqual(byLocation, {}, 'every wing has fewer than MIN_CELL engagements here, so none is listed (audit 2026-11-10: same rule as Together)');

  const byTimeOfDay = Object.fromEntries(report.json.tables.byTimeOfDay.rows.map((r) => [r[0], r[1]]));
  // Same buckets as Together (impact.js): 7-10, 10-1, 1-4, 4-8.
  assert.equal(byTimeOfDay['Midday (10am-1pm)'], 4, 'dog8, dog9, dog10 on day1 + dog12 on day2, 10am-12pm EDT');
  assert.equal(byTimeOfDay['Afternoon (1-4pm)'], undefined, 'dog11 alone at 1pm is below MIN_CELL');

  const dowLabel = (dateKey) => {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
  };
  const byDow = Object.fromEntries(report.json.tables.byDayOfWeek.rows.map((r) => [r[0], r[1]]));
  assert.equal(byDow[dowLabel(day1)], 4);
  assert.equal(byDow[dowLabel(day2)], undefined, 'a single engagement on that weekday is below MIN_CELL');

  const dogNames = report.json.tables.uniqueDogsServed.rows.map((r) => r[0]);
  assert.ok(['Dog8', 'Dog9', 'Dog10', 'Dog11', 'Dog12'].every((n) => dogNames.includes(n)));

  const shelterContext = Object.fromEntries(report.json.tables.shelterContext.rows.map((r) => [r[0], r[1]]));
  assert.deepEqual(shelterContext, { 'New dogs listed': 1, Adopted: 1, Returned: 1, 'Removed (other)': 0 });

  const h = report.json.stats.highlights;
  // day2 is below MIN_CELL, so day1 is the only candidate: busiest and
  // quietest would be the same day, so neither is shown (audit 2026-11-10).
  assert.equal(h.busiestDay, null);
  assert.equal(h.quietestDay, null, 'the below-MIN_CELL day2 is never the one spotlighted as quietest');
  assert.equal(h.avgWalksPerVolunteer, 2.5); // 5 walks / 2 volunteers
  assert.equal(h.avgWalkMinutes, 14); // 4200s total / 5 walks / 60
});

test('dogIds= produces per-walk detail for just those dogs, with no walker identity anywhere', async () => {
  const report = await call('GET', '/api/staff/reports?from=2026-09-10&to=2026-09-11&dogIds=8,9', { staff: true });
  assert.equal(report.status, 200);
  assert.equal(report.json.dogDetail.length, 2);
  const dog8 = report.json.dogDetail.find((d) => d.dogId === 8);
  assert.equal(dog8.dogName, 'Dog8');
  assert.equal(dog8.totals.walks, 1);
  assert.deepEqual(dog8.table.columns, ['Date', 'Activity', 'Duration (min)', 'Location']);
  assert.ok(!JSON.stringify(report.json.dogDetail).match(/walker|@example\.com/i), 'no walker name/email anywhere in dog detail');
});

test('GET /api/staff/dogs is staff-gated and lists every dog', async () => {
  assert.equal((await call('GET', '/api/staff/dogs')).status, 403);
  const res = await call('GET', '/api/staff/dogs', { staff: true });
  assert.equal(res.status, 200);
  assert.ok(res.json.dogs.some((d) => d.id === 1 && d.name === 'Rex'));
});

test('saved report formats are shared across staff, not per-account, and staff-gated', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    assert.equal((await call(method, '/api/staff/saved-reports' + (method === 'GET' || method === 'POST' ? '' : '/999999'))).status, 403);
  }

  const created = await call('POST', '/api/staff/saved-reports', {
    staff: true, body: { name: 'County Monthly', sections: ['byActivity', 'byLocation'], granularity: 'month', dogIds: [1, 2] }
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.sections, ['byActivity', 'byLocation']);

  // A different staff account sees the same saved report -- it's shared, not scoped.
  const listedByOther = await call('GET', '/api/staff/saved-reports', { user: WALKER_B, staff: true });
  assert.ok(listedByOther.json.reports.some((r) => r.id === created.json.id && r.name === 'County Monthly'));

  const updated = await call('PUT', `/api/staff/saved-reports/${created.json.id}`, { staff: true, body: { name: 'County Monthly (renamed)' } });
  assert.equal(updated.json.name, 'County Monthly (renamed)');
  assert.deepEqual(updated.json.sections, ['byActivity', 'byLocation'], 'fields left out of the PUT body are unchanged');

  assert.equal((await call('DELETE', `/api/staff/saved-reports/${created.json.id}`, { staff: true })).status, 200);
  const listedAfterDelete = await call('GET', '/api/staff/saved-reports', { staff: true });
  assert.ok(!listedAfterDelete.json.reports.some((r) => r.id === created.json.id));
});

test('export endpoints return the right content types with a non-empty body', async () => {
  const query = 'from=2026-09-01&to=2026-09-02&granularity=day';
  const csv = await call('GET', `/api/staff/reports/export.csv?${query}`, { staff: true });
  assert.equal(csv.status, 200);
  assert.ok(csv.headers.get('content-type').includes('text/csv'));
  assert.ok(csv.text.includes('Totals'));

  const xlsxRes = await fetch(`${base}/api/staff/reports/export.xlsx?${query}`, { headers: { 'x-auth-email': WALKER_A, 'x-auth-staff': '1' } });
  assert.equal(xlsxRes.status, 200);
  assert.ok(xlsxRes.headers.get('content-type').includes('spreadsheetml'));
  const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
  assert.ok(xlsxBuf.length > 0);

  const pdfRes = await fetch(`${base}/api/staff/reports/export.pdf?${query}`, { headers: { 'x-auth-email': WALKER_A, 'x-auth-staff': '1' } });
  assert.equal(pdfRes.status, 200);
  assert.ok(pdfRes.headers.get('content-type').includes('application/pdf'));
  const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
  assert.ok(pdfBuf.subarray(0, 5).toString() === '%PDF-');
});
