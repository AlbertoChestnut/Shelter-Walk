const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const QRCode = require('qrcode');
const db = require('./db');
const { runScrape, IMAGES_DIR } = require('./scraper');
const push = require('./push');
const wiki = require('./wiki');
const impact = require('./impact');
const notes = require('./notes');
const account = require('./account');
// Every walk notice (started, time warning, auto-stopped) shares this tag,
// so each one replaces the last on the phone rather than piling up.
const WALK_PUSH_TAG = 'walk';
const { hashEmail } = require('./emailHash');

const PORT = process.env.PORT || 3000;
const app = express();

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

// Cache-bust the versioned assets on every container start so a redeploy is
// always picked up immediately, regardless of any browser/proxy cache sitting
// in between (their Cache-Control headers can't be trusted to be honored).
const ASSET_VERSION = String(Date.now());
const INDEX_HTML = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
  .replace('__BUILD__', ASSET_VERSION)
  .replace('/css/style.css', `/css/style.css?v=${ASSET_VERSION}`)
  .replace('/js/html5-qrcode.min.js', `/js/html5-qrcode.min.js?v=${ASSET_VERSION}`)
  .replace('/js/app.js', `/js/app.js?v=${ASSET_VERSION}`);

function sendIndex(req, res) {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.type('html').send(INDEX_HTML);
}

app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
// Cached dog photos — survive a dog's listing disappearing after adoption.
app.use('/cached-images', express.static(IMAGES_DIR, { maxAge: '30d' }));
app.get('/', sendIndex);
// Bookmarkable shortcut straight into the QR scanner.
app.get('/scan', sendIndex);

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

const MAX_PUPPY_AGE_MONTHS = 6;
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
const DEFAULT_EXPERIENCE_LEVEL = 'beginner';

function resolveExperienceLevel(userId) {
  const id = parseInt(userId, 10);
  if (!id) return null;
  const user = db.prepare('SELECT experience_level FROM users WHERE id = ?').get(id);
  return (user && user.experience_level) || null;
}

const getCheckoff = db.prepare(`
  SELECT 1 FROM session_checkoffs WHERE dog_id = ? AND date_key = ?
`);

// Kennel locations are just the wing letter (A-E) -- many dogs share one,
// so there's no "one dog per spot" bumping any more. Accepts a full code
// or the kennel-card "Da12" quirk and keeps only the letter; anything that
// doesn't come down to A-E is null (caller decides whether that's an error).
const KENNEL_LETTERS = ['A', 'B', 'C', 'D', 'E'];
function kennelLetter(raw) {
  let v = String(raw || '').trim().toUpperCase();
  if (/^D[A-E]\d/.test(v)) v = v.slice(1);
  return KENNEL_LETTERS.includes(v[0]) ? v[0] : null;
}

