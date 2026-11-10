// Staff-only surface: a live ops board (who's out, from which kennel wing,
// for how long) plus aggregated/anonymous activity reports for the county,
// downloadable as JSON, CSV, XLSX or PDF.
//
// Access is gated on the shelterwalk.com login's own staff flag
// (X-Auth-Staff), not this app's isPrivileged/canAudit permissions -- a
// deliberately separate, narrower check from isStaffOrPrivileged() elsewhere,
// matching the server.js comment that X-Auth-Staff is "shelterwalk.com's
// login-level staff flag, a different thing from this app's own permissions."
//
// The reports side follows the same privacy rule impact.js enforces for the
// "Together" view: never a per-volunteer number, never a small enough sample
// that a quiet shift could be pinned on one person. MIN_CELL is imported
// (not redefined) from impact.js so both views agree on what "too small to
// show" means. Per-dog sections (uniqueDogsServed, dogDetail) are a
// deliberate, requested exception -- they name dogs, never volunteers, so
// that rule doesn't apply to them.
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { MIN_CELL } = require('./impact');
// Shelter context (new dogs, adoptions) counts dogs only, like the Shelter trends.
const { DOG_EVENTS_WHERE } = require('./shelterTrends');
const statsBreakdown = require('./statsBreakdown');

const TZ = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function dateKeyOf(iso) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
function hourOf(iso) {
  return Number(hourFmt.format(new Date(iso)));
}

