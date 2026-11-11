// Breakdowns behind the Stats tab (My stats and Together): one species at a
// time (dogs, cats) or both, by engagement type, POO vs non-POO for dogs,
// kittens vs adult cats, and what's at the shelter right now.
//
// POO is counted as it was AT THE TIME of each engagement, not as the dog's
// sticker reads today: stickers come and go, and an adopted dog's are cleared,
// so "today's sticker" would quietly rewrite history. The sticker on/off
// events in shelter_events (the same ones the dog's timeline shows) are
// replayed to get the status at each walk's start. A sticker that was on
// before events were logged has a backfilled "on" dated to the stay's start
// (db.js), the earliest point it can honestly be pinned to.
const species = require('./species');
const { FOSTER_LOCATION } = require('./shelterTrends');
// The shelter's clock, and the under-a-minute rule for averages: they still
// count everywhere else (constants.js, the one copy).
const { SHELTER_TZ: TZ, MIN_AVG_SECONDS } = require('./constants');

const POO_STATUSES = ['priority', 'poo', 'none'];

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const shelterDateKey = (iso) => dayFmt.format(new Date(iso));

// 'dog' | 'cat' | 'all' from a query value; anything else is 'all'.
const speciesFilter = (raw) => (species.validSpecies(raw) ? raw : 'all');
const filterKinds = (filter) => (filter === 'all' ? species.SPECIES_KEYS : [filter]);

// (dogId, iso) -> 'priority' | 'poo' | 'none', from the sticker events.
// Loaded once per request: one query, then a short scan per walk. dogIds
// (optional): only those dogs' events are loaded (the dogs in the result),
// using the shelter_events(dog_id, kind, occurred_at) index.
function pooResolver(db, dogIds) {
  const only = Array.isArray(dogIds) ? [...new Set(dogIds.filter((id) => Number.isInteger(id)))] : null;
  const rows = only && !only.length ? [] : db.prepare(`
    SELECT dog_id AS dogId, kind, detail, occurred_at AS at FROM shelter_events
    WHERE detail IN ('poo', 'poo_priority') AND kind IN ('sticker_on', 'sticker_off', 'sticker_auto_off')
      ${only ? 'AND dog_id IN (SELECT value FROM json_each(?))' : ''}
    ORDER BY occurred_at ASC, id ASC
  `).all(...(only ? [JSON.stringify(only)] : []));
  const byDog = new Map();
  for (const r of rows) {
    if (!byDog.has(r.dogId)) byDog.set(r.dogId, []);
    byDog.get(r.dogId).push(r);
  }
  return (dogId, at) => {
    let poo = false;
    let priority = false;
    for (const e of byDog.get(dogId) || []) {
      if (e.at > at) break;
      const on = e.kind === 'sticker_on';
      if (e.detail === 'poo') poo = on; else priority = on;
    }
    return priority ? 'priority' : (poo ? 'poo' : 'none');
  };
}

function bucket() { return { count: 0, totalSeconds: 0, animals: new Set(), avgCount: 0, avgTotal: 0 }; }
function addTo(map, key, row) {
  if (!map.has(key)) map.set(key, bucket());
  const b = map.get(key);
  b.count += 1;
  b.totalSeconds += row.duration_seconds || 0;
  b.animals.add(row.dog_id);
  if ((row.duration_seconds || 0) >= MIN_AVG_SECONDS) { b.avgCount += 1; b.avgTotal += row.duration_seconds; }
}
function rowsOf(map, keyName, order) {
  const keys = order ? order.filter((k) => map.has(k)) : [...map.keys()];
  const list = keys.map((k) => {
    const b = map.get(k);
    // avgCount: how many the average is over, so the app can say when some
    // were left out ("not counting 2 under a minute").
    return { [keyName]: k, count: b.count, animals: b.animals.size, totalSeconds: b.totalSeconds, avgSeconds: b.avgCount ? b.avgTotal / b.avgCount : 0, avgCount: b.avgCount };
  });
  return order ? list : list.sort((a, b) => b.count - a.count);
}

// rows: completed walks with dog_id, species, tags, activity, started_at,
// duration_seconds. pooAt: pooResolver(db). POO and kittens split only the
// rows of the species they're about. POO is about walks only (a POO dog's
// sticker means nothing for a cuddle), so it splits just the walks (owner,
// 2026-11-10). (A species split was computed here until audit3; nothing
// showed it.)
function breakdown(rows, pooAt) {
  const byActivity = new Map();
  const byPoo = new Map();
  const byAge = new Map();
  for (const r of rows) {
    const kind = species.validSpecies(r.species) ? r.species : species.DEFAULT_SPECIES;
    addTo(byActivity, r.activity || 'walk', r);
    if (species.speciesInfo(kind).stickers && (r.activity || 'walk') === 'walk') addTo(byPoo, pooAt(r.dog_id, r.started_at), r);
    if (species.speciesInfo(kind).youngFirst) addTo(byAge, species.isYoung(r) ? 'young' : 'adult', r);
  }
  return {
    byActivity: rowsOf(byActivity, 'activity'),
    byPoo: rowsOf(byPoo, 'status', POO_STATUSES),
    byAge: rowsOf(byAge, 'group', ['young', 'adult'])
  };
}

// What's at the shelter right now, per species in the filter, and how many
// of them had an engagement today (`walkedIds`: dog ids engaged with today,
// by whoever the caller is counting). Dogs: walkable for `isWalkable` (the
// viewer's level), POO / priority POO / non-POO by today's stickers. Cats:
// kittens and adults. Listed animals in foster aren't at the shelter, so
// none of `counts` include them; they're only `inFoster` (owner, 2026-11-09).
function shelterNow(db, filter, { isWalkable, walkedIds }) {
  const out = {};
  const listed = db.prepare('SELECT * FROM dogs WHERE still_listed = 1 AND awaiting_listing = 0 AND species = ?');
  for (const kind of filterKinds(filter)) {
    const info = species.speciesInfo(kind);
    const all = listed.all(kind);
    const rows = all.filter((r) => r.location !== FOSTER_LOCATION);
    const counts = {};
    const today = {};
    const add = (key, row) => {
      counts[key] = (counts[key] || 0) + 1;
      if (walkedIds && walkedIds.has(row.shelter_buddy_id)) today[key] = (today[key] || 0) + 1;
    };
    for (const row of rows) {
      add('total', row);
      if (info.levelRules && isWalkable(row)) add('walkable', row);
      if (info.stickers) add(row.poo_status === 'priority' ? 'priority' : (row.poo_status === 'poo' ? 'poo' : 'nonPoo'), row);
      if (info.youngFirst) add(species.isYoung(row) ? 'young' : 'adult', row);
    }
    out[kind] = { counts, today: walkedIds ? today : null, inFoster: all.length - rows.length };
  }
  return out;
}

module.exports = { shelterDateKey, speciesFilter, filterKinds, pooResolver, breakdown, shelterNow };
