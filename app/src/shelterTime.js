// A walk's shelter date and hour, fast. Intl.DateTimeFormat is slow (tens of
// microseconds a call), and Together and the staff reports convert every
// walk on every request, so this remembers the answer per UTC hour: the
// shelter's zone (America/New_York) is a whole number of hours off UTC and
// changes it on a UTC hour boundary, so every instant in one UTC hour has the
// same shelter date and hour.
const { SHELTER_TZ } = require('./constants');

const HOUR_MS = 3600000;
const MAX_ENTRIES = 200000; // ~23 years of hours; cleared, never grown past it
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHELTER_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
});
const cache = new Map();

function compute(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Object.freeze({ dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) });
}

// { dateKey: 'YYYY-MM-DD', hour: 0-23 } at the shelter for an ISO time (or a
// Date or ms). An invalid time throws a RangeError, like Intl does.
function shelterParts(when) {
  const ms = when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : new Date(when).getTime());
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid time value: ${when}`);
  const h = Math.floor(ms / HOUR_MS);
  let v = cache.get(h);
  if (!v) {
    v = compute(h * HOUR_MS);
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(h, v);
  }
  return v;
}
const shelterDateKey = (when) => shelterParts(when).dateKey;
const shelterHour = (when) => shelterParts(when).hour;
// The shelter's time of day in hours with a fraction (19.25 is 7:15pm), for
// the walk windows. The zone is a whole number of hours off UTC, so the
// minutes past the hour are the same as UTC's.
const toMs = (when) => (when instanceof Date ? when.getTime() : (typeof when === 'number' ? when : new Date(when).getTime()));
const shelterTimeOfDay = (when) => shelterHour(when) + (((toMs(when) % HOUR_MS) + HOUR_MS) % HOUR_MS) / HOUR_MS;

module.exports = { shelterParts, shelterDateKey, shelterHour, shelterTimeOfDay };
