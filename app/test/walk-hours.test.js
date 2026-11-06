// Walking hours (7am to 7pm shelter time), checked without a server.
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.WALK_HOURS;
const { walkWindow, walkHoursError } = require('../src/walkHours');

test('the walk window is 7am to 7pm Eastern, across DST', () => {
  // Summer (EDT, UTC-4)
  const summer = walkWindow('2026-07-10T15:00:00Z');
  assert.equal(summer.opensAt.toISOString(), '2026-07-10T11:00:00.000Z');
  assert.equal(summer.closesAt.toISOString(), '2026-07-10T23:00:00.000Z');
  // Winter (EST, UTC-5)
  const winter = walkWindow('2026-12-10T15:00:00Z');
  assert.equal(winter.opensAt.toISOString(), '2026-12-10T12:00:00.000Z');
  assert.equal(winter.closesAt.toISOString(), '2026-12-11T00:00:00.000Z');
  // 11pm Eastern is already the next UTC day but still the same shelter day
  assert.equal(walkWindow('2026-07-11T03:00:00Z').closesAt.toISOString(), '2026-07-10T23:00:00.000Z');
});

test('walk times outside the window are refused', () => {
  assert.equal(walkHoursError('2026-07-10T14:00:00Z', '2026-07-10T14:30:00Z'), null, '10am to 10:30am is fine');
  assert.equal(walkHoursError('2026-07-10T22:45:00Z', '2026-07-10T23:00:00Z'), null, 'ending right at 7pm is fine');
  assert.equal(walkHoursError('2026-07-10T11:00:00Z', null), null, 'starting right at 7am is fine');
  assert.match(walkHoursError('2026-07-10T10:30:00Z', '2026-07-10T11:30:00Z'), /7am to 7pm/, '6:30am start');
  assert.match(walkHoursError('2026-07-10T23:05:00Z', null), /7am to 7pm/, 'starting after 7pm');
  assert.match(walkHoursError('2026-07-10T22:45:00Z', '2026-07-10T23:10:00Z'), /7pm/, 'ending after 7pm');
});

test('staff hours: a closed day refuses walks, other hours move the window, other days are untouched', () => {
  const { setScheduleSource, walkWindow: win, walkHoursError: err } = require('../src/walkHours');
  setScheduleSource((dateKey, dow) => {
    if (dateKey === '2026-11-26') return { closed: true, note: 'Thanksgiving' };
    if (dateKey === '2026-11-27') return { open: 10 * 60, close: 21 * 60, note: 'Late night' };
    if (dow === 0) return { open: 9 * 60, close: 17 * 60 }; // Sundays
    return null;
  });
  try {
    assert.match(err('2026-11-26T16:00:00Z', null), /closed that day \(Thanksgiving\)/);
    const late = win('2026-11-27T16:00:00Z');
    assert.equal(late.hoursLabel, '10am to 9pm');
    assert.equal(late.note, 'Late night');
    assert.equal(err('2026-11-28T01:30:00Z', null), null, '8:30pm EST is fine on the late night');
    assert.match(err('2026-11-27T13:00:00Z', null), /10am to 9pm/, '8am EST is too early that day');
    assert.equal(win('2026-11-29T16:00:00Z').hoursLabel, '9am to 5pm', 'a Sunday uses the weekly hours');
    assert.equal(win('2026-11-30T16:00:00Z').hoursLabel, '7am to 7pm', 'a Monday with nothing set uses the default');
  } finally {
    setScheduleSource(null);
  }
});