// The calendar day before dateKey (noon UTC keeps DST out of it).
function previousDateKey(dateKey) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' });
function offsetMinutes(date) {
  const name = (offsetFmt.formatToParts(date).find((p) => p.type === 'timeZoneName') || {}).value || '';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
// The same shelter clock time one calendar day earlier. Not now - 24h: the
// day after a DST change is 23 or 25 hours long.
function sameTimeYesterday(now) {
  const guess = new Date(now.getTime() - 86400000);
  return new Date(guess.getTime() + (offsetMinutes(now) - offsetMinutes(guess)) * 60000);
}

// Staff numbers that say "dogs" count dogs only. ?species=cat|all switches
// the whole report or board (anything else: dogs).
function parseSpecies(raw) {
  if (raw === 'all') return 'all';
  const f = statsBreakdown.speciesFilter(raw);
  return f === 'all' ? 'dog' : f;
}
const NOUNS = {
  dog: { one: 'dog', many: 'dogs', Many: 'Dogs' },
  cat: { one: 'cat', many: 'cats', Many: 'Cats' },
  all: { one: 'animal', many: 'animals', Many: 'Animals' }
};
const nounsFor = (species) => NOUNS[species] || NOUNS.dog;

// What people see for each activity, everywhere on the staff side (tables,
// exports, the live board). Never the raw keys.
const ACTIVITY_LABELS = { walk: 'Walk', cuddle: 'Cuddle', matchmaking: 'Matchmaking', playgroup: 'Play group', daycation: 'Daycation' };
function activityLabel(activity) {
  const a = activity || 'walk';
  return ACTIVITY_LABELS[a] || a.charAt(0).toUpperCase() + a.slice(1);
}

// Walk-length averages: walk activity only, finished walks only, and never
// a walk under a minute (a misscan), same rule as personal stats and Together.
const MIN_AVERAGED_SECONDS = statsBreakdown.MIN_AVG_SECONDS || 60;
function walkOnlyAvgSeconds(rows) {
  const walks = rows.filter((r) => (r.activity || 'walk') === 'walk' && (r.duration_seconds || 0) >= MIN_AVERAGED_SECONDS);
  return walks.length ? walks.reduce((s, r) => s + r.duration_seconds, 0) / walks.length : null;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDateKey(v) {
  return typeof v === 'string' && DATE_KEY_RE.test(v) ? v : null;
}

// Monday of the week dateKey falls in, as its own YYYY-MM-DD key. Noon UTC
// avoids any DST edge when doing day-of-week arithmetic.
function weekStartKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const dow = noon.getUTCDay(); // 0 = Sunday
  noon.setUTCDate(noon.getUTCDate() - ((dow + 6) % 7));
  return noon.toISOString().slice(0, 10);
}
const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function dayOfWeekOf(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

// The same four sessions as Together (impact.js SLOTS) and the Available
// list's slot grid, so a walk lands in the same bucket on every screen. The
// last one runs to 8pm (Together labels it "4-7p"; here it says 4-8pm).
// "other" catches anything outside those hours (daycations mostly).
const SESSIONS = [
  { key: 'morning', label: 'Morning (7-10am)', from: 7, to: 10 },
  { key: 'midday', label: 'Midday (10am-1pm)', from: 10, to: 13 },
  { key: 'afternoon', label: 'Afternoon (1-4pm)', from: 13, to: 16 },
  { key: 'evening', label: 'Evening (4-8pm)', from: 16, to: 20 }
];
const OTHER_SESSION = { key: 'other', label: 'Other hours' };
function sessionOf(hour) {
  return SESSIONS.find((s) => hour >= s.from && hour < s.to) || OTHER_SESSION;
}

function periodKeyOf(dateKey, granularity) {
  if (granularity === 'month') return dateKey.slice(0, 7);
  if (granularity === 'week') return weekStartKey(dateKey);
  return dateKey;
}

const MONTH_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
// "Tue, Sep 1, 2026" -- reports can span years and get exported, so the year stays.
function dayLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return DAY_FMT.format(new Date(Date.UTC(y, m - 1, d, 12)));
}
function periodLabel(periodKey, granularity) {
  if (granularity === 'month') {
    const [y, m] = periodKey.split('-').map(Number);
    return MONTH_FMT.format(new Date(Date.UTC(y, m - 1, 1)));
  }
  if (granularity === 'week') return `Week of ${dayLabel(periodKey)}`;
  return dayLabel(periodKey);
}

const GRANULARITIES = ['day', 'week', 'month'];
const DEFAULT_REPORT_DAYS = 30;

// Table sections the report builder can select (each becomes one
// report.tables entry); 'highlights' is a selectable extra but lives under
// report.stats, not report.tables, since it's not a table.
const SECTION_KEYS = ['byActivity', 'byPeriod', 'byLocation', 'byDayOfWeek', 'byTimeOfDay', 'shelterContext', 'uniqueDogsServed'];
const SELECTABLE_KEYS = [...SECTION_KEYS, 'highlights'];
const DEFAULT_SECTIONS = ['byActivity', 'byPeriod'];

function parseSections(raw) {
  if (!raw) return DEFAULT_SECTIONS;
  const requested = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((s) => SELECTABLE_KEYS.includes(s));
  return valid.length ? valid : DEFAULT_SECTIONS;
}

// Trims a full report down to just the requested sections/highlights --
// report.dogDetail passes through untouched (picking dogs is its own
// explicit action, not gated by the sections list).
function pickSections(report, sections) {
  const tables = {};
  for (const key of sections) if (report.tables[key]) tables[key] = report.tables[key];
  const stats = { totals: report.stats.totals };
  if (sections.includes('highlights')) stats.highlights = report.stats.highlights;
  return { range: report.range, granularity: report.granularity, species: report.species, minCell: report.minCell, notes: report.notes, stats, tables, dogDetail: report.dogDetail };
}

function hoursOf(seconds) {
  return Math.round((seconds / 3600) * 10) / 10;
}

// Resolves { from, to } shelter-local date keys from the request, defaulting
// to the last DEFAULT_REPORT_DAYS days (inclusive of today).
function resolveRange(req) {
  const todayKey = dateKeyOf(new Date().toISOString());
  const to = validDateKey(req.query.to) || todayKey;
  let from = validDateKey(req.query.from);
  if (!from) {
    const d = new Date(`${to}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (DEFAULT_REPORT_DAYS - 1));
    from = d.toISOString().slice(0, 10);
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

function paddedWindow(from, to) {
  const paddedFrom = new Date(`${from}T00:00:00Z`);
  paddedFrom.setUTCDate(paddedFrom.getUTCDate() - 1);
  const paddedTo = new Date(`${to}T00:00:00Z`);
  paddedTo.setUTCDate(paddedTo.getUTCDate() + 2);
  return { paddedFrom: paddedFrom.toISOString(), paddedTo: paddedTo.toISOString() };
}

// Completed walks whose shelter-local start date falls within [from, to],
// inclusive. Over-fetches a generously padded UTC window (DST-safe) then
// filters precisely in JS by dateKeyOf. Joins the dog's name and keeps the
// walk's own `location` so byLocation/uniqueDogsServed need no 2nd query.
// species: 'dog' (default), 'cat' or 'all' -- same species split as Together.
function walksInRange(db, from, to, species = 'dog') {
  const { paddedFrom, paddedTo } = paddedWindow(from, to);
  const kinds = statsBreakdown.filterKinds(species);
  const rows = db.prepare(`
    SELECT w.dog_id, w.user_id, w.activity, w.duration_seconds, w.started_at, w.location, d.name AS dog_name
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.ended_at IS NOT NULL AND w.started_at >= ? AND w.started_at < ?
      AND d.species IN (${kinds.map(() => '?').join(', ')})
  `).all(paddedFrom, paddedTo, ...kinds);
  return rows.filter((r) => {
    const key = dateKeyOf(r.started_at);
    return key >= from && key <= to;
  });
}

// Shelter-wide context (new dogs, adoptions, returns) for the same range --
// no volunteer data at all, so no MIN_CELL suppression applies here.
function shelterContextInRange(db, from, to) {
  const { paddedFrom, paddedTo } = paddedWindow(from, to);
  const rows = db.prepare(`
    SELECT kind, occurred_at FROM shelter_events
    WHERE kind IN ('new_dog', 'adopted', 'returned', 'removed') AND occurred_at >= ? AND occurred_at < ?
      AND ${DOG_EVENTS_WHERE}
  `).all(paddedFrom, paddedTo);
  const counts = { new_dog: 0, adopted: 0, returned: 0, removed: 0 };
  for (const r of rows) {
    const key = dateKeyOf(r.occurred_at);
    if (key >= from && key <= to) counts[r.kind] += 1;
  }
  return counts;
}

// Per-walk detail for specific dog(s) -- deliberately no walker identity,
// same rule impact.js's registerDay follows for other people's walks.
function dogDetailInRange(db, from, to, dogIds) {
  if (!dogIds.length) return [];
  const placeholders = dogIds.map(() => '?').join(',');
  const names = db.prepare(`SELECT shelter_buddy_id AS id, name FROM dogs WHERE shelter_buddy_id IN (${placeholders})`).all(...dogIds);
  const nameById = new Map(names.map((r) => [r.id, r.name]));
  const { paddedFrom, paddedTo } = paddedWindow(from, to);
  const rows = db.prepare(`
    SELECT dog_id, started_at, duration_seconds, activity, location FROM walks
    WHERE ended_at IS NOT NULL AND dog_id IN (${placeholders}) AND started_at >= ? AND started_at < ?
    ORDER BY started_at ASC
  `).all(...dogIds, paddedFrom, paddedTo).filter((r) => {
    const key = dateKeyOf(r.started_at);
    return key >= from && key <= to;
  });

  return dogIds.map((id) => {
    const dogRows = rows.filter((r) => r.dog_id === id);
    const totalSeconds = dogRows.reduce((sum, r) => sum + (r.duration_seconds || 0), 0);
    const dogName = nameById.get(id) || `Dog #${id}`;
    return {
      dogId: id,
      dogName,
      totals: { walks: dogRows.length, hours: hoursOf(totalSeconds) },
      table: {
        title: `${dogName}'s engagements`,
        columns: ['Date', 'Activity', 'Duration (min)', 'Location'],
        rows: dogRows.map((r) => [dayLabel(dateKeyOf(r.started_at)), activityLabel(r.activity), Math.round((r.duration_seconds || 0) / 60), r.location || ''])
      }
    };
  });
}

function bucket() { return { walks: 0, seconds: 0, dogs: new Set() }; }
function addToBucket(b, r) { b.walks += 1; b.seconds += r.duration_seconds || 0; b.dogs.add(r.dog_id); }

// Volunteer-activity breakdown rows with fewer than MIN_CELL engagements are
// left out (they still count in the totals), the same rule Together follows,
// so a quiet slice can't be pinned on whoever worked it. rows: [label, count, ...].
const privacyFloor = (rows) => rows.filter((r) => r[1] >= MIN_CELL);

function buildReportMetrics(db, { from, to, granularity, dogIds, kennelLetter, activities, species = 'dog' }) {
  const rows = walksInRange(db, from, to, species);
  const nouns = nounsFor(species);

  const totals = {
    walks: rows.length,
    hours: hoursOf(rows.reduce((sum, r) => sum + (r.duration_seconds || 0), 0)),
    uniqueDogs: new Set(rows.map((r) => r.dog_id)).size,
    volunteerHeadcount: new Set(rows.map((r) => r.user_id)).size
  };

  const byActivityRows = privacyFloor(activities.map((activity) => {
    const subset = rows.filter((r) => (r.activity || 'walk') === activity);
    return [activityLabel(activity), subset.length, hoursOf(subset.reduce((s, r) => s + (r.duration_seconds || 0), 0))];
  }));

  // Day-level buckets, always at day granularity regardless of what the
  // caller picked for byPeriod -- both byPeriod (rolled up to the requested
  // granularity) and the busiest/quietest highlights come from this.
  const dayBuckets = new Map();
  for (const r of rows) {
    const key = dateKeyOf(r.started_at);
    if (!dayBuckets.has(key)) dayBuckets.set(key, bucket());
    addToBucket(dayBuckets.get(key), r);
  }
  const periodBuckets = new Map();
  for (const [dayKey, b] of dayBuckets) {
    const periodKey = periodKeyOf(dayKey, granularity);
    if (!periodBuckets.has(periodKey)) periodBuckets.set(periodKey, bucket());
    const p = periodBuckets.get(periodKey);
    p.walks += b.walks; p.seconds += b.seconds;
    for (const d of b.dogs) p.dogs.add(d);
  }
  const byPeriodRows = [...periodBuckets.entries()]
    .filter(([, b]) => b.walks >= MIN_CELL)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([periodKey, b]) => [periodLabel(periodKey, granularity), b.walks, hoursOf(b.seconds), b.dogs.size]);

  const locationBuckets = new Map();
  for (const r of rows) {
    const letter = kennelLetter(r.location) || 'unassigned';
    if (!locationBuckets.has(letter)) locationBuckets.set(letter, bucket());
    addToBucket(locationBuckets.get(letter), r);
  }
  const byLocationRows = privacyFloor(['A', 'B', 'C', 'D', 'E', 'unassigned'].filter((k) => locationBuckets.has(k)).map((k) => {
    const b = locationBuckets.get(k);
    return [k === 'unassigned' ? 'Unassigned' : k, b.walks, hoursOf(b.seconds), b.dogs.size];
  }));

  const dowBuckets = new Map();
  for (const r of rows) {
    const dow = dayOfWeekOf(dateKeyOf(r.started_at));
    if (!dowBuckets.has(dow)) dowBuckets.set(dow, bucket());
    addToBucket(dowBuckets.get(dow), r);
  }
  const byDayOfWeekRows = privacyFloor(DOW_LABELS.map((label, i) => {
    const b = dowBuckets.get(i) || bucket();
    return [label, b.walks, hoursOf(b.seconds), b.dogs.size];
  }));

  const sessionBuckets = new Map();
  for (const r of rows) {
    const key = sessionOf(hourOf(r.started_at)).key;
    if (!sessionBuckets.has(key)) sessionBuckets.set(key, bucket());
    addToBucket(sessionBuckets.get(key), r);
  }
  const byTimeOfDayRows = privacyFloor([...SESSIONS, OTHER_SESSION].filter((s) => sessionBuckets.has(s.key)).map((s) => {
    const b = sessionBuckets.get(s.key);
    return [s.label, b.walks, hoursOf(b.seconds), b.dogs.size];
  }));

  const dogTotals = new Map();
  for (const r of rows) {
    if (!dogTotals.has(r.dog_id)) dogTotals.set(r.dog_id, { name: r.dog_name, walks: 0, seconds: 0 });
    const d = dogTotals.get(r.dog_id);
    d.walks += 1; d.seconds += r.duration_seconds || 0;
  }
  const uniqueDogsServedRows = [...dogTotals.values()]
    .sort((a, b) => b.walks - a.walks)
    .map((d) => [d.name, d.walks, hoursOf(d.seconds)]);

  const shelterContext = shelterContextInRange(db, from, to);
  const shelterContextRows = [
    ['New dogs listed', shelterContext.new_dog],
    ['Adopted', shelterContext.adopted],
    ['Returned', shelterContext.returned],
    ['Removed (other)', shelterContext.removed]
  ];

  // quietestDay is floored at MIN_CELL so a single-volunteer day is never
  // the one spotlighted; the avg* figures are whole-range-only (dividing two
  // aggregates already shown above, never shown per-period), so they can't
  // approach the per-person comparisons impact.js's privacy rule forbids.
  // Busiest and quietest both skip days under MIN_CELL, and when they'd be the
  // same count (every day tied, or a single day) neither says anything, so
  // both are left out.
  const dayEntries = [...dayBuckets.entries()].map(([dateKey, b]) => ({ dateKey, walks: b.walks }))
    .filter((d) => d.walks >= MIN_CELL)
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1));
  let busiest = dayEntries.length ? dayEntries.reduce((a, b) => (b.walks > a.walks ? b : a)) : null;
  let quietest = dayEntries.length ? dayEntries.reduce((a, b) => (b.walks < a.walks ? b : a)) : null;
  if (busiest && quietest && busiest.walks === quietest.walks) { busiest = null; quietest = null; }
  const avgWalkSeconds = walkOnlyAvgSeconds(rows);
  const highlights = {
    busiestDay: busiest ? { dateKey: busiest.dateKey, label: dayLabel(busiest.dateKey), walks: busiest.walks } : null,
    quietestDay: quietest ? { dateKey: quietest.dateKey, label: dayLabel(quietest.dateKey), walks: quietest.walks } : null,
    avgWalksPerVolunteer: totals.volunteerHeadcount ? Math.round((totals.walks / totals.volunteerHeadcount) * 10) / 10 : null,
    // Walk activity only, finished, a minute or longer (see walkOnlyAvgSeconds).
    avgWalkMinutes: avgWalkSeconds == null ? null : Math.round(avgWalkSeconds / 60)
  };

  const periodNoun = { day: 'Day', week: 'Week', month: 'Month' }[granularity] || 'Period';
  const unique = `Unique ${nouns.many}`;
  return {
    range: { from, to }, granularity, species, minCell: MIN_CELL,
    // Shown under the tables and in every export.
    notes: [
      `Counts ${species === 'all' ? 'dogs and cats' : `${nouns.many} only`}. An engagement is any walk, cuddle, matchmaking, play group or daycation that has finished.`,
      `Rows with fewer than ${MIN_CELL} engagements are left out of the breakdowns (they still count in the totals), so no one volunteer can be singled out.`,
      'Hours are rounded to one decimal in each row, so rows may not add up exactly to the total.'
    ],
    stats: { totals, highlights },
    tables: {
      byActivity: { title: 'By activity', columns: ['Activity', 'Engagements', 'Hours'], rows: byActivityRows },
      byPeriod: { title: `By ${periodNoun.toLowerCase()}`, columns: [periodNoun, 'Engagements', 'Hours', unique], rows: byPeriodRows },
      byLocation: { title: 'By location', columns: ['Location', 'Engagements', 'Hours', unique], rows: byLocationRows },
      byDayOfWeek: { title: 'By day of week', columns: ['Day', 'Engagements', 'Hours', unique], rows: byDayOfWeekRows },
      byTimeOfDay: { title: 'By time of day', columns: ['Time of day', 'Engagements', 'Hours', unique], rows: byTimeOfDayRows },
      shelterContext: { title: species === 'dog' ? 'Shelter context' : 'Shelter context (dogs only)', columns: ['Event', 'Count'], rows: shelterContextRows },
      uniqueDogsServed: { title: `${unique} served`, columns: [nouns.Many.replace(/s$/, ''), 'Engagements', 'Hours'], rows: uniqueDogsServedRows }
    },
    dogDetail: dogDetailInRange(db, from, to, dogIds || [])
  };
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function highlightLines(h) {
  return [
    ['Busiest day', h.busiestDay ? `${dayLabel(h.busiestDay.dateKey)} (${h.busiestDay.walks} engagements)` : 'n/a'],
    ['Quietest day', h.quietestDay ? `${dayLabel(h.quietestDay.dateKey)} (${h.quietestDay.walks} engagements)` : 'n/a'],
    ['Avg engagements per active volunteer', h.avgWalksPerVolunteer ?? 'n/a'],
    ['Avg walk length (minutes, walks only)', h.avgWalkMinutes ?? 'n/a']
  ];
}

