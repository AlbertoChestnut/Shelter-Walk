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
  assert.deepEqual(t.days.map((d) => d.foster), [4, null, 5]);
  assert.equal(t.floorNow, 25);
  assert.equal(t.fosterNow, 5);
});

test('a species added later starts the day after its import', () => {
  const { trendsSince } = require('../src/shelterTrends');
  assert.equal(trendsSince(null), TRENDS_SINCE);
  assert.equal(trendsSince('2026-01-05T15:00:00Z'), TRENDS_SINCE, 'dogs: history from before tracking was complete');
  // 8pm in New York on the 6th is the 7th in UTC: still the 6th's import.
  assert.equal(trendsSince('2026-11-07T01:00:00Z'), '2026-11-07');
  const now = new Date('2026-11-09T16:00:00Z');
  const events = [
    ...Array.from({ length: 90 }, () => ({ kind: 'new_dog', occurred_at: '2026-11-06T20:00:00Z' })),
    { kind: 'adopted', occurred_at: '2026-11-07T15:00:00Z' },
    { kind: 'new_dog', occurred_at: '2026-11-08T15:00:00Z' }
  ];
  const { days } = buildTrends(events, 90, now, new Map(), '2026-11-07');
  assert.deepEqual(days.map((d) => d.dateKey), ['2026-11-07', '2026-11-08', '2026-11-09']);
  assert.deepEqual(days.map((d) => d.broughtIn), [0, 1, 0], 'the import is not "brought in"');
  assert.deepEqual(days.map((d) => d.listed), [89, 90, 90]);
});

test('recordDailyCounts keeps the latest count of each day, per species', () => {
  const Database = require('better-sqlite3');
  const { recordDailyCounts } = require('../src/shelterTrends');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dogs (shelter_buddy_id INTEGER PRIMARY KEY, location TEXT, still_listed INTEGER, awaiting_listing INTEGER DEFAULT 0, species TEXT NOT NULL DEFAULT 'dog');
    CREATE TABLE shelter_species_counts (date_key TEXT NOT NULL, species TEXT NOT NULL, listed INTEGER NOT NULL, in_foster INTEGER NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY (date_key, species));`);
  const ins = db.prepare('INSERT INTO dogs (shelter_buddy_id, location, still_listed, awaiting_listing) VALUES (?, ?, ?, ?)');
  ins.run(1, 'Shelter', 1, 0); ins.run(2, 'In Foster', 1, 0); ins.run(3, 'In Foster', 0, 0); ins.run(4, 'Shelter', 0, 1);
  db.prepare("INSERT INTO dogs (shelter_buddy_id, location, still_listed, species) VALUES (9, 'Shelter', 1, 'cat'), (10, 'In Foster', 1, 'cat')").run();
  const rows = () => db.prepare('SELECT species, listed, in_foster FROM shelter_species_counts ORDER BY species').all();
  recordDailyCounts(db, new Date('2026-10-02T20:00:00Z'));
  ins.run(5, 'In Foster', 1, 0);
  recordDailyCounts(db, new Date('2026-10-02T14:00:00Z')); // an older backfill doesn't overwrite
  assert.deepEqual(rows(), [{ species: 'cat', listed: 2, in_foster: 1 }, { species: 'dog', listed: 2, in_foster: 1 }]);
  recordDailyCounts(db, new Date('2026-10-02T22:00:00Z'));
  assert.deepEqual(rows(), [{ species: 'cat', listed: 2, in_foster: 1 }, { species: 'dog', listed: 3, in_foster: 2 }]);
});
