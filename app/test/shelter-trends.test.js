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
