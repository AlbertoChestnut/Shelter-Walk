// Audit 2026-11-10, staff & play group area: the staff report and live board
// count the same things Together (/api/impact) does -- dogs only unless asked,
// finished engagements only, walk-only averages that skip misscans -- plus
// labels (no raw activity keys anywhere, exports included), the "fewer than
// 3" rule on every breakdown, "vs yesterday" by the same clock time (DST
// safe), the branded /staff 403 page and the play group "Adopted" badge.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const { startServer } = require('./_helpers');
const staffDashboard = require('../src/staffDashboard');

let base, dbFile, server;
const STAFF = 'audit.staff@example.com';
const VOL = 'audit.vol@example.com';

async function call(url, { user = STAFF, staff = true } = {}) {
  const res = await fetch(base + url, { headers: { 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

const FROM = '2026-10-05';
const TO = '2026-10-07';
const RAW_KEYS = ['walk', 'cuddle', 'matchmaking', 'playgroup', 'daycation', 'walking', 'cuddling', 'at play group', 'on a daycation'];
// Every (finished, dog) engagement seeded in [FROM, TO], to work out what
// the report should say independently of the code under test.
const seededDogRows = [];

test.before(async () => {
  server = await startServer({ prefix: 'sw-audit-staff-' });
  ({ base, dbFile } = server);
  const sid = (await call('/api/me')).json.id;
  const vid = (await call('/api/me', { user: VOL, staff: false })).json.id;
  const cid = (await call('/api/me', { user: 'audit.cats@example.com', staff: false })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at, species)
    VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?, ?, ?)`);
  for (let i = 1; i <= 6; i += 1) insDog.run(i, `Dog${i}`, 'A1', 1, now, now, 'dog');
  insDog.run(51, 'Kit', null, 1, now, now, 'cat');
  insDog.run(52, 'Tom', null, 1, now, now, 'cat');
  insDog.run(60, 'Gone', 'C1', 0, now, now, 'dog');
  db.prepare("INSERT INTO shelter_events (kind, dog_id, occurred_at) VALUES ('adopted', 60, ?)").run('2026-10-20T15:00:00.000Z');
  db.prepare("INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at) VALUES (60, ?, 0, '2026-10-01', 'Sweet', ?, ?)").run(vid, now, now);

  const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const add = (dogId, user, startIso, seconds, activity, location = 'A') => {
    const end = new Date(new Date(startIso).getTime() + seconds * 1000).toISOString();
    ins.run(dogId, user, startIso, end, seconds, activity, location);
    if (dogId < 50 && startIso >= `${FROM}T04:00:00.000Z` && startIso < '2026-10-08T04:00:00.000Z') seededDogRows.push({ dogId, seconds, activity });
  };
  // Oct 5-7 (EDT, so 14:00Z = 10am): walks, a cuddle, a daycation, a misscan,
  // cat cuddles that must never show up in the dog numbers.
  for (const day of ['05', '06', '07']) {
    add(1, sid, `2026-10-${day}T13:00:00.000Z`, 1200, 'walk');
    add(2, vid, `2026-10-${day}T14:00:00.000Z`, 1800, 'walk', 'B');
    add(3, sid, `2026-10-${day}T15:00:00.000Z`, 600, 'walk');
    add(51, vid, `2026-10-${day}T15:30:00.000Z`, 900, 'cuddle', null);
  }
  add(4, vid, '2026-10-05T16:00:00.000Z', 6 * 3600, 'daycation', null); // a 6h daycation
  add(5, sid, '2026-10-06T17:00:00.000Z', 20, 'walk'); // a 20 s misscan
  add(6, sid, '2026-10-07T18:00:00.000Z', 900, 'cuddle');
  add(1, sid, '2026-10-07T23:30:00.000Z', 1500, 'walk'); // 7:30pm EDT: the 4-8pm bucket, like Together
  add(52, vid, '2026-10-06T20:00:00.000Z', 600, 'cuddle', null);

  // Today: three finished dog walks, one finished cat cuddle, a dog walk and
  // a daycation still out, and a cat still out.
  const t = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  for (let i = 0; i < 3; i += 1) ins.run(1 + i, sid, iso(t - (80 - i * 10) * 1000), iso(t - (20 - i) * 1000), 60, 'walk', 'A');
  ins.run(51, vid, iso(t - 70 * 1000), iso(t - 5000), 65, 'cuddle', null);
  const open = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, activity, location) VALUES (?, ?, ?, ?, ?)');
  open.run(4, sid, iso(t - 30 * 1000), 'walk', 'B');
  open.run(5, vid, iso(t - 40 * 1000), 'daycation', null);
  open.run(52, cid, iso(t - 10 * 1000), 'cuddle', null); // one open walk per person

  // Yesterday: one engagement finished before this time of day, one finished
  // after it (it must not count in "vs yesterday").
  const cutoff = staffDashboard.sameTimeYesterday(new Date(t)).getTime();
  ins.run(6, sid, iso(cutoff - 40 * 1000), iso(cutoff - 10 * 1000), 30, 'walk', 'A');
  ins.run(2, sid, iso(cutoff - 30 * 1000), iso(cutoff + 3600 * 1000), 3630, 'walk', 'A');
  db.close();
});
test.after(async () => { if (server) { await server.stop(); server = null; } });

test('staff report totals equal Together for the same range and species; cats never land in dog numbers', async () => {
  const report = (await call(`/api/staff/reports?from=${FROM}&to=${TO}&sections=byActivity,byPeriod,uniqueDogsServed,highlights`)).json;
  assert.equal(report.species, 'dog', 'dogs are the default');
  const impact = (await call('/api/impact?days=all&species=dog', { staff: false, user: VOL })).json;
  const days = impact.days.filter((d) => d.dateKey >= FROM && d.dateKey <= TO);
  assert.equal(days.length, 3, 'Together lists all three days (each has 3+ engagements)');
  assert.equal(report.stats.totals.walks, days.reduce((s, d) => s + d.walks, 0), 'same engagement count as Together');
  assert.equal(report.stats.totals.hours, Math.round((days.reduce((s, d) => s + d.seconds, 0) / 3600) * 10) / 10, 'same hours as Together');
  assert.equal(report.stats.totals.walks, seededDogRows.length);
  assert.equal(report.stats.totals.uniqueDogs, 6, 'Kit and Tom (cats) are not unique dogs');
  const names = report.tables.uniqueDogsServed.rows.map((r) => r[0]);
  assert.ok(!names.includes('Kit') && !names.includes('Tom'), 'no cats under the dogs served');
  assert.equal(report.tables.uniqueDogsServed.title, 'Unique dogs served');

  // Per-day rows agree with Together's day list too.
  for (const d of days) {
    const row = report.tables.byPeriod.rows.find((r) => r[0].includes(Number(d.dateKey.slice(8))));
    assert.ok(row, `a row for ${d.dateKey}`);
    assert.equal(row[1], d.walks);
  }

  const cats = (await call(`/api/staff/reports?from=${FROM}&to=${TO}&species=cat`)).json;
  const catImpact = (await call('/api/impact?days=all&species=cat', { staff: false, user: VOL })).json;
  assert.equal(cats.species, 'cat');
  assert.equal(cats.stats.totals.walks, 4, '3 Kit cuddles + 1 Tom cuddle');
  assert.equal(cats.stats.totals.walks, catImpact.allTime.walks - 1, 'Together all-time minus today\'s finished cat cuddle');
  const both = (await call(`/api/staff/reports?from=${FROM}&to=${TO}&species=all`)).json;
  assert.equal(both.stats.totals.walks, report.stats.totals.walks + cats.stats.totals.walks);
});

test('avg walk length is walk-only, finished, a minute or longer (no daycations, cuddles or misscans)', async () => {
  const report = (await call(`/api/staff/reports?from=${FROM}&to=${TO}&sections=highlights`)).json;
  const walks = seededDogRows.filter((r) => r.activity === 'walk' && r.seconds >= 60);
  const expected = Math.round(walks.reduce((s, r) => s + r.seconds, 0) / walks.length / 60);
  assert.equal(report.stats.highlights.avgWalkMinutes, expected);
  // The old all-activity average would have been pulled way up by the 6h daycation.
  const allAvg = Math.round(seededDogRows.reduce((s, r) => s + r.seconds, 0) / seededDogRows.length / 60);
  assert.notEqual(report.stats.highlights.avgWalkMinutes, allAvg);
});

test('breakdowns hide rows under 3, time-of-day uses Together\'s buckets, and busiest/quietest are hidden when tied', async () => {
  const report = (await call(`/api/staff/reports?from=${FROM}&to=${TO}&sections=byActivity,byLocation,byDayOfWeek,byTimeOfDay,highlights`)).json;
  for (const key of ['byActivity', 'byLocation', 'byDayOfWeek', 'byTimeOfDay']) {
    for (const row of report.tables[key].rows) assert.ok(row[1] >= 3, `${key} row ${row[0]} has ${row[1]} (< 3 must be hidden)`);
  }
  const activities = report.tables.byActivity.rows.map((r) => r[0]);
  assert.deepEqual(activities, ['Walk'], 'only walks reach 3 here; the cuddle and daycation are hidden');
  const tod = Object.fromEntries(report.tables.byTimeOfDay.rows.map((r) => [r[0], r[1]]));
  assert.equal(tod['Midday (10am-1pm)'], 7, '10am and 11am EDT walks plus the noon daycation: Together\'s 10-1p slot');
  assert.equal(tod['Evening (4-8pm)'], undefined, 'the lone 7:30pm walk is in the 4-8pm bucket (as on Together), hidden as < 3');
  assert.equal(tod['Morning (7-10am)'], 3, '9am EDT walks: Together\'s 7-10a slot');
  assert.deepEqual(staffDashboard.SESSIONS.map((s) => [s.from, s.to]), [[7, 10], [10, 13], [13, 16], [16, 20]], 'same hours as impact.js SLOTS');

  // Oct 5: 4 dog engagements, Oct 6: 4, Oct 7: 5 (a tie for quietest goes to the earlier day).
  const h = report.stats.highlights;
  assert.equal(h.busiestDay.dateKey, '2026-10-07');
  assert.equal(h.quietestDay.dateKey, '2026-10-05');
  assert.equal(h.busiestDay.label, 'Wed, Oct 7, 2026');

  const oneDay = (await call('/api/staff/reports?from=2026-10-06&to=2026-10-06&sections=highlights')).json;
  assert.equal(oneDay.stats.highlights.busiestDay, null, 'a single day is both busiest and quietest: neither is shown');
  assert.equal(oneDay.stats.highlights.quietestDay, null);
  assert.ok(report.notes.some((n) => /rounded/.test(n)), 'the rounding note is there');
  assert.ok(report.notes.some((n) => /fewer than 3/.test(n)), 'the privacy note is there');
});

test('activity labels everywhere: report tables, the one-dog table, CSV and Excel never show raw keys', async () => {
  const q = `from=${FROM}&to=${TO}&sections=byActivity,byPeriod&dogIds=4,6`;
  const report = (await call(`/api/staff/reports?${q}`)).json;
  const dog4 = report.dogDetail.find((d) => d.dogId === 4);
  assert.deepEqual(dog4.table.rows, [['Mon, Oct 5, 2026', 'Daycation', 360, '']]);
  assert.equal(dog4.table.title, "Dog4's engagements");
  for (const dog of report.dogDetail) {
    for (const row of dog.table.rows) {
      assert.ok(['Walk', 'Cuddle', 'Matchmaking', 'Play group', 'Daycation'].includes(row[1]), `label, not a raw key: ${row[1]}`);
      assert.match(row[0], /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}$/, 'friendly date');
    }
  }
  assert.ok(report.dogDetail.find((d) => d.dogId === 6).table.rows.some((r) => r[1] === 'Cuddle'));
  assert.ok(dog4.table.rows.some((r) => r[1] === 'Daycation'));

  const csv = (await call(`/api/staff/reports/export.csv?${q}`)).text;
  const cells = csv.split('\n').flatMap((line) => line.split(','));
  for (const raw of RAW_KEYS) assert.ok(!cells.includes(raw), `CSV has no raw "${raw}" cell`);
  assert.ok(cells.includes('Daycation') && cells.includes('Cuddle'));
  assert.ok(/Engagements/.test(csv) && !/Volunteer Headcount/.test(csv));

  const xres = await fetch(`${base}/api/staff/reports/export.xlsx?${q}`, { headers: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await xres.arrayBuffer()));
  const values = [];
  wb.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((c) => values.push(String(c.value)))));
  for (const raw of RAW_KEYS) assert.ok(!values.includes(raw), `Excel has no raw "${raw}" cell`);
  assert.ok(values.includes('Daycation'));
});

test('live board: dogs only by default, finished engagements today match Together, vs yesterday by the same clock time', async () => {
  const live = (await call('/api/staff/live')).json;
  const impact = (await call('/api/impact?days=all&species=dog', { staff: false, user: VOL })).json;
  assert.equal(live.species, 'dog');
  assert.ok(impact.today, 'Together shows today (3 finished dog walks)');
  assert.equal(live.walksToday, impact.today.walks, 'same count as Together: in-progress walks and cats are not counted');
  assert.equal(live.walksToday, 3);
  assert.equal(live.hourlyToday.reduce((s, n) => s + n, 0), live.walksToday, 'the chart counts the same engagements as the tile');
  assert.equal(live.dogsOutToday, 5, 'dogs 1-3 (finished) plus dog 4 and dog 5 (still out); no cats');
  const out = [...Object.values(live.locations).flat(), ...live.daycation];
  assert.deepEqual(out.map((e) => e.dogId).sort(), [4, 5], '"Dogs out now" lists dogs only, not the cat cuddle');
  assert.equal(live.daycation[0].activityLabel, 'Daycation');
  assert.equal(live.locations.B[0].activityLabel, 'Walk');

  // Yesterday: only the engagement that had finished by this time counts.
  assert.equal(live.walksYesterday, 1, 'the one still out at this time yesterday is not counted');

  const cats = (await call('/api/staff/live?species=cat')).json;
  assert.equal(cats.walksToday, 1);
  assert.deepEqual([...Object.values(cats.locations).flat()].map((e) => e.dogId), [52]);
  const all = (await call('/api/staff/live?species=all')).json;
  assert.equal(all.walksToday, 4);
  assert.equal(all.activeWalkerCount, 3);
  assert.equal(live.activeWalkerCount, 2, 'the person with a cat is not counted on the dogs board');
});

test('live board averages: misscans ignored, no-history activities fall back to the walk average, not daycations', async () => {
  const live = (await call('/api/staff/live')).json;
  const db = new Database(dbFile, { readonly: true });
  const walkAvg = db.prepare("SELECT AVG(duration_seconds) AS a FROM walks WHERE activity = 'walk' AND ended_at IS NOT NULL AND auto_stopped = 0 AND duration_seconds >= 60").get().a;
  db.close();
  assert.equal(live.activityAverages.walk, Math.round(walkAvg), 'the 20 s and 30 s walks are left out');
  assert.equal(live.activityAverages.matchmaking, Math.round(walkAvg), 'no matchmaking history: the walk average, not one dragged up by a 6h daycation');
  assert.equal(live.activityAverages.playgroup, Math.round(walkAvg));
});

test('"yesterday" is a calendar day in New York, even right after a DST change', () => {
  // 00:30 EDT on Mar 9, 2026 (the day after clocks went forward).
  const now = new Date('2026-03-09T04:30:00.000Z');
  assert.equal(staffDashboard.dateKeyOf(now.toISOString()), '2026-03-09');
  assert.equal(staffDashboard.previousDateKey('2026-03-09'), '2026-03-08');
  const same = staffDashboard.sameTimeYesterday(now);
  assert.equal(same.toISOString(), '2026-03-08T05:30:00.000Z', '00:30 EST on Mar 8, not 23:30 on Mar 7');
  assert.equal(staffDashboard.dateKeyOf(same.toISOString()), '2026-03-08');
  // And the fall change: 00:30 EST on Nov 2 -> 00:30 EDT on Nov 1.
  assert.equal(staffDashboard.sameTimeYesterday(new Date('2026-11-02T05:30:00.000Z')).toISOString(), '2026-11-01T04:30:00.000Z');
  assert.equal(staffDashboard.previousDateKey('2026-03-01'), '2026-02-28');
});

test('/staff for a non-staff account is a small branded page with a way back, still a 403', async () => {
  const res = await call('/staff', { user: VOL, staff: false });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.text, /Shelter Walk/);
  assert.match(res.text, /href="\/app"/);
  assert.doesNotMatch(res.text, /id="liveSection"/, 'none of the dashboard itself');
  const api = await call('/api/staff/live', { user: VOL, staff: false });
  assert.equal(api.status, 403);
});

test('play group counts say when a dog with notes was adopted', async () => {
  const { counts } = (await call('/api/playgroup-notes/counts', { user: VOL, staff: false })).json;
  assert.equal(counts[60].stillListed, false);
  assert.equal(counts[60].adopted, true);
});
