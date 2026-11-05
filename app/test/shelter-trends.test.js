// Stats > Shelter: the listing count is rebuilt backwards from today's count
// using the event log, and in/out are counted per local (New York) day.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrends, TRENDS_SINCE } = require('../src/shelterTrends');

test('rebuilds each day\'s listing count from today backwards', () => {
  const now = new Date('2026-10-03T16:00:00Z');
  const events = [
    { kind: 'new_dog', occurred_at: '2026-10-01T15:00:00Z' },
    { kind: 'new_dog', occurred_at: '2026-10-01T16:00:00Z' },
    { kind: 'adopted', occurred_at: '2026-10-02T15:00:00Z' },
    { kind: 'returned', occurred_at: '2026-10-03T13:00:00Z' },
    { kind: 'removed', occurred_at: '2026-10-03T14:00:00Z' },
    // 1am UTC on the 3rd is still the 2nd in New York
    { kind: 'adopted', occurred_at: '2026-10-03T01:00:00Z' }
  ];
  const { days } = buildTrends(events, 50, now);
  assert.deepEqual(days.map((d) => d.dateKey), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(days.map((d) => d.listed), [52, 50, 50]);
  assert.deepEqual(days.map((d) => d.broughtIn), [2, 0, 1]);
  assert.deepEqual(days.map((d) => d.adopted), [0, 2, 0]);
  assert.deepEqual(days.map((d) => d.otherExits), [0, 0, 1]);
});

test('fills quiet days and ignores events before tracking was complete', () => {
  const now = new Date('2026-10-05T16:00:00Z');
  const { days } = buildTrends([
    { kind: 'adopted', occurred_at: '2026-09-01T15:00:00Z' },
    { kind: 'new_dog', occurred_at: '2026-10-02T15:00:00Z' }
  ], 10, now);
  assert.equal(days[0].dateKey, '2026-10-02');
  assert.equal(days.length, 4);
  assert.ok(days.every((d) => d.dateKey >= TRENDS_SINCE));
  assert.deepEqual(days.map((d) => d.listed), [10, 10, 10, 10]);
});

test('floor is listed minus foster on days with a foster count, a gap otherwise', () => {
  const now = new Date('2026-10-03T16:00:00Z');
  const events = [{ kind: 'new_dog', occurred_at: '2026-10-01T15:00:00Z' }];
  const fosterByDay = new Map([['2026-10-01', 4], ['2026-10-03', 5]]);
  const t = buildTrends(events, 30, now, fosterByDay);
  assert.deepEqual(t.days.map((d) => d.floor), [26, null, 25]);
  assert.equal(t.floorNow, 25);
});

test('recordDailyCounts keeps the latest count of each day', () => {
  const Database = require('better-sqlite3');
  const { recordDailyCounts } = require('../src/shelterTrends');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dogs (shelter_buddy_id INTEGER PRIMARY KEY, location TEXT, still_listed INTEGER, awaiting_listing INTEGER DEFAULT 0);
    CREATE TABLE shelter_daily_counts (date_key TEXT PRIMARY KEY, listed INTEGER NOT NULL, in_foster INTEGER NOT NULL, recorded_at TEXT NOT NULL);`);
  const ins = db.prepare('INSERT INTO dogs (shelter_buddy_id, location, still_listed, awaiting_listing) VALUES (?, ?, ?, ?)');
  ins.run(1, 'Shelter', 1, 0); ins.run(2, 'In Foster', 1, 0); ins.run(3, 'In Foster', 0, 0); ins.run(4, 'Shelter', 0, 1);
  recordDailyCounts(db, new Date('2026-10-02T20:00:00Z'));
  ins.run(5, 'In Foster', 1, 0);
  recordDailyCounts(db, new Date('2026-10-02T14:00:00Z')); // an older backfill doesn't overwrite
  assert.deepEqual(db.prepare('SELECT date_key, listed, in_foster FROM shelter_daily_counts').all(), [{ date_key: '2026-10-02', listed: 2, in_foster: 1 }]);
  recordDailyCounts(db, new Date('2026-10-02T22:00:00Z'));
  assert.deepEqual(db.prepare('SELECT listed, in_foster FROM shelter_daily_counts').get(), { listed: 3, in_foster: 2 });
});