function setKennelLocation(dogId, letter) {
  const dog = db.prepare('SELECT shelter_buddy_id, name FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  if (!dog) return null;
  db.prepare('UPDATE dogs SET kennel_location = ? WHERE shelter_buddy_id = ?').run(letter, dogId);
  return { location: letter, name: dog.name };
}

function cachedPhotoUrl(dogId, rawUrl) {
  const cachedPath = path.join(IMAGES_DIR, `${dogId}.jpg`);
  if (fs.existsSync(cachedPath)) return `/cached-images/${dogId}.jpg`;
  return rawUrl || null;
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
const getActiveWalk = db.prepare(`
  SELECT w.user_id AS userId, w.started_at AS startedAt,
         CASE WHEN u.hide_name_while_walking = 1 THEN 'a Volunteer' ELSE u.name END AS userName
  FROM walks w JOIN users u ON u.id = w.user_id
  WHERE w.dog_id = ? AND w.ended_at IS NULL
  LIMIT 1
`);

const getWalkedByUserCount = db.prepare(`
  SELECT COUNT(*) AS count FROM walks WHERE dog_id = ? AND user_id = ? AND ended_at IS NOT NULL
`);

const getRecentWalkCount = db.prepare(`
  SELECT COUNT(*) AS count FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL AND started_at >= ?
`);
const RECENT_WALK_WINDOW_DAYS = 7;

function serializeDog(row, experienceLevel, todayKey, userId) {
  const days = daysInShelter(row.date_in_shelter, row.still_listed ? null : row.removed_at);
  const ageMonths = parseAgeMonths(row.age);
  const walkStats = db.prepare(`
    SELECT COUNT(*) AS count, MAX(started_at) AS last_started_at
    FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL
  `).get(row.shelter_buddy_id);
  // How much attention a dog has gotten lately (not lifetime) — surfaces
  // dogs that have quietly gone unwalked for a while even if their
  // lifetime walkCount looks fine.
  const recentSince = new Date(Date.now() - RECENT_WALK_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recentWalkCount = getRecentWalkCount.get(row.shelter_buddy_id, recentSince).count;
  // A dog currently out on a walk counts as "walked" for filtering/sorting
  // purposes right away — no need to wait for the walk to end.
  const currentWalk = getActiveWalk.get(row.shelter_buddy_id) || null;
  const userIdInt = parseInt(userId, 10);
  const walkedByMe = userIdInt ? getWalkedByUserCount.get(row.shelter_buddy_id, userIdInt).count > 0 : false;

  const level = EXPERIENCE_LEVELS[experienceLevel] || EXPERIENCE_LEVELS[DEFAULT_EXPERIENCE_LEVEL];
  const ageMonthsHard = ageMonths != null && ageMonths <= MAX_PUPPY_AGE_MONTHS;
  const blueMarkers = row.blue_markers ? JSON.parse(row.blue_markers) : [];
  const hasEvo = blueMarkers.includes('blue_evo');
  const hasAnyBlue = blueMarkers.length > 0;
  const pbFlag = !!row.pb_flag;
  const tags = row.tags ? JSON.parse(row.tags) : [];
  const isPendingAdoption = tags.includes(PENDING_ADOPTION_TAG);
  // Alumni (manual, capped 1-15) and previous_days_in_shelter (automatic,
  // uncapped, banked by the scraper on a detected return) both add on top
  // of actual current-stay days -- different mechanisms answering different
  // questions, see the previous_days_in_shelter migration note in db.js.
  const effectiveDays = days != null
    ? days + (row.alumni_flag ? (row.alumni_bonus_days || 0) : 0) + (row.previous_days_in_shelter || 0)
    : days;

  // Precedence: too young (hard, no override) > EVO not allowed (hard,
  // not even PB) > any blue marker not allowed (hard) > pending adoption
  // not allowed (hard, beginners only) > PB (overrides the day threshold
  // when this level permits PB dogs at all) > day threshold.
  let eligible;
  let notEligibleReason = null;
  if (ageMonthsHard) {
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
  } else if (pbFlag) {
    eligible = level.allowPb;
    notEligibleReason = eligible ? null : 'pb_restricted';
  } else {
    eligible = effectiveDays != null ? effectiveDays >= level.minDays : null;
    notEligibleReason = eligible ? null : 'days';
  }

  return {
    id: row.shelter_buddy_id,
    name: row.name,
    sex: row.sex,
    age: row.age,
    ageMonths,
    breed: row.breed,
    weight: row.weight,
    desexed: row.desexed,
    location: row.location,
    dateInShelter: row.date_in_shelter,
    daysInShelter: days,
    summary: row.summary,
    tags,
    photoUrl: resolvePhotoUrl(row),
    stillListed: !!row.still_listed,
    removedAt: row.removed_at || null,
    // Alumni (returned dog, privileged-only): bonus days count toward
    // eligibility on top of actual time in shelter, without changing the
    // real daysInShelter figure shown elsewhere.
    isAlumni: !!row.alumni_flag,
    alumniBonusDays: row.alumni_bonus_days || 0,
    // Automatic, uncapped credit from prior stay(s) -- set when the scraper
    // detects this dog has come back after being removed/adopted before.
    previousDaysInShelter: row.previous_days_in_shelter || 0,
    effectiveDaysInShelter: effectiveDays,
    eligible,
    // Why `eligible` is false, so the UI can give an accurate reason instead
    // of always assuming "needs more days": 'too_young' | 'evo_restricted' |
    // 'blue_restricted' | 'pb_restricted' | 'days' | null (when eligible).
    notEligibleReason,
    minDaysForLevel: level.minDays,
    // Hard rule, no override: puppies 6 months or younger can never be walked.
    tooYoung: ageMonthsHard,
    blueMarkers,
    pooStatus: row.poo_status || 'none',
    starFlag: !!row.star_flag,
    pbFlag,
    isPendingAdoption,
    kennelLocation: row.kennel_location || null,
    checkedOffToday: todayKey ? !!getCheckoff.get(row.shelter_buddy_id, todayKey) : false,
    walkCount: walkStats.count,
    lastWalkedAt: walkStats.last_started_at,
    recentWalkCount,
    currentWalk,
    walkedByMe,
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
const ME_COLUMNS = 'id, name, experience_level AS experienceLevel, is_privileged AS isPrivileged, can_audit AS canAudit, onboarding_completed AS onboardingCompleted, hide_name_while_walking AS hideNameWhileWalking';

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
    // (matched by name, case-insensitively) gets THAT profile linked to
    // their account, rather than a duplicate.
    const localPart = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
    const derivedName = localPart.replace(/\b\w/g, (c) => c.toUpperCase()) || email;
    const unlinked = db.prepare('SELECT id FROM users WHERE auth_email_hash IS NULL AND name = ? COLLATE NOCASE').get(derivedName);
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
        onboardingCompleted: false, hideNameWhileWalking: true
      };
    }
  }
  return {
    ...row, isPrivileged: !!row.isPrivileged, canAudit: !!row.canAudit,
    onboardingCompleted: !!row.onboardingCompleted
  };
}

// ---- Who is asking: always the signed-in account, never a request field ----
// Every /api call is tied to the identity Caddy vouches for (X-Auth-Email).
// Any `userId` a page sends (query string or body) is overwritten with that
// identity, and /api/users/:id/... paths only work for your own id (staff and
// privileged walkers excepted). Without this, anyone signed in could read
// another volunteer's walks/stats/history just by changing a number in a
// request -- which is exactly the kind of individual-level visibility this
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
  const m = /^\/users\/(\d+)(\/|$)/.exec(req.path);
  if (m && Number(m[1]) !== me.id && !isStaffOrPrivileged(req, me) && !/^\/users\/\d+\/permissions$/.test(req.path)) {
    return res.status(403).json({ error: "That isn't your account." });
  }
  next();
});
// A walk can be changed only by the person who did it (or staff, to fix mistakes).
function walkAccessDenied(req, res, walk) {
  if (req.me && (walk.user_id === req.me.id || isStaffOrPrivileged(req, req.me))) return false;
  if (isInternalRequest(req)) return false;
  res.status(403).json({ error: 'You can only change your own walks.' });
  return true;
}