const rangeText = (range) => `${dayLabel(range.from)} to ${dayLabel(range.to)}`;
function totalsHeader(report) {
  return ['Engagements', 'Hours', `Unique ${nounsFor(report.species).many}`, 'Volunteers active'];
}

function reportToCsv(report) {
  const lines = [];
  lines.push('Shelter Walk - Volunteer Activity Report');
  lines.push(['Range', rangeText(report.range)].map(csvEscape).join(','));
  lines.push('');
  lines.push('Totals');
  lines.push(totalsHeader(report).join(','));
  const t = report.stats.totals;
  lines.push([t.walks, t.hours, t.uniqueDogs, t.volunteerHeadcount].join(','));

  if (report.stats.highlights) {
    lines.push('');
    lines.push('Highlights');
    for (const [label, value] of highlightLines(report.stats.highlights)) lines.push([label, value].map(csvEscape).join(','));
  }

  for (const table of Object.values(report.tables)) {
    lines.push('');
    lines.push(table.title);
    lines.push(table.columns.join(','));
    for (const row of table.rows) lines.push(row.map(csvEscape).join(','));
  }

  for (const dog of report.dogDetail || []) {
    lines.push('');
    lines.push(csvEscape(`${dog.dogName} - ${dog.totals.walks} engagements, ${dog.totals.hours} hours`));
    lines.push(dog.table.columns.join(','));
    for (const row of dog.table.rows) lines.push(row.map(csvEscape).join(','));
  }

  if (report.notes && report.notes.length) {
    lines.push('');
    lines.push('Notes');
    for (const note of report.notes) lines.push(csvEscape(note));
  }

  return lines.join('\n');
}

