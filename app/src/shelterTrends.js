// Shelter-wide trends for the Stats tab's "Shelter" view, one species at a
// time: how many were at the shelter and in foster each day, and how many
// came in and went out. Built only from the scraper's shelter_events log, the
// dogs table and the daily counts, so it carries no volunteer data at all.
//
// The listing count isn't stored per day (scrape_runs is pruned after 90
// days), so it's rebuilt backwards from today's count: the day before had
// every animal that arrived today taken back out, and every one that left put
// back in.
const species = require('./species');

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

// The animals actually at the shelter are the listed ones minus those in foster.
const FOSTER_LOCATION = 'In Foster';
const LISTED_WHERE = 'still_listed = 1 AND awaiting_listing = 0 AND species = ?';
// shelter_events for one species. For dogs, an event whose animal row is
// gone stays in, as before cats; other species need a known row.
const eventsWhere = (kind) => (kind === species.DEFAULT_SPECIES
  ? "dog_id NOT IN (SELECT shelter_buddy_id FROM dogs WHERE species != 'dog')"
  : `dog_id IN (SELECT shelter_buddy_id FROM dogs WHERE species = '${kind}')`);
const DOG_EVENTS_WHERE = eventsWhere('dog');

// events: [{ kind, occurred_at }] oldest first or not; listedNow: listed
// right now; fosterByDay: Map dateKey -> in foster at that day's end (from
// shelter_species_counts), with today's live count. A day with no foster
// count gets floor and foster: null (a gap in the chart, not a guess).
// since: the first day worth showing (TRENDS_SINCE, or later for a species
// that joined the app later -- see trendsSince).
function buildTrends(events, listedNow, now = new Date(), fosterByDay = new Map(), since = TRENDS_SINCE) {
  const todayKey = dateKeyOf(now.toISOString());
  const byDay = new Map();
  let firstKey = todayKey;
  for (const e of events) {
    const key = dateKeyOf(e.occurred_at);
    if (key > todayKey || key < since) continue;
    if (key < firstKey) firstKey = key;
    if (!byDay.has(key)) byDay.set(key, { newDogs: 0, returned: 0, adopted: 0, otherExits: 0 });
    const d = byDay.get(key);
    if (e.kind === 'new_dog') d.newDogs += 1;
    else if (e.kind === 'returned') d.returned += 1;
    else if (e.kind === 'adopted') d.adopted += 1;
    else if (e.kind === 'removed') d.otherExits += 1;
  }
  const days = [];
  if (firstKey < since) firstKey = since;
  for (let key = firstKey; key <= todayKey; key = nextDateKey(key)) {
    const d = byDay.get(key) || { newDogs: 0, returned: 0, adopted: 0, otherExits: 0 };
    days.push({ dateKey: key, ...d, broughtIn: d.newDogs + d.returned });
  }
  // Walk back from today: listed at the end of each day.
  let listed = listedNow;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    days[i].listed = Math.max(0, listed);
    const foster = fosterByDay.get(days[i].dateKey);
    days[i].foster = foster == null ? null : Math.min(foster, days[i].listed);
    days[i].floor = foster == null ? null : Math.max(0, days[i].listed - foster);
    listed = listed - days[i].broughtIn + days[i].adopted + days[i].otherExits;
  }
  const today = days[days.length - 1];
  return { days, listedNow, floorNow: today ? today.floor : null, fosterNow: today ? today.foster : null };
}

// A species added to the app later had its whole listing logged as "new" on
// the day it was first scraped (cats: 2026-11-06), so its trends start the
// day after that.
function trendsSince(firstEventAt) {
  if (!firstEventAt) return TRENDS_SINCE;
  const next = nextDateKey(dateKeyOf(firstEventAt));
  return next > TRENDS_SINCE ? next : TRENDS_SINCE;
}

function currentCounts(db, kind) {
  return db.prepare(`SELECT COUNT(*) AS listed, COALESCE(SUM(location = ?), 0) AS inFoster FROM dogs WHERE ${LISTED_WHERE}`).get(FOSTER_LOCATION, kind);
}

// Saves today's counts for every species; a later call the same day replaces
// an earlier one. `at` lets a backfill from an old backup file it under that
// backup's day, without ever overwriting a count taken later in the day.
function recordDailyCounts(db, at = new Date()) {
  const save = db.prepare(`
    INSERT INTO shelter_species_counts (date_key, species, listed, in_foster, recorded_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date_key, species) DO UPDATE SET listed = excluded.listed, in_foster = excluded.in_foster, recorded_at = excluded.recorded_at
    WHERE excluded.recorded_at >= shelter_species_counts.recorded_at
  `);
  for (const kind of species.SPECIES_KEYS) {
    const { listed, inFoster } = currentCounts(db, kind);
    save.run(dateKeyOf(at.toISOString()), kind, listed, inFoster, at.toISOString());
  }
}

function register(app, { db }) {
  // ?species=dog|cat (anything else: dogs).
  app.get('/api/shelter-trends', (req, res) => {
    const kind = species.validSpecies(req.query.species) ? req.query.species : species.DEFAULT_SPECIES;
    const where = eventsWhere(kind);
    const events = db.prepare(
      `SELECT kind, occurred_at FROM shelter_events WHERE kind IN ('new_dog', 'returned', 'adopted', 'removed') AND ${where}`
    ).all();
    const first = db.prepare(`SELECT MIN(occurred_at) AS at FROM shelter_events WHERE ${where}`).get().at;
    const now = new Date();
    const live = currentCounts(db, kind);
    const fosterByDay = new Map(db.prepare('SELECT date_key, in_foster FROM shelter_species_counts WHERE species = ?').all(kind).map((r) => [r.date_key, r.in_foster]));
    fosterByDay.set(dateKeyOf(now.toISOString()), live.inFoster);
    res.json({ species: kind, ...buildTrends(events, live.listed, now, fosterByDay, trendsSince(first)) });
  });
}

module.exports = { register, buildTrends, trendsSince, recordDailyCounts, dateKeyOf, TRENDS_SINCE, DOG_EVENTS_WHERE, FOSTER_LOCATION };
