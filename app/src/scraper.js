const fs = require('fs');
const path = require('path');
const db = require('./db');
const { sendPushToUser, hasPref } = require('./push');
const { isRename, withPreviousName } = require('./dogNames');
const shelterTrends = require('./shelterTrends');
const { SPECIES, SPECIES_KEYS, speciesFromTags } = require('./species');

const BASE = 'https://pets.wake.gov';
const USER_AGENT = 'dogwalk-personal-tracker/1.0 (+personal use, low frequency scrape)';

// Cached forever once downloaded, so a dog's photo survives their listing
// being pulled from pets.wake.gov after adoption.
const IMAGES_DIR = path.join(__dirname, '..', 'data', 'images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Retries a couple times (a dog whose very first photo-cache attempt fails
// and who then gets adopted before the next scrape would otherwise lose its
// photo forever, since it drops out of the list we scrape once removed --
// this actually happened once, hence the retry rather than a single try).
// `force` re-downloads even if a cached file already exists -- used when the
// shelter's photo URL for this dog has changed since the last scrape (a new,
// usually better, photo replaced the old one).
async function cacheImageIfNeeded(id, photoUrl, force = false, attempt = 1) {
  if (!photoUrl) return;
  const filePath = path.join(IMAGES_DIR, `${id}.jpg`);
  if (!force && fs.existsSync(filePath)) return;
  try {
    const res = await fetch(photoUrl, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    // An HTML error page saved as <id>.jpg would be served forever as a
    // "photo" and never retried, so refuse anything that isn't a real image.
    if (!type.startsWith('image/') || buffer.length < 500) throw new Error(`not an image (${type || 'no content-type'}, ${buffer.length} bytes)`);
    // Write to a temp name then rename, so a crash mid-write never leaves a
    // truncated file that existsSync() would treat as a good cached photo.
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, buffer);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return cacheImageIfNeeded(id, photoUrl, force, attempt + 1);
    }
    console.warn(`[scraper] failed to cache image for ${id} after ${attempt} attempts:`, err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// No request may hang forever: a stalled socket would otherwise hold the
// scrape lock indefinitely and freeze the dog list until the next restart.
const FETCH_TIMEOUT_MS = 20000;

// Transient failures (network blips, 5xx, an empty/truncated body -- the
// "Unexpected end of JSON input" the photos endpoint throws now and then)
// are retried before giving up.
async function fetchJson(url, options = {}, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        const err = new Error(`Request failed ${res.status} for ${url}`);
        // 4xx (other than 429) won't fix itself -- don't hammer the shelter's server.
        if (res.status < 500 && res.status !== 429) { err.permanent = true; throw err; }
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.permanent || attempt === attempts) break;
      await sleep(800 * attempt);
    }
  }
  throw lastErr;
}

// One species' adoption listing (`listing` = 'Dog' or 'Cat', see species.js).
async function fetchAnimalList(listing) {
  const body = {
    pageNumber: 1,
    pageSize: 500,
    shelterBuddyId: '',
    species: listing,
    tag: '',
    breed: '',
    location: '',
    searchText: '',
    sortBy: 'dateInShelter',
    sortAscending: true,
    excludePendingAdoptions: false
  };
  const json = await fetchJson(`${BASE}/api/animals/adopt/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return json.data || [];
}

function resolvePhotoUrl(relativePath) {
  // API returns paths like "../app_data/AnimalImages/251717/Large/251717_1.jpg"
  // relative to https://pets.wake.gov/adopt/ -> resolve against BASE + '/'
  return new URL(relativePath, `${BASE}/adopt/`).toString();
}

// A YouTube video attached to the dog -- shelter staff sometimes add one,
// either as a dedicated `youTubeVideoId` field on the detail record, or
// (older listings) embedded via an <iframe src="...youtube.com/embed/...">
// inside the summary HTML, which renders fine on the shelter's own site but
// gets stripped client-side here (app.js's sanitizeHtml() drops iframes;
// see its comment) since embedding arbitrary iframe/script markup from the
// shelter's page would be a real risk. Pulling out just the video id and
// handing back our own canonical watch URL is what makes a safe, direct
// link to it possible at all.
const YOUTUBE_ID_RE = /^[\w-]{11}$/;
const YOUTUBE_EMBED_ID_RE = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^"'\s]*&)?v=|v\/)|youtu\.be\/)([\w-]{11})/i;
function extractYouTubeUrl(html) {
  if (!html) return null;
  const m = YOUTUBE_EMBED_ID_RE.exec(html);
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}
function dogVideoUrl(detail) {
  if (!detail) return null;
  if (YOUTUBE_ID_RE.test(detail.youTubeVideoId || '')) {
    return `https://www.youtube.com/watch?v=${detail.youTubeVideoId}`;
  }
  return extractYouTubeUrl(detail.summary);
}