// Excel worksheet names: <=31 chars, no [ ] : * ? / \ -- and must be unique,
// so a counter suffix breaks any collision between two sections/dogs.
function sheetName(raw, used) {
  let name = String(raw).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name.slice(0, 28)} ${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

async function reportToXlsx(report) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const usedNames = new Set();

  const totalsSheet = workbook.addWorksheet(sheetName('Totals', usedNames));
  totalsSheet.addRow(['Range', rangeText(report.range)]);
  totalsSheet.addRow([]);
  const t = report.stats.totals;
  totalsSheet.addRow(totalsHeader(report)).font = { bold: true };
  totalsSheet.addRow([t.walks, t.hours, t.uniqueDogs, t.volunteerHeadcount]);

  if (report.stats.highlights) {
    totalsSheet.addRow([]);
    totalsSheet.addRow(['Highlights']).font = { bold: true };
    for (const [label, value] of highlightLines(report.stats.highlights)) totalsSheet.addRow([label, value]);
  }
  if (report.notes && report.notes.length) {
    totalsSheet.addRow([]);
    totalsSheet.addRow(['Notes']).font = { bold: true };
    for (const note of report.notes) totalsSheet.addRow([note]);
  }

  for (const table of Object.values(report.tables)) {
    const sheet = workbook.addWorksheet(sheetName(table.title, usedNames));
    sheet.addRow(table.columns).font = { bold: true };
    for (const row of table.rows) sheet.addRow(row);
  }

  for (const dog of report.dogDetail || []) {
    const sheet = workbook.addWorksheet(sheetName(dog.dogName, usedNames));
    sheet.addRow([`${dog.totals.walks} engagements, ${dog.totals.hours} hours`]);
    sheet.addRow(dog.table.columns).font = { bold: true };
    for (const row of dog.table.rows) sheet.addRow(row);
  }

  return workbook.xlsx.writeBuffer();
}

