// "Together": shelter-wide impact of everyone's walks, combined.
//
// PRIVACY IS THE DESIGN, NOT A FEATURE. This must never become a way to
// single out, compare, or blame an individual volunteer, so:
//   - The query never selects user_id (or any user column). Nothing in this
//     module can leak a name because no name ever enters it.
//   - No volunteer counts, rankings, per-person averages, or comparisons.
//   - No "shortfall" framing (no goals, misses, or zeros): only additive,
//     positive totals.
//   - Days and sessions with fewer than MIN_CELL walks are not listed at all
//     (they still count toward the overall totals), so a quiet session that
//     one identifiable person worked cannot be pinned on them.
// The tests in test/api.test.js enforce all of this.
const statsBreakdown = require('./statsBreakdown');

const TZ = 'America/New_York'; // the shelter's clock, same as the scraper schedule
const MIN_CELL = 3;

// Same four sessions as the Available list's slot grid (last one runs to 8pm
// but is labeled 4-7p).
const SLOTS = [
  { label: '7-10a', from: 7, to: 10 },
  { label: '10-1p', from: 10, to: 13 },
  { label: '1-4p', from: 13, to: 16 },
  { label: '4-7p', from: 16, to: 20 }
];

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
});
function localParts(iso) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { dateKey: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Averages leave out anything under a minute (an accidental scan ended right
// away); those still count in every total.
const { MIN_AVG_SECONDS } = statsBreakdown;
// "2026-11-10" moved by n calendar days.
function shiftDateKey(key, n) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function tally() { return { walks: 0, seconds: 0, dogs: new Set(), walkCount: 0, walkSeconds: 0, avgCount: 0, avgSeconds: 0, activities: new Map() }; }
function add(t, row) {
  const seconds = row.duration_seconds || 0;
  const averaged = seconds >= MIN_AVG_SECONDS;
  t.walks += 1;
  t.seconds += seconds;
  t.dogs.add(row.dog_id);
  if (averaged) { t.avgCount += 1; t.avgSeconds += seconds; }
  const activity = row.activity || 'walk';
  if (activity === 'walk' && averaged) { t.walkCount += 1; t.walkSeconds += seconds; }
  if (!t.activities.has(activity)) t.activities.set(activity, { count: 0, totalSeconds: 0, avgCount: 0, avgSeconds: 0 });
  const a = t.activities.get(activity);
  a.count += 1;
  a.totalSeconds += seconds;
  if (averaged) { a.avgCount += 1; a.avgSeconds += seconds; }
}
// Averaging duration across every kind of interaction lumps a 10-minute
// cuddle in with a 12-hour daycation, so this is walk-only whenever there are
// any walks in the period, falling back to the overall average otherwise.
function avgOf(t) { return t.walkCount > 0 ? t.walkSeconds / t.walkCount : (t.avgCount ? t.avgSeconds / t.avgCount : 0); }
// What that average is of, for its label: 'walk', the one activity every
// averaged engagement was (a matchmaking-only day), or null for a mix. Named
// only when at least MIN_CELL engagements make it up, like byActivityOf, so
// it can't single out a rare one ("Average engagement" then).
function avgActivityOf(t) {
  if (t.walkCount > 0) return 'walk';
  const kinds = [...t.activities.entries()].filter(([, a]) => a.avgCount > 0);
  return kinds.length === 1 && kinds[0][1].avgCount >= MIN_CELL ? kinds[0][0] : null;
}
function out(t) { return { walks: t.walks, dogs: t.dogs.size, seconds: t.seconds, avgSeconds: avgOf(t), avgActivity: avgActivityOf(t) }; }
// Per-activity counts, same MIN_CELL suppression as days/sessions get: an
// activity type a lone volunteer did a handful of times can't be pinned on
// them, so it's left out of the breakdown (it still counts in the totals).
function byActivityOf(t) {
  return [...t.activities.entries()]
    .map(([activity, a]) => ({ activity, count: a.count, totalSeconds: a.totalSeconds, avgSeconds: a.avgCount ? a.avgSeconds / a.avgCount : 0, avgCount: a.avgCount }))
    .filter((a) => a.count >= MIN_CELL)
    .sort((a, b) => b.count - a.count);
}

// rows: [{ dog_id, started_at, duration_seconds, activity }] -- deliberately
// nothing that could identify who logged them.
function buildImpact(rows, allTime, now = new Date()) {
  const days = new Map();
  for (const row of rows) {
    const { dateKey, hour } = localParts(row.started_at);
    if (!days.has(dateKey)) days.set(dateKey, { total: tally(), sessions: SLOTS.map(() => tally()) });
    const d = days.get(dateKey);
    add(d.total, row);
    const slot = SLOTS.findIndex((s) => hour >= s.from && hour < s.to);
    if (slot >= 0) add(d.sessions[slot], row);
  }
  const todayKey = localParts(now.toISOString()).dateKey;
  const list = [];
  let today = null;
  for (const [dateKey, d] of days) {
    if (d.total.walks < MIN_CELL) continue;
    const entry = {
      dateKey,
      ...out(d.total),
      byActivity: byActivityOf(d.total),
      sessions: d.sessions
        .map((t, i) => ({ label: SLOTS[i].label, ...out(t) }))
        .filter((s) => s.walks >= MIN_CELL)
    };
    if (dateKey === todayKey) today = entry;
    list.push(entry);
  }
  list.sort((a, b) => (a.dateKey < b.dateKey ? 1 : -1));
  return { minCell: MIN_CELL, today, days: list, allTime };
}

// The statsBreakdown.js splits (species, POO at the time, kittens), with
// the same MIN_CELL suppression as everything else here: a slice that only
// a handful of engagements fall into is left out (it still counts in the
// totals), so a rare one can't be pinned on whoever did it.
function suppressedBreakdown(rows, pooAt) {
  const b = statsBreakdown.breakdown(rows, pooAt);
  const keep = (list) => list.filter((x) => x.count >= MIN_CELL);
  return { bySpecies: keep(b.bySpecies), byPoo: keep(b.byPoo), byAge: keep(b.byAge) };
}

function register(app, { db, walkableFor }) {
  app.get('/api/impact', (req, res) => {
    // ?days=all: every day since tracking began (the app groups them by month).
    const span = req.query.days === 'all' ? Infinity : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
    // ?species=dog|cat narrows everything to one species (anything else: both).
    const filter = statsBreakdown.speciesFilter(req.query.species);
    const kinds = statsBreakdown.filterKinds(filter);
    // Pad the window by a day so a UTC/local boundary never clips a day.
    const since = span === Infinity ? '' : new Date(Date.now() - (span + 1) * 86400 * 1000).toISOString();
    const everything = db.prepare(`
      SELECT w.dog_id, w.started_at, w.duration_seconds, w.activity, d.species, d.tags
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id WHERE w.ended_at IS NOT NULL
    `).all();
    const all = everything.filter((r) => kinds.includes(r.species));
    // The window is whole shelter days: today and the span - 1 days before
    // it, so the oldest day listed is never cut short by the padding above.
    const firstKey = span === Infinity ? '' : shiftDateKey(localParts(new Date().toISOString()).dateKey, -(span - 1));
    const rows = all.filter((r) => r.started_at >= since && localParts(r.started_at).dateKey >= firstKey);
    const total = tally();
    for (const r of all) add(total, r);
    const pooAt = statsBreakdown.pooResolver(db);
    const allTime = {
      ...out(total),
      since: all.reduce((min, r) => (!min || r.started_at < min ? r.started_at : min), null),
      byActivity: byActivityOf(total),
      ...suppressedBreakdown(all, pooAt),
      // Both species, whatever the filter, so the app can show the split.
      bySpecies: suppressedBreakdown(everything, pooAt).bySpecies
    };
    const impact = buildImpact(rows, allTime);
    if (impact.today) {
      const todayRows = rows.filter((r) => localParts(r.started_at).dateKey === impact.today.dateKey);
      const { byPoo, byAge } = suppressedBreakdown(todayRows, pooAt);
      // A copy: the same day's entry in `days` keeps the plain day shape.
      impact.today = { ...impact.today, byPoo, byAge };
    }
    // What's listed right now. No "how many were walked today" here: that's
    // the kind of shortfall framing Together never shows.
    impact.shelterNow = statsBreakdown.shelterNow(db, filter, { isWalkable: walkableFor(req), walkedIds: null });
    impact.species = filter;
    // Trim to the requested number of days after bucketing in local time.
    if (span !== Infinity) impact.days = impact.days.slice(0, span);
    res.json(impact);
  });
}

// One day's walks in order: which dog, when, how long -- for everyone's walks
// combined. The ONLY thing that says whose a walk was is `mine`, and only to
// the person asking about their own walks; other walkers' walks carry no
// identity at all. Deliberately left out even though they exist on the walk:
// notes (someone's words), and the auto-stopped / edited / manual flags
// (they would quietly point at one person's forgetfulness).
function registerDay(app, { db, cachedPhotoUrl }) {
  app.get('/api/impact/day', (req, res) => {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must look like 2026-09-20' });
    // A local (New York) calendar day always lies within these UTC bounds.
    const base = new Date(`${date}T12:00:00Z`).getTime();
    const from = new Date(base - 36 * 3600 * 1000).toISOString();
    const to = new Date(base + 36 * 3600 * 1000).toISOString();
    const kinds = statsBreakdown.filterKinds(statsBreakdown.speciesFilter(req.query.species));
    const rows = db.prepare(`
      SELECT w.dog_id, w.started_at, w.ended_at, w.duration_seconds, w.activity, (w.user_id = ?) AS mine,
             d.name AS dog_name, d.photo_url, d.blue_markers, d.poo_status, d.star_flag, d.pb_flag
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE w.ended_at IS NOT NULL AND w.started_at >= ? AND w.started_at < ?
        AND d.species IN (${kinds.map(() => '?').join(', ')})
      ORDER BY w.started_at ASC, w.id ASC
    `).all(req.me.id, from, to, ...kinds).filter((r) => localParts(r.started_at).dateKey === date);
    // Same rule as the day list: a quiet day is not opened up, so it can't be
    // pinned on whoever happened to be there.
    if (rows.length < MIN_CELL) return res.status(404).json({ error: 'No details are shown for this day.' });
    // Round 4: someone else's engagement has no clock times, just its
    // session (slot, index into SLOTS, -1 outside them) and a length to the
    // nearest 5 minutes, the same as a dog's walk history -- exact times here
    // would undo that, and the dog list's coarse "last walked". Your own
    // keep their times. Ordered by session, never by anyone else's real time.
    const walks = rows.map((r) => {
      const hour = localParts(r.started_at).hour;
      const base = {
        dogId: r.dog_id,
        dogName: r.dog_name,
        photoUrl: cachedPhotoUrl ? cachedPhotoUrl(r.dog_id, r.photo_url) : r.photo_url,
        blueMarkers: r.blue_markers,
        pooStatus: r.poo_status,
        starFlag: !!r.star_flag,
        pbFlag: !!r.pb_flag,
        slot: SLOTS.findIndex((s) => hour >= s.from && hour < s.to),
        activity: r.activity,
        mine: !!r.mine
      };
      // Before the first session sorts first, after the last sorts last.
      base.sortKey = base.slot >= 0 ? base.slot : (hour < SLOTS[0].from ? -1 : SLOTS.length);
      return r.mine
        ? { ...base, startedAt: r.started_at, endedAt: r.ended_at, durationSeconds: r.duration_seconds }
        : { ...base, durationSeconds: Math.round((r.duration_seconds || 0) / 300) * 300 };
    }).sort((a, b) => a.sortKey - b.sortKey || (a.mine !== b.mine ? (a.mine ? -1 : 1) : 0)
      || (a.mine ? (a.startedAt < b.startedAt ? -1 : 1) : String(a.dogName).localeCompare(String(b.dogName)) || a.activity.localeCompare(b.activity) || a.durationSeconds - b.durationSeconds));
    // The day's exact totals, the same numbers as its row in the Together
    // list (a total over MIN_CELL+ engagements, like every Together figure).
    const day = tally();
    rows.forEach((r) => add(day, r));
    res.json({
      date,
      totals: out(day),
      walks: walks.map(({ sortKey, ...w }, i) => ({ order: i + 1, ...w }))
    });
  });
}

module.exports = { register, registerDay, buildImpact, MIN_CELL };
