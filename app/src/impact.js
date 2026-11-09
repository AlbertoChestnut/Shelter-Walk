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

function tally() { return { walks: 0, seconds: 0, dogs: new Set(), walkCount: 0, walkSeconds: 0, activities: new Map() }; }
function add(t, row) {
  t.walks += 1;
  t.seconds += row.duration_seconds || 0;
  t.dogs.add(row.dog_id);
  const activity = row.activity || 'walk';
  if (activity === 'walk') { t.walkCount += 1; t.walkSeconds += row.duration_seconds || 0; }
  if (!t.activities.has(activity)) t.activities.set(activity, { count: 0, totalSeconds: 0 });
  const a = t.activities.get(activity);
  a.count += 1;
  a.totalSeconds += row.duration_seconds || 0;
}
// Averaging duration across every kind of interaction lumps a 10-minute
// cuddle in with a 12-hour daycation, so this is walk-only whenever there are
// any walks in the period, falling back to the overall average otherwise.
function avgOf(t) { return t.walkCount > 0 ? t.walkSeconds / t.walkCount : (t.walks ? t.seconds / t.walks : 0); }
function out(t) { return { walks: t.walks, dogs: t.dogs.size, seconds: t.seconds, avgSeconds: avgOf(t) }; }
// Per-activity counts, same MIN_CELL suppression as days/sessions get: an
// activity type a lone volunteer did a handful of times can't be pinned on
// them, so it's left out of the breakdown (it still counts in the totals).
function byActivityOf(t) {
  return [...t.activities.entries()]
    .map(([activity, a]) => ({ activity, count: a.count, totalSeconds: a.totalSeconds, avgSeconds: a.count ? a.totalSeconds / a.count : 0 }))
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

function register(app, { db, cachedPhotoUrl }) {
  app.get('/api/impact', (req, res) => {
    // ?days=all: every day since tracking began (the app groups them by month).
    const span = req.query.days === 'all' ? Infinity : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
    // Pad the window by a day so a UTC/local boundary never clips a day.
    const since = span === Infinity ? '' : new Date(Date.now() - (span + 1) * 86400 * 1000).toISOString();
    const rows = db.prepare(
      'SELECT dog_id, started_at, duration_seconds, activity FROM walks WHERE ended_at IS NOT NULL AND started_at >= ?'
    ).all(since);
    const totals = db.prepare(
      'SELECT COUNT(*) AS walks, COUNT(DISTINCT dog_id) AS dogs, COALESCE(SUM(duration_seconds), 0) AS seconds, MIN(started_at) AS since FROM walks WHERE ended_at IS NOT NULL'
    ).get();
    const walkOnlyTotals = db.prepare(
      "SELECT COUNT(*) AS walkCount, COALESCE(SUM(duration_seconds), 0) AS walkSeconds FROM walks WHERE ended_at IS NOT NULL AND activity = 'walk'"
    ).get();
    const byActivityTotals = db.prepare(
      'SELECT activity, COUNT(*) AS count, COALESCE(SUM(duration_seconds), 0) AS totalSeconds FROM walks WHERE ended_at IS NOT NULL GROUP BY activity'
    ).all();
    const allTime = {
      walks: totals.walks,
      dogs: totals.dogs,
      seconds: totals.seconds,
      since: totals.since,
      avgSeconds: walkOnlyTotals.walkCount > 0 ? walkOnlyTotals.walkSeconds / walkOnlyTotals.walkCount : (totals.walks ? totals.seconds / totals.walks : 0),
      byActivity: byActivityTotals
        .map((a) => ({ activity: a.activity, count: a.count, totalSeconds: a.totalSeconds, avgSeconds: a.count ? a.totalSeconds / a.count : 0 }))
        .filter((a) => a.count >= MIN_CELL)
        .sort((a, b) => b.count - a.count)
    };
    const impact = buildImpact(rows, allTime);
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
    const rows = db.prepare(`
      SELECT w.dog_id, w.started_at, w.ended_at, w.duration_seconds, w.activity, (w.user_id = ?) AS mine,
             d.name AS dog_name, d.photo_url, d.blue_markers, d.poo_status, d.star_flag, d.pb_flag
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE w.ended_at IS NOT NULL AND w.started_at >= ? AND w.started_at < ?
      ORDER BY w.started_at ASC, w.id ASC
    `).all(req.me.id, from, to).filter((r) => localParts(r.started_at).dateKey === date);
    // Same rule as the day list: a quiet day is not opened up, so it can't be
    // pinned on whoever happened to be there.
    if (rows.length < MIN_CELL) return res.status(404).json({ error: 'No details are shown for this day.' });
    res.json({
      date,
      walks: rows.map((r, i) => ({
        order: i + 1,
        dogId: r.dog_id,
        dogName: r.dog_name,
        photoUrl: cachedPhotoUrl ? cachedPhotoUrl(r.dog_id, r.photo_url) : r.photo_url,
        blueMarkers: r.blue_markers,
        pooStatus: r.poo_status,
        starFlag: !!r.star_flag,
        pbFlag: !!r.pb_flag,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationSeconds: r.duration_seconds,
        activity: r.activity,
        mine: !!r.mine
      }))
    });
  });
}

module.exports = { register, registerDay, buildImpact, MIN_CELL };
