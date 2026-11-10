const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const db = require('./db');
const { runScrape, IMAGES_DIR } = require('./scraper');
const { dogSilhouetteSvg, catSilhouetteSvg, silhouetteUrl } = require('./silhouette');
const push = require('./push');
const wiki = require('./wiki');
const impact = require('./impact');
const shelterTrends = require('./shelterTrends');
const staffDashboard = require('./staffDashboard');
const shelterSchedule = require('./shelterSchedule');
const notes = require('./notes');
const noteTags = require('./noteTags');
const statsBreakdown = require('./statsBreakdown');
const playgroupNotes = require('./playgroupNotes');
const desktopViews = require('./desktopViews');
const feedback = require('./feedback');
const account = require('./account');
const species = require('./species');
const modulesCore = require('./modules');
// Every walk notice (started, length alerts, time warning, auto-stopped) shares this tag,
// so each one replaces the last on the phone rather than piling up.
const WALK_PUSH_TAG = 'walk';
const { hashEmail } = require('./emailHash');
const walkHours = require('./walkHours');

const PORT = process.env.PORT || 3000;
// Production needs the shared secret for the auth service's calls (account
// lookups, permission changes); without it those quietly stop working, so
// refuse to start instead. EMAIL_HASH_PEPPER gets the same check in emailHash.js.
if (process.env.NODE_ENV === 'production' && !process.env.INTERNAL_API_TOKEN) {
  throw new Error('[server] INTERNAL_API_TOKEN is not set. Refusing to start in production without it.');
}
// The example .env's placeholder is public, so it's as good as no token.
if (process.env.NODE_ENV === 'production' && process.env.INTERNAL_API_TOKEN.trim() === 'change-me') {
  throw new Error("[server] INTERNAL_API_TOKEN is still the example value 'change-me'. Set a real secret before starting in production.");
}
const crypto = require('crypto');
const app = express();
app.disable('x-powered-by');

// Content-Security-Policy: the browser refuses to run any script that isn't
// one of our own files (no inline scripts, no eval, no third-party hosts), so
// even if an attacker ever managed to get markup into a page, it couldn't
// execute or phone home. Inline *styles* are still allowed (the UI uses
// style attributes throughout). Dog photos may fall back to the shelter's own
// image host for a dog that hasn't been cached yet.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://pets.wake.gov",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  next();
});
app.use(express.json({ limit: '200kb' }));

// Personal answers (your account, your walks, stats and notes, anything that
// carries a private note or marks what's yours) are never stored: not by the
// browser, and not by the service worker's offline copy (sw.js skips any
// no-store response), so a shared shelter phone can't show one volunteer's
// data to the next. Shared shelter data (the dog list, updates, the Guide)
// still works offline.
const PERSONAL_API = [
  /^\/api\/me(?:\/|$)/,
  /^\/api\/users\//,
  /^\/api\/notes(?:\/|$)/,
  /^\/api\/dogs\/[^/]+\/?$/, // one dog: comes with your private note
  /^\/api\/dogs\/[^/]+\/(?:notes|walk-history|walk-stats|playgroup-notes)\/?$/,
  /^\/api\/playgroup-notes(?:\/|$)/,
  /^\/api\/walks(?:\/|$)/,
  /^\/api\/stats(?:\/|$)/,
  /^\/api\/impact(?:\/|$)/,
  /^\/api\/feedback(?:\/|$)/,
  /^\/api\/staff\//,
  /^\/api\/modules\/walker-chat\//
];
app.use('/api', (req, res, next) => {
  const p = req.originalUrl.split('?')[0].replace(/\/{2,}/g, '/');
  if (PERSONAL_API.some((re) => re.test(p))) res.set('Cache-Control', 'no-store');
  next();
});

// Last-resort safety nets. An unhandled rejection is logged and survived (a
// stray failed background task must not take the app down mid-walk); a true
// uncaught exception leaves the process in an unknown state, so log it and
// exit -- systemd restarts us within seconds.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception, exiting for a clean restart:', err);
  process.exit(1);
});

// The ?v= on every script and stylesheet: a hash of the files themselves
// (public/ and every module's public/), so it changes exactly when a deploy
// changes something, and a plain restart keeps every phone's cache. Assets
// requested with the current ?v= are cached for a year (see below).
function contentVersion(dirs) {
  const hash = require('crypto').createHash('sha256');
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) hash.update(path.relative(path.join(__dirname, '..'), full)).update('\0').update(fs.readFileSync(full));
    }
  };
  dirs.forEach(walk);
  return hash.digest('hex').slice(0, 12);
}
const MODULES_DIR = path.join(__dirname, '..', 'modules');
const ASSET_VERSION = contentVersion([
  path.join(__dirname, '..', 'public'),
  ...(fs.existsSync(MODULES_DIR) ? fs.readdirSync(MODULES_DIR).map((m) => path.join(MODULES_DIR, m, 'public')) : [])
]);
// Adds ?v= to every local /js/ and /css/ file a page loads, so none can be
// left one deploy behind (theme-init.js, staff-settings.js, ...).
const withAssetVersions = (html) => html
  .replace('__BUILD__', ASSET_VERSION)
  .replace(/(src|href)="(\/(?:js|css)\/[^"?#]+\.(?:js|css))"/g, `$1="$2?v=${ASSET_VERSION}"`);
// A file asked for with this build's ?v= can never change under that URL, so
// browsers keep it for a year without asking again. Any other ?v= (a page
// from an older build) is served fresh but not cached for long.
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && req.query && req.query.v !== undefined
      && /^\/(?:js|css|modules)\//.test(req.path)) {
    res.set('Cache-Control', req.query.v === ASSET_VERSION ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  next();
});
// Every /api answer says which build is running, so a page left open from
// before a deploy notices and reloads (or asks to, mid-walk; app.js
// noticeServerBuild).
app.use('/api', (req, res, next) => {
  res.set('X-App-Build', ASSET_VERSION);
  next();
});

// The module system (src/modules.js): optional features that live under
// app/modules/<id>/ instead of core. Discovered once at startup; which ones
// are *enabled* is read live from `moduleState` everywhere below, not baked
// in here, so a toggle in the Settings tab takes effect immediately.
const discoveredModules = modulesCore.discoverModules(path.join(__dirname, '..', 'modules'));
const moduleState = modulesCore.loadModuleState(db, discoveredModules);
modulesCore.mountModuleStatics(app, discoveredModules);

// A test copy of the site sets STAGE_BANNER (e.g. "STAGE") so nobody mistakes
// it for the real one: a fixed strip on every page and a tab-title prefix.
const STAGE_BANNER = (process.env.STAGE_BANNER || '').replace(/[^\w .:-]/g, '').slice(0, 40);
function withStageBanner(html) {
  if (!STAGE_BANNER) return html;
  return html
    .replace('<title>', `<title>[${STAGE_BANNER}] `)
    .replace('<body>', '<body><div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;pointer-events:none;'
      + 'background:#b45309;color:#fff;font:700 11px/16px system-ui,sans-serif;text-align:center;letter-spacing:.08em">'
      + `${STAGE_BANNER} &middot; TEST DATA ONLY</div>`);
}

