const fs = require('fs');
const path = require('path');
const db = require('./db');
const { sendPushToUser, hasPref } = require('./push');

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
async function cacheImageIfNeeded(id, photoUrl, attempt = 1) {
  if (!photoUrl) return;
  const filePath = path.join(IMAGES_DIR, `${id}.jpg`);
  if (fs.existsSync(filePath)) return;
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
      return cacheImageIfNeeded(id, photoUrl, attempt + 1);
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

async function fetchDogList() {
  const body = {
    pageNumber: 1,
    pageSize: 500,
    shelterBuddyId: '',
    species: 'Dog',
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
  shelter_buddy_id, name, sex, age, breed, weight, desexed, location,
  date_in_shelter, summary, tags, photo_url, still_listed, first_seen_at, last_seen_at, removed_at
) VALUES (
  @id, @name, @sex, @age, @breed, @weight, @desexed, @location,
  @dateInShelter, @summary, @tags, @photoUrl, 1, @now, @now, NULL
)
ON CONFLICT(shelter_buddy_id) DO UPDATE SET
  name = excluded.name,
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
  photo_url = COALESCE(excluded.photo_url, dogs.photo_url),
  still_listed = 1,
  missed_scrapes = 0,
  last_seen_at = excluded.last_seen_at,
  removed_at = NULL
`);

const delistDog = db.prepare('UPDATE dogs SET still_listed = 0, removed_at = ?, missed_scrapes = 0 WHERE shelter_buddy_id = ?');
const bumpMissed = db.prepare('UPDATE dogs SET missed_scrapes = missed_scrapes + 1 WHERE shelter_buddy_id = ?');
const startRun = db.prepare('INSERT INTO scrape_runs (started_at) VALUES (?)');
const finishRun = db.prepare('UPDATE scrape_runs SET finished_at = ?, ok = ?, dog_count = ?, note = ? WHERE id = ?');

const getDogRow = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?');
const getStillListed = db.prepare('SELECT shelter_buddy_id AS id, name, missed_scrapes AS missed FROM dogs WHERE still_listed = 1');
const addPreviousDays = db.prepare('UPDATE dogs SET previous_days_in_shelter = previous_days_in_shelter + ? WHERE shelter_buddy_id = ?');
const insertEvent = db.prepare(
  'INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES (?, ?, ?, ?, ?)'
);
// Everyone who's ever completed a walk with this dog -- used to (a) decide
// who might want a push about their adoption and (b) nothing else; walk
// history itself is untouched by any of this.
const getWalkersForDog = db.prepare(
  'SELECT DISTINCT user_id FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL AND user_id IS NOT NULL'
);

function logEvent(kind, dogId, title, occurredAt) {
  insertEvent.run(kind, dogId || null, title || null, null, occurredAt || new Date().toISOString());
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

async function doScrape(runId, finish) {
  let list;
  try {
    list = await fetchDogList();
  } catch (err) {
    console.error('[scraper] failed to fetch dog list, aborting this run:', err.message);
    finish(false, null, `list fetch failed: ${err.message}`);
    return { ok: false, error: err.message };
  }

  const previouslyListed = getStillListed.all();
  if (list.length === 0 && previouslyListed.length > 0) {
    console.error('[scraper] shelter returned an EMPTY listing; ignoring it and keeping current data');
    finish(false, 0, 'empty listing ignored');
    return { ok: false, error: 'empty listing' };
  }
  if (previouslyListed.length >= 20 && list.length < previouslyListed.length * (1 - MAX_PLAUSIBLE_DROP)) {
    const msg = `listing dropped from ${previouslyListed.length} to ${list.length} dogs; treating as a bad response`;
    console.error(`[scraper] ${msg} -- ignoring this run`);
    finish(false, list.length, msg);
    return { ok: false, error: msg };
  }

  const adoptedIds = await fetchAdoptedIds();
  const now = new Date().toISOString();
  const seenIds = [];
  let detailFailures = 0;

  for (const item of list) {
    const id = item.shelterBuddyId;
    if (id == null) continue;
    seenIds.push(id);
    const existing = getDogRow.get(id);
    const { detail, photoUrl } = await fetchDogDetailAndPhoto(id);
    if (!detail) detailFailures += 1;
    const tags = detail && detail.tags ? JSON.stringify(detail.tags) : JSON.stringify([]);

    upsertDog.run({
      id,
      name: item.name,
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
      hasDetail: detail ? 1 : 0,
      now
    });
    // Eager, not deferred to whenever someone first views this dog -- and
    // now that upsertDog has run, do it before anything else can fail this
    // iteration, so a dog never sits without an attempted photo.
    await cacheImageIfNeeded(id, photoUrl);

    if (!existing) {
      logEvent('new_dog', id, `${item.name} was added to the shelter's listing`, now);
    } else if (!existing.still_listed) {
      // Returning dog: bank their just-ended stay's length before
      // date_in_shelter above gets overwritten with their new stay's start.
      const priorStayDays = daysBetween(existing.date_in_shelter, existing.removed_at || existing.last_seen_at);
      if (priorStayDays > 0) addPreviousDays.run(priorStayDays, id);
      logEvent('returned', id, `${item.name} is back at the shelter`, now);
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
      if (adoptedIds.has(dog.id)) {
        logEvent('adopted', dog.id, `${dog.name} was adopted!`, now);
        delistDog.run(now, dog.id);
        for (const { user_id: userId } of getWalkersForDog.all(dog.id)) {
          if (hasPref(userId, 'adopted_walked_dog')) pushes.push({ userId, dog });
        }
      } else if (dog.missed + 1 >= MISSES_BEFORE_DELIST) {
        // A plain removal (transferred, returned to owner, record correction,
        // etc.) isn't happy news and isn't actionable for a walker the way a
        // new/returned/adopted dog is -- deliberately not logged as an event,
        // so it never shows in the Updates feed or triggers a notification.
        delistDog.run(now, dog.id);
      } else {
        bumpMissed.run(dog.id);
      }
    }
  })();
  // Pushes go out after the transaction commits, never from inside it.
  for (const { userId, dog } of pushes) {
    sendPushToUser(userId, {
      title: `${dog.name} was adopted! 🎉`,
      body: 'A dog you walked found a home.',
      url: '/'
    }).catch(() => {});
  }

  const note = detailFailures ? `${detailFailures} dog detail fetches failed (kept previous data)` : null;
  console.log(`[scraper] finished. ${seenIds.length} dogs currently listed.${note ? ' ' + note : ''}`);
  finish(true, seenIds.length, note);
  return { ok: true, count: seenIds.length, finishedAt: new Date().toISOString() };
}

module.exports = { runScrape, IMAGES_DIR };
