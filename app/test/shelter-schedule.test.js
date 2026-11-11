// Staff hours, special days and shelter alerts (src/shelterSchedule.js):
// staff-only writes, a closed day refusing walks, alerts landing in the
// Updates feed, and the two default-on notification prefs.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;
const WALKER = 'walker@example.com';
const STAFF = 'staff@example.com';

async function call(method, url, { user = WALKER, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

let today;
test.before(async () => {
  server = await startServer({ prefix: 'sw-schedule-' });
  ({ base, dbFile } = server);
  await call('GET', '/api/me');
  await call('GET', '/api/me', { user: STAFF });
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Rex', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
  db.close();
  today = (await call('GET', '/api/shelter/today')).json.today.dateKey;
});
test.after(async () => { if (server) { await server.stop(); server = null; } });

test('only staff can change hours or send alerts', async () => {
  assert.equal((await call('GET', '/api/staff/schedule')).status, 403);
  assert.equal((await call('POST', '/api/staff/alerts', { body: { title: 'x' } })).status, 403);
  assert.equal((await call('PUT', `/api/staff/schedule/days/${today}`, { body: { mode: 'closed' } })).status, 403);
  assert.equal((await call('GET', '/api/staff/schedule', { staff: true })).status, 200);
});

test('weekly hours save and validate', async () => {
  const sched = (await call('GET', '/api/staff/schedule', { staff: true })).json;
  assert.equal(sched.weekly.length, 7);
  assert.equal(sched.weekly[1].label, 'Monday');
  const days = sched.weekly.map((d) => ({ ...d }));
  days[0] = { ...days[0], open: '09:00', close: '17:00' };
  days[6] = { ...days[6], closed: true };
  const ok = await call('PUT', '/api/staff/schedule/weekly', { staff: true, body: { days } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.weekly[0].open, '09:00');
  assert.equal(ok.json.weekly[6].closed, true);
  const bad = days.map((d) => ({ ...d })); bad[2].open = '18:00'; bad[2].close = '06:00';
  assert.equal((await call('PUT', '/api/staff/schedule/weekly', { staff: true, body: { days: bad } })).status, 400);
  // put the week back so the closed Saturday can't affect the walk tests below
  await call('PUT', '/api/staff/schedule/weekly', { staff: true, body: { days: sched.weekly } });
});

test('a closed day refuses new walks and the app is told about it', async () => {
  const saved = await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'closed', note: 'Water main break' } });
  assert.equal(saved.status, 200);
  const t = (await call('GET', '/api/shelter/today')).json.today;
  assert.equal(t.closed, true);
  assert.equal(t.special, true);
  assert.equal(t.note, 'Water main break');
  const start = await call('POST', '/api/walks/start', { body: { dogId: 1, userId: 1 } });
  assert.equal(start.status, 409);
  assert.match(start.json.error, /closed.*Water main break/);

  assert.equal((await call('DELETE', `/api/staff/schedule/days/${today}`, { staff: true })).status, 200);
  assert.equal((await call('GET', '/api/shelter/today')).json.today.special, false);
  const ok = await call('POST', '/api/walks/start', { body: { dogId: 1, userId: 1 } });
  assert.equal(ok.status, 200, 'walks work again once the closure is removed');
});

test('special days validate their input', async () => {
  assert.equal((await call('PUT', '/api/staff/schedule/days/2020-01-01', { staff: true, body: { mode: 'closed' } })).status, 400, 'past date');
  assert.equal((await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'hours', open: '18:00', close: '09:00' } })).status, 400);
  assert.equal((await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'note', note: '' } })).status, 400);
  const note = await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'note', note: 'Kennel C closed for painting' } });
  assert.equal(note.status, 200);
  assert.equal(note.json.day.closed, false);
  const listed = (await call('GET', '/api/staff/schedule', { staff: true })).json.specialDays;
  assert.equal(listed[0].note, 'Kennel C closed for painting');
  await call('DELETE', `/api/staff/schedule/days/${today}`, { staff: true });
});