const INDEX_BASE = withAssetVersions(withStageBanner(fs
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')));

function sendIndex(req, res) {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  // The module tags are the one piece filled in per-request, not baked into
  // the const above at startup -- so enabling/disabling a module in the
  // Settings tab shows up on the very next load, no restart needed.
  res.type('html').send(INDEX_BASE.replace('<!-- MODULE_SCRIPTS -->', modulesCore.assetTagsHtml(discoveredModules, moduleState, ASSET_VERSION, 'index')));
}

// Opening the site itself on a computer lands on that person's start page
// (desktopViews.js): the volunteer app, the play group desk, or for staff
// the staff dashboard. Phones always get the app. /app and /scan are the app
// itself, never redirected, so every page's "Volunteer app" link works.
function sendRoot(req, res) {
  if (!desktopViews.isMobile(req)) {
    const isStaff = req.headers['x-auth-staff'] === '1';
    const user = resolveAuthedUser(req);
    const view = desktopViews.startView(user && user.desktopView, isStaff);
    if (view !== 'app') return res.redirect(desktopViews.pathFor(view));
  }
  sendIndex(req, res);
}

// Staff-only desktop dashboard: a separate standalone page from the mobile
// volunteer app above, reached from the desk page switcher (desk-nav.js) or
// a bookmark. Anyone else gets a small branded "staff only" page. The X-Auth-Staff
// check here is defense-in-depth only; the real gate is Caddy's forward_auth
// (see the X-Auth-Email/X-Auth-Staff comment above resolveAuthedUser below).
const STAFF_BASE = withAssetVersions(withStageBanner(fs
  .readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8')));

const STAFF_ONLY_HTML = withAssetVersions(fs.readFileSync(path.join(__dirname, '..', 'public', 'staff-only.html'), 'utf8'));

function sendStaff(req, res) {
  if (req.headers['x-auth-staff'] !== '1') return res.status(403).type('html').send(STAFF_ONLY_HTML);
  res.set('Cache-Control', 'no-cache, must-revalidate');
  const html = STAFF_BASE
    .replace('<!-- MODULE_STAFF_PANELS -->', modulesCore.staffPanelHtml(discoveredModules, moduleState, ASSET_VERSION))
    .replace('<!-- MODULE_SCRIPTS -->', modulesCore.assetTagsHtml(discoveredModules, moduleState, ASSET_VERSION, 'staff'));
  res.type('html').send(html);
}

// The raw page files behind /staff and /playgroup are never served as-is
// (that would skip /staff's staff-only check): their .html names go to the
// real routes.
app.use((req, res, next) => {
  let p = req.path;
  try { p = decodeURIComponent(p); } catch (err) { /* left as sent */ }
  const m = /^\/+(staff|playgroup)\.html$/i.exec(p);
  return m ? res.redirect(301, `/${m[1].toLowerCase()}`) : next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
// Drawn from the ID alone and versioned in its URL, so it can be cached for good.
app.get('/dog-silhouettes/:file', (req, res) => {
  const m = /^(cat-)?(\d{1,9})\.svg$/.exec(req.params.file);
  if (!m) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/svg+xml').send(m[1] ? catSilhouetteSvg(Number(m[2])) : dogSilhouetteSvg(Number(m[2])));
});
// Cached dog photos — survive a dog's listing disappearing after adoption.
// Photos only: the scraper's .lastmod/.tmp sidecars (and anything else that
// lands in the folder) are never served.
const CACHED_IMAGE_RE = /^\/(?:thumbs?\/)?\d{1,12}(?:[._-][a-z0-9]{1,16})?\.jpg$/i;
// Small list thumbnails (cards show photos at 52-76px; the cached originals
// are ~1024px, ~100 KB each), made from the cached photo the first time
// they're asked for and kept beside it in IMAGES_DIR/thumbs. Remade when the
// photo is newer than its thumbnail (the scraper replaced it).
const THUMB_PX = 160;
const thumbsDir = path.join(IMAGES_DIR, 'thumbs');
const thumbsInFlight = new Map();
let sharp = null;
try {
  sharp = require('sharp');
  // A small server: one image at a time, and no libvips cache held in memory.
  sharp.concurrency(1);
  sharp.cache(false);
} catch (err) {
  console.warn('[thumbs] sharp unavailable, list photos use the full image:', err.message);
}
function ensureThumb(id) {
  const src = path.join(IMAGES_DIR, `${id}.jpg`);
  const dest = path.join(thumbsDir, `${id}.jpg`);
  let srcStat;
  try { srcStat = fs.statSync(src); } catch (err) { return Promise.resolve(null); }
  try { if (fs.statSync(dest).mtimeMs >= srcStat.mtimeMs) return Promise.resolve(dest); } catch (err) { /* not made yet */ }
  if (!sharp) return Promise.resolve(src);
  if (thumbsInFlight.has(id)) return thumbsInFlight.get(id);
  const tmp = `${dest}.${process.pid}.tmp`;
  const job = fs.promises.mkdir(thumbsDir, { recursive: true })
    .then(() => sharp(src).rotate().resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'attention' }).jpeg({ quality: 72, mozjpeg: true }).toFile(tmp))
    .then(() => fs.promises.rename(tmp, dest))
    .then(() => dest)
    .catch((err) => {
      console.warn(`[thumbs] couldn't make a thumbnail for ${id}:`, err.message);
      fs.rm(tmp, { force: true }, () => {});
      return src;
    })
    .finally(() => thumbsInFlight.delete(id));
  thumbsInFlight.set(id, job);
  return job;
}
app.get(/^\/cached-images\/thumbs\/(\d{1,12})\.jpg$/, (req, res, next) => {
  ensureThumb(req.params[0]).then((file) => {
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=2592000');
    res.type('image/jpeg').sendFile(file, (err) => { if (err && !res.headersSent) next(err); });
  });
});
app.use('/cached-images', (req, res, next) => (CACHED_IMAGE_RE.test(req.path) ? next() : res.status(404).end()),
  express.static(IMAGES_DIR, { maxAge: '30d', dotfiles: 'deny' }));
app.get('/', sendRoot);
// Bookmarkable shortcut straight into the QR scanner -- deliberately not
// routed through sendRoot, so it always opens the scanner even for staff.
app.get('/scan', sendIndex);
app.get('/app', sendIndex);
app.get('/staff', sendStaff);
// The play group desk: a computer-sized page for typing up and exporting play
// group notes. Open to every walker, like the notes themselves.
const PLAYGROUP_BASE = withAssetVersions(withStageBanner(fs
  .readFileSync(path.join(__dirname, '..', 'public', 'playgroup.html'), 'utf8')));
app.get('/playgroup', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(PLAYGROUP_BASE.replace('<!-- MODULE_SCRIPTS -->', modulesCore.assetTagsHtml(discoveredModules, moduleState, ASSET_VERSION, 'playgroup')));
});

// `asOf` freezes the count at a specific moment (a delisted dog's
// removed_at) instead of always counting up to right now -- otherwise a
// dog's "days in shelter" would keep silently climbing forever after they
// were adopted and physically left, which makes no sense once they're gone.
function daysInShelter(dateInShelter, asOf) {
  if (!dateInShelter) return null;
  const then = new Date(dateInShelter).getTime();
  const now = asOf ? new Date(asOf).getTime() : Date.now();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

const MIN_WALK_AGE_MONTHS = 6;
// Shelter age strings look like "3 Years and 8 Months", "9 Months", or "8 Weeks".
function parseAgeMonths(ageStr) {
  if (!ageStr) return null;
  const yearsMatch = ageStr.match(/(\d+)\s*Years?/i);
  const monthsMatch = ageStr.match(/(\d+)\s*Months?/i);
  const weeksMatch = ageStr.match(/(\d+)\s*Weeks?/i);
  if (!yearsMatch && !monthsMatch && !weeksMatch) return null;
  const years = yearsMatch ? parseInt(yearsMatch[1], 10) : 0;
  const months = monthsMatch ? parseInt(monthsMatch[1], 10) : 0;
  const weeks = weeksMatch ? parseInt(weeksMatch[1], 10) : 0;
  return years * 12 + months + weeks / 4.345;
}

// Each volunteer picks (or is assigned) a named experience level — this
// bundles a day-in-shelter threshold together with blue-sticker/EVO/PB
// rules, replacing the old freeform per-user "minimum days" number.
// Dog data itself (markers, POO, location, walk counts/notes) stays shared —
// only this and personal stats are scoped per user.
// The shelter's own site flags a dog mid-adoption as "I'm getting adopted!"
// (see PENDING_ADOPTION_TAG below) -- beginners specifically shouldn't walk
// one (avoids the awkwardness/attachment of a dog that may leave any day),
// but it's fine for anyone more experienced.
const EXPERIENCE_LEVELS = {
  beginner: {
    label: 'Beginner',
    description: 'Less than 20 hours of volunteering',
    minDays: 15,
    allowBlue: false,
    allowEvo: false,
    allowPb: false,
    allowPending: false
  },
  established: {
    label: 'Established',
    description: '20 hours or more',
    minDays: 7,
    allowBlue: true,
    allowEvo: false,
    allowPb: true,
    allowPending: true
  },
  expert: {
    label: 'Experienced Volunteer',
    description: '1 year and 100 hours of service',
    minDays: 7,
    allowBlue: true,
    allowEvo: true,
    allowPb: true,
    allowPending: true
  }
};
// Exact flag name/string the shelter's own system (pets.wake.gov) uses in
// each dog's `tags` list for "someone has already started adopting them".
const PENDING_ADOPTION_TAG = "I'm getting adopted!";
// Dogs on stray hold can't be walked unless they're marked PB.
const STRAY_HOLD_TAG = 'On Stray Hold';
// The shelter's listing says where a foster dog is: not here.
const { FOSTER_LOCATION } = shelterTrends;
const DEFAULT_EXPERIENCE_LEVEL = 'beginner';

// A Beginner whose finished walks add up to 20 hours (the line between
// Beginner and Established) is offered the move up once, with balloons.
// Whether they say yes or not, they aren't asked again; Settings can still
// change the level any time.
const LEVEL_UP_HOURS = 20;
function levelUpOffer(userId) {
  const user = db.prepare('SELECT experience_level, level_up_offered_at FROM users WHERE id = ?').get(userId);
  if (!user || user.experience_level !== 'beginner' || user.level_up_offered_at) return false;
  // Only time with animals that have levels (dogs) counts: cat visits have
  // no skill levels or hour requirements.
  // Daycations don't count either: a dog out for the day is mostly time
  // away, not handling, and two of them would otherwise make 20 hours.
  // 20 hours exactly is enough ("20 hours or more", see EXPERIENCE_LEVELS).
  const levelKinds = species.SPECIES_KEYS.filter((k) => species.SPECIES[k].levelRules);
  const { seconds } = db.prepare(`
    SELECT COALESCE(SUM(w.duration_seconds), 0) AS seconds FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.user_id = ? AND w.ended_at IS NOT NULL AND w.activity != 'daycation'
      AND d.species IN (${levelKinds.map(() => '?').join(', ')})
  `).get(userId, ...levelKinds);
  return seconds >= LEVEL_UP_HOURS * 3600;
}

function resolveExperienceLevel(userId) {
  const id = parseInt(userId, 10);
  if (!id) return null;
  const user = db.prepare('SELECT experience_level FROM users WHERE id = ?').get(id);
  return (user && user.experience_level) || null;
}

// Kennel locations are just the wing letter (dogs A-E, cats A-D, see
// species.js) -- many animals share one, so there's no "one dog per spot"
// bumping any more. Accepts a full code or the kennel-card "Da12" quirk and
// keeps only the letter; anything that doesn't come down to one of the
// species' letters is null (caller decides whether that's an error).
const KENNEL_LETTERS = species.SPECIES.dog.kennels; // Audit Mode's wings
function kennelLetter(raw, kind) {
  const letters = species.speciesInfo(kind).kennels;
  let v = String(raw || '').trim().toUpperCase();
  if (/^D[A-E]\d/.test(v)) v = v.slice(1);
  return letters.includes(v[0]) ? v[0] : null;
}
const kennelLetterError = (kind) => {
  const letters = species.speciesInfo(kind).kennels;
  return `Pick a kennel letter, ${letters[0]} to ${letters[letters.length - 1]}.`;
};

function setKennelLocation(dogId, letter) {
  const dog = db.prepare('SELECT shelter_buddy_id, name FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  if (!dog) return null;
  db.prepare('UPDATE dogs SET kennel_location = ? WHERE shelter_buddy_id = ?').run(letter, dogId);
  return { location: letter, name: dog.name };
}

// No photo yet (not listed, or listed without one): the dog's own drawn
// silhouette (silhouette.js), so several such dogs still look different.
// The ?v= is the cached file's mtime: /cached-images is served with a 30-day
// max-age, so without it, a browser that already loaded a dog's old photo
// would keep showing it long after the shelter's new one replaced it on disk
// -- same URL, so no revalidation. Changing the file changes the mtime,
// which changes this URL, which busts that cache immediately.
// Cats without a photo get a cat silhouette.
const speciesOfStmt = db.prepare('SELECT species FROM dogs WHERE shelter_buddy_id = ?');
function cachedPhotoUrl(dogId, rawUrl) {
  const cachedPath = path.join(IMAGES_DIR, `${dogId}.jpg`);
  try {
    const v = Math.floor(fs.statSync(cachedPath).mtimeMs);
    return `/cached-images/${dogId}.jpg?v=${v}`;
  } catch (err) { /* not cached (yet) -- fall through */ }
  if (rawUrl) return rawUrl;
  const row = speciesOfStmt.get(dogId);
  return silhouetteUrl(dogId, row && row.species);
}

function resolvePhotoUrl(row) {
  return cachedPhotoUrl(row.shelter_buddy_id, row.photo_url);
}

// userName is deliberately computed here, not left to the client, so a
// volunteer who's turned on "hide my name while walking" (Privacy & Data)
// never has their real name leave the server for this dog at all. This is
// the ONLY thing that setting affects -- see the near-identical
// substitution in the walk-start "already out" check below, the other
// place a name could otherwise leak while a walk is in progress.
// Walk, cuddle, matchmaking, play group or daycation: all timed and counted
// the same way. A daycation (the dog out for the day) has its own time limit,
// see walkLimitMinutes below.
const ACTIVITIES = ['walk', 'cuddle', 'matchmaking', 'playgroup', 'daycation'];
// The activity sent in a request, 'walk' when none was sent, or null if it
// isn't one we know.
function activityFrom(value) {
  if (value === undefined || value === null || value === '') return 'walk';
  return ACTIVITIES.includes(value) ? value : null;
}
// The same, for one animal: only that species' activities count, and a
// request with none gets the species' first one (a cat's is a cuddle).
function activityForAnimal(value, row) {
  const allowed = species.speciesInfo(row && row.species).activities;
  if (value === undefined || value === null || value === '') return allowed[0];
  return allowed.includes(value) ? value : null;
}
const activityError = (row) => {
  const info = species.speciesInfo(row && row.species);
  return `A ${info.noun} can only have: ${info.activities.join(', ')}.`;
};

// Everything serializeDog needs from other tables, fetched with a handful of
// grouped queries for the whole list (or just one dog when dogId is given)
// instead of several queries per dog. The walker on a dog's current walk is
// never sent as an id, only `mine` (whether it's the asker's own walk), so
// "hide my name while walking" can't be undone by mapping an id to a name.
const RECENT_WALK_WINDOW_DAYS = 7;
const dogLookupStatements = new Map();
function dogLookupStatement(sql) {
  if (!dogLookupStatements.has(sql)) dogLookupStatements.set(sql, db.prepare(sql));
  return dogLookupStatements.get(sql);
}
function dogLookups(userId, todayKey, dogId = null) {
  const one = dogId != null ? ' AND w.dog_id = ?' : '';
  const oneParam = dogId != null ? [dogId] : [];
  const byDog = (rows) => new Map(rows.map((r) => [r.dog_id, r]));
  const recentSince = new Date(Date.now() - RECENT_WALK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const walkStats = byDog(dogLookupStatement(`
    SELECT w.dog_id, COUNT(*) AS count, MAX(w.started_at) AS last_started_at,
           SUM(CASE WHEN w.started_at >= ? THEN 1 ELSE 0 END) AS recent
    FROM walks w WHERE w.ended_at IS NOT NULL${one} GROUP BY w.dog_id
  `).all(recentSince, ...oneParam));
  const active = byDog(dogLookupStatement(`
    SELECT w.dog_id, w.user_id, w.started_at AS startedAt, w.activity,
           CASE WHEN u.hide_name_while_walking = 1 THEN 'a volunteer' ELSE u.name END AS userName
    FROM walks w JOIN users u ON u.id = w.user_id
    WHERE w.ended_at IS NULL${one} ORDER BY w.started_at DESC
  `).all(...oneParam).reverse());
  const mine = userId ? byDog(dogLookupStatement(`
    SELECT w.dog_id, COUNT(*) AS count, MAX(w.started_at) AS last_started_at
    FROM walks w WHERE w.user_id = ? AND w.ended_at IS NOT NULL${one} GROUP BY w.dog_id
  `).all(userId, ...oneParam)) : new Map();
  const favorites = userId
    ? new Set(dogLookupStatement('SELECT dog_id FROM favorite_dogs WHERE user_id = ?').all(userId).map((r) => r.dog_id))
    : new Set();
  const checkedOff = todayKey
    ? new Set(dogLookupStatement('SELECT dog_id FROM session_checkoffs WHERE date_key = ?').all(todayKey).map((r) => r.dog_id))
    : new Set();
  const warnings = new Map(); // species -> latest adult engagement today (kittens only)
  return {
    walkStats: (id) => walkStats.get(id) || { count: 0, last_started_at: null, recent: 0 },
    currentWalk: (id) => {
      const w = active.get(id);
      if (!w) return null;
      // The start time only on your own: polling someone else's with their
      // name would time their walks (and so their notes). No page shows how
      // long anyone else has been out.
      const mine = !!userId && w.user_id === userId;
      return mine ? { startedAt: w.startedAt, activity: w.activity, userName: w.userName, mine } : { activity: w.activity, userName: w.userName, mine };
    },
    myStats: (id) => mine.get(id) || { count: 0, last_started_at: null },
    isFavorite: (id) => favorites.has(id),
    checkedOffToday: (id) => checkedOff.has(id),
    handlingWarning: (row) => {
      if (!warnings.has(row.species)) warnings.set(row.species, { value: undefined });
      const memo = warnings.get(row.species);
      return handlingWarningFor(row, userId, memo);
    }
  };
}

// Disease control (species.js youngFirst): kittens may be handled before
// adult cats, never after. If this volunteer was with an adult cat during the
// last 16 hours (this shift, in practice), opening a kitten carries a warning
// naming that adult: { name, at, young, adult }. It never blocks anything.
const getLatestAdultToday = db.prepare(`
  SELECT d.name, d.tags, d.species, w.started_at AS at FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
  WHERE w.user_id = ? AND d.species = ? AND w.started_at >= ? ORDER BY w.started_at DESC
`);
// memo (optional, per request and species): the lookup is the same for every
// kitten in a list, so it runs once.
function handlingWarningFor(row, userId, memo) {
  const rule = species.speciesInfo(row.species).youngFirst;
  if (!rule || !userId || !species.isYoung(row)) return null;
  let adult = memo ? memo.value : undefined;
  if (adult === undefined) {
    const since = new Date(Date.now() - 16 * 3600000).toISOString(); // today's shift, roughly
    adult = getLatestAdultToday.all(userId, row.species, since).find((w) => !species.isYoung(w)) || null;
    if (memo) memo.value = adult;
  }
  return adult ? { name: adult.name, at: adult.at, young: rule.young, adult: rule.adult } : null;
}

// Precedence: too young (hard, no override) > EVO not allowed (hard, not
// even PB) > any blue marker not allowed (hard) > pending adoption not
// allowed (hard, beginners only) > stray hold (only PB dogs on stray hold
// can be walked, unless Alumni's stray-hold bypass is on -- see below) >
// PB (overrides the day threshold when this level permits PB dogs at
// all) > day threshold.
// Pulled out of serializeDog so /api/walks/start can enforce this exact
// rule too: a dog not cleared for a volunteer's level must not be walkable
// at all, not just flagged in the UI. One function means the badge shown
// before starting a walk and the hard rule enforced when starting it can
// never disagree.
function dogEligibility(row, experienceLevel) {
  const level = EXPERIENCE_LEVELS[experienceLevel] || EXPERIENCE_LEVELS[DEFAULT_EXPERIENCE_LEVEL];
  // A species without stickers shows none (its sticker columns are left as
  // they are, just not used), and one without level rules is open to everyone.
  const kind = species.speciesInfo(row.species);
  const ageMonths = parseAgeMonths(row.age);
  const ageMonthsHard = kind.levelRules && ageMonths != null && ageMonths < MIN_WALK_AGE_MONTHS;
  const blueMarkers = kind.stickers && row.blue_markers ? JSON.parse(row.blue_markers) : [];
  const hasEvo = blueMarkers.includes('blue_evo');
  const hasAnyBlue = blueMarkers.length > 0;
  const pbFlag = kind.stickers && !!row.pb_flag;
  const tags = row.tags ? JSON.parse(row.tags) : [];
  const isPendingAdoption = tags.includes(PENDING_ADOPTION_TAG);
  const isStrayHold = tags.includes(STRAY_HOLD_TAG);
  const days = daysInShelter(row.date_in_shelter, row.still_listed ? null : row.removed_at);
  // Alumni (manual, capped 1-15) and previous_days_in_shelter (automatic,
  // uncapped, banked by the scraper on a detected return) both add on top
  // of actual current-stay days -- different mechanisms answering different
  // questions, see the previous_days_in_shelter migration note in db.js.
  const effectiveDays = days != null
    ? days + (row.alumni_flag ? (row.alumni_bonus_days || 0) : 0) + (row.previous_days_in_shelter || 0)
    : days;

  let eligible;
  let notEligibleReason = null;
  if (!kind.levelRules) {
    eligible = true;
  } else if (ageMonthsHard) {
    eligible = false;
    notEligibleReason = 'too_young';
  } else if (hasEvo && !level.allowEvo) {
    eligible = false;
    notEligibleReason = 'evo_restricted';
  } else if (hasAnyBlue && !level.allowBlue) {
    eligible = false;
    notEligibleReason = 'blue_restricted';
  } else if (isPendingAdoption && !level.allowPending) {
    eligible = false;
    notEligibleReason = 'pending_restricted';
    // The stray-hold tag mirrors the shelter's own site -- it stays in
    // force regardless of Alumni's bonus days. Only Alumni's separate
    // stray-hold bypass (its own privileged-only toggle) lifts this.
  } else if (isStrayHold && !pbFlag && !row.alumni_bypass_stray_hold) {
    eligible = false;
    notEligibleReason = 'stray_hold';
  } else if (pbFlag) {
    eligible = level.allowPb;
    notEligibleReason = eligible ? null : 'pb_restricted';
  } else {
    eligible = effectiveDays != null ? effectiveDays >= level.minDays : null;
    notEligibleReason = eligible ? null : 'days';
  }
  // Listed as in foster care: not at the shelter, so not one to pick from
  // the list. Checked last, so any level rule that also applies is the one
  // shown (and still enforced). Starting one isn't refused (see
  // /api/walks/start): a scanned kennel card means the animal is here and
  // the listing is behind; the app asks the walker to check the card.
  if (row.location === FOSTER_LOCATION && eligible !== false) {
    eligible = false;
    notEligibleReason = 'in_foster';
  }

  return {
    eligible, notEligibleReason, level, kind, ageMonthsHard, blueMarkers, hasEvo, hasAnyBlue,
    pbFlag, tags, isPendingAdoption, isStrayHold, days, effectiveDays
  };
}

// lookups: dogLookups() for the request (a list passes one for all its dogs);
// left out, it's built for this one dog. withSummary: the shelter's long
// description HTML, only sent for a single dog (the list never shows it).
function serializeDog(row, experienceLevel, todayKey, userId, { lookups, withSummary = true } = {}) {
  const ageMonths = parseAgeMonths(row.age);
  const userIdInt = parseInt(userId, 10) || null;
  const look = lookups || dogLookups(userIdInt, todayKey, row.shelter_buddy_id);
  const walkStats = look.walkStats(row.shelter_buddy_id);
  // How much attention a dog has gotten lately (not lifetime) — surfaces
  // dogs that have quietly gone unwalked for a while even if their
  // lifetime walkCount looks fine.
  const recentWalkCount = walkStats.recent || 0;
  // A dog currently out on a walk counts as "walked" for filtering/sorting
  // purposes right away — no need to wait for the walk to end.
  const currentWalk = look.currentWalk(row.shelter_buddy_id);
  const myStats = look.myStats(row.shelter_buddy_id);
  const walkedByMe = myStats.count > 0;
  const isFavorite = look.isFavorite(row.shelter_buddy_id);

  const {
    eligible, notEligibleReason, level, kind, ageMonthsHard, blueMarkers,
    pbFlag, tags, isPendingAdoption, isStrayHold, days, effectiveDays
  } = dogEligibility(row, experienceLevel);

  return {
    id: row.shelter_buddy_id,
    name: row.name,
    species: species.validSpecies(row.species) ? row.species : species.DEFAULT_SPECIES,
    previousNames: JSON.parse(row.previous_names || '[]'),
    sex: row.sex,
    age: row.age,
    ageMonths,
    breed: row.breed,
    weight: row.weight,
    desexed: row.desexed,
    location: row.location,
    dateInShelter: row.date_in_shelter,
    daysInShelter: days,
    summary: withSummary ? row.summary : undefined,
    tags,
    photoUrl: resolvePhotoUrl(row),
    // A YouTube video from the dog's page on the shelter's own site, if they
    // have one (scraper.js) -- a direct link, since the iframe embed itself
    // is stripped out of `summary` for safety (see sanitizeHtml in app.js).
    videoUrl: row.video_url || null,
    stillListed: !!row.still_listed,
    awaitingListing: !!row.awaiting_listing,
    removedAt: row.removed_at || null,
    // Alumni (returned dog, privileged-only): two independent toggles, not
    // one bundled flag. Bonus days count toward eligibility on top of
    // actual time in shelter, without changing the real daysInShelter
    // figure shown elsewhere; the stray-hold bypass separately lifts that
    // block entirely (see dogEligibility). A dog can have either, neither,
    // or both.
    isAlumni: !!row.alumni_flag,
    alumniBonusDays: row.alumni_bonus_days || 0,
    alumniBypassStrayHold: !!row.alumni_bypass_stray_hold,
    // Automatic, uncapped credit from prior stay(s) -- set when the scraper
    // detects this dog has come back after being removed/adopted before.
    previousDaysInShelter: row.previous_days_in_shelter || 0,
    effectiveDaysInShelter: effectiveDays,
    eligible,
    // Why `eligible` is false, so the UI can give an accurate reason instead
    // of always assuming "needs more days": 'too_young' | 'evo_restricted' |
    // 'blue_restricted' | 'pending_restricted' | 'stray_hold' | 'pb_restricted' |
    // 'days' | null (when eligible).
    notEligibleReason,
    minDaysForLevel: kind.levelRules ? level.minDays : null,
    // Hard rule, no override: puppies under 6 months old can never be walked.
    tooYoung: ageMonthsHard,
    blueMarkers,
    pooStatus: (kind.stickers && row.poo_status) || 'none',
    starFlag: kind.stickers && !!row.star_flag,
    pbFlag,
    isPendingAdoption,
    isStrayHold,
    // A kitten (species.js youngFirst): shown on cards, and the handling-order
    // warning below is about it.
    isYoung: species.isYoung(row),
    handlingWarning: look.handlingWarning(row),
    kennelLocation: row.kennel_location || null,
    checkedOffToday: todayKey ? look.checkedOffToday(row.shelter_buddy_id) : false,
    walkCount: walkStats.count,
    // Shelter-wide, so only the day and walk window (see coarseWalkTime):
    // the exact time would time whoever walked them last.
    lastWalkedAt: coarseWalkTime(walkStats.last_started_at),
    recentWalkCount,
    currentWalk,
    walkedByMe,
    isFavorite,
    // This user's own walks with the dog, for the "walks together" lines on
    // the profile and scan screens (walkCount above is shelter-wide).
    myWalkCount: myStats.count,
    myLastWalkedAt: myStats.last_started_at,
    adoptUrl: `https://pets.wake.gov/adopt/${row.shelter_buddy_id}`
  };
}

// ---- Users ----
// Identity comes from shelterwalk.com's login, not a name picker: Caddy's
// forward_auth relays the signed-in account's email here as X-Auth-Email
// (see Caddyfile `copy_headers` and Django's forward_auth_check view). A
// walker is matched to that email, or created on their first visit.
//
// X-Auth-Email is a placeholder tied to the Django account
// (`user-{pk}@login.internal`, see account_placeholder_email() in the
// Django app's invites/email_hash.py), not a real address -- this app
// never has a real one to work with (see EMAIL_HASH_PEPPER below), it
// just needs something stable to hash consistently.
//
// Rolled back to this 2026-09-23, after trying (and reverting) a fully
// unlinkable, client-computed alternative the same day -- see git history
// around then for what that looked like and why it didn't hold up in
// practice for a two-person staging site (WebAuthn/PRF timing turned out
// to be too unreliable to depend on). This version is simpler and
// deterministic: anyone with both this app's pepper and Django's database
// COULD reconstruct which walker profile belongs to which login account
// -- that's a real, accepted tradeoff now, not an oversight.
const ME_COLUMNS = 'id, name, experience_level AS experienceLevel, is_privileged AS isPrivileged, can_audit AS canAudit, onboarding_completed AS onboardingCompleted, hide_name_while_walking AS hideNameWhileWalking, default_activity AS defaultActivity, species_pref AS speciesPref, desktop_view AS desktopView';

// Resolves (and if needed, creates or links) the walker profile for the
// trusted X-Auth-Email header. Returns null if the header is missing, e.g.
// a request that somehow reached this app without going through Caddy's
// forward_auth.
function resolveAuthedUser(req) {
  const email = (req.headers['x-auth-email'] || '').trim().toLowerCase();
  if (!email) return null;
  const emailHash = hashEmail(email);
  let row = db.prepare(`SELECT ${ME_COLUMNS} FROM users WHERE auth_email_hash = ?`).get(emailHash);
  if (!row) {
    // Someone who already had a walker profile from before logins existed
    // (matched by name, case-insensitively) can get THAT profile linked to
    // their account, rather than a duplicate. Only when LINK_ACCOUNTS_BY_NAME=1
    // is set (a one-time migration switch): otherwise anyone whose email
    // happens to start with an old profile's name could claim it, along with
    // any permissions it has.
    const localPart = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    const derivedName = localPart.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
    const unlinked = process.env.LINK_ACCOUNTS_BY_NAME === '1'
      ? db.prepare('SELECT id FROM users WHERE auth_email_hash IS NULL AND name = ? COLLATE NOCASE').get(derivedName)
      : null;
    if (unlinked) {
      db.prepare('UPDATE users SET auth_email_hash = ? WHERE id = ?').run(emailHash, unlinked.id);
      row = db.prepare(`SELECT ${ME_COLUMNS} FROM users WHERE id = ?`).get(unlinked.id);
    } else {
      let name = derivedName;
      for (let suffix = 2; db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE').get(name); suffix += 1) {
        name = `${derivedName} (${suffix})`;
      }
      // updates_last_seen_at starts at "now": a brand-new volunteer shouldn't
      // open the app to a "99+" badge and a wall of green "new" borders for
      // events that happened long before they joined.
      //
      // hide_name_while_walking starts ON for a genuinely brand-new account
      // (unlike the column's own DEFAULT 0, which only matters for accounts
      // that predate this setting and must stay exactly as they were) --
      // new volunteers make this choice explicitly on the onboarding privacy
      // step, but starting private-by-default means skipping that step, or
      // any other path that creates a user, still errs toward privacy.
      const nowIso = new Date().toISOString();
      const info = db.prepare(
        'INSERT INTO users (name, created_at, auth_email_hash, updates_last_seen_at, hide_name_while_walking) VALUES (?, ?, ?, ?, 1)'
      ).run(name, nowIso, emailHash, nowIso);
      row = {
        id: info.lastInsertRowid, name, experienceLevel: null, isPrivileged: false, canAudit: false,
        onboardingCompleted: false, hideNameWhileWalking: true, defaultActivity: 'walk',
        speciesPref: species.DEFAULT_SPECIES_PREF
      };
      notifyAdmins({ title: '👋 New account', body: `${name} just opened Shelter Walk for the first time.`, tag: `signup-${row.id}` });
    }
  }
  return {
    ...row, isPrivileged: !!row.isPrivileged, canAudit: !!row.canAudit,
    onboardingCompleted: !!row.onboardingCompleted, hideNameWhileWalking: !!row.hideNameWhileWalking
  };
}

// Admins (privileged accounts) hear when someone new joins, unless they
// turned new_signups off. Both notices for one person share a tag, so
// "finished setting up" replaces "new account" instead of stacking.
function notifyAdmins(payload) {
  const admins = db.prepare(`
    SELECT id FROM users u WHERE is_privileged = 1
      AND NOT EXISTS (SELECT 1 FROM notification_prefs p WHERE p.user_id = u.id AND p.pref_key = 'new_signups' AND p.enabled = 0)
  `).all();
  for (const { id } of admins) push.sendPushToUser(id, { url: '/', ...payload }).catch(() => {});
}

// ---- Who is asking: always the signed-in account, never a request field ----
// Every /api call is tied to the identity Caddy vouches for (X-Auth-Email).
// Any `userId` a page sends (query string or body) is overwritten with that
// identity, and /api/users/:id/... paths only work for your own id -- staff
// and privileged walkers included: no page anywhere (the app, the staff
// dashboard, the Feedback inbox, the play group desk) reads or changes
// another member's settings, prefs, filters or alerts, so nobody can. The
// one exception is /permissions, below. Without this, anyone signed in could
// read another volunteer's walks/stats/history just by changing a number in
// a request -- which is exactly the kind of individual-level visibility this
// app is designed never to allow.
const SELF_EXEMPT = new Set(['/api/client-error']);
function isStaffOrPrivileged(req, user) {
  return req.headers['x-auth-staff'] === '1' || !!(user && user.isPrivileged);
}
app.use('/api', (req, res, next) => {
  if (SELF_EXEMPT.has(req.originalUrl.split('?')[0])) return next();
  if (isInternalRequest(req)) return next(); // trusted service-to-service (Django staff panel)
  const me = resolveAuthedUser(req);
  if (!me) return res.status(401).json({ error: 'Not signed in.' });
  req.me = me;
  // Set even when the page sent none: endpoints treat a missing userId as
  // "everyone" (e.g. GET /api/walks), which would otherwise hand any signed-in
  // volunteer the full record of everyone's walks.
  if (req.query) req.query.userId = String(me.id);
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && req.body.userId !== undefined) req.body.userId = me.id;
  // Matched loosely on purpose (any case, repeated slashes, any id text), the
  // way Express's own routing matches, and then the id must be exactly this
  // account's id in plain digits: "4x", "4.0", "%204" or "/Users/4" can't
  // slip past. The per-route check in app.param('id') below repeats this.
  const m = /^\/+users\/+([^/]*)/i.exec(req.path);
  if (m && !isOwnUserId(m[1], me) && !isPermissionsPath(req.path)) {
    return res.status(403).json({ error: "That isn't your account." });
  }
  next();
});
// Cross-site request forgery: a page on another site can make a signed-in
// browser send a plain form (urlencoded, multipart, text/plain) or a
// body-less no-cors POST, but never a JSON one without the browser asking
// first. So every state-changing /api request must say it's JSON; only a
// DELETE with no body at all is let through bare. The Guide's image upload
// is checked for an image type by its own route instead (wiki.js), after
// its editor check. Any browser that says the request came from another
// site (Sec-Fetch-Site: cross-site) is refused outright. The trusted auth
// service (bearer token, no cookies) is exempt. Runs after the sign-in
// check, so a signed-out request still gets its 401.
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use('/api', (req, res, next) => {
  if (!STATE_CHANGING.has(req.method)) return next();
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return res.status(403).json({ error: 'Requests from other sites are not accepted.' });
  }
  if (isInternalRequest(req)) return next();
  const p = req.originalUrl.split('?')[0].replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (req.method === 'POST' && /^\/api\/wiki\/images$/i.test(p)) return next();
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (req.method === 'DELETE' && !hasBody) return next();
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return res.status(415).json({ error: 'Send this request as JSON (Content-Type: application/json).' });
  next();
});
const isOwnUserId = (raw, me) => /^\d+$/.test(String(raw)) && Number(raw) === me.id;
// Changing permissions has its own privileged-only check (and is how a
// privileged walker manages someone else), so it's the one exception. Kept
// for the login app's walker-permissions page and privileged admins working
// by hand; the route itself refuses anyone who isn't privileged.
const isPermissionsPath = (p) => /^\/+(?:api\/+)?users\/+[^/]+\/+permissions\/*$/i.test(p);
// Every /api/users/:id/... route: the id has to be plain digits, and your own
// unless you're the trusted auth service (or it's /permissions, above).
app.param('id', (req, res, next, raw) => {
  if (!req.route || !/^\/api\/users\/:id(?:\/|$)/.test(req.route.path)) return next();
  if (!/^\d+$/.test(String(raw))) return res.status(404).json({ error: 'User not found' });
  if (isInternalRequest(req) || isPermissionsPath(req.originalUrl.split('?')[0])) return next();
  if (!req.me || Number(raw) !== req.me.id) {
    return res.status(403).json({ error: "That isn't your account." });
  }
  next();
});
// A walk can be changed or deleted only by the person who did it: no page
// lets staff edit someone else's walks (Stats only ever lists your own), so
// there's no staff override. Moving a walk to the right person is its own
// staff-only route (PUT /api/walks/:id/user).
function walkAccessDenied(req, res, walk) {
  if (req.me && walk.user_id === req.me.id) return false;
  if (isInternalRequest(req)) return false;
  res.status(403).json({ error: 'You can only change your own walks.' });
  return true;
}

// Guide / wiki (sections + images) lives in wiki.js.
wiki.register(app, { db, resolveAuthedUser });
// Who's walkable is always "for the viewer's own level" (dogEligibility).
const walkableFor = (req) => {
  const level = (req.me && req.me.experienceLevel) || DEFAULT_EXPERIENCE_LEVEL;
  return (row) => dogEligibility(row, level).eligible === true;
};
impact.register(app, { db, walkableFor });
impact.registerDay(app, { db, cachedPhotoUrl });
shelterTrends.register(app, { db });
const tags = noteTags.create(db, { cachedPhotoUrl });
const notesApi = notes.register(app, { db, isStaffOrPrivileged, cachedPhotoUrl, noteTags: tags });
const playgroupApi = playgroupNotes.register(app, { db, isStaffOrPrivileged, cachedPhotoUrl });
feedback.register(app, { db, isStaffOrPrivileged, push });
account.register(app, { db });

app.get('/api/me', (req, res) => {
  const user = resolveAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in (missing auth header) - reload, or contact an admin if this persists.' });
  }
  // Whether to show admin-only links (e.g. the staff panel) — this is
  // shelterwalk.com's login-level "staff" flag (from Django), a different
  // thing from this app's own isPrivileged/canAudit permissions.
  const isStaff = req.headers['x-auth-staff'] === '1';
  // The species table (species.js) rides along, so the app's rules for what
  // each animal can do always match the server's.
  // The pages this person can use on a computer and which one they start on
  // (Settings, and the switcher on the desktop pages).
  const desktop = {
    views: desktopViews.available(isStaff).map(({ key, label, path: p }) => ({ key, label, path: p })),
    start: desktopViews.startView(user.desktopView, isStaff),
    chosen: user.desktopView && desktopViews.isValid(user.desktopView, isStaff) ? user.desktopView : null
  };
  res.json({ ...user, isStaff, desktop, levelUpOffer: levelUpOffer(user.id), species: species.SPECIES });
});

// Display names can't be used to pass as someone else. Saved as NFKC
// (full-width and other compatibility forms folded to plain letters), with
// invisible characters dropped: controls, zero-width and joiners, bidi
// overrides/isolates, soft hyphens, and the "blank" fillers.
const INVISIBLE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]/g;
function cleanDisplayName(raw) {
  return String(raw == null ? '' : raw).normalize('NFKC').replace(INVISIBLE_NAME_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
// Letters from other scripts that look just like Latin ones, for the clash
// check only (the name is saved as typed).
const CONFUSABLES = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ү: 'y',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
  ɑ: 'a', ɡ: 'g', ı: 'i', ȷ: 'j', ℓ: 'l', '0': 'o'
};
// Two names that read the same: lowercased, spaces collapsed, accents and
// look-alike letters folded.
function nameSkeleton(name) {
  return cleanDisplayName(name).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/./gu, (c) => CONFUSABLES[c] || c).replace(/\s+/g, ' ').trim();
}

// The Profile section's two fields save together as one first/last pair.
app.put('/api/me', (req, res) => {
  const user = resolveAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  const name = cleanDisplayName(req.body.name);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const skeleton = nameSkeleton(name);
  const clash = db.prepare('SELECT id, name FROM users WHERE id != ?').all(user.id).some((u) => nameSkeleton(u.name) === skeleton);
  if (clash) return res.status(409).json({ error: 'A user with that name already exists' });
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  // Best effort: the staff account list in the login app shows this same
  // name. A failure there shouldn't block saving it here.
  const placeholder = String(req.headers['x-auth-email'] || '').trim().toLowerCase();
  if (placeholder) {
    account.setLoginName(placeholder, name)
      .then((r) => { if (r.status !== 200) console.warn(`[account] login app did not take the name for user ${user.id}: ${r.status}`); })
      .catch((err) => console.warn(`[account] could not send name to the login app for user ${user.id}: ${err.message}`));
  }
  res.json({ ...user, name });
});

// The Privacy & Data section's toggles. hideNameWhileWalking: whether this
// volunteer's name shows on the live "currently being walked by" badge --
// see dogLookups() and the walk-start "already out" check, both of
// which substitute a generic label instead of the real name.
app.put('/api/me/privacy', (req, res) => {
  const user = resolveAuthedUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const updates = {};
  if ('hideNameWhileWalking' in req.body) updates.hide_name_while_walking = req.body.hideNameWhileWalking ? 1 : 0;
  const columns = Object.keys(updates);
  if (columns.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  db.prepare(`UPDATE users SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...columns.map((c) => updates[c]), user.id);
  res.json({
    hideNameWhileWalking: 'hide_name_while_walking' in updates ? !!updates.hide_name_while_walking : undefined
  });
});

// Privacy & Data's "Download my data": everything this account has ever put
// into the app, in one file, for transparency's sake -- not something
// anyone else, including staff, can pull for someone else (it's the signed-
// in user's own data, read straight from their own req.me, same as every
// other /api/me route). Includes tips they wrote publicly (their own copy
// of something already shared, not a leak) but never another volunteer's
// data.
app.get('/api/me/export', (req, res) => {
  const me = req.me;
  if (!me) return res.status(401).json({ error: 'Not signed in.' });
  const profile = db.prepare(
    'SELECT name, experience_level AS experienceLevel, created_at AS createdAt, hide_name_while_walking AS hideNameWhileWalking, default_activity AS defaultActivity, walk_alert_minutes AS walkAlertMinutes FROM users WHERE id = ?'
  ).get(me.id);
  profile.hideNameWhileWalking = !!profile.hideNameWhileWalking;
  profile.walkAlertMinutes = walkAlertMinutes(profile.walkAlertMinutes);
  // The database itself never holds a reversible copy of your email (see
  // emailHash.js) -- this is the live, trusted value from the request that
  // got you here, the same source account deletion already uses.
  profile.email = String(req.headers['x-auth-email'] || '').trim().toLowerCase();
  const walks = db.prepare(`
    SELECT d.name AS dog, w.started_at AS startedAt, w.ended_at AS endedAt, w.duration_seconds AS durationSeconds,
           w.location, w.notes, w.manual_entry AS manualEntry, w.auto_stopped AS autoStopped
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.user_id = ? ORDER BY w.started_at ASC
  `).all(me.id);
  const privateNotes = db.prepare(`
    SELECT d.name AS dog, n.body, n.created_at AS createdAt, n.updated_at AS updatedAt
    FROM dog_notes n JOIN dogs d ON d.shelter_buddy_id = n.dog_id
    WHERE n.user_id = ? AND n.visibility = 'private' ORDER BY n.updated_at ASC
  `).all(me.id);
  const publicTipsWritten = db.prepare(`
    SELECT d.name AS dog, n.body, n.created_at AS createdAt
    FROM dog_notes n JOIN dogs d ON d.shelter_buddy_id = n.dog_id
    WHERE n.user_id = ? AND n.visibility = 'public' ORDER BY n.created_at ASC
  `).all(me.id);
  const savedFilters = db.prepare('SELECT name, filter_json AS filterJson, created_at AS createdAt FROM saved_filters WHERE user_id = ?').all(me.id);
  const notificationPrefs = db.prepare('SELECT pref_key AS pref, enabled FROM notification_prefs WHERE user_id = ?').all(me.id).map((r) => ({ ...r, enabled: !!r.enabled }));
  const favoriteDogs = db.prepare(`
    SELECT d.name AS dog, f.created_at AS createdAt
    FROM favorite_dogs f JOIN dogs d ON d.shelter_buddy_id = f.dog_id
    WHERE f.user_id = ? ORDER BY f.created_at ASC
  `).all(me.id);
  res.json({
    exportedAt: new Date().toISOString(),
    note: "This is everything Shelter Walk has stored about your account. It does not include your email sign-in history or passkeys, which belong to the separate login system.",
    profile,
    // Tags read as "@Name" here, not the stored "@[id]".
    walks: walks.map((w) => ({ ...w, notes: tags.toText(w.notes) })),
    privateNotes: privateNotes.map((n) => ({ ...n, body: tags.toText(n.body) })),
    publicTipsWritten: publicTipsWritten.map((n) => ({ ...n, body: tags.toText(n.body) })),
    savedFilters,
    notificationPrefs,
    favoriteDogs
  });
});

// Marks the first-run onboarding sequence (name -> experience level ->
// passkey offer -> notification prefs -> info -> thank you) as done, so it
// never shows again for this account. Separate from experience_level being
// set, since a returning/linked account might already have a level from
// before this sequence existed but still hasn't seen the rest of it.
app.post('/api/users/:id/onboarding-complete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT name, onboarding_completed FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(id);
  if (!user.onboarding_completed) {
    notifyAdmins({ title: '✅ Finished setting up', body: `${user.name} finished onboarding and is ready to walk.`, tag: `signup-${id}` });
  }
  res.json({ id, onboardingCompleted: true });
});

// ---- Notification & feed preferences (granular, per category) ----
// Two different kinds of "on/off" sharing one generic key/value table:
// - notify_*: push notifications, opt-IN (default off) -- nobody gets
//   pushed at without asking first.
// - show_*: whether an event kind appears in the Updates feed at all,
//   opt-OUT (default on) -- e.g. someone who'd rather not see "a dog was
//   removed" posts can turn just that off without losing the rest.
// favorite_* are the hearted-dog notices (see scraper.js), separate from
// adopted_walked_dog so someone can hear about just their favorites.
// Two pushes are on unless turned off: shelter_alerts (urgent news from
// staff, shelterSchedule.js) and new_signups (only ever sent to privileged
// accounts: someone new joined the app).
const PREF_DEFAULTS = {
  shelter_alerts: true,
  new_signups: true,
  adopted_walked_dog: false,
  walk_started: false,
  favorite_adopted: false,
  favorite_pending: false,
  favorite_returned: false,
  show_new_dog: true,
  show_adopted: true,
  show_returned: true
};
const PREF_KEYS = Object.keys(PREF_DEFAULTS);

app.get('/api/users/:id/notification-prefs', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = db.prepare('SELECT pref_key, enabled FROM notification_prefs WHERE user_id = ?').all(id);
  const byKey = Object.fromEntries(rows.map((r) => [r.pref_key, !!r.enabled]));
  const prefs = Object.fromEntries(PREF_KEYS.map((k) => [k, k in byKey ? byKey[k] : PREF_DEFAULTS[k]]));
  res.json({ prefs });
});

app.put('/api/users/:id/notification-prefs', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { key, enabled } = req.body;
  if (!PREF_KEYS.includes(key)) {
    return res.status(400).json({ error: `key must be one of: ${PREF_KEYS.join(', ')}` });
  }
  db.prepare(`
    INSERT INTO notification_prefs (user_id, pref_key, enabled) VALUES (?, ?, ?)
    ON CONFLICT(user_id, pref_key) DO UPDATE SET enabled = excluded.enabled
  `).run(id, key, enabled ? 1 : 0);
  res.json({ key, enabled: !!enabled });
});

function getUserPrefs(userId) {
  const rows = db.prepare('SELECT pref_key, enabled FROM notification_prefs WHERE user_id = ?').all(userId);
  const byKey = Object.fromEntries(rows.map((r) => [r.pref_key, !!r.enabled]));
  return Object.fromEntries(PREF_KEYS.map((k) => [k, k in byKey ? byKey[k] : PREF_DEFAULTS[k]]));
}

// ---- Favorite dogs ----
// Hearting a dog: a personal list for the "My favorites" filter and the
// favorite_* notifications. Only listed or once-listed dogs, not kennel-card
// stand-ins. Personal like a private note: no one else, staff included, can
// change it.
app.put('/api/users/:id/favorites/:dogId', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const dogId = parseInt(req.params.dogId, 10);
  if (!req.me || userId !== req.me.id) return res.status(403).json({ error: "That isn't your account." });
  const favorite = !!(req.body && req.body.favorite);
  if (favorite) {
    const dog = db.prepare('SELECT 1 FROM dogs WHERE shelter_buddy_id = ? AND awaiting_listing = 0').get(dogId);
    if (!dog) return res.status(404).json({ error: 'Dog not found' });
    db.prepare('INSERT OR IGNORE INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, ?, ?)').run(userId, dogId, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM favorite_dogs WHERE user_id = ? AND dog_id = ?').run(userId, dogId);
  }
  res.json({ dogId, favorite });
});

// ---- Walk length alerts ----
// Up to MAX_WALK_ALERTS walk lengths, in minutes, at which the walker gets a
// push notification during a walk (sent by the walk-limit sweep below).
const MAX_WALK_ALERTS = 3;
function walkAlertMinutes(json) {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list.filter((m) => Number.isInteger(m) && m > 0) : [];
  } catch (err) { return []; }
}

app.get('/api/users/:id/walk-alerts', (req, res) => {
  const row = db.prepare('SELECT walk_alert_minutes FROM users WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ minutes: walkAlertMinutes(row.walk_alert_minutes) });
});

app.put('/api/users/:id/walk-alerts', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { minutes } = req.body;
  if (!Array.isArray(minutes)) return res.status(400).json({ error: 'minutes must be a list.' });
  const maxMinutes = MAX_TOTAL_MINUTES - 1;
  if (!minutes.every((m) => Number.isInteger(m) && m >= 1 && m <= maxMinutes)) {
    return res.status(400).json({ error: `Each alert must be a whole number of minutes from 1 to ${maxMinutes}.` });
  }
  const clean = [...new Set(minutes)].sort((a, b) => a - b);
  if (clean.length > MAX_WALK_ALERTS) return res.status(400).json({ error: `You can set up to ${MAX_WALK_ALERTS} alerts.` });
  const info = db.prepare('UPDATE users SET walk_alert_minutes = ? WHERE id = ?').run(JSON.stringify(clean), id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ minutes: clean });
});

// ---- Web Push ----
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.VAPID_PUBLIC_KEY });
});

// The server POSTs to whatever endpoint is stored here, so only the browsers'
// own push services are accepted (no internal or arbitrary hosts), over https
// on the default port.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/
];
function validPushEndpoint(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return false;
  let url;
  try { url = new URL(raw); } catch (err) { return false; }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password
    && PUSH_HOSTS.some((re) => re.test(url.hostname.toLowerCase()));
}
// Web Push keys: p256dh is an uncompressed P-256 point (65 bytes, 0x04
// first), auth a 16-byte secret, both base64url.
function base64urlBytes(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(v)) return null;
  return Buffer.from(v.replace(/=+$/, ''), 'base64url');
}
function validPushKeys(keys) {
  const p256dh = keys && base64urlBytes(keys.p256dh);
  const auth = keys && base64urlBytes(keys.auth);
  return !!(p256dh && p256dh.length === 65 && p256dh[0] === 4 && auth && auth.length === 16);
}

const MAX_PUSH_SUBSCRIPTIONS = 10;
app.post('/api/push/subscribe', (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !validPushEndpoint(subscription.endpoint) || !validPushKeys(subscription.keys)) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }
  const { endpoint, keys } = subscription;
  const existing = db.prepare('SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  if (existing && existing.user_id !== req.me.id) {
    // Someone else's subscription: only the same browser (which holds the
    // same secret keys, e.g. a shared shelter phone after switching
    // accounts) can move it over. Knowing an endpoint URL alone isn't enough.
    if (existing.p256dh !== keys.p256dh || existing.auth !== keys.auth) {
      return res.status(409).json({ error: 'That push subscription belongs to another account.' });
    }
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at
  `).run(req.me.id, endpoint, keys.p256dh, keys.auth, new Date().toISOString());
  // Up to MAX_PUSH_SUBSCRIPTIONS devices per account; the oldest go first.
  db.prepare(`
    DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
      SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)
  `).run(req.me.id, req.me.id, MAX_PUSH_SUBSCRIPTIONS);
  res.json({ ok: true });
});

// Only your own subscriptions can be removed.
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(String(endpoint), req.me.id);
  res.json({ ok: true });
});

// Trusted server-to-server only (the Django accounts page). Callers name an
// account by the same placeholder they send in X-Auth-Email on every request
// -- this app fingerprints it with its own secret, exactly like sign-in
// does, so Django never needs to know how that fingerprint works. Nothing
// here creates a profile: an account that has never opened the app simply
// has no entry.
app.post('/api/internal/accounts/lookup', (req, res) => {
  if (!isInternalRequest(req)) return res.status(403).json({ error: 'Not available.' });
  const emails = Array.isArray(req.body.emails) ? req.body.emails.slice(0, 1000) : [];
  const stmt = db.prepare(
    'SELECT id, experience_level AS experienceLevel, is_privileged AS isPrivileged, can_audit AS canAudit FROM users WHERE auth_email_hash = ?'
  );
  const accounts = {};
  for (const email of emails) {
    const row = stmt.get(hashEmail(String(email)));
    if (row) accounts[email] = { experienceLevel: row.experienceLevel, isPrivileged: !!row.isPrivileged, canAudit: !!row.canAudit };
  }
  res.json({ accounts });
});

app.put('/api/internal/accounts/permissions', (req, res) => {
  if (!isInternalRequest(req)) return res.status(403).json({ error: 'Not available.' });
  const { email, isPrivileged, canAudit } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });
  const info = db.prepare('UPDATE users SET is_privileged = ?, can_audit = ? WHERE auth_email_hash = ?')
    .run(isPrivileged ? 1 : 0, canAudit ? 1 : 0, hashEmail(String(email)));
  if (info.changes === 0) return res.status(404).json({ error: 'That account has not opened the app yet.' });
  res.json({ isPrivileged: !!isPrivileged, canAudit: !!canAudit });
});

app.get('/api/users/:id', (req, res) => {
  const row = db.prepare(
    'SELECT id, name, experience_level AS experienceLevel, is_privileged AS isPrivileged, can_audit AS canAudit FROM users WHERE id = ?'
  ).get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ ...row, isPrivileged: !!row.isPrivileged, canAudit: !!row.canAudit });
});

// The answer to the 20-hour level-up offer. accept: true moves a Beginner
// to Established; either way the offer is marked as made.
app.post('/api/users/:id/level-up-offer', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT experience_level FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const experienceLevel = req.body.accept === true && user.experience_level === 'beginner' ? 'established' : user.experience_level;
  db.prepare('UPDATE users SET experience_level = ?, level_up_offered_at = ? WHERE id = ?').run(experienceLevel, new Date().toISOString(), id);
  res.json({ id, experienceLevel });
});

// So the frontend can build the tier picker (onboarding + Settings) without
// hardcoding the rules in two places.
app.get('/api/experience-levels', (req, res) => {
  res.json({
    levels: Object.entries(EXPERIENCE_LEVELS).map(([key, level]) => ({ key, ...level }))
  });
});

// Trusted server-to-server calls (currently: the Django staff panel's
// walker-permissions page, since that's the only UI for this now) present
// this shared secret instead of a requestingUserId -- there's no dogwalk
// account to attribute the call to when the caller is another service, not
// a browser session.
// Compared in constant time (hashed first, so the lengths always match), so
// response timing gives nothing away about the token.
function isInternalRequest(req) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return false;
  const header = String(req.headers['authorization'] || '');
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

// Lets a privileged user (or a trusted internal caller) grant/revoke
// another user's individual permissions (Alumni override, Audit Mode)
// without a full account/role system.
app.put('/api/users/:id/permissions', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { isPrivileged, canAudit } = req.body;
  // Who's asking comes from the trusted X-Auth-Email header, never from the
  // request body -- a body field is trivially forgeable by any signed-in user.
  if (!isInternalRequest(req)) {
    const requester = resolveAuthedUser(req);
    if (!requester || !requester.isPrivileged) {
      return res.status(403).json({ error: 'Only privileged users can change permissions' });
    }
  }
  const info = db.prepare('UPDATE users SET is_privileged = ?, can_audit = ? WHERE id = ?')
    .run(isPrivileged ? 1 : 0, canAudit ? 1 : 0, id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ id, isPrivileged: !!isPrivileged, canAudit: !!canAudit });
});

// Any of: experienceLevel, defaultActivity (the scan screen's usual
// activity), speciesPref (who they work with: dog, cat or both), desktopView
// (start page on a computer; null = the default).
app.put('/api/users/:id/settings', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { experienceLevel, defaultActivity, speciesPref, desktopView } = req.body;
  if (experienceLevel === undefined && defaultActivity === undefined && speciesPref === undefined && desktopView === undefined) {
    return res.status(400).json({ error: 'Nothing to save: send experienceLevel, defaultActivity, speciesPref and/or desktopView.' });
  }
  // Everything is checked first, then saved in one UPDATE, so a bad field
  // never leaves the good ones half-saved.
  if (desktopView !== undefined && desktopView !== null && !desktopViews.isValid(desktopView, req.headers['x-auth-staff'] === '1')) {
    return res.status(400).json({ error: `desktopView must be one of: ${desktopViews.available(req.headers['x-auth-staff'] === '1').map((v) => v.key).join(', ')}` });
  }
  if (speciesPref !== undefined && !species.SPECIES_PREFS.includes(speciesPref)) {
    return res.status(400).json({ error: `speciesPref must be one of: ${species.SPECIES_PREFS.join(', ')}` });
  }
  if (experienceLevel !== undefined && !Object.prototype.hasOwnProperty.call(EXPERIENCE_LEVELS, experienceLevel)) {
    return res.status(400).json({ error: `experienceLevel must be one of: ${Object.keys(EXPERIENCE_LEVELS).join(', ')}` });
  }
  if (defaultActivity !== undefined && !ACTIVITIES.includes(defaultActivity)) {
    return res.status(400).json({ error: `defaultActivity must be one of: ${ACTIVITIES.join(', ')}` });
  }
  const user = db.prepare('SELECT experience_level, default_activity, species_pref, desktop_view FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // desktopView alone answers with just that (what the desktop switcher expects).
  if (experienceLevel === undefined && defaultActivity === undefined && speciesPref === undefined) {
    db.prepare('UPDATE users SET desktop_view = ? WHERE id = ?').run(desktopView, id);
    return res.json({ id, desktopView });
  }
  const next = {
    experienceLevel: experienceLevel !== undefined ? experienceLevel : user.experience_level,
    defaultActivity: defaultActivity !== undefined ? defaultActivity : user.default_activity,
    speciesPref: speciesPref !== undefined ? speciesPref : user.species_pref
  };
  db.prepare('UPDATE users SET experience_level = ?, default_activity = ?, species_pref = ?, desktop_view = ? WHERE id = ?')
    .run(next.experienceLevel, next.defaultActivity, next.speciesPref, desktopView !== undefined ? desktopView : user.desktop_view, id);
  res.json({ id, ...next });
});

// A garbage ?limit= (NaN, negative, absurdly large) used to reach SQLite as-is
// and throw; always land on a sane positive integer instead.
function clampLimit(raw, fallback, max = 5000) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A real calendar date ("2026-13-40" isn't one).
function validDateKey(v) {
  if (typeof v !== 'string' || !DATE_KEY_RE.test(v)) return null;
  const d = new Date(`${v}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

// ---- Dogs ----
// The shelter's Animal IDs (kennel card QR/barcode) are 4-9 digit numbers.
const looksLikeAnimalId = (id) => Number.isInteger(id) && id >= 1000 && id <= 999999999;

// Only the species the signed-in volunteer works with (Settings). Looking up
// one animal by ID (a scan) works for any species.
function speciesWhere(req) {
  const kinds = species.speciesForPref(req.me && req.me.speciesPref);
  return { sql: `species IN (${kinds.map(() => '?').join(', ')})`, params: kinds };
}

app.get('/api/dogs', (req, res) => {
  const experienceLevel = resolveExperienceLevel(req.query.userId);
  const onlyEligible = req.query.eligible === 'true';
  const onlyListed = req.query.all !== 'true';
  const todayKey = validDateKey(req.query.dateKey);
  const kinds = speciesWhere(req);
  // Stand-ins for not-yet-listed kennel cards aren't real dogs yet: no list shows them.
  let rows = db.prepare(`SELECT * FROM dogs WHERE awaiting_listing = 0 AND ${kinds.sql}` + (onlyListed ? ' AND still_listed = 1' : '')).all(...kinds.params);
  const lookups = dogLookups(req.me.id, todayKey);
  let dogs = rows.map((r) => serializeDog(r, experienceLevel, todayKey, req.me.id, { lookups, withSummary: false }));
  if (onlyEligible) {
    dogs = dogs.filter((d) => d.eligible);
  }
  dogs.sort((a, b) => (b.daysInShelter || 0) - (a.daysInShelter || 0));
  res.json({ experienceLevel, dogs });
});

// When each of this dog's currently-set stickers was last turned on, for the
// "added <date>" line in the marker picker (see stickerDatesFor in app.js).
// Keyed the same as STICKER_LABELS below (star/pb/poo/poo_priority/blue_*).
// Single-dog lookup only -- the list route never needs this, so it stays out
// of serializeDog rather than costing every dog on /api/dogs a extra query.
const latestStickerOn = db.prepare(`
  SELECT detail, MAX(occurred_at) AS addedAt FROM shelter_events
  WHERE dog_id = ? AND kind = 'sticker_on' GROUP BY detail
`);
function stickerDatesFor(dogId) {
  const dates = {};
  for (const row of latestStickerOn.all(dogId)) dates[row.detail] = row.addedAt;
  return dates;
}

app.get('/api/dogs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!row) {
    // A kennel card can be printed before the shelter's listing has the dog.
    // notListedYet: the app offers to walk them anyway on this ID.
    return res.status(404).json({ error: "We don't have this dog's details yet.", notListedYet: looksLikeAnimalId(id), id });
  }
  const experienceLevel = resolveExperienceLevel(req.query.userId);
  const todayKey = validDateKey(req.query.dateKey);
  const dog = serializeDog(row, experienceLevel, todayKey, req.me.id);
  // The dog's walks, for the "walked today" hints. No notes and no walk ids
  // here at all: the dog's notes are their own list (notes.walkNotes, from
  // notes.js), never joined to a walk. Someone else's walk carries only its
  // shelter date (as noteDay's timestamp) and activity; only your own keep
  // their times. Ordered by date, then yours first, then by activity.
  const walks = db.prepare('SELECT user_id, started_at, ended_at, activity FROM walks WHERE dog_id = ?').all(id)
    .map((w) => (w.user_id === req.me.id
      ? { mine: true, activity: w.activity, started_at: w.started_at, ended_at: w.ended_at }
      : { mine: false, activity: w.activity, started_at: noteTags.noteDay(w.started_at), ended_at: w.ended_at ? noteTags.noteDay(w.started_at) : null }))
    .sort((a, b) => {
      const da = statsBreakdown.shelterDateKey(a.started_at);
      const dbk = statsBreakdown.shelterDateKey(b.started_at);
      if (da !== dbk) return da < dbk ? 1 : -1;
      if (a.mine !== b.mine) return a.mine ? -1 : 1;
      return a.mine ? (a.started_at < b.started_at ? 1 : -1) : a.activity.localeCompare(b.activity);
    });
  dog.playgroupCounts = playgroupApi.counts(id);
  dog.stickerDates = stickerDatesFor(id);
  Object.assign(dog, modulesCore.runDogEnrichers(id, moduleState));
  res.json({ dog, walks, notes: notesApi.notesFor(id, req.me.id) });
});

// A scannable QR code linking to this dog's public adoption page, so a
// walker can show it on their phone to a member of the public who wants more
// info -- generated on the fly (nothing to cache on disk, nothing to keep in
// sync with the shelter's own site) and served as inline SVG so it stays
// crisp at any size and needs no extra network request from the browser.
app.get('/api/dogs/:id/qr.svg', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dog = db.prepare('SELECT shelter_buddy_id FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  try {
    const svg = await QRCode.toString(`https://pets.wake.gov/adopt/${id}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/svg+xml; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(svg);
  } catch (err) {
    res.status(500).json({ error: 'Could not generate a QR code right now.' });
  }
});

// The "log" icon's popup: this dog's full tracked timeline -- arrivals,
// pending adoptions (and ones that fell through), adoptions, returns, and
// plain removals. Built from the shared shelter_events log (the same rows
// the Updates feed reads), not a separate table. Capped to the last 6
// months so this stays a short, readable list even for a dog with a long
// history, rather than growing forever as the event log does.
const STAY_HISTORY_MONTHS = 6;
const STICKER_EVENT_KINDS = ['sticker_on', 'sticker_off', 'sticker_auto_off'];
// A sticker switched on and back off (or off then on) within the same
// calendar day leaves nothing to show -- the dog ends the day exactly as it
// started, so both events are dropped rather than cluttering the timeline
// with a no-op. Grouped by day (not a rolling 24h window) and by sticker
// (`detail`), independent of every other sticker.
function collapseSameDaySticker(rows) {
  const groups = new Map(); // "day|key" -> rows[]
  for (const row of rows) {
    const key = `${row.occurredAt.slice(0, 10)}|${row.detail}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const kept = [];
  for (const group of groups.values()) {
    const hasOn = group.some((r) => r.kind === 'sticker_on');
    const hasOff = group.some((r) => r.kind === 'sticker_off' || r.kind === 'sticker_auto_off');
    if (hasOn && hasOff) continue;
    kept.push(...group);
  }
  return kept.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
app.get('/api/dogs/:id/stay-history', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dog = db.prepare('SELECT shelter_buddy_id FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  const since = new Date();
  since.setMonth(since.getMonth() - STAY_HISTORY_MONTHS);
  const events = db.prepare(`
    SELECT kind, title, detail, occurred_at AS occurredAt FROM shelter_events
    WHERE dog_id = ? AND kind IN ('new_dog', 'returned', 'adopted', 'removed', 'pending_adoption', 'pending_canceled')
      AND occurred_at >= ?
    ORDER BY occurred_at ASC, id ASC
  `).all(id, since.toISOString());
  // Toggleable separately on the timeline (see showStayLogPopup in app.js)
  // since most volunteers care about arrivals/adoptions, not every sticker
  // flip -- kept in its own list rather than merged into `events` so the
  // client can show/hide it without another round trip.
  const stickerRows = db.prepare(`
    SELECT kind, title, detail, occurred_at AS occurredAt FROM shelter_events
    WHERE dog_id = ? AND kind IN (${STICKER_EVENT_KINDS.map(() => '?').join(', ')})
      AND occurred_at >= ?
    ORDER BY occurred_at ASC, id ASC
  `).all(id, ...STICKER_EVENT_KINDS, since.toISOString());
  const stickerEvents = collapseSameDaySticker(stickerRows);
  res.json({ months: STAY_HISTORY_MONTHS, events, stickerEvents });
});

// "Our walks together" stats for the profile sheet's graph link -- personal
// (this user + this dog) plus a shelter-wide total for context.
app.get('/api/dogs/:id/walk-stats', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const dog = db.prepare('SELECT shelter_buddy_id FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  const mine = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(duration_seconds), 0) AS totalSeconds,
           MIN(started_at) AS firstWalkedAt, MAX(started_at) AS lastWalkedAt,
           COALESCE(MAX(duration_seconds), 0) AS longestSeconds
    FROM walks WHERE dog_id = ? AND user_id = ? AND ended_at IS NOT NULL
  `).get(id, userId);
  // Other volunteers' share to the nearest 5 minutes (dogTotalsFor).
  const everyone = dogTotalsFor(id, userId);
  res.json({ mine, everyone });
});

// The app's four daily walk windows (WALK_SLOTS in app.js), in shelter
// hours: 7-10, 10-1, 1-4 and 4-7 (to 8, for a walk that runs long). The
// index of the one a time falls in, or -1 outside them.
const SHELTER_SLOTS = [[7, 10], [10, 13], [13, 16], [16, 20]];
const shelterHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
function shelterSlotIndex(iso) {
  const hour = Number(shelterHourFmt.format(new Date(iso)));
  return SHELTER_SLOTS.findIndex(([from, to]) => hour >= from && hour < to);
}
// A walk time anyone may see, at walk-window precision: the start of its
// window (SHELTER_SLOTS) on its shelter day, as an ISO time so dates, sorts
// and "today" checks keep working. Before the first window counts as the
// first, after the last as the last, so the order of days and windows holds.
function coarseWalkTime(iso) {
  if (!iso) return iso;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const c = walkHours.shelterClock(ms);
  const hour = Math.floor(c.minutes / 60);
  const slot = SHELTER_SLOTS.findIndex(([from, to]) => hour >= from && hour < to);
  const fromHour = slot >= 0 ? SHELTER_SLOTS[slot][0]
    : hour < SHELTER_SLOTS[0][0] ? SHELTER_SLOTS[0][0] : SHELTER_SLOTS[SHELTER_SLOTS.length - 1][0];
  return walkHours.shelterTimeToDate(c.y, c.m, c.d, fromHour * 60).toISOString();
}
// Other volunteers' combined time with a dog, to the nearest 5 minutes (the
// same precision as their rows in walk-history): an exact shelter-wide total
// minus your own would give someone else's exact walk length, and two looks
// a walk apart would give that walk's. Your own part stays exact.
const roundToFive = (seconds) => Math.round((seconds || 0) / 300) * 300;
function dogTotalsFor(dogId, userId) {
  const all = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(duration_seconds), 0) AS totalSeconds FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL').get(dogId);
  const mine = db.prepare('SELECT COALESCE(SUM(duration_seconds), 0) AS totalSeconds FROM walks WHERE dog_id = ? AND user_id = ? AND ended_at IS NOT NULL').get(dogId, userId);
  return { count: all.count, totalSeconds: mine.totalSeconds + roundToFive(all.totalSeconds - mine.totalSeconds) };
}

// Every finished walk this dog has had, newest first. Each one says only
// whether it was yours: never who else walked, and no notes. Someone else's
// walk has no exact times either, just its shelter date, walk window (slot,
// see SHELTER_SLOTS) and length to the nearest 5 minutes: exact rows would
// undo Together's "fewer than 3" rule and line notes up against walkers.
// Your own keep their times. Ordered by date and window, never by the real
// times of anyone else's.
app.get('/api/dogs/:id/walk-history', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dog = db.prepare('SELECT name, species FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  const walks = db.prepare(`
    SELECT user_id, started_at, ended_at, duration_seconds, activity
    FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL
  `).all(id).map((w) => {
    const base = { date: statsBreakdown.shelterDateKey(w.started_at), slot: shelterSlotIndex(w.started_at), activity: w.activity };
    return w.user_id === req.me.id
      ? { ...base, mine: true, startedAt: w.started_at, endedAt: w.ended_at, durationSeconds: w.duration_seconds }
      : { ...base, mine: false, durationSeconds: Math.round((w.duration_seconds || 0) / 300) * 300 };
  }).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1)
    : a.slot !== b.slot ? b.slot - a.slot
      : a.mine !== b.mine ? (a.mine ? -1 : 1)
        : a.mine ? (a.startedAt < b.startedAt ? 1 : -1)
          : a.activity.localeCompare(b.activity) || a.durationSeconds - b.durationSeconds));
  // The same totals as walk-stats' "everyone": exact for your own walks,
  // other volunteers' share to the nearest 5 minutes.
  const totals = dogTotalsFor(id, req.me.id);
  res.json({ name: dog.name, species: dog.species, walks, totals });
});

// blank + alphabetical letter codes, with the EVO rectangle last.
const VALID_BLUE_MARKERS = [
  'blue', 'blue_c', 'blue_d', 'blue_e', 'blue_h', 'blue_j',
  'blue_m', 'blue_p', 'blue_q', 'blue_r', 'blue_s', 'blue_evo'
];
const VALID_POO_STATUSES = ['none', 'poo', 'priority'];

// Human-readable label for each individually-tracked sticker, used only for
// the "turned on/off" events on a dog's timeline (see /api/dogs/:id/stay-
// history) -- independent of the icon/letter shown on the kennel card
// itself (see BLUE_MARKER_NAMES in app.js).
const STICKER_LABELS = {
  star: 'Good for beginners (star)',
  pb: 'PB: Potty break only',
  poo: 'POO: Potty Outside Only',
  poo_priority: 'POO: priority (first out, last in)',
  blue_c: 'Blue: Difficult to collar',
  blue_d: 'Blue: Door dasher',
  blue_e: 'Blue: Energetic',
  blue_h: 'Blue: Humpy',
  blue_j: 'Blue: Jumpy',
  blue_m: 'Blue: Mouthy',
  blue_p: 'Blue: Puller',
  blue_q: 'Blue: Quirky',
  blue_r: 'Blue: Reactive',
  blue_s: 'Blue: Shy / shutdown',
  blue_evo: 'Blue: Experienced volunteer only'
};
const insertStickerEvent = db.prepare(
  'INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES (?, ?, ?, ?, ?)'
);
// One event per sticker that actually changed, not one event for the whole
// PUT -- so the timeline (and its same-day on/off collapsing, see
// /api/dogs/:id/stay-history) can treat "turned the star on" and "turned PB
// off" as separate, independently-cancelable entries even when both happen
// in the same request. POO's plain/priority pair is modeled as two
// independent booleans here (never both on at once) so it collapses the
// same way every other sticker does.
function logStickerChanges(dogId, before, after) {
  const beforeBlue = new Set(before.blueMarkers);
  const afterBlue = new Set(after.blueMarkers);
  const changes = [];
  for (const key of VALID_BLUE_MARKERS) {
    if (key === 'blue') continue; // never toggled directly, only implied client-side
    if (beforeBlue.has(key) !== afterBlue.has(key)) changes.push([key, afterBlue.has(key)]);
  }
  if (before.starFlag !== after.starFlag) changes.push(['star', after.starFlag]);
  if (before.pbFlag !== after.pbFlag) changes.push(['pb', after.pbFlag]);
  if (before.pooStatus !== after.pooStatus) {
    if (before.pooStatus === 'poo') changes.push(['poo', false]);
    if (before.pooStatus === 'priority') changes.push(['poo_priority', false]);
    if (after.pooStatus === 'poo') changes.push(['poo', true]);
    if (after.pooStatus === 'priority') changes.push(['poo_priority', true]);
  }
  if (!changes.length) return;
  const now = new Date().toISOString();
  for (const [key, on] of changes) {
    insertStickerEvent.run(on ? 'sticker_on' : 'sticker_off', dogId, STICKER_LABELS[key] || key, key, now);
  }
}
app.put('/api/dogs/:id/markers', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { blueMarkers, pooStatus, starFlag, pbFlag } = req.body;
  const animal = db.prepare('SELECT species, blue_markers, poo_status, star_flag, pb_flag FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (animal && !species.speciesInfo(animal.species).stickers) {
    return res.status(400).json({ error: `${species.speciesInfo(animal.species).plural} don't have kennel card stickers.` });
  }
  if (!Array.isArray(blueMarkers) || blueMarkers.some((m) => !VALID_BLUE_MARKERS.includes(m))) {
    return res.status(400).json({ error: `blueMarkers must be an array of: ${VALID_BLUE_MARKERS.join(', ')}` });
  }
  if (!VALID_POO_STATUSES.includes(pooStatus)) {
    return res.status(400).json({ error: `pooStatus must be one of ${VALID_POO_STATUSES.join(', ')}` });
  }
  const uniqueBlue = [...new Set(blueMarkers)];
  const info = db.prepare(`
    UPDATE dogs SET blue_markers = ?, poo_status = ?, star_flag = ?, pb_flag = ? WHERE shelter_buddy_id = ?
  `).run(JSON.stringify(uniqueBlue), pooStatus, starFlag ? 1 : 0, pbFlag ? 1 : 0, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Dog not found' });
  logStickerChanges(id, {
    blueMarkers: JSON.parse(animal.blue_markers || '[]'),
    pooStatus: animal.poo_status,
    starFlag: !!animal.star_flag,
    pbFlag: !!animal.pb_flag
  }, { blueMarkers: uniqueBlue, pooStatus, starFlag: !!starFlag, pbFlag: !!pbFlag });
  res.json({ id, blueMarkers: uniqueBlue, pooStatus, starFlag: !!starFlag, pbFlag: !!pbFlag });
});

// Alumni (returned dog): privileged users only, enforced here server-side
// (not just hidden in the UI) since it changes who a dog is shown as
// eligible to. Two independent toggles -- bonusDays (clamped 1-15 when
// alumni is on) and bypassStrayHold -- so a privileged user can set
// either, neither, or both for the same dog.
app.put('/api/dogs/:id/alumni', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { alumni, bonusDays, bypassStrayHold } = req.body;
  const user = resolveAuthedUser(req);
  if (!user || !user.isPrivileged) {
    return res.status(403).json({ error: 'Only privileged users can set alumni status' });
  }
  const userId = user.id;
  const clampedBonus = alumni ? Math.min(15, Math.max(1, Math.round(Number(bonusDays) || 0))) : 0;
  const info = db.prepare(
    'UPDATE dogs SET alumni_flag = ?, alumni_bonus_days = ?, alumni_bypass_stray_hold = ? WHERE shelter_buddy_id = ?'
  ).run(alumni ? 1 : 0, clampedBonus, bypassStrayHold ? 1 : 0, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Dog not found' });
  const row = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(id);
  const dog = serializeDog(row, resolveExperienceLevel(userId), null, userId);
  res.json({
    id, isAlumni: !!alumni, alumniBonusDays: clampedBonus, alumniBypassStrayHold: !!bypassStrayHold,
    eligible: dog.eligible, notEligibleReason: dog.notEligibleReason
  });
});

// Save a dog's kennel location without starting a walk (e.g. you're just
// noting where they are right now, not walking them).
app.put('/api/dogs/:id/location', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const animal = db.prepare('SELECT species FROM dogs WHERE shelter_buddy_id = ?').get(id);
  const letter = kennelLetter(req.body.location, animal && animal.species);
  if (!letter) {
    return res.status(400).json({ error: kennelLetterError(animal && animal.species) });
  }
  const result = setKennelLocation(id, letter);
  if (!result) return res.status(404).json({ error: 'Dog not found' });
  res.json({ id, ...result });
});

// Audit Mode's "every kennel in this wing was scanned": any dog still
// recorded in the wing that wasn't scanned can't be there, so its letter is
// cleared (it's somewhere else, or gone). dryRun lists who that would be
// without changing anything, so the app can show names before confirming.
app.post('/api/audit/clear-unscanned', (req, res) => {
  if (!(req.headers['x-auth-staff'] === '1' || (req.me && (req.me.canAudit || req.me.isPrivileged)))) {
    return res.status(403).json({ error: 'Audit access is needed for this.' });
  }
  const letter = kennelLetter(req.body.letter, 'dog');
  if (!letter || String(req.body.letter).trim().length !== 1) return res.status(400).json({ error: 'Pick a kennel letter, A to E.' });
  const scanned = new Set((Array.isArray(req.body.scannedIds) ? req.body.scannedIds : []).map((id) => parseInt(id, 10)).filter(Number.isFinite));
  if (!scanned.size) return res.status(400).json({ error: 'No dogs were scanned in this wing.' });
  // Audit Mode walks the dog wings: a cat filed under the same letter is left alone.
  const unscanned = db.prepare("SELECT shelter_buddy_id AS id, name FROM dogs WHERE kennel_location = ? AND species = 'dog' ORDER BY name")
    .all(letter).filter((d) => !scanned.has(d.id));
  if (!req.body.dryRun && unscanned.length) {
    const clear = db.prepare('UPDATE dogs SET kennel_location = NULL WHERE shelter_buddy_id = ? AND kennel_location = ?');
    db.transaction(() => unscanned.forEach((d) => clear.run(d.id, letter)))();
    console.log(`[audit] wing ${letter}: cleared ${unscanned.length} unscanned dog(s) (${scanned.size} scanned)`);
  }
  res.json({ letter, cleared: unscanned, dryRun: !!req.body.dryRun });
});

// ---- Saved filters (per user, Available list Presets tab) ----
app.get('/api/users/:id/saved-filters', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const rows = db.prepare(
    'SELECT id, name, filter_json AS filterJson, created_at AS createdAt FROM saved_filters WHERE user_id = ? ORDER BY created_at'
  ).all(userId);
  res.json({ filters: rows.map((r) => ({ id: r.id, name: r.name, filter: JSON.parse(r.filterJson), createdAt: r.createdAt })) });
});

app.post('/api/users/:id/saved-filters', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { name, filter } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  if (!filter || typeof filter !== 'object') return res.status(400).json({ error: 'filter is required' });
  const info = db.prepare(
    'INSERT INTO saved_filters (user_id, name, filter_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(userId, String(name).trim(), JSON.stringify(filter), new Date().toISOString());
  res.json({ id: info.lastInsertRowid, name: String(name).trim(), filter });
});

app.put('/api/users/:id/saved-filters/:filterId', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const filterId = parseInt(req.params.filterId, 10);
  const { name, filter } = req.body;
  const existing = db.prepare('SELECT * FROM saved_filters WHERE id = ? AND user_id = ?').get(filterId, userId);
  if (!existing) return res.status(404).json({ error: 'Saved filter not found' });
  const newName = name != null && String(name).trim() ? String(name).trim() : existing.name;
  const newFilterJson = filter != null ? JSON.stringify(filter) : existing.filter_json;
  db.prepare('UPDATE saved_filters SET name = ?, filter_json = ? WHERE id = ?').run(newName, newFilterJson, filterId);
  res.json({ id: filterId, name: newName, filter: JSON.parse(newFilterJson) });
});

app.delete('/api/users/:id/saved-filters/:filterId', (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const filterId = parseInt(req.params.filterId, 10);
  const info = db.prepare('DELETE FROM saved_filters WHERE id = ? AND user_id = ?').run(filterId, userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Saved filter not found' });
  res.json({ id: filterId, deleted: true });
});

// ---- Same-day checkoffs (someone else already walked this dog today) ----
// Ids from a request body: a positive whole number, or null.
const positiveInt = (v) => (/^\d+$/.test(String(v)) && Number(v) > 0 && Number.isSafeInteger(Number(v)) ? Number(v) : null);

app.post('/api/checkoff', (req, res) => {
  const dogId = positiveInt(req.body.dogId);
  const key = validDateKey(req.body.dateKey);
  if (!dogId || !key) return res.status(400).json({ error: 'dogId and a valid dateKey (YYYY-MM-DD) are required' });
  db.prepare(`
    INSERT INTO session_checkoffs (dog_id, date_key, checked_at) VALUES (?, ?, ?)
    ON CONFLICT(dog_id, date_key) DO NOTHING
  `).run(dogId, key, new Date().toISOString());
  res.json({ dogId, dateKey: key, checked: true });
});

app.delete('/api/checkoff', (req, res) => {
  const dogId = parseInt(req.query.dogId, 10);
  const key = validDateKey(req.query.dateKey);
  if (!dogId || !key) return res.status(400).json({ error: 'dogId and a valid dateKey (YYYY-MM-DD) are required' });
  db.prepare('DELETE FROM session_checkoffs WHERE dog_id = ? AND date_key = ?').run(dogId, key);
  res.json({ dogId, dateKey: key, checked: false });
});

// ---- Manual shift checkoffs (a walk happened but was never scanned in) ----
// Rows are permanent history, keyed by date_key, so the confirm screen only
// ever shows today's date_key as checked — a free midnight reset without
// deleting anything.
app.get('/api/manual-checkoffs', (req, res) => {
  const dogId = parseInt(req.query.dogId, 10);
  const key = validDateKey(req.query.dateKey);
  if (!dogId || !key) return res.status(400).json({ error: 'dogId and a valid dateKey (YYYY-MM-DD) are required' });
  const rows = db.prepare(
    'SELECT slot_index AS slotIndex FROM manual_shift_checkoffs WHERE dog_id = ? AND date_key = ?'
  ).all(dogId, key);
  res.json({ slots: rows.map((r) => r.slotIndex) });
});

app.put('/api/manual-checkoffs', (req, res) => {
  const { dateKey, checked, userId } = req.body;
  const dogId = positiveInt(req.body.dogId);
  const slotIndex = /^\d{1,2}$/.test(String(req.body.slotIndex)) ? Number(req.body.slotIndex) : null;
  const key = validDateKey(dateKey);
  if (!dogId || !key || slotIndex == null) {
    return res.status(400).json({ error: 'dogId, a valid dateKey (YYYY-MM-DD), and slotIndex are required' });
  }
  if (checked) {
    db.prepare(`
      INSERT INTO manual_shift_checkoffs (dog_id, date_key, slot_index, checked_at, user_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(dog_id, date_key, slot_index) DO NOTHING
    `).run(dogId, key, slotIndex, new Date().toISOString(), userId || null);
  } else {
    db.prepare(
      'DELETE FROM manual_shift_checkoffs WHERE dog_id = ? AND date_key = ? AND slot_index = ?'
    ).run(dogId, key, slotIndex);
  }
  res.json({ dogId, dateKey: key, slotIndex, checked: !!checked });
});

// ---- Updates (shared, global feed -- the Updates tab) ----
// Every shelter-level event (new dog, removed, adopted, returned), written
// by the scraper (see logEvent in scraper.js). Not personal/ack-based like
// the old topbar bell was -- everyone sees the same feed. The one bit of
// personalization: an 'adopted' row about a dog THIS user has walked gets
// `personalHighlight: true` when they've opted into that (see
// notification_prefs), so the UI can call it out for them specifically.
// The event kinds the Updates feed shows. 'removed' (a plain delisting that
// wasn't an adoption) is left out on purpose; see below.
const UPDATE_KINDS = ['new_dog', 'adopted', 'returned', 'alert'];
app.get('/api/updates', (req, res) => {
  const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  const limit = clampLimit(req.query.limit, 100);
  // Optional filters from the feed's Today / This week and type chips.
  // `since` is normalized through Date so only a real timestamp reaches the
  // query; `kinds` keeps only the kinds the feed knows.
  const sinceDate = req.query.since ? new Date(String(req.query.since)) : null;
  const since = sinceDate && !isNaN(sinceDate) ? sinceDate.toISOString() : '';
  const kinds = String(req.query.kinds || '').split(',').filter((k) => UPDATE_KINDS.includes(k));
  const kindList = kinds.length ? kinds : UPDATE_KINDS;
  // Fetch more than asked before filtering by show_* prefs, so hiding a
  // category doesn't just leave someone with a short feed once they've
  // scrolled past however many of that kind happened to lead the results.
  // 'removed' (a plain delisting that wasn't an adoption) is excluded
  // outright -- not happy news, not actionable, shouldn't show up at all.
  // The scraper stopped writing new ones of these; this also hides any
  // already sitting in the table from before that change.
  // Only news about the species this volunteer works with; shelter-wide
  // alerts (no animal) always show.
  const kindsOf = speciesWhere(req);
  let rows = db.prepare(`
    SELECT e.id, e.kind, e.dog_id, d.name AS dog_name, d.photo_url, d.species,
           d.blue_markers, d.poo_status, d.star_flag, d.pb_flag,
           e.title, e.detail, e.occurred_at
    FROM shelter_events e
    LEFT JOIN dogs d ON d.shelter_buddy_id = e.dog_id
    WHERE e.kind IN (${kindList.map(() => '?').join(', ')}) AND e.occurred_at >= ?
      AND (d.shelter_buddy_id IS NULL OR d.${kindsOf.sql})
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ?
  `).all(...kindList, since, ...kindsOf.params, limit * 4);
  rows.forEach((r) => {
    if (r.dog_id) r.photo_url = cachedPhotoUrl(r.dog_id, r.photo_url);
    // No stickers for a species without them, same as serializeDog.
    if (r.species && !species.speciesInfo(r.species).stickers) Object.assign(r, { blue_markers: '[]', poo_status: 'none', star_flag: 0, pb_flag: 0 });
  });

  let prefEnabled = false;
  let walkedDogIds = new Set();
  let favoriteDogIds = new Set();
  let lastSeenAt = null;
  if (userId) {
    const prefs = getUserPrefs(userId);
    prefEnabled = prefs.adopted_walked_dog;
    walkedDogIds = new Set(
      db.prepare('SELECT DISTINCT dog_id FROM walks WHERE user_id = ? AND ended_at IS NOT NULL').all(userId).map((r) => r.dog_id)
    );
    favoriteDogIds = new Set(
      db.prepare('SELECT dog_id FROM favorite_dogs WHERE user_id = ?').all(userId).map((r) => r.dog_id)
    );
    // A favorite's own news always shows, even in a category hidden here,
    // and so does a kind picked on the feed's type chips (asked for outright).
    if (!kinds.length) rows = rows.filter((r) => prefs[`show_${r.kind}`] !== false || favoriteDogIds.has(r.dog_id));
    const userRow = db.prepare('SELECT updates_last_seen_at FROM users WHERE id = ?').get(userId);
    lastSeenAt = userRow ? userRow.updates_last_seen_at : null;
  }
  // ISO 8601 strings compare correctly with plain string ordering, so this
  // needs no date parsing. Counted before slicing to `limit` so paging the
  // feed down the road wouldn't quietly undercount older unread events.
  const unreadCount = lastSeenAt ? rows.filter((r) => r.occurred_at > lastSeenAt).length : rows.length;
  rows = rows.slice(0, limit);
  rows.forEach((r) => {
    r.personalHighlight = !!(r.kind === 'adopted' && prefEnabled && r.dog_id && walkedDogIds.has(r.dog_id));
    r.favorite = !!(r.dog_id && favoriteDogIds.has(r.dog_id));
    r.unread = lastSeenAt ? r.occurred_at > lastSeenAt : true;
  });
  res.json({ updates: rows, unreadCount });
});

// Lightweight badge-count check -- called on app init/tab switches without
// paying for the full feed query and prefs filtering above.
app.get('/api/updates/unread-count', (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const userRow = db.prepare('SELECT updates_last_seen_at FROM users WHERE id = ?').get(userId);
  const lastSeenAt = userRow ? userRow.updates_last_seen_at : null;
  const kindsOf = speciesWhere(req);
  const count = db.prepare(`
    SELECT COUNT(*) AS c FROM shelter_events e LEFT JOIN dogs d ON d.shelter_buddy_id = e.dog_id
    WHERE e.kind != 'removed' AND e.occurred_at > ? AND (d.shelter_buddy_id IS NULL OR d.${kindsOf.sql})
  `).get(lastSeenAt || '', ...kindsOf.params).c;
  res.json({ count });
});

// Marks everything up to now as seen -- called once the Updates tab has
// actually been opened and rendered, not on every poll.
app.put('/api/users/:id/updates-seen', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET updates_last_seen_at = ? WHERE id = ?').run(now, id);
  res.json({ seenAt: now });
});

// ---- Walks ----
app.get('/api/walks/active', (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  enforceWalkLimits(); // don't report a walk as running past its deadline
  const row = db.prepare(`
    SELECT w.*, d.name AS dog_name, d.photo_url, d.date_in_shelter
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.ended_at IS NULL AND w.user_id = ? ORDER BY w.started_at DESC LIMIT 1
  `).get(userId);
  if (row) {
    row.photo_url = cachedPhotoUrl(row.dog_id, row.photo_url);
    row.stopsAt = walkStopsAt(row);
    row.closesAt = closesAtFor(row);
  }
  // No walk going, but one ended recently and its end screen was never
  // finished: the app shows that screen again. Either the time limit
  // stopped it (auto_stopped: the walker says when it really ended), or End
  // was tapped (it ended then; only the notes are left).
  const wrapUp = row ? null : db.prepare(`
    SELECT id, dog_id, location, started_at, ended_at, activity, auto_stopped FROM walks
    WHERE user_id = ? AND wrap_up_pending = 1 AND ended_at > ?
    ORDER BY started_at DESC LIMIT 1
  `).get(userId, new Date(Date.now() - WRAP_UP_HOURS * 3600000).toISOString());
  if (wrapUp) {
    wrapUp.closesAt = closesAtFor(wrapUp);
    wrapUp.autoStopped = !!wrapUp.auto_stopped;
    delete wrapUp.auto_stopped;
  }
  // ?walkId=: the walk this device is showing. walkMissing says it's gone
  // (deleted or cancelled on another device), so the app can stop showing
  // it rather than guess it was ended. Only this user's own walks count.
  const askedId = parseInt(req.query.walkId, 10);
  const walkMissing = askedId > 0
    ? !db.prepare('SELECT 1 FROM walks WHERE id = ? AND user_id = ?').get(askedId, userId)
    : undefined;
  res.json({ walk: row || null, wrapUp: wrapUp || null, ...(walkMissing !== undefined ? { walkMissing } : {}) });
});

const MAX_STAND_INS_PER_DAY = 3;
app.post('/api/walks/start', (req, res) => {
  const { dogId, location, userId } = req.body;
  if (!dogId || !userId) {
    return res.status(400).json({ error: 'dogId and userId are required' });
  }
  if (!activityFrom(req.body.activity)) return res.status(400).json({ error: `activity must be one of: ${ACTIVITIES.join(', ')}` });
  const hoursError = walkHours.walkHoursError(new Date().toISOString(), null);
  if (hoursError) return res.status(409).json({ error: hoursError });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  let dog = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  // A kennel card the shelter's listing doesn't have yet: walk them on the
  // card's Animal ID through a stand-in row (see awaiting_listing in db.js).
  // The walker says which species the card is for; the listing corrects it.
  if (!dog && req.body.unlisted === true && looksLikeAnimalId(Number(dogId))) {
    const kind = species.validSpecies(req.body.species) ? req.body.species : species.DEFAULT_SPECIES;
    // Checked before the stand-in is made, so a start that's refused anyway
    // doesn't leave one behind.
    if (db.prepare('SELECT 1 FROM walks WHERE ended_at IS NULL AND user_id = ?').get(userId)) {
      return res.status(409).json({ error: 'You already have a walk in progress' });
    }
    if (location != null && String(location).trim() !== '' && !kennelLetter(location, kind)) {
      return res.status(400).json({ error: kennelLetterError(kind) });
    }
    // At most MAX_STAND_INS_PER_DAY new stand-ins per walker per shelter day:
    // each is a "Dog #N" row anyone can see, so it can't be made in bulk.
    const todayKey = statsBreakdown.shelterDateKey(new Date().toISOString());
    const recentStandIns = db.prepare(`
      SELECT DISTINCT d.shelter_buddy_id, d.first_seen_at FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE w.user_id = ? AND d.awaiting_listing = 1 AND d.first_seen_at >= ?
    `).all(userId, new Date(Date.now() - 36 * 3600000).toISOString())
      .filter((d) => statsBreakdown.shelterDateKey(d.first_seen_at) === todayKey);
    if (recentStandIns.length >= MAX_STAND_INS_PER_DAY) {
      return res.status(429).json({ error: `You can walk up to ${MAX_STAND_INS_PER_DAY} animals that aren't listed yet in a day. Ask staff if more kennel cards are missing from the listing.` });
    }
    const nowIso = new Date().toISOString();
    db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, still_listed, awaiting_listing, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, 0, 1, ?, ?)`).run(Number(dogId), `${species.speciesInfo(kind).label} #${Number(dogId)}`, kind, nowIso, nowIso);
    dog = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  }
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  const activity = activityForAnimal(req.body.activity, dog);
  if (!activity) return res.status(400).json({ error: activityError(dog) });
  // A dog off the listing (say, just returned, before the shelter's site
  // catches up) can still be walked: the walk is filed under their ID like
  // any other, and the scraper treats them as a return when they reappear.

  const ageMonths = parseAgeMonths(dog.age);
  if (species.speciesInfo(dog.species).levelRules && ageMonths != null && ageMonths < MIN_WALK_AGE_MONTHS) {
    return res.status(403).json({ error: `${dog.name} is too young to walk (${dog.age}). Puppies under 6 months old can't be walked, no exceptions.` });
  }

  // A dog not cleared for this volunteer's level can't be started at all --
  // a hard rule enforced here, not just a caution the UI shows and lets you
  // click past. Checked against the dog's current row, i.e. after any
  // marker change (PB, blue stickers, ...) the walker just saved, so a
  // change that allows or blocks this walk is always checked with its own
  // effect already in place.
  // Listed as in foster is the exception: the walker has the kennel card in
  // hand, so the listing is what's out of date (the app has them check).
  const { eligible, notEligibleReason } = dogEligibility(dog, resolveExperienceLevel(userId));
  if (eligible === false && notEligibleReason !== 'in_foster') {
    return res.status(403).json({
      error: `${dog.name} isn't cleared to walk at your experience level right now.`,
      notEligibleReason
    });
  }

  // Per-user, not global — two different people can each have their own
  // walk going at the same time. But the same dog can't be walked by two
  // people at once.
  const existingActive = db.prepare('SELECT id FROM walks WHERE ended_at IS NULL AND user_id = ?').get(userId);
  if (existingActive) {
    return res.status(409).json({ error: 'You already have a walk in progress', walkId: existingActive.id });
  }
  const dogAlreadyOut = db.prepare(`
    SELECT w.id, CASE WHEN u.hide_name_while_walking = 1 THEN 'a volunteer' ELSE u.name END AS user_name
    FROM walks w JOIN users u ON u.id = w.user_id
    WHERE w.ended_at IS NULL AND w.dog_id = ?
  `).get(dogId);
  if (dogAlreadyOut) {
    return res.status(409).json({ error: `${dog.name} is already out with ${dogAlreadyOut.user_name}` });
  }

  // Location is optional -- if it's left blank, leave the dog's existing
  // kennel letter (if any) alone rather than overwriting it with nothing.
  const hasLocation = location != null && String(location).trim() !== '';
  const trimmedLocation = hasLocation ? kennelLetter(location, dog.species) : '';
  if (hasLocation && !trimmedLocation) {
    return res.status(400).json({ error: kennelLetterError(dog.species) });
  }
  if (trimmedLocation) setKennelLocation(dogId, trimmedLocation);

  // Out with the next dog: any stopped walk still waiting for its real end
  // time keeps the time-limit end (it can still be fixed in Stats).
  db.prepare('UPDATE walks SET wrap_up_pending = 0 WHERE user_id = ? AND wrap_up_pending = 1').run(userId);
  const startedAt = new Date().toISOString();
  let info;
  try {
    info = db.prepare(`
      INSERT INTO walks (dog_id, location, started_at, user_id, activity) VALUES (?, ?, ?, ?, ?)
    `).run(dogId, trimmedLocation || null, startedAt, userId, activity);
  } catch (err) {
    // Two taps racing past the checks above: the one-open-walk indexes (db.js) catch it.
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'A walk is already in progress for you or this dog.' });
    throw err;
  }

  const finalLocation = trimmedLocation || dog.kennel_location || null;
  // A standing reminder that survives the phone locking/the app being
  // closed -- the whole reason this app has real push, not just an in-app
  // feed. Fire-and-forget: a failed push should never fail starting a walk.
  if (push.hasPref(userId, 'walk_started')) {
    // Shelter's local time, not the server's (server runs in UTC) -- same
    // timezone used for the scraper's cron schedule elsewhere in this file.
    const startTimeLabel = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York'
    }).format(new Date(startedAt));
    // Location and start time are baked into the title itself, not just the
    // body -- some platforms only surface the title in a collapsed
    // lock-screen banner, which was making both look like they never showed.
    push.sendPushToUser(userId, {
      title: finalLocation ? `${dog.name} - Return to: ${finalLocation}` : dog.name,
      body: `Started ${startTimeLabel}${finalLocation ? ` · Return to: ${finalLocation}` : ''}`,
      url: '/',
      tag: WALK_PUSH_TAG
    }, { TTL: 30 * 60, urgency: 'high' }).catch(() => {});
  }

  res.json({
    walkId: info.lastInsertRowid,
    dogId,
    location: finalLocation,
    startedAt,
    stopsAt: walkStopsAt({ started_at: startedAt, extend_minutes: 0, activity }),
    closesAt: closesAtFor({ started_at: startedAt, activity }),
    autoStopMinutes: walkLimitMinutes({ extend_minutes: 0, activity })
  });
});

// "I'm still walking": adds time before the automatic stop.
app.post('/api/walks/:id/extend', (req, res) => {
  const id = parseInt(req.params.id, 10);
  enforceWalkLimits();
  const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  if (walkAccessDenied(req, res, walk)) return;
  if (walk.ended_at) {
    return res.status(409).json({ error: walk.auto_stopped ? 'This walk already stopped automatically. You can fix its time in Stats.' : 'This walk has already ended.', autoStopped: !!walk.auto_stopped });
  }
  if (walk.activity === 'daycation') {
    return res.status(409).json({ error: `Daycations already run up to ${DAYCATION_MINUTES / 60} hours, so there's no time to add.` });
  }
  if (new Date(walkStopsAt(walk)).getTime() === walkClosesMs(walk)) {
    return res.status(409).json({ error: `The shelter closes at ${walkHours.walkWindow(walk.started_at).closeLabel}, so this one can't go any longer.` });
  }
  if (walkLimitMinutes(walk) + EXTEND_MINUTES > MAX_TOTAL_MINUTES) {
    return res.status(409).json({ error: `Walks can be extended up to ${MAX_TOTAL_MINUTES / 60} hours in total.` });
  }
  db.prepare('UPDATE walks SET extend_minutes = extend_minutes + ?, warned = 0 WHERE id = ?').run(EXTEND_MINUTES, id);
  const updated = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  res.json({ walkId: id, stopsAt: walkStopsAt(updated), addedMinutes: EXTEND_MINUTES });
});

// Ending a walk by hand: it ended when End Walk was tapped (endTappedAt),
// not when the notes were saved. That's also true if the time limit ran out
// while the notes were being typed.
//
// Wrapping up a walk the time limit stopped (wrap_up_pending): the walker
// gets the same end screen, and says when it really ended -- endedAt, any
// time from the start up to now (walks top out at MAX_TOTAL_MINUTES), or
// left out to keep the time-limit end. A changed time marks the walk as
// edited, keeping the time-limit end as the original.
app.put('/api/walks/:id/end', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { notes } = req.body;
  const noteError = walkNoteError(notes);
  if (noteError) return res.status(400).json({ error: noteError });
  const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  if (walkAccessDenied(req, res, walk)) return;
  const now = Date.now();
  const handEndLimit = Math.min(now, new Date(walkStopsAt(walk)).getTime());
  // finishLater: the app's End button. The walk ends now, and its end
  // screen (notes) is saved afterwards through PUT /api/walks/:id with
  // wrapUpDone -- until then wrap_up_pending brings that screen back when
  // the app is reopened. A tap after the time limit already stopped it (or
  // after it ended some other way) is not a hand end: the 409 below sends
  // the app to that walk's own end screen.
  const finishLater = req.body.finishLater === true;
  // A tap "in the future" on a walk that's still going is a phone clock
  // running fast: it meant now, so the server's now it is (never refused --
  // End must always work). Hand-picked times in edits are still checked.
  let sentEnd = req.body.endTappedAt;
  if (sentEnd && !walk.ended_at) {
    const sentMs = new Date(sentEnd).getTime();
    if (Number.isFinite(sentMs) && sentMs > now) sentEnd = new Date(handEndLimit).toISOString();
  }
  let tapped = sentEnd ? walkEndTime(sentEnd, walk.started_at, handEndLimit) : null;
  if (tapped && tapped.error) {
    if (!(finishLater && walk.ended_at)) return res.status(400).json({ error: tapped.error });
    tapped = null;
  }
  const endedByHand = !walk.ended_at || (walk.auto_stopped && tapped && new Date(tapped.iso) < new Date(walk.ended_at));
  const wrappingUp = !endedByHand && !finishLater && walk.auto_stopped && walk.wrap_up_pending;
  if (!endedByHand && !wrappingUp) {
    return res.status(409).json({
      error: walk.auto_stopped ? `This walk was stopped automatically after ${Math.round(walk.duration_seconds / 60)} minutes.` : 'Walk already ended',
      autoStopped: !!walk.auto_stopped,
      alreadyEnded: true,
      wrapUpPending: !!walk.wrap_up_pending,
      endedAt: walk.ended_at,
      durationSeconds: walk.duration_seconds
    });
  }

  let endedAt;
  let recordedEnd;
  if (endedByHand) {
    endedAt = tapped ? tapped.iso : new Date(handEndLimit).toISOString();
    recordedEnd = endedAt;
  } else {
    const daycation = walk.activity === 'daycation';
    const closesMs = daycation ? Infinity : walkClosesMs(walk);
    const maxMinutes = daycation ? DAYCATION_MINUTES : MAX_TOTAL_MINUTES;
    const latest = Math.min(now, new Date(walk.started_at).getTime() + maxMinutes * 60000, closesMs);
    // A walk can't run past closing, so "just now" (or any time) after it
    // means it ended at closing.
    const sentMs = req.body.endedAt ? new Date(req.body.endedAt).getTime() : NaN;
    const sent = Number.isFinite(sentMs) && sentMs > closesMs && closesMs <= now ? new Date(closesMs).toISOString() : req.body.endedAt;
    const picked = sent
      ? walkEndTime(sent, walk.started_at, latest, `${daycation ? 'Daycations' : 'Walks'} can't be longer than ${maxMinutes / 60} hours.`)
      : { iso: walk.ended_at };
    if (picked.error) return res.status(400).json({ error: picked.error });
    endedAt = picked.iso;
    recordedEnd = walk.ended_at;
  }
  const durationSeconds = Math.max(0, Math.round((new Date(endedAt) - new Date(walk.started_at)) / 1000));
  const edited = endedAt !== recordedEnd;
  const autoStopped = wrappingUp ? 1 : 0;
  // A note sent along is kept; ending without one (finishLater) keeps any
  // already there rather than blanking it.
  const cleanNotes = notes ? tags.clean(String(notes).trim(), walk.dog_id) : (finishLater ? walk.notes : null);

  db.prepare(`
    UPDATE walks SET ended_at = ?, duration_seconds = ?, notes = ?, auto_stopped = ?, wrap_up_pending = ?,
           edited = CASE WHEN ? THEN 1 ELSE edited END,
           original_started_at = CASE WHEN ? THEN COALESCE(original_started_at, started_at) ELSE original_started_at END,
           original_ended_at = CASE WHEN ? THEN COALESCE(original_ended_at, ?) ELSE original_ended_at END
    WHERE id = ?
  `).run(endedAt, durationSeconds, cleanNotes, autoStopped, finishLater ? 1 : 0, edited ? 1 : 0, edited ? 1 : 0, edited ? 1 : 0, recordedEnd, id);

  const levelUp = !!req.me && walk.user_id === req.me.id && levelUpOffer(req.me.id);
  res.json({ walkId: id, endedAt, durationSeconds, edited, autoStopped: !!autoStopped, levelUpOffer: levelUp });
});

// Correct a walk's recorded times after the fact (you forgot to end it
// promptly, mis-tapped, etc). Only touches fields actually sent.
app.put('/api/walks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  if (walkAccessDenied(req, res, walk)) return;
  // Times are stored only as toISOString() (UTC, milliseconds, Z), so every
  // range and order query that compares them as text stays right.
  let startedAt = walk.started_at;
  if (req.body.startedAt !== undefined && req.body.startedAt !== null && req.body.startedAt !== '') {
    startedAt = isoTime(req.body.startedAt);
    if (!startedAt) return res.status(400).json({ error: 'That start time is not a valid time.' });
  }
  let endedAt = walk.ended_at;
  if (req.body.endedAt !== undefined) {
    if (req.body.endedAt === null || req.body.endedAt === '') {
      // A finished walk can't be turned back into one that's still going.
      if (walk.ended_at) return res.status(400).json({ error: "A finished walk can't be reopened. Pick its end time instead." });
      endedAt = null;
    } else {
      endedAt = isoTime(req.body.endedAt);
      if (!endedAt) return res.status(400).json({ error: 'That end time is not a valid time.' });
    }
  }
  const animal = db.prepare('SELECT species FROM dogs WHERE shelter_buddy_id = ?').get(walk.dog_id);
  // A kennel letter, the same as everywhere else (or blank for none).
  let location = walk.location;
  if (req.body.location !== undefined) {
    const raw = req.body.location == null ? '' : String(req.body.location).trim();
    location = raw ? kennelLetter(raw, animal && animal.species) : null;
    if (raw && !location) return res.status(400).json({ error: kennelLetterError(animal && animal.species) });
  }
  const noteError = walkNoteError(req.body.notes);
  if (noteError) return res.status(400).json({ error: noteError });
  const notes = req.body.notes !== undefined ? (req.body.notes ? tags.clean(String(req.body.notes).trim(), walk.dog_id) : null) : walk.notes;
  const activity = req.body.activity !== undefined ? activityForAnimal(req.body.activity, animal) : walk.activity;
  if (!activity) return res.status(400).json({ error: activityError(animal) });
  // Only a real change to the times counts as an edit — re-saving the same
  // values (e.g. opening the editor and tapping Save without changing
  // anything) must not flip the "Edited" badge on. Compared as instants, so
  // the same time written another way isn't a change either.
  const timesChanged = !sameInstant(startedAt, walk.started_at) || !sameInstant(endedAt, walk.ended_at);
  if (!timesChanged) { startedAt = walk.started_at; endedAt = walk.ended_at; }
  if (endedAt && timesChanged) {
    const checked = walkEndTime(endedAt, startedAt, Date.now());
    if (checked.error) return res.status(400).json({ error: checked.error });
  }
  // One still going can only have its start moved earlier (a late scan), and
  // never into the future: a future start would never stop on its own.
  if (!endedAt && timesChanged) {
    const startMs = new Date(startedAt).getTime();
    if (startMs > Date.now() + CLOCK_SKEW_MS) return res.status(400).json({ error: "The start time can't be in the future." });
    if (startMs > new Date(walk.started_at).getTime()) return res.status(400).json({ error: 'A walk that is still going can only have its start moved earlier.' });
  }
  if (endedAt && (timesChanged || activity !== walk.activity)) {
    const lengthError = walkLengthError(activity, startedAt, endedAt);
    if (lengthError) return res.status(400).json({ error: lengthError });
  }
  // Switching what an open walk is mid-way: a daycation's 12 hours can't
  // turn into a walk that's already past a walk's limit.
  if (!walk.ended_at && activity !== walk.activity && Date.now() >= new Date(walkStopsAt({ ...walk, activity })).getTime()) {
    return res.status(409).json({ error: `This has already gone past the time limit for a ${activity}. End it instead, then fix it in Stats if needed.` });
  }
  if (timesChanged || activity !== walk.activity) {
    const hoursError = walkHoursErrorFor(activity, startedAt, endedAt);
    if (hoursError) return res.status(400).json({ error: hoursError });
  }
  if (timesChanged || activity !== walk.activity) {
    const overlap = walkOverlapError({ userId: walk.user_id, dogId: walk.dog_id, activity, startedAt, endedAt, exceptId: id });
    if (overlap) return res.status(409).json({ error: overlap });
  }
  const durationSeconds = endedAt
    ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000))
    : null;
  // Preserve the true original the first time it's ever edited; later edits
  // don't overwrite it, so it always reflects what was originally scanned.
  const originalStartedAt = timesChanged && walk.original_started_at == null ? walk.started_at : walk.original_started_at;
  const originalEndedAt = timesChanged && walk.original_ended_at == null ? walk.ended_at : walk.original_ended_at;
  db.prepare(`
    UPDATE walks SET started_at = ?, ended_at = ?, location = ?, notes = ?, duration_seconds = ?, activity = ?,
           edited = CASE WHEN ? THEN 1 ELSE edited END,
           original_started_at = ?, original_ended_at = ?
    WHERE id = ?
  `).run(startedAt, endedAt, location, notes, durationSeconds, activity, timesChanged ? 1 : 0, originalStartedAt, originalEndedAt, id);
  // wrapUpDone: the end screen of a walk ended with End (finishLater on
  // /end) was saved or skipped, so reopening the app no longer brings it back.
  const wrapUpDone = req.body.wrapUpDone === true && !!endedAt;
  if (wrapUpDone) db.prepare('UPDATE walks SET wrap_up_pending = 0 WHERE id = ?').run(id);
  // Still going: the time limit depends on the activity, so send it back.
  const running = endedAt ? null : { ...walk, started_at: startedAt, activity };
  res.json({
    id, startedAt, endedAt, location, notes, durationSeconds, activity, edited: timesChanged || !!walk.edited,
    stopsAt: running ? walkStopsAt(running) : undefined,
    closesAt: running ? closesAtFor(running) : undefined,
    levelUpOffer: wrapUpDone && !!req.me && walk.user_id === req.me.id ? levelUpOffer(req.me.id) : undefined
  });
});

// Log a walk that already happened but was never entered live (forgot to
// scan someone in, catching up on a paper log, etc). Requires both times —
// this always represents a completed walk, never an in-progress one, so it
// can't collide with the single-active-walk-per-user rule. It can't be longer
// than a live one could run, or overlap another of this walker's walks or
// another walk with the same dog.
app.post('/api/walks/manual', (req, res) => {
  const { userId, location, notes } = req.body;
  const noteError = walkNoteError(notes);
  if (noteError) return res.status(400).json({ error: noteError });
  const dogId = positiveInt(req.body.dogId);
  if (!dogId || !userId || !req.body.startedAt || !req.body.endedAt) {
    return res.status(400).json({ error: 'dogId, userId, startedAt, and endedAt are all required' });
  }
  const startedAt = isoTime(req.body.startedAt);
  const endedAt = isoTime(req.body.endedAt);
  if (!startedAt) return res.status(400).json({ error: 'That start time is not a valid time.' });
  if (!endedAt) return res.status(400).json({ error: 'That end time is not a valid time.' });
  const dog = db.prepare('SELECT shelter_buddy_id, species FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  const checked = walkEndTime(endedAt, startedAt, Date.now());
  if (checked.error) return res.status(400).json({ error: checked.error });
  const activity = activityForAnimal(req.body.activity, dog);
  if (!activity) return res.status(400).json({ error: activityError(dog) });
  const lengthError = walkLengthError(activity, startedAt, endedAt);
  if (lengthError) return res.status(400).json({ error: lengthError });
  const hoursError = walkHoursErrorFor(activity, startedAt, endedAt);
  if (hoursError) return res.status(400).json({ error: hoursError });
  const rawLocation = location == null ? '' : String(location).trim();
  const cleanLocation = rawLocation ? kennelLetter(rawLocation, dog.species) : null;
  if (rawLocation && !cleanLocation) return res.status(400).json({ error: kennelLetterError(dog.species) });
  const overlap = walkOverlapError({ userId: user.id, dogId, activity, startedAt, endedAt });
  if (overlap) return res.status(409).json({ error: overlap });
  const durationSeconds = Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  const info = db.prepare(`
    INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, notes, manual_entry, activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(dogId, user.id, cleanLocation, startedAt, endedAt, durationSeconds, notes ? tags.clean(String(notes).trim(), dogId) : null, activity);
  res.json({ id: info.lastInsertRowid });
});

// Also doubles as "cancel this walk" for one still in progress (started but
// not ended yet) -- a hard delete either way, since an unended walk never
// counted toward anyone's stats or "already walked" status in the first
// place (every such query below filters on ended_at IS NOT NULL).
app.delete('/api/walks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  if (walkAccessDenied(req, res, walk)) return;
  db.prepare('DELETE FROM walks WHERE id = ?').run(id);
  // A kennel-card stand-in ("Dog #N", awaiting_listing) whose only walk this
  // was goes too, unless someone has left a note on it since.
  db.prepare(`
    DELETE FROM dogs WHERE shelter_buddy_id = ? AND awaiting_listing = 1
      AND NOT EXISTS (SELECT 1 FROM walks WHERE dog_id = ?)
      AND NOT EXISTS (SELECT 1 FROM dog_notes WHERE dog_id = ?)
      AND NOT EXISTS (SELECT 1 FROM playgroup_notes WHERE dog_id = ?)
  `).run(walk.dog_id, walk.dog_id, walk.dog_id, walk.dog_id);
  res.json({ id, deleted: true });
});

app.get('/api/walks', (req, res) => {
  const dogId = req.query.dogId ? parseInt(req.query.dogId, 10) : null;
  const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  const limit = clampLimit(req.query.limit, 1000);
  const conditions = [];
  const params = [];
  if (dogId) { conditions.push('w.dog_id = ?'); params.push(dogId); }
  if (userId) { conditions.push('w.user_id = ?'); params.push(userId); }
  // ?ended=1: finished walks only (charts and averages leave out the one
  // still going).
  if (req.query.ended === '1') conditions.push('w.ended_at IS NOT NULL');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  // The walk-limit bookkeeping columns (warned, alerted_minutes, ...) stay out.
  const rows = db.prepare(`
    SELECT w.id, w.dog_id, w.user_id, w.location, w.started_at, w.ended_at, w.duration_seconds, w.notes,
           w.activity, w.manual_entry, w.edited, w.auto_stopped, w.original_started_at, w.original_ended_at,
           d.name AS dog_name, d.photo_url, d.breed, d.species, d.tags,
           d.blue_markers, d.poo_status, d.star_flag, d.pb_flag
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    ${where} ORDER BY w.started_at DESC LIMIT ?
  `).all(...params, limit);
  const pooAt = statsBreakdown.pooResolver(db, rows.map((r) => r.dog_id));
  rows.forEach((r) => {
    r.photo_url = cachedPhotoUrl(r.dog_id, r.photo_url);
    // For the Stats tab's breakdowns: POO as it was when the walk started
    // (statsBreakdown.js), and whether the animal is a kitten.
    const kind = species.speciesInfo(r.species);
    r.poo_then = kind.stickers ? pooAt(r.dog_id, r.started_at) : null;
    r.is_young = species.isYoung(r);
    delete r.tags;
    if (!kind.stickers) Object.assign(r, { blue_markers: '[]', poo_status: 'none', star_flag: 0, pb_flag: 0 });
  });
  res.json({ walks: rows, tagged: tags.namesFor(rows.map((r) => r.notes)) });
});

// Every completed walk (any user) whose started_at falls in a UTC range —
// used to build the Available list's per-dog "walked this time slot today"
// grid. The client computes the range from ITS OWN local midnight-to-midnight
// so day boundaries land correctly regardless of server timezone.
app.get('/api/walks/for-day', (req, res) => {
  const { dateKey } = req.query;
  // Real times, in order, at most 48 hours apart (a day, with room for any
  // time zone); anything else could ask for every walk ever.
  const fromUtc = isoTime(req.query.fromUtc);
  const toUtc = isoTime(req.query.toUtc);
  if (!fromUtc || !toUtc) return res.status(400).json({ error: 'fromUtc and toUtc are required' });
  const spanMs = new Date(toUtc) - new Date(fromUtc);
  if (spanMs <= 0 || spanMs > 48 * 3600000) return res.status(400).json({ error: 'fromUtc to toUtc must be a range of up to 48 hours.' });
  // Only what the grid draws: which walk window (SHELTER_SLOTS) each dog was
  // out in, once per dog and window. No times, lengths or counts, which
  // would be everyone's walks one by one and undo Together's "fewer than 3".
  const seen = new Set();
  const rows = [];
  for (const w of db.prepare(`
    SELECT dog_id, started_at FROM walks WHERE ended_at IS NOT NULL AND started_at >= ? AND started_at < ?
  `).all(fromUtc, toUtc)) {
    const slotIndex = shelterSlotIndex(w.started_at);
    const key = `${w.dog_id}|${slotIndex}`;
    if (slotIndex < 0 || seen.has(key)) continue;
    seen.add(key);
    rows.push({ dog_id: w.dog_id, slotIndex });
  }
  rows.sort((a, b) => a.dog_id - b.dog_id || a.slotIndex - b.slotIndex);
  // Manual checkoffs (a walk that happened but wasn't scanned in) fill a
  // slot too, so the grid/"needs a walk this shift" filter don't treat an
  // attended dog as neglected just because it wasn't scanned.
  const key = validDateKey(dateKey);
  const manualCheckoffs = key
    ? db.prepare('SELECT dog_id, slot_index AS slotIndex FROM manual_shift_checkoffs WHERE date_key = ?').all(key)
    : [];
  res.json({ walks: rows, manualCheckoffs });
});

// Reassign which user a past walk should be attributed to — useful for
// backfilling walks that were recorded under the wrong person (e.g. before
// multi-user support existed, everything defaulted to one account). Staff and
// privileged admins only, by hand (no page calls it); it moves a walk and
// never reads anyone's data back, so it stays.
app.put('/api/walks/:id/user', (req, res) => {
  if (!isStaffOrPrivileged(req, req.me)) return res.status(403).json({ error: 'Only staff can reassign a walk.' });
  const id = parseInt(req.params.id, 10);
  const userId = Number(req.body.targetUserId);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  const walk = db.prepare('SELECT id, dog_id, activity, started_at, ended_at FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  // Same rules as any other walk of theirs: one in progress at a time, and
  // no two entries of theirs at the same time.
  if (!walk.ended_at && db.prepare('SELECT 1 FROM walks WHERE user_id = ? AND ended_at IS NULL AND id != ?').get(userId, id)) {
    return res.status(409).json({ error: 'That volunteer already has a walk in progress.' });
  }
  // (dogId -1: only their own entries count here; the dog's other walkers
  // are whoever they already were.)
  if (walkOverlapError({ userId, dogId: -1, activity: walk.activity, startedAt: walk.started_at, endedAt: walk.ended_at, exceptId: id })) {
    return res.status(409).json({ error: 'That volunteer already has another entry at the same time.' });
  }
  db.prepare('UPDATE walks SET user_id = ? WHERE id = ?').run(userId, id);
  res.json({ id, userId });
});

// ---- Stats (personal to each user) ----
// "totalWalks"/"totalSeconds" are every kind of interaction added together
// (a walk, a cuddle, a playgroup turn, a 12-hour daycation -- all count the
// same toward "time spent with them"). But averaging duration across all of
// those lumps a 10-minute cuddle in with a 12-hour daycation, so the average
// is walk-only when the volunteer has any walks, falling back to their
// overall average otherwise (a cat volunteer never has a 'walk' row).
//
// ?species=dog|cat narrows everything to one species (anything else: both).
// Breakdowns (statsBreakdown.js) ride along: bySpecies (always both, so the
// app can show the split), byActivity, byPoo (dogs, POO as it was at the
// time), byAge (kittens / adult cats), and shelterNow -- what's listed right
// now and how many of those this volunteer engaged with today.
app.get('/api/stats', (req, res) => {
  const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  // An optional filter down to one activity, for the "by activity" drill-down.
  const activity = ACTIVITIES.includes(req.query.activity) ? req.query.activity : null;
  const filter = statsBreakdown.speciesFilter(req.query.species);
  const kinds = statsBreakdown.filterKinds(filter);
  const kindSql = `d.species IN (${kinds.map(() => '?').join(', ')})`;
  const where = `w.ended_at IS NOT NULL AND w.user_id = ? AND ${kindSql}${activity ? ' AND w.activity = ?' : ''}`;
  const params = [userId, ...kinds, ...(activity ? [activity] : [])];

  const totals = db.prepare(`
    SELECT COUNT(*) AS totalWalks, COUNT(DISTINCT w.dog_id) AS uniqueDogs,
           COALESCE(SUM(w.duration_seconds), 0) AS totalSeconds,
           COALESCE(AVG(CASE WHEN w.duration_seconds >= ${statsBreakdown.MIN_AVG_SECONDS} THEN w.duration_seconds END), 0) AS avgAllSeconds
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id WHERE ${where}
  `).get(...params);
  // Averages (here and below) leave out anything under a minute: an
  // accidental scan ended right away isn't a short walk.

  // Already scoped to one activity (the "by activity" drill-down): its own
  // average is exactly what the label says, no walk-only substitution needed.
  if (activity) {
    totals.avgSeconds = totals.avgAllSeconds;
  } else {
    const walkOnly = db.prepare(`
      SELECT COUNT(*) AS walkCount, COALESCE(AVG(w.duration_seconds), 0) AS avgSeconds
      FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
      WHERE w.ended_at IS NOT NULL AND w.user_id = ? AND ${kindSql} AND w.activity = 'walk'
        AND w.duration_seconds >= ${statsBreakdown.MIN_AVG_SECONDS}
    `).get(userId, ...kinds);
    totals.avgSeconds = walkOnly.walkCount > 0 ? walkOnly.avgSeconds : totals.avgAllSeconds;
  }
  delete totals.avgAllSeconds;

  const perDog = db.prepare(`
    SELECT d.shelter_buddy_id AS id, d.name, d.photo_url, d.still_listed AS stillListed,
           d.removed_at AS removedAt, d.species,
           d.blue_markers, d.poo_status, d.star_flag, d.pb_flag,
           COUNT(w.id) AS walkCount, MAX(w.started_at) AS lastWalkedAt,
           COALESCE(SUM(w.duration_seconds), 0) AS totalSeconds
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE ${where}
    GROUP BY d.shelter_buddy_id
    ORDER BY walkCount DESC, lastWalkedAt DESC
  `).all(...params);
  perDog.forEach((r) => {
    r.photo_url = cachedPhotoUrl(r.id, r.photo_url);
    r.stillListed = !!r.stillListed;
    if (!species.speciesInfo(r.species).stickers) Object.assign(r, { blue_markers: '[]', poo_status: 'none', star_flag: 0, pb_flag: 0 });
  });

  // Every completed engagement of this volunteer's, for the breakdowns.
  const rows = db.prepare(`
    SELECT w.dog_id, w.activity, w.started_at, w.duration_seconds, d.species, d.tags
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.ended_at IS NOT NULL AND w.user_id = ?
  `).all(userId);
  const pooAt = statsBreakdown.pooResolver(db, rows.map((r) => r.dog_id));
  const inFilter = rows.filter((r) => kinds.includes(r.species) && (!activity || r.activity === activity));
  const { byActivity, byPoo, byAge } = statsBreakdown.breakdown(inFilter, pooAt);
  const { bySpecies } = statsBreakdown.breakdown(rows, pooAt);

  // Today in shelter time, including an engagement still under way.
  const todayKey = statsBreakdown.shelterDateKey(new Date().toISOString());
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const walkedIds = new Set(db.prepare('SELECT dog_id, started_at FROM walks WHERE user_id = ? AND started_at >= ?').all(userId, since)
    .filter((r) => statsBreakdown.shelterDateKey(r.started_at) === todayKey).map((r) => r.dog_id));
  const shelterNow = statsBreakdown.shelterNow(db, filter, { isWalkable: walkableFor(req), walkedIds });

  res.json({ species: filter, totals, perDog, byActivity, bySpecies, byPoo, byAge, shelterNow });
});

// ---- Manual scrape trigger ----
let scrapeInFlight = false;
app.post('/api/scrape/run', async (req, res) => {
  // Staff (from the login system) or privileged walkers only -- the Settings
  // button is hidden for everyone else, but hiding isn't enforcement.
  const user = resolveAuthedUser(req);
  if (req.headers['x-auth-staff'] !== '1' && !(user && user.isPrivileged)) {
    return res.status(403).json({ error: 'Only staff can refresh shelter data.' });
  }
  if (scrapeInFlight) return res.status(409).json({ error: 'Scrape already running' });
  scrapeInFlight = true;
  try {
    const result = await runScrape();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    scrapeInFlight = false;
  }
});

app.get('/api/scrape/status', (req, res) => {
  const row = db.prepare("SELECT MAX(last_seen_at) AS lastScrapeAt, COALESCE(SUM(species = 'dog'), 0) AS dogCount, COALESCE(SUM(species = 'cat'), 0) AS catCount FROM dogs WHERE still_listed = 1").get();
  res.json(row);
});

// Frontend errors, so a bug on someone's phone shows up in the server log
// (journalctl -u dogwalk) instead of only ever being seen by that one person.
// Capped so a broken page looping on an error can't flood the log.
let clientErrorWindowStart = Date.now();
let clientErrorCount = 0;
app.post('/api/client-error', (req, res) => {
  if (Date.now() - clientErrorWindowStart > 60000) { clientErrorWindowStart = Date.now(); clientErrorCount = 0; }
  if (clientErrorCount++ < 20) {
    const b = req.body || {};
    const clip = (v, n) => String(v == null ? '' : v).slice(0, n).replace(/\s+/g, ' ');
    console.warn(`[client-error] ${clip(b.message, 300)} | ${clip(b.source, 200)} | ${clip(b.stack, 500)} | ${clip(req.headers['user-agent'], 120)}`);
  }
  res.status(204).end();
});

// Liveness/health for the external monitor (see the shelterwalk-healthcheck
// timer on the droplet) -- hit directly on 127.0.0.1, so it never needs to
// pass the login gate. Exposes nothing beyond counts and timestamps.
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const lastRun = db.prepare('SELECT started_at AS startedAt, finished_at AS finishedAt, ok, dog_count AS dogCount, note FROM scrape_runs ORDER BY id DESC LIMIT 1').get() || null;
    const lastOk = db.prepare('SELECT finished_at AS finishedAt, dog_count AS dogCount FROM scrape_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() || null;
    const openWalks = db.prepare('SELECT COUNT(*) AS c FROM walks WHERE ended_at IS NULL').get().c;
    // A scrape that "succeeds" with no animals, or far fewer than usual, is
    // a problem too (the shelter's API changing shape looked exactly like
    // that): 503 so the health check emails, with the reason in `problems`.
    const problems = [];
    if (lastOk && lastOk.dogCount === 0) problems.push('the last successful scrape listed no animals');
    else if (lastOk && lastOk.dogCount != null) {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const counts = db.prepare('SELECT dog_count AS c FROM scrape_runs WHERE ok = 1 AND dog_count IS NOT NULL AND finished_at >= ? ORDER BY id DESC LIMIT 300').all(weekAgo).map((r) => r.c).sort((a, b) => a - b);
      const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
      if (counts.length >= 5 && lastOk.dogCount < median * 0.5) {
        problems.push(`the last successful scrape listed ${lastOk.dogCount} animals, under half the usual ${median}`);
      }
    }
    res.status(problems.length ? 503 : 200).json({
      ok: problems.length === 0,
      ...(problems.length ? { problems } : {}),
      uptimeSeconds: Math.round(process.uptime()),
      lastScrape: lastRun,
      lastSuccessfulScrapeAt: lastOk ? lastOk.finishedAt : null,
      openWalks
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public up/down check for outside monitoring (the homelab Uptime Kuma).
// Caddy lets /uptime through without signing in, so it says nothing but
// "ok" or "down": the app and its database answer, and the shelter data
// refreshed recently. The scraper runs every 30 minutes 6am-7:30pm, so the
// longest normal gap is overnight (about 10.5 hours).
const UPTIME_MAX_SCRAPE_AGE_HOURS = 13;
app.get('/uptime', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('text/plain');
  try {
    db.prepare('SELECT 1').get();
    const lastOk = db.prepare('SELECT finished_at AS finishedAt FROM scrape_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get();
    const fresh = process.env.DISABLE_SCRAPER
      || (lastOk && Date.now() - new Date(lastOk.finishedAt).getTime() < UPTIME_MAX_SCRAPE_AGE_HOURS * 3600000);
    if (!fresh) return res.status(503).send('down');
    res.send('ok');
  } catch (err) {
    res.status(503).send('down');
  }
});

// ---- Walk time limit ----
// A walk stops by itself after AUTO_STOP_MINUTES so a forgotten "End Walk"
// never ties up a dog or blocks that volunteer from starting the next one.
// The walker can add EXTEND_MINUTES at a time (before it stops) for a longer
// walk. A walk the system ended is flagged auto_stopped, and is recorded as
// running exactly to its limit -- not to whenever we noticed.
const AUTO_STOP_MINUTES = 45; // walks, cuddles, play group (was 30 until 2026-11-06, owner)
// Activities whose default limit isn't AUTO_STOP_MINUTES: matchmaking (meeting
// a possible adopter) usually runs longer than a walk (owner, 2026-11-06).
// +10 min and the 3-hour cap work the same way on top of it.
const ACTIVITY_LIMIT_MINUTES = { matchmaking: 60 };
const EXTEND_MINUTES = 10;
const MAX_TOTAL_MINUTES = 180;
const WARN_MINUTES_BEFORE = 3;
// How long a stopped walk keeps asking for its real end time when the app is
// next opened. After that it keeps the time-limit end (fixable in Stats).
const WRAP_UP_HOURS = 12;
// A daycation (the dog out with the volunteer for the day) is different:
// it runs up to DAYCATION_MINUTES with no extending, no length alerts, and
// isn't stopped at closing time (it still has to start during walking hours).
const DAYCATION_MINUTES = 12 * 60;
// Never past MAX_TOTAL_MINUTES: time added as one activity can't carry a
// walk past the cap after switching to one with a longer default (a walk
// extended to 3 hours, switched to matchmaking).
const walkLimitMinutes = (w) => (w.activity === 'daycation'
  ? DAYCATION_MINUTES
  : Math.min(MAX_TOTAL_MINUTES, (ACTIVITY_LIMIT_MINUTES[w.activity] || AUTO_STOP_MINUTES) + (w.extend_minutes || 0)));
// Closing time for the walk's day, in ms. Staff can move a day's closing
// time while walks are out; one that started after the new closing time
// isn't held to it (it would otherwise stop before it began).
const walkClosesMs = (w) => {
  const closesMs = walkHours.walkWindow(w.started_at).closesAt.getTime();
  return closesMs > new Date(w.started_at).getTime() ? closesMs : Infinity;
};
// Whichever comes first: the time limit, or closing time for walks (7pm
// unless staff set other hours).
const walkStopsAt = (w) => {
  const limitMs = new Date(w.started_at).getTime() + walkLimitMinutes(w) * 60000;
  if (w.activity === 'daycation') return new Date(limitMs).toISOString();
  return new Date(Math.min(limitMs, walkClosesMs(w))).toISOString();
};
// Closing time for the walk's day, or null for a daycation (not held to it).
const closesAtFor = (w) => {
  const closesMs = w.activity === 'daycation' ? Infinity : walkClosesMs(w);
  return closesMs === Infinity ? null : new Date(closesMs).toISOString();
};
// Walking-hours check for a start/end pair; a daycation only has to start
// during walking hours.
const walkHoursErrorFor = (activity, startedAt, endedAt) =>
  walkHours.walkHoursError(startedAt, activity === 'daycation' ? null : endedAt);

// Phones and the server can disagree on the time by a little, so an end
// time up to this far in the future is taken as "now", not rejected.
const CLOCK_SKEW_MS = 2 * 60000;
// Checks an end time the walker sent: after the start, and no later than
// latestMs (now, or an earlier cap such as the walk's limit, which gets
// tooLateError). Returns { iso } or { error }.
function walkEndTime(value, startedAt, latestMs, tooLateError = "The end time can't be after the walk's time limit.") {
  let ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return { error: 'That end time is not a valid time.' };
  // A phone whose clock runs a little behind the server's, ending a walk
  // seconds after starting it, sends an end time before the start. When that
  // time is also within clock-skew of now, it meant "now": the server's clock
  // decides. (Earlier end times, e.g. when a notification's End was tapped,
  // are kept as sent.)
  const startMs = new Date(startedAt).getTime();
  if (ms <= startMs && Math.abs(ms - Date.now()) <= CLOCK_SKEW_MS) ms = Math.min(Date.now(), latestMs);
  if (ms <= startMs) return { error: 'The end time has to be after the walk started.' };
  if (ms > latestMs + CLOCK_SKEW_MS) {
    return { error: latestMs < Date.now() - CLOCK_SKEW_MS ? tooLateError : "The end time can't be in the future." };
  }
  return { iso: new Date(Math.min(ms, latestMs)).toISOString() };
}

// A time from a request as toISOString(), or null if it isn't a real time.
// Only full dates with a time are taken ("2026-11-09T14:00:00Z", with or
// without milliseconds or an offset), not loose text like "Nov 9 10:00".
function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
const sameInstant = (a, b) => (a == null || b == null ? a == b : new Date(a).getTime() === new Date(b).getTime()); // eslint-disable-line eqeqeq

// The note for other walkers left on a walk: up to MAX_WALK_NOTE characters,
// the same as a tip (notes.js), refused with a clear message rather than cut.
function walkNoteError(notes) {
  if (notes == null) return null;
  return String(notes).trim().length > notesApi.MAX_WALK_NOTE
    ? `A note can be up to ${notesApi.MAX_WALK_NOTE} characters. This one has ${String(notes).trim().length}.`
    : null;
}

// Hand-logged and edited entries can't be longer than a live one could run:
// 12 hours for a daycation, 3 hours for anything else.
function walkLengthError(activity, startedAt, endedAt) {
  const maxMinutes = activity === 'daycation' ? DAYCATION_MINUTES : MAX_TOTAL_MINUTES;
  if (new Date(endedAt) - new Date(startedAt) <= maxMinutes * 60000) return null;
  return `${activity === 'daycation' ? 'A daycation' : `A ${activityNoun(activity)}`} can't be longer than ${maxMinutes / 60} hours.`;
}

// Another walk of this walker's, or with this dog, at the same time (one
// still going counts up to now). Times are compared with julianday() so
// older rows stored in other formats still compare correctly. Play group is
// the one shared activity: several walkers can log the same dog's session.
const overlappingWalk = db.prepare(`
  SELECT w.id, w.user_id, d.name AS dog_name FROM walks w LEFT JOIN dogs d ON d.shelter_buddy_id = w.dog_id
  WHERE (w.user_id = @userId OR (w.dog_id = @dogId AND @activity != 'playgroup' AND w.activity != 'playgroup'))
    AND w.id != @exceptId
    AND julianday(w.started_at) < julianday(@endedAt)
    AND julianday(COALESCE(w.ended_at, @now)) > julianday(@startedAt)
  ORDER BY (w.user_id = @userId) DESC LIMIT 1
`);
function walkOverlapError({ userId, dogId, activity, startedAt, endedAt, exceptId = 0 }) {
  const now = new Date().toISOString();
  const row = overlappingWalk.get({ userId: userId == null ? -1 : userId, dogId, activity, exceptId, startedAt, endedAt: endedAt || now, now });
  if (!row) return null;
  return row.user_id === userId
    ? `This overlaps another of your entries (${row.dog_name || 'another animal'}) at the same time.`
    : `${row.dog_name || 'This animal'} already has an entry at that time.`;
}

// A length alert more than this late (the walker added it partway through
// the walk, or the server was down) is skipped rather than sent stale.
const ALERT_GRACE_MS = 2 * 60000;
const ACTIVITY_VERBS = { walk: 'walking', cuddle: 'cuddling', matchmaking: 'at matchmaking', playgroup: 'at play group', daycation: 'on a daycation' };
// What notifications call each activity ("End cuddle", "Cuddles stop after...").
const ACTIVITY_NOUNS = { walk: 'walk', cuddle: 'cuddle', matchmaking: 'matchmaking session', playgroup: 'play group', daycation: 'daycation' };
const activityNoun = (activity) => ACTIVITY_NOUNS[activity] || 'walk';
// Buttons on the walk alerts. Android shows them (iPhone ignores them, so the
// tap-to-open path must still do everything); sw.js handles each one.
const walkAlertActions = (w) => ({
  walkId: w.id,
  dogName: w.dog_name || null,
  actions: w.activity === 'daycation'
    ? [{ action: 'end', title: 'End daycation' }]
    : [{ action: 'extend', title: '+10 min' }, { action: 'end', title: `End ${activityNoun(w.activity)}` }]
});

function enforceWalkLimits() {
  const open = db.prepare(`
    SELECT w.id, w.user_id, w.started_at, w.extend_minutes, w.warned, w.alerted_minutes, w.location, w.activity,
           d.name AS dog_name, d.kennel_location, u.walk_alert_minutes
    FROM walks w LEFT JOIN dogs d ON d.shelter_buddy_id = w.dog_id LEFT JOIN users u ON u.id = w.user_id
    WHERE w.ended_at IS NULL
  `).all();
  const now = Date.now();
  for (const w of open) {
    const stopsAt = new Date(walkStopsAt(w)).getTime();
    const startedMs = new Date(w.started_at).getTime();
    // The walker's length alerts: only the latest one that's due is sent,
    // once, and only if it isn't stale.
    // (Not on daycations: walk-length alerts would just be noise all day.)
    const due = w.activity === 'daycation' ? [] : walkAlertMinutes(w.walk_alert_minutes)
      .filter((m) => m > w.alerted_minutes && startedMs + m * 60000 <= now && now < stopsAt);
    if (due.length) {
      const minutes = Math.max(...due);
      db.prepare('UPDATE walks SET alerted_minutes = ? WHERE id = ?').run(minutes, w.id);
      if (now - (startedMs + minutes * 60000) <= ALERT_GRACE_MS) {
        const returnTo = w.location || w.kennel_location;
        push.sendPushToUser(w.user_id, {
          title: `${w.dog_name || `Your ${activityNoun(w.activity)}`}: ${minutes} minutes`,
          body: `You've been ${ACTIVITY_VERBS[w.activity] || 'walking'} for ${minutes} minutes.${returnTo ? ` Return to: ${returnTo}` : ''}`,
          url: '/',
          tag: WALK_PUSH_TAG,
          ...walkAlertActions(w)
        }, push.WALK_ALERT_PUSH).catch(() => {});
      }
    }
    if (now >= stopsAt) {
      const seconds = Math.round((stopsAt - startedMs) / 1000);
      const atClosing = w.activity !== 'daycation' && stopsAt === walkClosesMs(w);
      db.prepare('UPDATE walks SET ended_at = ?, duration_seconds = ?, auto_stopped = 1, wrap_up_pending = 1 WHERE id = ? AND ended_at IS NULL')
        .run(new Date(stopsAt).toISOString(), seconds, w.id);
      console.warn(`[server] auto-stopped walk ${w.id} after ${Math.round(seconds / 60)} min${atClosing ? ' (closing time)' : ''}`);
      if (w.user_id && push.hasPref(w.user_id, 'walk_started')) {
        push.sendPushToUser(w.user_id, {
          title: `${w.dog_name || `Your ${activityNoun(w.activity)}`}: stopped automatically`,
          body: atClosing
            ? `The shelter closes at ${walkHours.walkWindow(w.started_at).closeLabel}. Open the app to say when it really ended.`
            : w.activity === 'daycation'
              ? `Daycations stop after ${DAYCATION_MINUTES / 60} hours. Open the app to say when it really ended.`
              : `A ${activityNoun(w.activity)} stops after ${walkLimitMinutes(w)} minutes. Open the app to say when it really ended.`,
          url: '/',
          tag: WALK_PUSH_TAG
        }).catch(() => {});
      }
    } else if (!w.warned && stopsAt - now <= WARN_MINUTES_BEFORE * 60000) {
      db.prepare('UPDATE walks SET warned = 1 WHERE id = ?').run(w.id);
      if (w.user_id && push.hasPref(w.user_id, 'walk_started')) {
        push.sendPushToUser(w.user_id, {
          title: `${w.dog_name || `Your ${activityNoun(w.activity)}`}: ${WARN_MINUTES_BEFORE} minutes left`,
          body: w.activity === 'daycation' ? 'The daycation will stop on its own. End it when the dog is back.' : `Add more time, or the ${activityNoun(w.activity)} will stop on its own.`,
          url: '/',
          tag: WALK_PUSH_TAG,
          ...walkAlertActions(w)
        }, push.WALK_ALERT_PUSH).catch(() => {});
      }
    }
  }
}
// Every 10 seconds, so length alerts arrive close to the minute.
setInterval(() => { try { enforceWalkLimits(); } catch (err) { console.error('[server] walk limit sweep failed:', err); } }, 10 * 1000);
try { enforceWalkLimits(); } catch (err) { console.error('[server] walk limit sweep failed:', err); }

// Registered down here (not with the other .register() calls above) because
// it needs enforceWalkLimits, which isn't defined until just above this line.
staffDashboard.register(app, { db, enforceWalkLimits, kennelLetter, cachedPhotoUrl, ACTIVITY_VERBS, ACTIVITIES });
shelterSchedule.register(app, { db, push });

// The module system: GET/PUT /api/modules (the Settings tab's backend), then
// every discovered module's own register(app, ctx), regardless of its
// enabled state -- Express has no way to un-register a route once added, so
// a disabled module's routes/jobs stay mounted but check ctx.isEnabled()/
// enabledGuard themselves (see src/modules.js), which is what makes
// toggling take effect immediately instead of needing a restart. Loaded
// last, same reasoning as staffDashboard/shelterSchedule just above: a
// module may depend on core state (enforceWalkLimits, kennelLetter, ...)
// that isn't defined until this point in the file.
modulesCore.registerModuleAdminRoutes(app, discoveredModules, moduleState, db);
for (const m of discoveredModules) {
  const ctx = modulesCore.buildModuleCtx(m.id, {
    db, state: moduleState,
    legacyExtras: { cachedPhotoUrl, isStaffOrPrivileged, resolveAuthedUser, push, onAccountDeleted: account.onAccountDeleted }
  });
  m.register(app, ctx);
}

// Scrape history is only useful for health checks; keep 90 days.
function pruneOldRecords() {
  db.prepare('DELETE FROM scrape_runs WHERE started_at < ?').run(new Date(Date.now() - 90 * 86400 * 1000).toISOString());
}
setInterval(() => { try { pruneOldRecords(); } catch (err) { console.error('[server] prune failed:', err); } }, 24 * 3600 * 1000);
try { pruneOldRecords(); } catch (err) { console.error('[server] prune failed:', err); }

// These two stay LAST, after every route above (core, staff, schedule and
// every module), or a later route's errors would skip them.
// An /api path nothing answered: JSON, like every other API reply.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});
// Any error that escapes a route becomes a clean JSON response instead of
// Express's default HTML stack page (which the frontend can't parse, and
// which shows file paths). Details go to the server log only.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const raw = err.status || err.statusCode;
  const status = Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : 500;
  if (status >= 500) console.error(`[server] ${req.method} ${req.originalUrl} failed:`, err);
  // Express's own 4xx errors (bad JSON, too large) have safe, short messages.
  const message = status >= 500 ? 'Something went wrong on the server. Please try again.'
    : (err.expose !== false && err.message ? String(err.message).slice(0, 200) : 'Bad request');
  res.status(status).json({ error: message });
});

// Loopback only: Caddy is the sole legitimate client (it injects the trusted
// X-Auth-Email header after authenticating), so nothing else should ever be
// able to reach this port and forge that header.
app.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => {
  console.log(`dogwalk server listening on port ${PORT}`);
});

// Run once shortly after startup (catches up after a restart regardless of
// time of day), then every 30 minutes from 6am (catches overnight intakes
// before walking starts at 7am) through 7:30pm, covering walking and adoption
// hours. About 3 requests per listed animal (details, photo list, and a
// conditional photo GET that is usually a bodyless 304), so roughly 650 per
// run at ~215 animals, one at a time with a pause between animals; ~28 runs
// a day stays gentle on the county's site.
const SCRAPE_SCHEDULE = '0,30 6-19 * * *';
if (!process.env.DISABLE_SCRAPER) {
  setTimeout(() => {
    scrapeInFlight = true;
    runScrape().catch((err) => console.error('[scraper] initial run failed:', err)).finally(() => { scrapeInFlight = false; });
  }, 5000);

  cron.schedule(SCRAPE_SCHEDULE, () => {
    if (scrapeInFlight) {
      console.log('[scraper] skipping scheduled run, one already in flight');
      return;
    }
    scrapeInFlight = true;
    runScrape().catch((err) => console.error('[scraper] scheduled run failed:', err)).finally(() => { scrapeInFlight = false; });
  }, { timezone: 'America/New_York' }); // the shelter's local time, not the server's - matters since the server runs in UTC
}