function reportToPdf(report, res) {
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(18).text('Shelter Walk - Volunteer Activity Report');
  doc.fontSize(10).fillColor('#555').text(`Range: ${rangeText(report.range)}`);
  doc.text(`Generated: ${new Date().toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' })}`);
  doc.fillColor('#000').moveDown(1);

  const t = report.stats.totals;
  const [engagementsLabel, hoursLabel, uniqueLabel, volunteersLabel] = totalsHeader(report);
  doc.fontSize(13).text('Totals');
  doc.fontSize(11)
    .text(`${engagementsLabel}: ${t.walks}`)
    .text(`${hoursLabel}: ${t.hours}`)
    .text(`${uniqueLabel}: ${t.uniqueDogs}`)
    .text(`${volunteersLabel}: ${t.volunteerHeadcount}`);
  doc.moveDown(1);

  if (report.stats.highlights) {
    if (doc.y > 650) doc.addPage();
    doc.fontSize(13).text('Highlights');
    doc.fontSize(11);
    for (const [label, value] of highlightLines(report.stats.highlights)) doc.text(`${label}: ${value}`);
    doc.moveDown(1);
  }

  const colX = [50, 250, 350, 450];
  function table(title, columns, rows) {
    if (doc.y > 650) doc.addPage();
    doc.fontSize(13).text(title);
    doc.fontSize(10);
    const headerY = doc.y;
    columns.forEach((cell, i) => doc.text(cell, colX[i] || 50, headerY));
    doc.moveDown(0.3);
    if (!rows.length) {
      doc.fillColor('#777').text('Nothing to show in this range.', 50).fillColor('#000');
      doc.moveDown(0.5);
      return;
    }
    for (const row of rows) {
      if (doc.y > 700) doc.addPage();
      const rowY = doc.y;
      row.forEach((cell, i) => doc.text(String(cell), colX[i] || 50, rowY));
      doc.moveDown(0.2);
    }
    doc.moveDown(0.8);
  }

  for (const t2 of Object.values(report.tables)) table(t2.title, t2.columns, t2.rows);
  for (const dog of report.dogDetail || []) {
    table(`${dog.table.title} (${dog.totals.walks} engagements, ${dog.totals.hours}h)`, dog.table.columns, dog.table.rows);
  }
  if (report.notes && report.notes.length) {
    if (doc.y > 650) doc.addPage();
    doc.fontSize(9).fillColor('#555');
    for (const note of report.notes) doc.text(note, 50);
    doc.fillColor('#000');
  }

  doc.end();
}

