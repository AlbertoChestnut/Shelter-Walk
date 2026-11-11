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
//     one identifiable person worked cannot be pinned on them. Breakdown
//     slices (engagement type, species, POO, kittens) are shown whatever
//     their size: they're counts only, never tied to a day or a session, and
//     hiding them left percentages that didn't add up (owner, 2026-11-10).
// The tests in test/api.test.js enforce all of this.
const statsBreakdown = require('./statsBreakdown');
const { WALK_SLOTS: SLOTS, MIN_AVG_SECONDS, roundToStep } = require('./constants');
// The shelter's date and hour of a walk (cached per UTC hour: see shelterTime.js).
const { shelterParts: localParts, shelterTimeOfDay } = require('./shelterTime');
const { realDateKey } = require('./validate');

const MIN_CELL = 3;

// SLOTS: the same four sessions as the Available list's slot grid.
// Averages leave out anything under MIN_AVG_SECONDS (an accidental scan ended
// right away); those still count in every total.

// The walk-based part of /api/impact is the same for everyone, so it's kept
// for TOGETHER_TTL_MS per (span, species, shelter day) and thrown away the
// moment anything it reads changes: walks, a dog's species or tags, or a
// sticker event (POO at the time). Temp triggers on the server's own DB
// connection catch its writes; PRAGMA data_version catches any other
// connection's (a test or script writing to the file). Totals stay exact.
const TOGETHER_TTL_MS = 45000;
const TOGETHER_MAX_ENTRIES = 24;
function togetherCache(db) {
  let generation = 0;
  const entries = new Map();
  try {
    db.function('together_cache_bump', () => { generation += 1; return null; });
    const bump = 'BEGIN SELECT together_cache_bump(); END';
    db.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS together_walks_ins AFTER INSERT ON main.walks ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_walks_upd AFTER UPDATE ON main.walks ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_walks_del AFTER DELETE ON main.walks ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_dogs_ins AFTER INSERT ON main.dogs ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_dogs_upd AFTER UPDATE OF species, tags ON main.dogs ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_dogs_del AFTER DELETE ON main.dogs ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_events_ins AFTER INSERT ON main.shelter_events ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_events_upd AFTER UPDATE ON main.shelter_events ${bump};
      CREATE TEMP TRIGGER IF NOT EXISTS together_events_del AFTER DELETE ON main.shelter_events ${bump};
    `);
  } catch (e) {
    // No triggers (an unexpected schema): never cache rather than go stale.
    return { get: (key, build) => build(), clear() {} };
  }
  const dataVersion = db.prepare('PRAGMA data_version').pluck();
  return {
    get(key, build) {
      const now = Date.now();
      const stamp = `${generation}:${dataVersion.get()}`;
      const hit = entries.get(key);
      if (hit && hit.stamp === stamp && now - hit.at < TOGETHER_TTL_MS) return hit.value;
      const value = build();
      // build() only reads, but compare against the stamp from before it so
      // a write that lands meanwhile can't be cached as current.
      entries.delete(key);
      if (entries.size >= TOGETHER_MAX_ENTRIES) entries.delete(entries.keys().next().value);
      entries.set(key, { stamp, at: now, value });
      return value;
    },
    clear() { entries.clear(); }
  };
}
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
// averaged engagement was (a matchmaking-only day), or null for a mix.
function avgActivityOf(t) {
  if (t.walkCount > 0) return 'walk';
  const kinds = [...t.activities.entries()].filter(([, a]) => a.avgCount > 0);
  return kinds.length === 1 ? kinds[0][0] : null;
}
// Which engagements avgOf is over: walks of a minute or more when there are
// any, otherwise every engagement of a minute or more.
function averagesWalksOnly(t) { return t.walkCount > 0; }
function isAveraged(t, row) {
  if ((row.duration_seconds || 0) < MIN_AVG_SECONDS) return false;
  return !averagesWalksOnly(t) || (row.activity || 'walk') === 'walk';
}
// avgCount: how many engagements the average is over; avgSkipped: how many of
// the same kind it left out as under a minute. The app shows these as they
// are: others' lengths reach it rounded to 5 minutes, so it can't tell a
// 1-2 minute walk (averaged) from a mis-scan (audit3).
function out(t) {
  const walksOnly = averagesWalksOnly(t);
  const walkRows = t.activities.has('walk') ? t.activities.get('walk').count : 0;
  return {
    walks: t.walks,
    dogs: t.dogs.size,
    seconds: t.seconds,
    avgSeconds: avgOf(t),
    avgActivity: avgActivityOf(t),
    avgCount: walksOnly ? t.walkCount : t.avgCount,
    avgSkipped: walksOnly ? walkRows - t.walkCount : t.walks - t.avgCount
  };
}
// Per-activity counts, every activity type however few.
function byActivityOf(t) {
  return [...t.activities.entries()]
    .map(([activity, a]) => ({ activity, count: a.count, totalSeconds: a.totalSeconds, avgSeconds: a.avgCount ? a.avgSeconds / a.avgCount : 0, avgCount: a.avgCount }))
    .sort((a, b) => b.count - a.count);
}

// rows: [{ dog_id, started_at, duration_seconds, activity }] -- deliberately
// nothing that could identify who logged them.
function buildImpact(rows, allTime, now = new Date()) {
  const days = new Map();
  for (const row of rows) {
    const { dateKey } = localParts(row.started_at);
    const hour = shelterTimeOfDay(row.started_at);
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

// The statsBreakdown.js splits (species, POO at the time, kittens).
function splitBreakdown(rows, pooAt) {
  const { bySpecies, byPoo, byAge } = statsBreakdown.breakdown(rows, pooAt);
  return { bySpecies, byPoo, byAge };
}

function register(app, { db, walkableFor }) {
  const cache = togetherCache(db);
  app.get('/api/impact', (req, res) => {
    // ?days=all: every day since tracking began (the app groups them by month).
    const span = req.query.days === 'all' ? Infinity : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
    // ?species=dog|cat narrows everything to one species (anything else: both).
    const filter = statsBreakdown.speciesFilter(req.query.species);
    const todayKey = localParts(new Date()).dateKey;
    const impact = cache.get(`${span}|${filter}|${todayKey}`, () => buildTogether(db, span, filter));
    // What's listed right now (per viewer: what they may walk), so never
    // cached. No "how many were walked today" here: that's the kind of
    // shortfall framing Together never shows.
    res.json({
      ...impact,
      shelterNow: statsBreakdown.shelterNow(db, filter, { isWalkable: walkableFor(req), walkedIds: null }),
      species: filter
    });
  });
  return cache;
}

// Everything in /api/impact that doesn't depend on who's asking.
function buildTogether(db, span, filter) {
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
    ...splitBreakdown(all, pooAt),
    // Both species, whatever the filter, so the app can show the split.
    bySpecies: splitBreakdown(everything, pooAt).bySpecies
  };
  const impact = buildImpact(rows, allTime);
  if (impact.today) {
    const todayRows = rows.filter((r) => localParts(r.started_at).dateKey === impact.today.dateKey);
    const { byPoo, byAge } = splitBreakdown(todayRows, pooAt);
    // A copy: the same day's entry in `days` keeps the plain day shape.
    impact.today = { ...impact.today, byPoo, byAge };
  }
  // Trim to the requested number of days after bucketing in local time.
  if (span !== Infinity) impact.days = impact.days.slice(0, span);
  return impact;
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
    if (!realDateKey(date)) return res.status(400).json({ error: 'date must look like 2026-09-20' });
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
    // The day's exact totals, the same numbers as its row in the Together
    // list (a total over MIN_CELL+ engagements, like every Together figure).
    const day = tally();
    rows.forEach((r) => add(day, r));
    // Round 4: someone else's engagement has no clock times, just its
    // session (slot, index into SLOTS, -1 outside them) and a length to the
    // nearest 5 minutes, the same as a dog's walk history -- exact times here
    // would undo that, and the dog list's coarse "last walked". Your own
    // keep their times. Ordered by session, never by anyone else's real time.
    const walks = rows.map((r) => {
      const hour = shelterTimeOfDay(r.started_at);
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
        mine: !!r.mine,
        // In the day's average (totals.avgSeconds)? Decided on the exact
        // length, which the app no longer has for others' rounded rows.
        averaged: isAveraged(day, r)
      };
      // Before the first session sorts first, after the last sorts last.
      base.sortKey = base.slot >= 0 ? base.slot : (hour < SLOTS[0].from ? -1 : SLOTS.length);
      return r.mine
        ? { ...base, startedAt: r.started_at, endedAt: r.ended_at, durationSeconds: r.duration_seconds }
        : { ...base, durationSeconds: roundToStep(r.duration_seconds) };
    }).sort((a, b) => a.sortKey - b.sortKey || (a.mine !== b.mine ? (a.mine ? -1 : 1) : 0)
      || (a.mine ? (a.startedAt < b.startedAt ? -1 : 1) : String(a.dogName).localeCompare(String(b.dogName)) || a.activity.localeCompare(b.activity) || a.durationSeconds - b.durationSeconds));
    res.json({
      date,
      totals: out(day),
      walks: walks.map(({ sortKey, ...w }, i) => ({ order: i + 1, ...w }))
    });
  });
}

module.exports = { register, registerDay, MIN_CELL };