async function fetchDogDetailAndPhoto(id) {
  let detail = null;
  let photoUrl = null;
  try {
    detail = await fetchJson(`${BASE}/api/animals/adopt/${id}`, {}, 2);
  } catch (err) {
    console.warn(`[scraper] failed to fetch detail for ${id}:`, err.message);
  }
  try {
    const photos = await fetchJson(`${BASE}/api/photos/${id}`, {}, 2);
    const largeList = photos.large || [];
    if (largeList.length > 0) {
      photoUrl = resolvePhotoUrl(largeList[0]);
    }
  } catch (err) {
    console.warn(`[scraper] failed to fetch photos for ${id}:`, err.message);
  }
  return { detail, photoUrl };
}

const upsertDog = db.prepare(`
INSERT INTO dogs (
  shelter_buddy_id, name, species, sex, age, breed, weight, desexed, location,
  date_in_shelter, summary, tags, photo_url, video_url, still_listed, first_seen_at, last_seen_at, removed_at
) VALUES (
  @id, @name, @species, @sex, @age, @breed, @weight, @desexed, @location,
  @dateInShelter, @summary, @tags, @photoUrl, @videoUrl, 1, @now, @now, NULL
)
ON CONFLICT(shelter_buddy_id) DO UPDATE SET
  name = excluded.name,
  species = excluded.species,
  sex = excluded.sex,
  age = excluded.age,
  -- Fields that only come from the per-dog detail call keep their last good
  -- value when that call failed this run (hasDetail = 0), instead of being
  -- overwritten with NULL / an empty tag list -- which would, for example,
  -- silently clear a dog's "pending adoption" flag until the next scrape.
  breed = CASE WHEN @hasDetail = 1 THEN excluded.breed ELSE dogs.breed END,
  weight = CASE WHEN @hasDetail = 1 THEN excluded.weight ELSE dogs.weight END,
  desexed = CASE WHEN @hasDetail = 1 THEN excluded.desexed ELSE dogs.desexed END,
  location = CASE WHEN @hasDetail = 1 THEN excluded.location ELSE dogs.location END,
  date_in_shelter = COALESCE(excluded.date_in_shelter, dogs.date_in_shelter),
  summary = CASE WHEN @hasDetail = 1 THEN excluded.summary ELSE dogs.summary END,
  tags = CASE WHEN @hasDetail = 1 THEN excluded.tags ELSE dogs.tags END,
  video_url = CASE WHEN @hasDetail = 1 THEN excluded.video_url ELSE dogs.video_url END,
  photo_url = COALESCE(excluded.photo_url, dogs.photo_url),
  still_listed = 1,
  awaiting_listing = 0,
  missed_scrapes = 0,
  last_seen_at = excluded.last_seen_at,
  removed_at = NULL
`);

const delistDog = db.prepare('UPDATE dogs SET still_listed = 0, removed_at = ?, missed_scrapes = 0 WHERE shelter_buddy_id = ?');
const bumpMissed = db.prepare('UPDATE dogs SET missed_scrapes = missed_scrapes + 1 WHERE shelter_buddy_id = ?');
const startRun = db.prepare('INSERT INTO scrape_runs (started_at) VALUES (?)');
const finishRun = db.prepare('UPDATE scrape_runs SET finished_at = ?, ok = ?, dog_count = ?, note = ? WHERE id = ?');