// How long a walk "normally" runs, per activity, is a plain running average
// of every completed walk ever recorded for that activity -- recomputed
// fresh on every request (no stored/cached stat), so it's always current.
// Nothing here is a limit: a walk running longer than its average just gets
// flagged as such on the live board, nothing stops or warns anyone.
//
// auto_stopped = 1 rows are excluded: those walks were cut off by the time
// limit (and never corrected afterward -- see the auto_stopped/wrap_up_pending
// handling in server.js), so duration_seconds on them is an artifact of the
// limit, not a real walk length. Counting them would skew every average up
// toward the time limit itself, defeating the point of the comparison.
//
// Misscans under a minute are left out too (MIN_AVERAGED_SECONDS).
//
// An activity with no (non-auto-stopped) history yet falls back to the walk
// average -- never an all-activity average, which 12-hour daycations would
// drag up -- then a flat default, purely so the board has something sane to
// show. Daycations get no "above average" badge on the board at all.
const DEFAULT_AVERAGE_SECONDS = 30 * 60;
// species: 'dog' | 'cat' | 'all' (the board's switch), so cat cuddles never
// set the dog board's "usual length" bars or the other way round.
function computeActivityAverages(db, activities, species = 'all') {
  const perActivity = db.prepare(`
    SELECT w.activity, AVG(w.duration_seconds) AS avgSeconds
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.ended_at IS NOT NULL AND w.auto_stopped = 0 AND w.duration_seconds >= ?
      AND (? = 'all' OR d.species = ?)
    GROUP BY w.activity
  `).all(MIN_AVERAGED_SECONDS, species, species);
  const byActivity = Object.fromEntries(perActivity.map((r) => [r.activity, r.avgSeconds]));
  const fallback = byActivity.walk || DEFAULT_AVERAGE_SECONDS;
  return Object.fromEntries(activities.map((a) => [a, Math.round(byActivity[a] || fallback)]));
}

