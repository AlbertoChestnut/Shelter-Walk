// Walking hours (7am to 7:15pm shelter time), checked without a server.
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.WALK_HOURS;
const { walkWindow, walkHoursError } = require('../src/walkHours');

test('the walk window is 7am to 7:15pm Eastern, across DST', () => {
  // Summer (EDT, UTC-4)
  const summer = walkWindow('2026-07-10T15:00:00Z');
  assert.equal(summer.opensAt.toISOString(), '2026-07-10T11:00:00.000Z');
  assert.equal(summer.closesAt.toISOString(), '2026-07-10T23:15:00.000Z');
  // Winter (EST, UTC-5)
  const winter = walkWindow('2026-12-10T15:00:00Z');
  assert.equal(winter.opensAt.toISOString(), '2026-12-10T12:00:00.000Z');
  assert.equal(winter.closesAt.toISOString(), '2026-12-11T00:15:00.000Z');
  // 11pm Eastern is already the next UTC day but still the same shelter day
  assert.equal(walkWindow('2026-07-11T03:00:00Z').closesAt.toISOString(), '2026-07-10T23:15:00.000Z');
});

test('walk times outside the window are refused', () => {
  assert.equal(walkHoursError('2026-07-10T14:00:00Z', '2026-07-10T14:30:00Z'), null, '10am to 10:30am is fine');
  assert.equal(walkHoursError('2026-07-10T23:00:00Z', '2026-07-10T23:15:00Z'), null, 'ending right at 7:15pm is fine');
  assert.equal(walkHoursError('2026-07-10T11:00:00Z', null), null, 'starting right at 7am is fine');
  assert.match(walkHoursError('2026-07-10T10:30:00Z', '2026-07-10T11:30:00Z'), /7am to 7:15pm/, '6:30am start');
  assert.match(walkHoursError('2026-07-10T23:20:00Z', null), /7am to 7:15pm/, 'starting after 7:15pm');
  assert.match(walkHoursError('2026-07-10T23:00:00Z', '2026-07-10T23:25:00Z'), /7:15pm/, 'ending after 7:15pm');
});