// Guide / wiki (sections + images) lives in wiki.js.
wiki.register(app, { db, resolveAuthedUser });
impact.register(app, { db });
impact.registerDay(app, { db, cachedPhotoUrl });
const notesApi = notes.register(app, { db, isStaffOrPrivileged });
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
  res.json({ ...user, isStaff });
});

// The Profile section's two fields save together as one first/last pair.
app.put('/api/me', (req, res) => {
  const user = resolveAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'name is required' });
  const clash = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE AND id != ?').get(name, user.id);
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
// see getActiveWalk() and the walk-start "already out" check, both of
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
    'SELECT name, experience_level AS experienceLevel, created_at AS createdAt, hide_name_while_walking AS hideNameWhileWalking FROM users WHERE id = ?'
  ).get(me.id);
  profile.hideNameWhileWalking = !!profile.hideNameWhileWalking;
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
  res.json({
    exportedAt: new Date().toISOString(),
    note: "This is everything Shelter Walk has stored about your account. It does not include your email sign-in history or passkeys, which belong to the separate login system.",
    profile,
    walks,
    privateNotes,
    publicTipsWritten,
    savedFilters,
    notificationPrefs
  });
});

// Marks the first-run onboarding sequence (name -> experience level ->
// passkey offer -> notification prefs -> info -> thank you) as done, so it
// never shows again for this account. Separate from experience_level being
// set, since a returning/linked account might already have a level from
// before this sequence existed but still hasn't seen the rest of it.
app.post('/api/users/:id/onboarding-complete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('UPDATE users SET onboarding_completed = 1 WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ id, onboardingCompleted: true });
});

// ---- Notification & feed preferences (granular, per category) ----
// Two different kinds of "on/off" sharing one generic key/value table:
// - notify_*: push notifications, opt-IN (default off) -- nobody gets
//   pushed at without asking first.
// - show_*: whether an event kind appears in the Updates feed at all,
//   opt-OUT (default on) -- e.g. someone who'd rather not see "a dog was
//   removed" posts can turn just that off without losing the rest.
const PREF_DEFAULTS = {
  adopted_walked_dog: false,
  walk_started: false,
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

// ---- Web Push ----
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: push.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  const { userId, subscription } = req.body;
  if (!userId || !subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'userId and a valid subscription are required' });
  }
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, new Date().toISOString());
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
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
function isInternalRequest(req) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return false;
  const header = req.headers['authorization'] || '';
  return header === `Bearer ${token}`;
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

app.put('/api/users/:id/settings', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { experienceLevel } = req.body;
  if (!Object.prototype.hasOwnProperty.call(EXPERIENCE_LEVELS, experienceLevel)) {
    return res.status(400).json({ error: `experienceLevel must be one of: ${Object.keys(EXPERIENCE_LEVELS).join(', ')}` });
  }
  const info = db.prepare('UPDATE users SET experience_level = ? WHERE id = ?').run(experienceLevel, id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ id, experienceLevel });
});

// A garbage ?limit= (NaN, negative, absurdly large) used to reach SQLite as-is
// and throw; always land on a sane positive integer instead.
function clampLimit(raw, fallback, max = 5000) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDateKey(v) {
  return typeof v === 'string' && DATE_KEY_RE.test(v) ? v : null;
}