function register(app, { db, enforceWalkLimits, kennelLetter, cachedPhotoUrl, ACTIVITIES }) {
  function requireStaff(req, res, next) {
    if (req.headers['x-auth-staff'] !== '1') return res.status(403).json({ error: 'Staff only.' });
    next();
  }

  const LOCATION_KEYS = ['A', 'B', 'C', 'D', 'E'];
  const openWalksStmt = db.prepare(`
    SELECT w.id, w.dog_id, w.user_id, w.started_at, w.location, w.activity, w.extend_minutes,
           d.name AS dog_name, d.kennel_location, d.photo_url, d.species,
           CASE WHEN u.hide_name_while_walking = 1 THEN 'a volunteer' ELSE u.name END AS walker_name
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id JOIN users u ON u.id = w.user_id
    WHERE w.ended_at IS NULL
  `);
  // 3-day lookback covers both "today" and "yesterday" from one query.
  const walksSinceStmt = db.prepare(`
    SELECT w.dog_id, w.started_at, w.ended_at, d.species
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id WHERE w.started_at >= ?
  `);

  app.get('/api/staff/live', requireStaff, (req, res) => {
    enforceWalkLimits();
    const species = parseSpecies(req.query.species);
    const kinds = statsBreakdown.filterKinds(species);
    const open = openWalksStmt.all().filter((w) => kinds.includes(w.species));
    const locations = Object.fromEntries([...LOCATION_KEYS, 'unassigned'].map((k) => [k, []]));
    // Daycations are off-site (out with a volunteer for the day), not in any
    // kennel wing -- they get their own area instead of a location bucket,
    // on both the location and activity views.
    const daycation = [];
    for (const w of open) {
      const letter = kennelLetter(w.location) || kennelLetter(w.kennel_location);
      const entry = {
        dogId: w.dog_id,
        dogName: w.dog_name,
        photoUrl: cachedPhotoUrl(w.dog_id, w.photo_url),
        activity: w.activity,
        activityLabel: activityLabel(w.activity),
        species: w.species,
        startedAt: w.started_at,
        location: letter,
        walkerName: w.walker_name
      };
      if (w.activity === 'daycation') daycation.push(entry);
      else (locations[letter] || locations.unassigned).push(entry);
    }

    const now = new Date();
    const since = new Date(now.getTime() - 3 * 86400 * 1000).toISOString();
    const todayKey = dateKeyOf(now.toISOString());
    const yesterdayKey = previousDateKey(todayKey);
    // "vs yesterday" compares like with like: yesterday's engagements that
    // had finished by this same clock time yesterday.
    const yesterdayCutoff = sameTimeYesterday(now).toISOString();
    // walksToday / hourlyToday count finished engagements started today, the
    // same rule as Together (/api/impact): one still out shows under "out
    // now" and counts once it ends. Dogs out today includes those still out.
    let walksToday = 0;
    let walksYesterday = 0;
    const hourlyToday = new Array(24).fill(0);
    const dogVisitsToday = new Map();
    for (const { dog_id: dogId, started_at: startedAt, ended_at: endedAt, species: kind } of walksSinceStmt.all(since)) {
      if (!kinds.includes(kind)) continue;
      const key = dateKeyOf(startedAt);
      if (key === todayKey) {
        if (endedAt) {
          walksToday += 1;
          hourlyToday[hourOf(startedAt)] += 1;
        }
        dogVisitsToday.set(dogId, (dogVisitsToday.get(dogId) || 0) + 1);
      } else if (key === yesterdayKey && endedAt && endedAt <= yesterdayCutoff) walksYesterday += 1;
    }
    // How many distinct dogs have been out today, by how many times each --
    // "4plus" lumps 4 or more together rather than an ever-growing tail.
    const outsToday = { 1: 0, 2: 0, 3: 0, '4plus': 0 };
    for (const count of dogVisitsToday.values()) outsToday[count >= 4 ? '4plus' : count] += 1;

    res.json({
      generatedAt: now.toISOString(),
      species,
      activeWalkerCount: new Set(open.map((w) => w.user_id)).size,
      walksToday,
      walksYesterday,
      hourlyToday,
      dogsOutToday: dogVisitsToday.size,
      outsToday,
      daycation,
      activityAverages: computeActivityAverages(db, ACTIVITIES, species),
      locations
    });
  });

  // Minimal list for the report builder's dog picker -- every dog ever seen
  // (not just currently listed), since a report can cover dogs no longer
  // on the shelter's site.
  const allDogsStmt = db.prepare("SELECT shelter_buddy_id AS id, name FROM dogs WHERE awaiting_listing = 0 ORDER BY name COLLATE NOCASE");
  app.get('/api/staff/dogs', requireStaff, (req, res) => {
    res.json({ dogs: allDogsStmt.all() });
  });

  function parseReportParams(req, res) {
    const granularity = req.query.granularity || 'day';
    if (!GRANULARITIES.includes(granularity)) {
      res.status(400).json({ error: `granularity must be one of: ${GRANULARITIES.join(', ')}` });
      return null;
    }
    const { from, to } = resolveRange(req);
    const sections = parseSections(req.query.sections);
    const dogIds = String(req.query.dogIds || '').split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
    return { from, to, granularity, sections, dogIds, species: parseSpecies(req.query.species) };
  }

  function buildPickedReport(params) {
    const full = buildReportMetrics(db, { ...params, kennelLetter, activities: ACTIVITIES });
    return pickSections(full, params.sections);
  }

  app.get('/api/staff/reports', requireStaff, (req, res) => {
    const params = parseReportParams(req, res);
    if (!params) return;
    res.json(buildPickedReport(params));
  });

  app.get('/api/staff/reports/export.csv', requireStaff, (req, res) => {
    const params = parseReportParams(req, res);
    if (!params) return;
    const report = buildPickedReport(params);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="shelter-walk-report-${report.range.from}-to-${report.range.to}.csv"`);
    res.send(reportToCsv(report));
  });

  app.get('/api/staff/reports/export.xlsx', requireStaff, async (req, res) => {
    const params = parseReportParams(req, res);
    if (!params) return;
    const report = buildPickedReport(params);
    const buffer = await reportToXlsx(report);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="shelter-walk-report-${report.range.from}-to-${report.range.to}.xlsx"`);
    res.send(buffer);
  });

  app.get('/api/staff/reports/export.pdf', requireStaff, (req, res) => {
    const params = parseReportParams(req, res);
    if (!params) return;
    const report = buildPickedReport(params);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="shelter-walk-report-${report.range.from}-to-${report.range.to}.pdf"`);
    reportToPdf(report, res);
  });

  // ---- Saved report formats (shared across every staff account) ----
  const MAX_SAVED_REPORTS = 100;
  function serializeSavedReport(row) {
    return {
      id: row.id,
      name: row.name,
      sections: JSON.parse(row.sections),
      granularity: row.granularity,
      dogIds: JSON.parse(row.dog_ids),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  function validSectionsBody(sections) {
    if (!Array.isArray(sections) || !sections.every((s) => typeof s === 'string')) return null;
    return sections.filter((s) => SELECTABLE_KEYS.includes(s));
  }
  function validDogIdsBody(dogIds) {
    return Array.isArray(dogIds) ? dogIds.filter((n) => Number.isInteger(n) && n > 0) : [];
  }

  app.get('/api/staff/saved-reports', requireStaff, (req, res) => {
    const rows = db.prepare('SELECT * FROM saved_staff_reports ORDER BY name COLLATE NOCASE').all();
    res.json({ reports: rows.map(serializeSavedReport) });
  });

  app.post('/api/staff/saved-reports', requireStaff, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const sections = validSectionsBody(req.body.sections);
    if (!sections) return res.status(400).json({ error: 'sections must be a list of section keys' });
    const granularity = GRANULARITIES.includes(req.body.granularity) ? req.body.granularity : 'day';
    const dogIds = validDogIdsBody(req.body.dogIds);
    const count = db.prepare('SELECT COUNT(*) AS c FROM saved_staff_reports').get().c;
    if (count >= MAX_SAVED_REPORTS) return res.status(400).json({ error: `You can save up to ${MAX_SAVED_REPORTS} report formats.` });
    const now = new Date().toISOString();
    const info = db.prepare(
      'INSERT INTO saved_staff_reports (name, sections, granularity, dog_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, JSON.stringify(sections), granularity, JSON.stringify(dogIds), now, now);
    res.json(serializeSavedReport(db.prepare('SELECT * FROM saved_staff_reports WHERE id = ?').get(info.lastInsertRowid)));
  });

  app.put('/api/staff/saved-reports/:id', requireStaff, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare('SELECT * FROM saved_staff_reports WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim().slice(0, 120) : existing.name;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const sections = req.body.sections !== undefined ? validSectionsBody(req.body.sections) : JSON.parse(existing.sections);
    if (!sections) return res.status(400).json({ error: 'sections must be a list of section keys' });
    const granularity = req.body.granularity !== undefined
      ? (GRANULARITIES.includes(req.body.granularity) ? req.body.granularity : existing.granularity)
      : existing.granularity;
    const dogIds = req.body.dogIds !== undefined ? validDogIdsBody(req.body.dogIds) : JSON.parse(existing.dog_ids);
    db.prepare('UPDATE saved_staff_reports SET name = ?, sections = ?, granularity = ?, dog_ids = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(sections), granularity, JSON.stringify(dogIds), new Date().toISOString(), id);
    res.json(serializeSavedReport(db.prepare('SELECT * FROM saved_staff_reports WHERE id = ?').get(id)));
  });

  app.delete('/api/staff/saved-reports/:id', requireStaff, (req, res) => {
    const info = db.prepare('DELETE FROM saved_staff_reports WHERE id = ?').run(parseInt(req.params.id, 10));
    if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });
}

module.exports = {
  register, buildReportMetrics, pickSections, dateKeyOf,
  previousDateKey, sameTimeYesterday, computeActivityAverages, SESSIONS, ACTIVITY_LABELS
};