const getDogRow = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?');
const setPreviousNames = db.prepare('UPDATE dogs SET previous_names = ? WHERE shelter_buddy_id = ?');
const getStillListed = db.prepare('SELECT shelter_buddy_id AS id, name, species, missed_scrapes AS missed FROM dogs WHERE still_listed = 1');
const addPreviousDays = db.prepare('UPDATE dogs SET previous_days_in_shelter = previous_days_in_shelter + ? WHERE shelter_buddy_id = ?');
// Was the stay that just ended actually an adoption, or a plain delisting
// (the scraper never logs an event for that case -- see the comment where
// a dog is delisted below)? Tells "returned after being adopted" (someone
// adopted them and it didn't work out) apart from "back on the adoption
// floor" (never left shelter care -- pulled for vet work, a hold, a data
// hiccup) when they reappear. Same 'returned' event kind either way, so
// every existing filter/preference/icon still applies to both; only the
// wording (and detail column) differs.
const wasAdoptedDuringStay = db.prepare(
  "SELECT 1 FROM shelter_events WHERE dog_id = ? AND kind = 'adopted' AND occurred_at >= ? AND occurred_at <= ? LIMIT 1"
);
// A dog coming back after a long gap is treated as a fresh start, not a
// continuation -- their behavior markers were set by whoever last walked
// them, months ago, and are stale rather than helpful by now; their old
// stay shouldn't shorten how long a new volunteer has to wait to walk them,
// either. RETURN_STALE_MONTHS matches the stay-history popup's own window
// (see server.js), so "more than 6 months ago" means the same thing in both
// places.
const RETURN_STALE_MONTHS = 6;
const resetStaleBehaviorMarkers = db.prepare(
  "UPDATE dogs SET blue_markers = '[]', poo_status = 'none', star_flag = 0, pb_flag = 0 WHERE shelter_buddy_id = ?"
);
function monthsAgo(months, from) {
  const d = new Date(from);
  d.setMonth(d.getMonth() - months);
  return d;
}
const insertEvent = db.prepare(
  'INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES (?, ?, ?, ?, ?)'
);
// Everyone who's ever completed a walk with this dog -- used to (a) decide
// who might want a push about their adoption and (b) nothing else; walk
// history itself is untouched by any of this.
const getWalkersForDog = db.prepare(
  'SELECT DISTINCT user_id FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL AND user_id IS NOT NULL'
);

// Walkers who've hearted this dog (see favorite_dogs in db.js).
const getFavoritersForDog = db.prepare('SELECT user_id FROM favorite_dogs WHERE dog_id = ?');
// Same tag server.js reads isPendingAdoption from.
const PENDING_ADOPTION_TAG = "I'm getting adopted!";
// Same tag server.js reads isStrayHold from.
const STRAY_HOLD_TAG = 'On Stray Hold';
const clearPbFlag = db.prepare("UPDATE dogs SET pb_flag = 0 WHERE shelter_buddy_id = ?");

function dogImageUrl(dogId) {
  return fs.existsSync(path.join(IMAGES_DIR, `${dogId}.jpg`)) ? `/cached-images/${dogId}.jpg` : undefined;
}

// A favorite_* push to everyone who hearted this dog and opted into that kind.
function pushToFavoriters(dogId, prefKey, payload) {
  for (const { user_id: userId } of getFavoritersForDog.all(dogId)) {
    if (hasPref(userId, prefKey)) sendPushToUser(userId, { url: '/', image: dogImageUrl(dogId), ...payload }).catch(() => {});
  }
}

function logEvent(kind, dogId, title, occurredAt, detail) {
  insertEvent.run(kind, dogId || null, title || null, detail || null, occurredAt || new Date().toISOString());
}

// How many days a just-ended stay lasted, for banking into
// previous_days_in_shelter before a returning dog's date_in_shelter gets
// overwritten by the upsert for their new stay.
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms > 0 ? Math.floor(ms / (1000 * 60 * 60 * 24)) : 0;
}

async function fetchAdoptedIds() {
  try {
    const json = await fetchJson(`${BASE}/api/animals/adopted?page=1&pagesize=300`);
    return new Set((json.data || []).map((d) => d.shelterBuddyId));
  } catch (err) {
    console.warn('[scraper] failed to fetch recently-adopted list:', err.message);
    return new Set();
  }
}

// A dog has to be absent from this many scrapes in a row (unless the shelter
// itself lists them as adopted) before we believe they're really gone.
const MISSES_BEFORE_DELIST = 2;
// A listing that shrinks by more than this fraction in one go is treated as a
// bad response, not a real mass adoption -- we'd rather skip a run than
// delist the whole shelter.
const MAX_PLAUSIBLE_DROP = 0.4;

