// Shelter-wide trends for the Stats tab's "Shelter" view: how many dogs were
// listed each day, and how many came in and went out. Built only from the
// scraper's shelter_events log and the dogs table, so it carries no volunteer
// data at all.
//
// The listing count isn't stored per day (scrape_runs is pruned after 90
// days), so it's rebuilt backwards from today's count: the day before had
// every dog that arrived today taken back out, and every dog that left put
// back in.
const TZ = 'America/New_York'; // the shelter's clock, same as impact.js
// Dogs leaving without an adoption ('removed') were only logged from this day
// on, so earlier days can't be rebuilt correctly and aren't shown.
const TRENDS_SINCE = '2026-09-23';

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function dateKeyOf(iso) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function nextDateKey(key) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The dogs actually at the shelter are the listed ones minus those in foster.
const FOSTER_LOCATION = 'In Foster';
const LISTED_WHERE = 'still_listed = 1 AND awaiting_listing = 0';

// events: [{ kind, occurred_at }] oldest first or not; listedNow: dogs listed
// right now; fosterByDay: Map dateKey -> dogs in foster at that day's end
// (from shelter_daily_counts), with today's live count. A day with no foster
// count gets floor: null (a gap in the chart, not a guess).
function buildTrends(events, listedNow, now = new Date(), fosterByDay = new Map()) {
  const todayKey = dateKeyOf(now.toISOString());
  const byDay = new Map();
  let firstKey = todayKey;
  for (const e of events) {
    const key = dateKeyOf(e.occurred_at);
    if (key > todayKey || key < TRENDS_SINCE) continue;
    if (key < firstKey) firstKey = key;
    if (!byDay.has(key)) byDay.set(key, { newDogs: 0, returned: 0, adopted: 0, otherExits: 0 });
    const d = byDay.get(key);
    if (e.kind === 'new_dog') d.newDogs += 1;
    else if (e.kind === 'returned') d.returned += 1;
    else if (e.kind === 'adopted') d.adopted += 1;
    else if (e.kind === 'removed') d.otherExits += 1;
  }
  const days = [];
  if (firstKey < TRENDS_SINCE) firstKey = TRENDS_SINCE;
  for (let key = firstKey; key <= todayKey; key = nextDateKey(key)) {
    const d = byDay.get(key) || { newDogs: 0, returned: 0, adopted: 0, otherExits: 0 };
    days.push({ dateKey: key, ...d, broughtIn: d.newDogs + d.returned });
  }
  // Walk back from today: listed at the end of each day.
  let listed = listedNow;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    days[i].listed = Math.max(0, listed);
    const foster = fosterByDay.get(days[i].dateKey);
    days[i].floor = foster == null ? null : Math.max(0, days[i].listed - foster);
    listed = listed - days[i].broughtIn + days[i].adopted + days[i].otherExits;
  }
  const today = days[days.length - 1];
  return { days, listedNow, floorNow: today ? today.floor : null };
}

function currentCounts(db) {
  return db.prepare(`SELECT COUNT(*) AS listed, COALESCE(SUM(location = ?), 0) AS inFoster FROM dogs WHERE ${LISTED_WHERE}`).get(FOSTER_LOCATION);
}

// Saves today's counts; a later call the same day replaces an earlier one.
// `at` lets a backfill from an old backup file it under that backup's day,
// without ever overwriting a count taken later in the day.
function recordDailyCounts(db, at = new Date()) {
  const { listed, inFoster } = currentCounts(db);
  db.prepare(`
    INSERT INTO shelter_daily_counts (date_key, listed, in_foster, recorded_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(date_key) DO UPDATE SET listed = excluded.listed, in_foster = excluded.in_foster, recorded_at = excluded.recorded_at
    WHERE excluded.recorded_at >= shelter_daily_counts.recorded_at
  `).run(dateKeyOf(at.toISOString()), listed, inFoster, at.toISOString());
}

function register(app, { db }) {
  app.get('/api/shelter-trends', (req, res) => {
    const events = db.prepare(
      "SELECT kind, occurred_at FROM shelter_events WHERE kind IN ('new_dog', 'returned', 'adopted', 'removed')"
    ).all();
    const now = new Date();
    const live = currentCounts(db);
    const fosterByDay = new Map(db.prepare('SELECT date_key, in_foster FROM shelter_daily_counts').all().map((r) => [r.date_key, r.in_foster]));
    fosterByDay.set(dateKeyOf(now.toISOString()), live.inFoster);
    res.json(buildTrends(events, live.listed, now, fosterByDay));
  });
}

module.exports = { register, buildTrends, recordDailyCounts, dateKeyOf, TRENDS_SINCE };