test('shelter alerts show in Updates, with their own filter, and staff can remove them', async () => {
  const sent = await call('POST', '/api/staff/alerts', { staff: true, body: { title: 'Closed today', body: 'Power outage. No walks.' } });
  assert.equal(sent.status, 200);
  const feed = (await call('GET', '/api/updates?limit=50')).json.updates;
  const alert = feed.find((u) => u.kind === 'alert');
  assert.equal(alert.title, 'Closed today');
  assert.equal(alert.detail, 'Power outage. No walks.');
  const onlyAlerts = (await call('GET', '/api/updates?kinds=alert')).json.updates;
  assert.ok(onlyAlerts.length >= 1 && onlyAlerts.every((u) => u.kind === 'alert'));
  assert.equal((await call('DELETE', `/api/staff/alerts/${sent.json.id}`, { staff: true })).status, 200);
  assert.equal((await call('GET', '/api/updates?kinds=alert')).json.updates.length, 0);
  assert.equal((await call('POST', '/api/staff/alerts', { staff: true, body: { title: '  ' } })).status, 400);
});

test('saving a special day with notify also posts an alert', async () => {
  const r = await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'hours', open: '08:00', close: '21:00', note: 'Adoption event', notify: true } });
  assert.equal(r.status, 200);
  assert.ok(r.json.alert);
  const alert = (await call('GET', '/api/updates?kinds=alert')).json.updates[0];
  assert.match(alert.title, /Different hours today/);
  assert.match(alert.detail, /Adoption event/);
  await call('DELETE', `/api/staff/schedule/days/${today}`, { staff: true });
});

// An alert expires at the day's closing time; with no walk-hour limit set
// (the test server's default) that's the last minute of the day instead.
function assertClosing(expiresAt, day, msg) {
  if (new Date(day.closesAt).getUTCFullYear() <= 9999) return assert.equal(expiresAt, day.closesAt, msg);
  const fmt = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
  assert.equal(fmt(expiresAt), `${day.dateKey}, 23:59`, msg);
}

test('a special day can carry a longer message, shown in the day notice and the alert', async () => {
  const message = 'Dogs still need potty breaks.\nText the volunteer coordinator if you can help.';
  const r = await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'closed', note: 'Veterans Day', message, notify: true } });
  assert.equal(r.status, 200);
  assert.equal(r.json.day.message, message);
  const t = (await call('GET', '/api/shelter/today')).json.today;
  assert.equal(t.message, message);
  assert.equal(t.note, 'Veterans Day');
  const alert = (await call('GET', '/api/updates?kinds=alert')).json.updates.find((u) => u.id === r.json.alert.id);
  assert.equal(alert.detail, `No walks today. Veterans Day\n\n${message}`);
  // A message alone is enough for a "just a note" day.
  assert.equal((await call('PUT', `/api/staff/schedule/days/${today}`, { staff: true, body: { mode: 'note', message: 'Bring towels' } })).status, 200);
  const sched = (await call('GET', '/api/staff/schedule', { staff: true })).json;
  assert.equal(sched.specialDays.find((d) => d.dateKey === today).message, 'Bring towels');
  await call('DELETE', `/api/staff/schedule/days/${today}`, { staff: true });
  assert.equal((await call('GET', '/api/shelter/today')).json.today.message, '');
});