async function runScrape() {
  const startedAt = new Date().toISOString();
  console.log(`[scraper] starting scrape at ${startedAt}`);
  const runId = startRun.run(startedAt).lastInsertRowid;
  const finish = (ok, count, note) => {
    try { finishRun.run(new Date().toISOString(), ok ? 1 : 0, count == null ? null : count, note || null, runId); } catch (e) { /* never let bookkeeping mask the real result */ }
  };
  try {
    return await doScrape(runId, finish);
  } catch (err) {
    console.error('[scraper] scrape crashed:', err);
    finish(false, null, `crashed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Fetches each species' listing and checks it on its own: a bad cat listing
// is skipped (cats keep their current data) while the dogs still refresh, and
// the other way round. Returns the usable lists and what went wrong.
async function fetchListings() {
  const previouslyListed = getStillListed.all();
  const lists = [];
  const problems = [];
  for (const kind of SPECIES_KEYS) {
    const plural = SPECIES[kind].plural.toLowerCase();
    let items;
    try {
      items = await fetchAnimalList(SPECIES[kind].listing);
    } catch (err) {
      console.error(`[scraper] failed to fetch the ${kind} list, keeping current ${plural}:`, err.message);
      problems.push(`${kind} list fetch failed: ${err.message}`);
      continue;
    }
    const before = previouslyListed.filter((d) => d.species === kind).length;
    if (items.length === 0 && before > 0) {
      console.error(`[scraper] shelter returned an EMPTY ${kind} listing; ignoring it and keeping current data`);
      problems.push(`empty ${kind} listing ignored`);
      continue;
    }
    if (before >= 20 && items.length < before * (1 - MAX_PLAUSIBLE_DROP)) {
      const msg = `${kind} listing dropped from ${before} to ${items.length} ${plural}; treating as a bad response`;
      console.error(`[scraper] ${msg} -- ignoring it`);
      problems.push(msg);
      continue;
    }
    lists.push({ kind, items });
  }
  return { lists, problems };
}

async function doScrape(runId, finish) {
  const { lists, problems } = await fetchListings();
  if (!lists.length) {
    const error = problems.join('; ');
    finish(false, null, error);
    return { ok: false, error };
  }
  const list = lists.flatMap(({ kind, items }) => items.map((item) => ({ ...item, listKind: kind })));
  const refreshedKinds = new Set(lists.map((l) => l.kind));

  const adoptedIds = await fetchAdoptedIds();
  const now = new Date().toISOString();
  const seenIds = [];
  const seenKinds = new Map(); // id -> species, for the per-species counts
  let detailFailures = 0;
  let skippedUnnamed = 0;
  let dogFailures = 0;

  for (const item of list) {
    const id = item.shelterBuddyId;
    if (id == null) continue;
    const existing = getDogRow.get(id);
    const { detail, photoUrl } = await fetchDogDetailAndPhoto(id);
    // Brand-new intakes can be listed before the shelter names them
    // ("name": null). A dog we already have keeps its last name; a new one
    // waits for its name and is added on the first scrape that has it.
    const name = item.name || (detail && detail.name) || (existing && existing.name) || null;
    if (!name) {
      skippedUnnamed += 1;
      continue;
    }
    seenIds.push(id);
    if (!detail) detailFailures += 1;
    const tags = detail && detail.tags ? JSON.stringify(detail.tags) : JSON.stringify([]);
    const kind = speciesFromTags(detail && detail.tags, item.listKind);
    seenKinds.set(id, kind);

    // One dog's bad data must never abort the whole run (and freeze every
    // other dog's data): log it, keep the dog listed as-is, move on.
    try {
      upsertDog.run({
        id,
        name,
        species: kind,
        sex: item.sex || (detail && detail.sex) || null,
        age: item.age || (detail && detail.age) || null,
        breed: (detail && detail.primaryBreed) || null,
        weight: (detail && detail.weight) || null,
        desexed: (detail && detail.desexed) || null,
        location: (detail && detail.location) || null,
        dateInShelter: item.dateInShelter || (detail && detail.dateInShelter) || null,
        summary: (detail && detail.summary) || null,
        tags,
        photoUrl,
        videoUrl: dogVideoUrl(detail),
        hasDetail: detail ? 1 : 0,
        now
      });
      // Renamed by the shelter: keep the old name so the app can show
      // "aka <old name>" and still find them by it (see dogNames.js).
      if (existing && !existing.awaiting_listing && isRename(existing.name, name)) {
        setPreviousNames.run(withPreviousName(existing.previous_names, existing.name, name), id);
      }
      // Eager, not deferred to whenever someone first views this dog -- and
      // now that upsertDog has run, do it before anything else can fail this
      // iteration, so a dog never sits without an attempted photo.
      // Shelter staff replace a dog's photo over time (the intake photo is
      // usually a poor one); the shelter gives that new photo its own URL,
      // so a change here means re-downloading over the stale cached file.
      const photoChanged = !!(existing && existing.photo_url && photoUrl && existing.photo_url !== photoUrl);
      await cacheImageIfNeeded(id, photoUrl, photoChanged);

      // A stand-in from a kennel card scanned before the listing had the dog
      // (awaiting_listing) is a new arrival too, not a return -- its walks were
      // already filed under this ID, so they're now on the real dog.
      if (!existing || existing.awaiting_listing) {
        logEvent('new_dog', id, `${name} was added to the shelter's listing`, now);
      } else if (existing.still_listed) {
        // Someone just started adopting a favorite: worth a heads-up while
        // there's still time to visit. Only on a fresh detail fetch, since a
        // failed one keeps the old tags (see upsertDog). Both directions are
        // logged (not just the push) so the dog's timeline can show a pending
        // adoption that fell through, not just ones that stuck.
        const existingTags = JSON.parse(existing.tags || '[]');
        const wasPending = existingTags.includes(PENDING_ADOPTION_TAG);
        const isPending = !!(detail && (detail.tags || []).includes(PENDING_ADOPTION_TAG));
        if (detail && !wasPending && isPending) {
          logEvent('pending_adoption', id, `${name}'s adoption went pending`, now);
          pushToFavoriters(id, 'favorite_pending', {
            title: `Someone is adopting ${name}`,
            body: 'One of your favorites may be going home soon.'
          });
        } else if (detail && wasPending && !isPending) {
          logEvent('pending_canceled', id, `${name}'s pending adoption fell through`, now);
        }
        // PB exists specifically to let a dog on stray hold go out anyway
        // for a short bathroom walk (see dogEligibility in server.js). Once
        // the hold itself is lifted the sticker has nothing left to
        // override, so it's cleared automatically instead of sitting there
        // as a stale PB badge someone has to remember to take off -- logged
        // the same way a manual toggle is, so the timeline shows why it
        // changed.
        if (detail && existingTags.includes(STRAY_HOLD_TAG) && !(detail.tags || []).includes(STRAY_HOLD_TAG) && existing.pb_flag) {
          clearPbFlag.run(id);
          logEvent('sticker_auto_off', id, 'PB: Potty break OK', now, 'pb');
        }
      } else {
        // Returning dog: bank their just-ended stay's length before
        // date_in_shelter above gets overwritten with their new stay's start
        // -- but only if they haven't been gone so long that stay no longer
        // says anything useful about them today (see RETURN_STALE_MONTHS).
        const leftAt = existing.removed_at || existing.last_seen_at;
        if (leftAt && new Date(leftAt) >= monthsAgo(RETURN_STALE_MONTHS, now)) {
          const priorStayDays = daysBetween(existing.date_in_shelter, leftAt);
          if (priorStayDays > 0) addPreviousDays.run(priorStayDays, id);
        } else {
          resetStaleBehaviorMarkers.run(id);
        }
        const adopted = leftAt && wasAdoptedDuringStay.get(id, existing.date_in_shelter, leftAt);
        // leftAt is also when the adoption itself happened (removed_at is set
        // at the same moment logEvent('adopted', ...) fires), so the gap to
        // now is how long they were actually out before coming back.
        const daysSinceLeft = leftAt ? daysBetween(leftAt, now) : 0;
        logEvent(
          'returned', id,
          adopted
            ? `${name} was returned to the shelter after being adopted (${daysSinceLeft} day${daysSinceLeft === 1 ? '' : 's'})`
            : `${name} is back on the adoption floor`,
          now,
          adopted ? 'adopted_return' : 'floor_return'
        );
        pushToFavoriters(id, 'favorite_returned', {
          title: `${name} is back at the shelter`,
          body: 'One of your favorites has returned.'
        });
      }
    } catch (err) {
      dogFailures += 1;
      console.error(`[scraper] couldn't save dog ${id}, skipping it this run:`, err.message);
    }

    await sleep(250);
  }

  // Anything that was listed a moment ago but isn't in this scrape: adopted
  // (confirmed by the shelter's own adopted list) leaves immediately;
  // anything else has to be missing MISSES_BEFORE_DELIST scrapes in a row.
  // Classified BEFORE delisting -- needs the still-listed rows to exist.
  const seenSet = new Set(seenIds);
  const pushes = [];
  db.transaction(() => {
    for (const dog of getStillListed.all()) {
      if (seenSet.has(dog.id)) continue;
      // A species whose listing was skipped this run keeps everyone listed.
      if (!refreshedKinds.has(dog.species)) continue;
      if (adoptedIds.has(dog.id)) {
        logEvent('adopted', dog.id, `${dog.name} was adopted!`, now);
        delistDog.run(now, dog.id);
        // One push per person, even for a favorite they've also walked.
        const favoriters = new Set(getFavoritersForDog.all(dog.id)
          .map((r) => r.user_id).filter((userId) => hasPref(userId, 'favorite_adopted')));
        favoriters.forEach((userId) => pushes.push({ userId, dog, favorite: true }));
        for (const { user_id: userId } of getWalkersForDog.all(dog.id)) {
          if (!favoriters.has(userId) && hasPref(userId, 'adopted_walked_dog')) pushes.push({ userId, dog });
        }
      } else if (dog.missed + 1 >= MISSES_BEFORE_DELIST) {
        // A plain removal (transferred, returned to owner, record
        // correction, etc.) isn't happy news and isn't actionable for a
        // walker the way a new/returned/adopted dog is, so the server's
        // /api/updates deliberately filters 'removed' events back out
        // (`WHERE kind != 'removed'`) -- it never shows in the Updates
        // feed or triggers a notification. But it still has to be LOGGED,
        // not skipped outright: the dog's timeline (GET
        // /api/dogs/:id/stay-history, shown by app.js's showStayLogPopup)
        // just lists every event in order, so a stay that ended in a plain
        // removal needs its own entry here or that stay would appear to
        // never end. Skipping the write here was an earlier bug's actual
        // cause, diagnosed 2026-09-23.
        logEvent('removed', dog.id, null, now);
        delistDog.run(now, dog.id);
      } else {
        bumpMissed.run(dog.id);
      }
    }
  })();
  // Pushes go out after the transaction commits, never from inside it.
  for (const { userId, dog, favorite } of pushes) {
    sendPushToUser(userId, {
      title: `${dog.name} was adopted! 🎉`,
      body: favorite ? 'One of your favorites found a home.' : (dog.species === 'cat' ? 'A cat you spent time with found a home.' : 'A dog you walked found a home.'),
      url: '/',
      // Shown in the notification (the service worker fetches it).
      image: dogImageUrl(dog.id)
    }).catch(() => {});
  }

  const counts = Object.fromEntries(SPECIES_KEYS.map((k) => [k, 0]));
  for (const k of seenKinds.values()) counts[k] = (counts[k] || 0) + 1;
  const note = [
    ...problems,
    detailFailures && `${detailFailures} dog detail fetches failed (kept previous data)`,
    skippedUnnamed && `${skippedUnnamed} new listing(s) without a name yet, skipped`,
    dogFailures && `${dogFailures} dog(s) couldn't be saved, skipped`
  ].filter(Boolean).join('; ') || null;
  const countText = SPECIES_KEYS.map((k) => `${counts[k]} ${SPECIES[k].plural.toLowerCase()}`).join(', ');
  console.log(`[scraper] finished. ${countText} currently listed.${note ? ' ' + note : ''}`);
  // A skipped species listing still fails the run (the uptime check notices
  // if it keeps happening), even though everything else was refreshed.
  const ok = problems.length === 0;
  finish(ok, seenIds.length, note);
  try { shelterTrends.recordDailyCounts(db); } catch (e) { console.warn('[scraper] daily counts not saved:', e.message); }
  return { ok, count: seenIds.length, counts, error: ok ? undefined : problems.join('; '), finishedAt: new Date().toISOString() };
}

module.exports = { runScrape, IMAGES_DIR };