// ---- Dogs ----
app.get('/api/dogs', (req, res) => {
  const experienceLevel = resolveExperienceLevel(req.query.userId);
  const onlyEligible = req.query.eligible === 'true';
  const onlyListed = req.query.all !== 'true';
  const todayKey = validDateKey(req.query.dateKey);
  let rows = db.prepare('SELECT * FROM dogs' + (onlyListed ? ' WHERE still_listed = 1' : '')).all();
  let dogs = rows.map((r) => serializeDog(r, experienceLevel, todayKey, req.query.userId));
  if (onlyEligible) {
    dogs = dogs.filter((d) => d.eligible);
  }
  dogs.sort((a, b) => (b.daysInShelter || 0) - (a.daysInShelter || 0));
  res.json({ experienceLevel, dogs });
});

app.get('/api/dogs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Dog not found in local database. Try refreshing the shelter data.' });
  const experienceLevel = resolveExperienceLevel(req.query.userId);
  const todayKey = validDateKey(req.query.dateKey);
  const dog = serializeDog(row, experienceLevel, todayKey, req.query.userId);
  const walks = db.prepare(`
    SELECT id, location, started_at, ended_at, duration_seconds, notes
    FROM walks WHERE dog_id = ? ORDER BY started_at DESC
  `).all(id);
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