test('an alert about a day leaves Updates at that day\'s closing time, or when the day is removed', async () => {
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const key = tomorrow.toISOString().slice(0, 10);
  const r = await call('PUT', `/api/staff/schedule/days/${key}`, { staff: true, body: { mode: 'closed', notify: true } });
  assert.equal(r.status, 200);
  const day = (await call('GET', '/api/shelter/today')).json.upcoming.find((d) => d.dateKey === key);
  assertClosing(r.json.alert.expiresAt, day, 'a closed day still expires at the hours it would have had');
  const shown = () => call('GET', '/api/updates?kinds=alert').then((x) => x.json.updates.filter((u) => u.id === r.json.alert.id).length);
  assert.equal(await shown(), 1);

  // Past its expiry: out of the feed and the unread badge.
  const db = new Database(dbFile);
  db.prepare('UPDATE shelter_events SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), r.json.alert.id);
  assert.equal(await shown(), 0);
  db.prepare('UPDATE shelter_events SET expires_at = ? WHERE id = ?').run(r.json.alert.expiresAt, r.json.alert.id);
  db.close();
  assert.equal(await shown(), 1);

  // The closure is called off: its alert goes with it.
  await call('DELETE', `/api/staff/schedule/days/${key}`, { staff: true });
  assert.equal(await shown(), 0);
});

test('a plain alert shows for a week, or until the day staff pick', async () => {
  const week = await call('POST', '/api/staff/alerts', { staff: true, body: { title: 'Parking lot repaved' } });
  const days = (new Date(week.json.expiresAt) - new Date(week.json.occurredAt)) / 86400000;
  assert.equal(Math.round(days), 7);
  const until = await call('POST', '/api/staff/alerts', { staff: true, body: { title: 'Bring towels', until: today } });
  assertClosing(until.json.expiresAt, (await call('GET', '/api/shelter/today')).json.today);
  assert.equal((await call('POST', '/api/staff/alerts', { staff: true, body: { title: 'x', until: '2020-01-01' } })).status, 400);
  for (const a of [week, until]) await call('DELETE', `/api/staff/alerts/${a.json.id}`, { staff: true });
});

test('shelter alerts and admin signup notices are on by default and can be turned off', async () => {
  const me = (await call('GET', '/api/me')).json;
  const prefs = (await call('GET', `/api/users/${me.id}/notification-prefs`)).json.prefs;
  assert.equal(prefs.shelter_alerts, true);
  assert.equal(prefs.new_signups, true);
  assert.equal(prefs.walk_started, false, 'the other pushes stay opt-in');
  assert.equal((await call('PUT', `/api/users/${me.id}/notification-prefs`, { body: { key: 'shelter_alerts', enabled: false } })).status, 200);
  assert.equal((await call('GET', `/api/users/${me.id}/notification-prefs`)).json.prefs.shelter_alerts, false);
});

test('alerts sent before expiry existed get one at startup, read from their headline', async () => {
  const s = await startServer({ prefix: 'sw-schedule-old-', env: { WALK_HOURS: '07:00-19:00' } });
  await s.stop();
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const key = tomorrow.toISOString().slice(0, 10);
  const label = tomorrow.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
  const sentAt = new Date().toISOString();
  const db = new Database(s.dbFile);
  const add = db.prepare("INSERT INTO shelter_events (kind, title, detail, occurred_at) VALUES ('alert', ?, 'x', ?)");
  const closed = add.run(`Shelter closed on ${label}`, sentAt).lastInsertRowid;
  const todays = add.run('Different hours today', sentAt).lastInsertRowid;
  const plain = add.run('Parking lot repaved', sentAt).lastInsertRowid;
  db.close();

  const again = await startServer({ dbFile: s.dbFile, prefix: 'sw-schedule-old-', env: { WALK_HOURS: '07:00-19:00' } });
  await again.stop();
  const check = new Database(s.dbFile);
  const row = (id) => check.prepare('SELECT expires_at, about_date FROM shelter_events WHERE id = ?').get(id);
  const et = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  assert.equal(et(row(closed).expires_at), `${key}, 19:00`, 'closed tomorrow: gone at 7pm tomorrow');
  assert.equal(row(closed).about_date, key);
  assert.equal(et(row(todays).expires_at), `${today}, 19:00`);
  assert.equal(Math.round((new Date(row(plain).expires_at) - new Date(sentAt)) / 86400000), 7);
  check.close();
});
