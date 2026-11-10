// Walking hours at the shelter: by default nobody can walk a dog before 7am
// or after 7pm, shelter time. Starting a walk, logging one by hand, and
// editing a walk's times are all held to the day's window, and a walk still
// running at closing time stops by itself then.
//
// Staff can change the hours (shelterSchedule.js): usual hours per weekday,
// and single days that are closed or run different hours. setScheduleSource
// plugs that in; a day it says nothing about uses the default window.
//
// WALK_HOURS ("HH:MM-HH:MM") overrides the default window. "00:00-24:00"
// means no walking-hours limit at all (the API tests use it so they pass at
// any time, including walks that run past midnight); a day staff closed is
// still closed then.
const SHELTER_TZ = 'America/New_York';

function parseHours(spec) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]);
  const close = Number(m[3]) * 60 + Number(m[4]);
  return open < close && close <= 24 * 60 ? { open, close } : null;
}
const { open: OPEN_MINUTES, close: CLOSE_MINUTES } = parseHours(process.env.WALK_HOURS) || parseHours('07:00-19:00');
const NO_LIMIT = OPEN_MINUTES === 0 && CLOSE_MINUTES === 24 * 60;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHELTER_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});

// The shelter's wall clock at a given instant.
function shelterClock(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, minutes: +p.hour * 60 + +p.minute, seconds: +p.second };
}

// The instant it's `minutes` past midnight, shelter time, on the given
// shelter day. Works out the UTC offset at that moment, so DST is handled.
function shelterTimeToDate(y, m, d, minutes) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const c = shelterClock(guess);
  const offsetMs = Date.UTC(c.y, c.m - 1, c.d, 0, c.minutes, c.seconds) - guess;
  return new Date(guess - offsetMs);
}

// (dateKey, dayOfWeek) -> null, or { open, close } in minutes past midnight
// and/or { closed, note } for that shelter day.
let scheduleSource = null;
function setScheduleSource(fn) { scheduleSource = fn; }

const pad2 = (n) => String(n).padStart(2, '0');
function dayHours(y, m, d) {
  const dateKey = `${y}-${pad2(m)}-${pad2(d)}`;
  const staff = (scheduleSource && scheduleSource(dateKey, new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay())) || {};
  return {
    dateKey,
    open: Number.isInteger(staff.open) ? staff.open : OPEN_MINUTES,
    close: Number.isInteger(staff.close) ? staff.close : CLOSE_MINUTES,
    closed: !!staff.closed,
    note: staff.note || ''
  };
}

// Opening and closing instants for the shelter day that `date` falls on,
// whether staff closed it, and their note for the day. On a closed day the
// times are still filled in, so a walk already out when staff close the
// shelter keeps its usual end time; new walks are refused (walkHoursError).
function walkWindow(date) {
  const c = shelterClock(date);
  const h = dayHours(c.y, c.m, c.d);
  const base = { dateKey: h.dateKey, closed: h.closed, note: h.note };
  if (NO_LIMIT) return { ...base, opensAt: new Date(0), closesAt: new Date(8.64e15), openLabel: OPEN_LABEL, closeLabel: CLOSE_LABEL, hoursLabel: HOURS_LABEL };
  return {
    ...base,
    opensAt: shelterTimeToDate(c.y, c.m, c.d, h.open),
    closesAt: shelterTimeToDate(c.y, c.m, c.d, h.close),
    openLabel: fmtMinutes(h.open),
    closeLabel: fmtMinutes(h.close),
    hoursLabel: `${fmtMinutes(h.open)} to ${fmtMinutes(h.close)}`
  };
}

function fmtMinutes(total) {
  const h = Math.floor(total / 60) % 24;
  const mm = String(total % 60).padStart(2, '0');
  return `${h % 12 || 12}${mm === '00' ? '' : ':' + mm}${h < 12 ? 'am' : 'pm'}`;
}
const OPEN_LABEL = fmtMinutes(OPEN_MINUTES);
const CLOSE_LABEL = fmtMinutes(CLOSE_MINUTES);
const HOURS_LABEL = `${OPEN_LABEL} to ${CLOSE_LABEL}`;

// Why a walk from startedAt to endedAt (endedAt may be null for one still
// running) falls outside walking hours, or null if it's inside them.
// Other checks (end after start, not in the future) live in server.js.
function walkHoursError(startedAt, endedAt) {
  const start = new Date(startedAt);
  if (Number.isNaN(start.getTime())) return 'That start time is not a valid time.';
  const w = walkWindow(start);
  if (w.closed) return `The shelter is closed that day${w.note ? ` (${w.note})` : ''}, so there are no walks.`;
  if (start < w.opensAt || start >= w.closesAt) return `Walks can only happen from ${w.hoursLabel}.`;
  if (endedAt != null && new Date(endedAt) > w.closesAt) return `Walks end by ${w.closeLabel}, so the end time can't be later than that.`;
  return null;
}

module.exports = {
  walkWindow, walkHoursError, setScheduleSource, shelterClock, shelterTimeToDate, fmtMinutes, parseHours,
  OPEN_MINUTES, CLOSE_MINUTES, OPEN_LABEL, CLOSE_LABEL, HOURS_LABEL
};