// The "returned" icon's breakdown popup: this dog's earlier stay(s), for
// dogs the scraper has seen leave and come back. Built from the shared
// shelter_events log (the same rows the Updates feed reads), not a separate
// table -- there's no per-stay ledger, so a prior stay is reconstructed as
// the span between a 'new_dog'/'returned' event and the 'adopted'/'removed'
// event that follows it. Capped to the last 6 months so this stays a short,
// readable list even for a dog with a long history, rather than growing
// forever as the shelter's event log does.
const STAY_HISTORY_MONTHS = 6;
app.get('/api/dogs/:id/stay-history', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT date_in_shelter, still_listed, removed_at, previous_days_in_shelter FROM dogs WHERE shelter_buddy_id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Dog not found' });
  const since = new Date();
  since.setMonth(since.getMonth() - STAY_HISTORY_MONTHS);
  const events = db.prepare(`
    SELECT kind, occurred_at AS occurredAt FROM shelter_events
    WHERE dog_id = ? AND kind IN ('new_dog', 'returned', 'adopted', 'removed') AND occurred_at >= ?
    ORDER BY occurred_at ASC, id ASC
  `).all(id, since.toISOString());
  // Only stays that ended before this current one started -- the current
  // stay itself is described by the dog's own date_in_shelter/still_listed
  // fields already shown alongside this popup, so it isn't repeated here.
  const priorEvents = events.filter((e) => e.occurredAt < row.date_in_shelter);
  const priorStays = [];
  let openedAt = null;
  for (const e of priorEvents) {
    if (e.kind === 'new_dog' || e.kind === 'returned') {
      openedAt = e.occurredAt;
    } else if (openedAt) {
      priorStays.push({ arrivedAt: openedAt, leftAt: e.occurredAt });
      openedAt = null;
    }
  }
  res.json({
    months: STAY_HISTORY_MONTHS,
    priorStays,
    previousDaysInShelter: row.previous_days_in_shelter || 0
  });
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
  const everyone = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(duration_seconds), 0) AS totalSeconds
    FROM walks WHERE dog_id = ? AND ended_at IS NOT NULL
  `).get(id);
  res.json({ mine, everyone });
});

// blank + alphabetical letter codes, with the EVO rectangle last.
const VALID_BLUE_MARKERS = [
  'blue', 'blue_c', 'blue_d', 'blue_e', 'blue_h', 'blue_j',
  'blue_m', 'blue_p', 'blue_q', 'blue_r', 'blue_s', 'blue_evo'
];
const VALID_POO_STATUSES = ['none', 'poo', 'priority'];
app.put('/api/dogs/:id/markers', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { blueMarkers, pooStatus, starFlag, pbFlag } = req.body;
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
  res.json({ id, blueMarkers: uniqueBlue, pooStatus, starFlag: !!starFlag, pbFlag: !!pbFlag });
});

// Alumni (returned dog): privileged users only, enforced here server-side
// (not just hidden in the UI) since it changes who a dog is shown as
// eligible to. bonusDays is clamped 1-15 when alumni is being turned on.
app.put('/api/dogs/:id/alumni', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { alumni, bonusDays } = req.body;
  const user = resolveAuthedUser(req);
  if (!user || !user.isPrivileged) {
    return res.status(403).json({ error: 'Only privileged users can set alumni status' });
  }
  const userId = user.id;
  const clampedBonus = alumni ? Math.min(15, Math.max(1, Math.round(Number(bonusDays) || 0))) : 0;
  const info = db.prepare(
    'UPDATE dogs SET alumni_flag = ?, alumni_bonus_days = ? WHERE shelter_buddy_id = ?'
  ).run(alumni ? 1 : 0, clampedBonus, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Dog not found' });
  const row = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(id);
  const dog = serializeDog(row, resolveExperienceLevel(userId), null, userId);
  res.json({ id, isAlumni: !!alumni, alumniBonusDays: clampedBonus, eligible: dog.eligible, notEligibleReason: dog.notEligibleReason });
});

// Save a dog's kennel location without starting a walk (e.g. you're just
// noting where they are right now, not walking them).
app.put('/api/dogs/:id/location', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const letter = kennelLetter(req.body.location);
  if (!letter) {
    return res.status(400).json({ error: 'Pick a kennel letter, A to E.' });
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
  const letter = kennelLetter(req.body.letter);
  if (!letter || String(req.body.letter).trim().length !== 1) return res.status(400).json({ error: 'Pick a kennel letter, A to E.' });
  const scanned = new Set((Array.isArray(req.body.scannedIds) ? req.body.scannedIds : []).map((id) => parseInt(id, 10)).filter(Number.isFinite));
  if (!scanned.size) return res.status(400).json({ error: 'No dogs were scanned in this wing.' });
  const unscanned = db.prepare('SELECT shelter_buddy_id AS id, name FROM dogs WHERE kennel_location = ? ORDER BY name')
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
app.post('/api/checkoff', (req, res) => {
  const { dogId, dateKey } = req.body;
  const key = validDateKey(dateKey);
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
  const { dogId, dateKey, slotIndex, checked, userId } = req.body;
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
app.get('/api/updates', (req, res) => {
  const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  const limit = clampLimit(req.query.limit, 100);
  // Fetch more than asked before filtering by show_* prefs, so hiding a
  // category doesn't just leave someone with a short feed once they've
  // scrolled past however many of that kind happened to lead the results.
  // 'removed' (a plain delisting that wasn't an adoption) is excluded
  // outright -- not happy news, not actionable, shouldn't show up at all.
  // The scraper stopped writing new ones of these; this also hides any
  // already sitting in the table from before that change.
  let rows = db.prepare(`
    SELECT e.id, e.kind, e.dog_id, d.name AS dog_name, d.photo_url,
           d.blue_markers, d.poo_status, d.star_flag, d.pb_flag,
           e.title, e.detail, e.occurred_at
    FROM shelter_events e
    LEFT JOIN dogs d ON d.shelter_buddy_id = e.dog_id
    WHERE e.kind != 'removed'
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ?
  `).all(limit * 4);
  rows.forEach((r) => { if (r.dog_id) r.photo_url = cachedPhotoUrl(r.dog_id, r.photo_url); });

  let prefEnabled = false;
  let walkedDogIds = new Set();
  let lastSeenAt = null;
  if (userId) {
    const prefs = getUserPrefs(userId);
    prefEnabled = prefs.adopted_walked_dog;
    walkedDogIds = new Set(
      db.prepare('SELECT DISTINCT dog_id FROM walks WHERE user_id = ? AND ended_at IS NOT NULL').all(userId).map((r) => r.dog_id)
    );
    rows = rows.filter((r) => prefs[`show_${r.kind}`] !== false);
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
  const count = lastSeenAt
    ? db.prepare("SELECT COUNT(*) AS c FROM shelter_events WHERE kind != 'removed' AND occurred_at > ?").get(lastSeenAt).c
    : db.prepare("SELECT COUNT(*) AS c FROM shelter_events WHERE kind != 'removed'").get().c;
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
  if (row) { row.photo_url = cachedPhotoUrl(row.dog_id, row.photo_url); row.stopsAt = walkStopsAt(row); }
  res.json({ walk: row || null });
});

app.post('/api/walks/start', (req, res) => {
  const { dogId, location, userId } = req.body;
  if (!dogId || !userId) {
    return res.status(400).json({ error: 'dogId and userId are required' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  const dog = db.prepare('SELECT * FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  if (!dog.still_listed) {
    return res.status(409).json({ error: `${dog.name} is no longer listed at the shelter, so a walk can't be started.` });
  }

  const ageMonths = parseAgeMonths(dog.age);
  if (ageMonths != null && ageMonths <= MAX_PUPPY_AGE_MONTHS) {
    return res.status(403).json({ error: `${dog.name} is too young to walk (${dog.age}). Puppies 6 months or younger can't be walked, no exceptions.` });
  }

  // Per-user, not global — two different people can each have their own
  // walk going at the same time. But the same dog can't be walked by two
  // people at once.
  const existingActive = db.prepare('SELECT id FROM walks WHERE ended_at IS NULL AND user_id = ?').get(userId);
  if (existingActive) {
    return res.status(409).json({ error: 'You already have a walk in progress', walkId: existingActive.id });
  }
  const dogAlreadyOut = db.prepare(`
    SELECT w.id, CASE WHEN u.hide_name_while_walking = 1 THEN 'a Volunteer' ELSE u.name END AS user_name
    FROM walks w JOIN users u ON u.id = w.user_id
    WHERE w.ended_at IS NULL AND w.dog_id = ?
  `).get(dogId);
  if (dogAlreadyOut) {
    return res.status(409).json({ error: `${dog.name} is already out with ${dogAlreadyOut.user_name}` });
  }

  // Location is optional -- if it's left blank, leave the dog's existing
  // kennel letter (if any) alone rather than overwriting it with nothing.
  const hasLocation = location != null && String(location).trim() !== '';
  const trimmedLocation = hasLocation ? kennelLetter(location) : '';
  if (hasLocation && !trimmedLocation) {
    return res.status(400).json({ error: 'Pick a kennel letter, A to E.' });
  }
  if (trimmedLocation) setKennelLocation(dogId, trimmedLocation);

  const startedAt = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO walks (dog_id, location, started_at, user_id) VALUES (?, ?, ?, ?)
  `).run(dogId, trimmedLocation || null, startedAt, userId);

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
    }).catch(() => {});
  }

  res.json({
    walkId: info.lastInsertRowid,
    dogId,
    location: finalLocation,
    startedAt,
    stopsAt: walkStopsAt({ started_at: startedAt, extend_minutes: 0 }),
    autoStopMinutes: AUTO_STOP_MINUTES
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
  if (walkLimitMinutes(walk) + EXTEND_MINUTES > MAX_TOTAL_MINUTES) {
    return res.status(409).json({ error: `Walks can be extended up to ${MAX_TOTAL_MINUTES / 60} hours in total.` });
  }
  db.prepare('UPDATE walks SET extend_minutes = extend_minutes + ?, warned = 0 WHERE id = ?').run(EXTEND_MINUTES, id);
  const updated = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  res.json({ walkId: id, stopsAt: walkStopsAt(updated), addedMinutes: EXTEND_MINUTES });
});

app.put('/api/walks/:id/end', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { notes } = req.body;
  const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  if (walkAccessDenied(req, res, walk)) return;
  if (walk.ended_at) {
    return res.status(409).json({
      error: walk.auto_stopped ? `This walk was stopped automatically after ${Math.round(walk.duration_seconds / 60)} minutes.` : 'Walk already ended',
      autoStopped: !!walk.auto_stopped,
      endedAt: walk.ended_at,
      durationSeconds: walk.duration_seconds
    });
  }

  const endedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.round((new Date(endedAt) - new Date(walk.started_at)) / 1000));

  db.prepare(`
    UPDATE walks SET ended_at = ?, duration_seconds = ?, notes = ? WHERE id = ?
  `).run(endedAt, durationSeconds, notes ? String(notes).trim() : null, id);

  res.json({ walkId: id, endedAt, durationSeconds });
});

// Correct a walk's recorded times after the fact (you forgot to end it
// promptly, mis-tapped, etc). Only touches fields actually sent.
app.put('/api/walks/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const walk = db.prepare('SELECT * FROM walks WHERE id = ?').get(id);
  if (!walk) return res.status(404).json({ error: 'Walk not found' });
  if (walkAccessDenied(req, res, walk)) return;
  const startedAt = req.body.startedAt || walk.started_at;
  const endedAt = req.body.endedAt !== undefined ? req.body.endedAt : walk.ended_at;
  const location = req.body.location !== undefined ? String(req.body.location).trim() : walk.location;
  const notes = req.body.notes !== undefined ? (req.body.notes ? String(req.body.notes).trim() : null) : walk.notes;
  const durationSeconds = endedAt
    ? Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000))
    : null;
  // Only a real change to the times counts as an edit — re-saving the same
  // values (e.g. opening the editor and tapping Save without changing
  // anything) must not flip the "Edited" badge on.
  const timesChanged = startedAt !== walk.started_at || endedAt !== walk.ended_at;
  // Preserve the true original the first time it's ever edited; later edits
  // don't overwrite it, so it always reflects what was originally scanned.
  const originalStartedAt = timesChanged && walk.original_started_at == null ? walk.started_at : walk.original_started_at;
  const originalEndedAt = timesChanged && walk.original_ended_at == null ? walk.ended_at : walk.original_ended_at;
  db.prepare(`
    UPDATE walks SET started_at = ?, ended_at = ?, location = ?, notes = ?, duration_seconds = ?,
           edited = CASE WHEN ? THEN 1 ELSE edited END,
           original_started_at = ?, original_ended_at = ?
    WHERE id = ?
  `).run(startedAt, endedAt, location, notes, durationSeconds, timesChanged ? 1 : 0, originalStartedAt, originalEndedAt, id);
  res.json({ id, startedAt, endedAt, location, notes, durationSeconds, edited: timesChanged || !!walk.edited });
});

// Log a walk that already happened but was never entered live (forgot to
// scan someone in, catching up on a paper log, etc). Requires both times —
// this always represents a completed walk, never an in-progress one, so it
// can't collide with the single-active-walk-per-user rule.
app.post('/api/walks/manual', (req, res) => {
  const { dogId, userId, location, startedAt, endedAt, notes } = req.body;
  if (!dogId || !userId || !startedAt || !endedAt) {
    return res.status(400).json({ error: 'dogId, userId, startedAt, and endedAt are all required' });
  }
  const dog = db.prepare('SELECT shelter_buddy_id FROM dogs WHERE shelter_buddy_id = ?').get(dogId);
  if (!dog) return res.status(404).json({ error: 'Dog not found' });
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  const durationSeconds = Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  const cleanLocation = location && String(location).trim() ? String(location).trim() : null;
  const info = db.prepare(`
    INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, notes, manual_entry)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(dogId, userId, cleanLocation, startedAt, endedAt, durationSeconds, notes ? String(notes).trim() : null);
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
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT w.*, d.name AS dog_name, d.photo_url, d.breed,
           d.blue_markers, d.poo_status, d.star_flag, d.pb_flag
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    ${where} ORDER BY w.started_at DESC LIMIT ?
  `).all(...params, limit);
  rows.forEach((r) => { r.photo_url = cachedPhotoUrl(r.dog_id, r.photo_url); });
  res.json({ walks: rows });
});

// Every completed walk (any user) whose started_at falls in a UTC range —
// used to build the Available list's per-dog "walked this time slot today"
// grid. The client computes the range from ITS OWN local midnight-to-midnight
// so day boundaries land correctly regardless of server timezone.
app.get('/api/walks/for-day', (req, res) => {
  const { fromUtc, toUtc, dateKey } = req.query;
  if (!fromUtc || !toUtc) return res.status(400).json({ error: 'fromUtc and toUtc are required' });
  const rows = db.prepare(`
    SELECT dog_id, started_at, duration_seconds
    FROM walks WHERE ended_at IS NOT NULL AND started_at >= ? AND started_at < ?
  `).all(fromUtc, toUtc);
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
// multi-user support existed, everything defaulted to one account).
app.put('/api/walks/:id/user', (req, res) => {
  if (!isStaffOrPrivileged(req, req.me)) return res.status(403).json({ error: 'Only staff can reassign a walk.' });
  const id = parseInt(req.params.id, 10);
  const userId = Number(req.body.targetUserId);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(400).json({ error: 'Unknown user' });
  const info = db.prepare('UPDATE walks SET user_id = ? WHERE id = ?').run(userId, id);
  if (info.changes === 0) return res.status(404).json({ error: 'Walk not found' });
  res.json({ id, userId });
});

// ---- Stats (personal to each user) ----
app.get('/api/stats', (req, res) => {
  const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const totals = db.prepare(`
    SELECT COUNT(*) AS totalWalks, COUNT(DISTINCT dog_id) AS uniqueDogs,
           COALESCE(SUM(duration_seconds), 0) AS totalSeconds,
           COALESCE(AVG(duration_seconds), 0) AS avgSeconds
    FROM walks WHERE ended_at IS NOT NULL AND user_id = ?
  `).get(userId);

  const perDog = db.prepare(`
    SELECT d.shelter_buddy_id AS id, d.name, d.photo_url, d.still_listed AS stillListed,
           d.removed_at AS removedAt,
           d.blue_markers, d.poo_status, d.star_flag, d.pb_flag,
           COUNT(w.id) AS walkCount, MAX(w.started_at) AS lastWalkedAt,
           COALESCE(SUM(w.duration_seconds), 0) AS totalSeconds
    FROM walks w JOIN dogs d ON d.shelter_buddy_id = w.dog_id
    WHERE w.ended_at IS NOT NULL AND w.user_id = ?
    GROUP BY d.shelter_buddy_id
    ORDER BY walkCount DESC, lastWalkedAt DESC
  `).all(userId);
  perDog.forEach((r) => { r.photo_url = cachedPhotoUrl(r.id, r.photo_url); r.stillListed = !!r.stillListed; });

  res.json({ totals, perDog });
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
  const row = db.prepare('SELECT MAX(last_seen_at) AS lastScrapeAt, COUNT(*) AS dogCount FROM dogs WHERE still_listed = 1').get();
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
    const lastOk = db.prepare('SELECT finished_at AS finishedAt FROM scrape_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() || null;
    const openWalks = db.prepare('SELECT COUNT(*) AS c FROM walks WHERE ended_at IS NULL').get().c;
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      lastScrape: lastRun,
      lastSuccessfulScrapeAt: lastOk ? lastOk.finishedAt : null,
      openWalks
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Any error that escapes a route becomes a clean JSON response instead of
// Express's default HTML stack page (which the frontend can't parse).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`[server] ${req.method} ${req.originalUrl} failed:`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server. Please try again.' : (err.message || 'Bad request') });
});

// ---- Walk time limit ----
// A walk stops by itself after AUTO_STOP_MINUTES so a forgotten "End Walk"
// never ties up a dog or blocks that volunteer from starting the next one.
// The walker can add EXTEND_MINUTES at a time (before it stops) for a longer
// walk. A walk the system ended is flagged auto_stopped, and is recorded as
// running exactly to its limit -- not to whenever we noticed.
const AUTO_STOP_MINUTES = 20;
const EXTEND_MINUTES = 10;
const MAX_TOTAL_MINUTES = 180;
const WARN_MINUTES_BEFORE = 3;
const walkLimitMinutes = (w) => AUTO_STOP_MINUTES + (w.extend_minutes || 0);
const walkStopsAt = (w) => new Date(new Date(w.started_at).getTime() + walkLimitMinutes(w) * 60000).toISOString();

function enforceWalkLimits() {
  const open = db.prepare(`
    SELECT w.id, w.user_id, w.started_at, w.extend_minutes, w.warned, d.name AS dog_name
    FROM walks w LEFT JOIN dogs d ON d.shelter_buddy_id = w.dog_id WHERE w.ended_at IS NULL
  `).all();
  const now = Date.now();
  for (const w of open) {
    const stopsAt = new Date(walkStopsAt(w)).getTime();
    if (now >= stopsAt) {
      const minutes = walkLimitMinutes(w);
      db.prepare('UPDATE walks SET ended_at = ?, duration_seconds = ?, auto_stopped = 1 WHERE id = ? AND ended_at IS NULL')
        .run(new Date(stopsAt).toISOString(), minutes * 60, w.id);
      console.warn(`[server] auto-stopped walk ${w.id} after ${minutes} min`);
      if (w.user_id && push.hasPref(w.user_id, 'walk_started')) {
        push.sendPushToUser(w.user_id, {
          title: `${w.dog_name || 'Your walk'}: stopped automatically`,
          body: `Walks stop after ${minutes} minutes. If it ran longer, you can fix the time in Stats.`,
          url: '/',
          tag: WALK_PUSH_TAG
        }).catch(() => {});
      }
    } else if (!w.warned && stopsAt - now <= WARN_MINUTES_BEFORE * 60000) {
      db.prepare('UPDATE walks SET warned = 1 WHERE id = ?').run(w.id);
      if (w.user_id && push.hasPref(w.user_id, 'walk_started')) {
        push.sendPushToUser(w.user_id, {
          title: `${w.dog_name || 'Your walk'}: ${WARN_MINUTES_BEFORE} minutes left`,
          body: 'Open the app to add more time, or the walk will stop on its own.',
          url: '/',
          tag: WALK_PUSH_TAG
        }).catch(() => {});
      }
    }
  }
}
setInterval(() => { try { enforceWalkLimits(); } catch (err) { console.error('[server] walk limit sweep failed:', err); } }, 30 * 1000);
try { enforceWalkLimits(); } catch (err) { console.error('[server] walk limit sweep failed:', err); }

// Scrape history is only useful for health checks; keep 90 days.
function pruneOldRecords() {
  db.prepare('DELETE FROM scrape_runs WHERE started_at < ?').run(new Date(Date.now() - 90 * 86400 * 1000).toISOString());
}
setInterval(() => { try { pruneOldRecords(); } catch (err) { console.error('[server] prune failed:', err); } }, 24 * 3600 * 1000);
try { pruneOldRecords(); } catch (err) { console.error('[server] prune failed:', err); }

// Loopback only: Caddy is the sole legitimate client (it injects the trusted
// X-Auth-Email header after authenticating), so nothing else should ever be
// able to reach this port and forge that header.
app.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => {
  console.log(`dogwalk server listening on port ${PORT}`);
});

// Run once shortly after startup (catches up after a restart regardless of
// time of day), then on a fixed daily schedule: once first thing in the
// morning (6am, catches overnight intakes before the shelter opens), then
// hourly through adoption hours (noon-7pm) when listings/photos change most
// often as dogs get adopted or brought in.
if (!process.env.DISABLE_SCRAPER) {
  setTimeout(() => {
    scrapeInFlight = true;
    runScrape().catch((err) => console.error('[scraper] initial run failed:', err)).finally(() => { scrapeInFlight = false; });
  }, 5000);

  cron.schedule('0 6,12-19 * * *', () => {
    if (scrapeInFlight) {
      console.log('[scraper] skipping scheduled run, one already in flight');
      return;
    }
    scrapeInFlight = true;
    runScrape().catch((err) => console.error('[scraper] scheduled run failed:', err)).finally(() => { scrapeInFlight = false; });
  }, { timezone: 'America/New_York' }); // the shelter's local time, not the server's - matters since the server runs in UTC
}
