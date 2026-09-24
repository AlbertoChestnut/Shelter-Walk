const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dogwalk.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Another process (the nightly backup's .backup, a manual sqlite3 session)
// holding a lock briefly should make us wait, not throw SQLITE_BUSY at a
// volunteer mid-walk.
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS dogs (
  shelter_buddy_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sex TEXT,
  age TEXT,
  breed TEXT,
  weight TEXT,
  desexed TEXT,
  location TEXT,
  date_in_shelter TEXT,
  summary TEXT,
  tags TEXT,
  photo_url TEXT,
  still_listed INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE IF NOT EXISTS walks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dog_id INTEGER NOT NULL REFERENCES dogs(shelter_buddy_id),
  location TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_checkoffs (
  dog_id INTEGER NOT NULL REFERENCES dogs(shelter_buddy_id),
  date_key TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (dog_id, date_key)
);

-- One row per dog/day/shift-slot marking a walk that happened but was never
-- scanned into the app (a staff walk, a quick bathroom break, etc). Rows are
-- permanent (never deleted in bulk) so history/stats survive past today, but
-- only today's date_key is ever shown as "checked" on the confirm screen —
-- that's what gives the natural midnight reset without losing the record.
CREATE TABLE IF NOT EXISTS manual_shift_checkoffs (
  dog_id INTEGER NOT NULL REFERENCES dogs(shelter_buddy_id),
  date_key TEXT NOT NULL,
  slot_index INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  PRIMARY KEY (dog_id, date_key, slot_index)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- A user's own named filter combination for the Available list (Presets
-- tab) — private to that user, unlike everything else in this schema.
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColumns.includes('is_privileged')) {
  db.exec('ALTER TABLE users ADD COLUMN is_privileged INTEGER NOT NULL DEFAULT 0');
  // Whoever this app's data already belonged to becomes the first privileged
  // user — everyone else stays unprivileged until manually promoted (no UI
  // for that yet; flip the column directly if needed).
  db.prepare("UPDATE users SET is_privileged = 1 WHERE name = 'Alberto'").run();
}
// can_audit: a separate permission from is_privileged (Alumni) — someone can
// have one without the other. Gates the Audit Mode tab so most walkers never
// see it (keeps the app simple for the common case).
if (!userColumns.includes('can_audit')) {
  db.exec('ALTER TABLE users ADD COLUMN can_audit INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE users SET can_audit = 1 WHERE name = 'Alberto'").run();
}
// experience_level replaces the old freeform min_days_threshold: a named
// tier (beginner/established/expert) that bundles a day threshold together
// with blue-sticker/EVO/PB rules — see EXPERIENCE_LEVELS in server.js.
// NULL means "not chosen yet" — existing rows land here too, so everyone
// (new or already in the database) gets asked once on their next sign-in.
if (!userColumns.includes('experience_level')) {
  db.exec('ALTER TABLE users ADD COLUMN experience_level TEXT');
}
if (userColumns.includes('min_days_threshold')) {
  try {
    db.exec('ALTER TABLE users DROP COLUMN min_days_threshold');
  } catch (err) {
    // Older SQLite builds (pre-3.35) can't drop columns — harmless to leave
    // it in place unused if so.
    console.warn('[db] could not drop min_days_threshold:', err.message);
  }
}
// Links a walker to the shelterwalk.com account that identifies them, so
// the app can tell who's using it from the trusted X-Auth-Email header
// (set by Django, relayed by Caddy) instead of a manual name picker --
// stored only as a keyed one-way hash (see emailHash.js), never the email
// itself. NULL for any walker created before this existed.
if (!userColumns.includes('auth_email_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN auth_email_hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_email_hash ON users(auth_email_hash) WHERE auth_email_hash IS NOT NULL');
}
// One-time migration off an earlier plaintext auth_email column: hash
// whatever's there into auth_email_hash above, then drop it outright --
// nothing in this app reads the plaintext column any more.
if (userColumns.includes('auth_email')) {
  const { hashEmail } = require('./emailHash');
  const legacyRows = db.prepare('SELECT id, auth_email FROM users WHERE auth_email IS NOT NULL').all();
  for (const r of legacyRows) {
    db.prepare('UPDATE users SET auth_email_hash = ? WHERE id = ?').run(hashEmail(r.auth_email), r.id);
  }
  try {
    db.exec('DROP INDEX IF EXISTS idx_users_auth_email');
    db.exec('ALTER TABLE users DROP COLUMN auth_email');
  } catch (err) {
    // Older SQLite builds (pre-3.35) can't drop columns -- the values are
    // already migrated and unread either way, so this is cosmetic only.
    console.warn('[db] could not drop the old plaintext auth_email column (values are already migrated to auth_email_hash and no longer read from it):', err.message);
  }
}
// Whether this account has been walked through the first-run onboarding
// sequence (name -> experience level -> passkey offer -> notification
// prefs -> info -> thank you). Backfilled to "already done" for anyone who
// existed before this flag did, so it only ever applies going forward to
// genuinely new accounts.
if (!userColumns.includes('onboarding_completed')) {
  db.exec('ALTER TABLE users ADD COLUMN onboarding_completed INTEGER NOT NULL DEFAULT 0');
  db.prepare('UPDATE users SET onboarding_completed = 1').run();
}
// When this user last viewed the Updates tab -- drives the unread badge and
// the green "new" border on individual update cards. Backfilled to "now"
// for existing accounts so this feature's rollout doesn't dump every past
// event on everyone as unread; only events from here on ever count.
if (!userColumns.includes('updates_last_seen_at')) {
  db.exec('ALTER TABLE users ADD COLUMN updates_last_seen_at TEXT');
  db.prepare('UPDATE users SET updates_last_seen_at = ?').run(new Date().toISOString());
}
// Privacy: whether this volunteer's name shows on the LIVE "currently being
// walked by" badge while they have a dog out. Defaults to on (the app's
// existing, unchanged behavior) so no one's visibility silently changes;
// it's an opt-in to more privacy, not the other way around. Never affects
// anything once a walk ends -- that's a separate, absolute rule enforced
// everywhere walk history is shown, not a setting.
if (!userColumns.includes('hide_name_while_walking')) {
  db.exec('ALTER TABLE users ADD COLUMN hide_name_while_walking INTEGER NOT NULL DEFAULT 0');
}
// Migrations: add columns to dogs table if they don't exist yet (older DBs
// created before these columns existed).
// - poo_status: tri-state (none/poo/priority) — priority is the yellow
//   circle with a "*", a distinct shape from the separate gold star.
// - star_flag: independent gold star, unrelated to POO status.
// - blue_markers: JSON array of independently-toggleable blue behavior
//   markers (any combination of blue/blue_q/blue_c/blue_m/blue_h).
// poo_flag/behavior_marker are earlier, superseded columns left in place
// harmlessly (SQLite has no cheap DROP COLUMN in older versions).
const dogColumns = db.prepare("PRAGMA table_info(dogs)").all().map((c) => c.name);
if (!dogColumns.includes('poo_status')) {
  db.exec("ALTER TABLE dogs ADD COLUMN poo_status TEXT NOT NULL DEFAULT 'none'");
}
if (!dogColumns.includes('poo_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN poo_flag INTEGER NOT NULL DEFAULT 0');
}
if (!dogColumns.includes('star_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN star_flag INTEGER NOT NULL DEFAULT 0');
}
// pb_flag: "Potty Break OK" — yellow circle, independent of POO/star. Marks
// a dog as needing a short, bathroom-only walk (an injury or similar), not
// a shortcut around the days-in-shelter threshold -- an otherwise-too-new
// PB dog still isn't eligible until it meets it.
if (!dogColumns.includes('pb_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN pb_flag INTEGER NOT NULL DEFAULT 0');
}
// pb_early_flag: "PB-E", Potty Break Early — the opposite kind of exception:
// clears a dog for a short walk *before* the shelter's 7-day hold is up,
// for volunteer levels trusted with PB walks. Unlike pb_flag it deliberately
// does grant early eligibility, but only up to PB_EARLY_HOLD_DAYS (see
// server.js) -- once the dog reaches that many days it's eligible the
// normal way regardless, so the flag has nothing left to grant.
if (!dogColumns.includes('pb_early_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN pb_early_flag INTEGER NOT NULL DEFAULT 0');
}
// Alumni (returned dog): adds bonus days on top of actual days-in-shelter
// for eligibility purposes only — gated to privileged users, see users
// migration below.
if (!dogColumns.includes('alumni_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN alumni_flag INTEGER NOT NULL DEFAULT 0');
}
if (!dogColumns.includes('alumni_bonus_days')) {
  db.exec('ALTER TABLE dogs ADD COLUMN alumni_bonus_days INTEGER NOT NULL DEFAULT 0');
}
if (!dogColumns.includes('behavior_marker')) {
  db.exec("ALTER TABLE dogs ADD COLUMN behavior_marker TEXT NOT NULL DEFAULT 'none'");
}
if (!dogColumns.includes('blue_markers')) {
  db.exec("ALTER TABLE dogs ADD COLUMN blue_markers TEXT NOT NULL DEFAULT '[]'");
}
// kennel_location: current known physical location, kept up to date whenever
// you save it standalone or start a walk. Locations are unique in practice
// (one dog per kennel), enforced in application code — see setKennelLocation.
if (!dogColumns.includes('kennel_location')) {
  db.exec('ALTER TABLE dogs ADD COLUMN kennel_location TEXT');
}
// Cumulative days from every PRIOR completed stay at the shelter for this
// dog (auto-computed by the scraper when a previously-removed dog reappears
// in a fresh scrape — see detectReturn() in scraper.js), uncapped and
// separate from the manual, capped Alumni bonus above. Both add into
// effectiveDaysInShelter (see serializeDog in server.js) since they answer
// different questions: Alumni is "give this dog credit as if returning",
// this is "this dog *is* returning and we know their real prior time".
if (!dogColumns.includes('previous_days_in_shelter')) {
  db.exec('ALTER TABLE dogs ADD COLUMN previous_days_in_shelter INTEGER NOT NULL DEFAULT 0');
}

// ---- Multi-user migration ----
// Walk history, per-user experience level, and adoption notifications are
// personal; dog data (markers, POO, kennel location, walk counts/notes shown
// to any walker) stays shared and untouched by any of this.
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const now = new Date().toISOString();
  // experience_level left NULL — the onboarding prompt picks it up on their
  // first sign-in rather than guessing.
  const insertUser = db.prepare(
    'INSERT INTO users (name, created_at, is_privileged, can_audit) VALUES (?, ?, ?, ?)'
  );
  insertUser.run('Alberto', now, 1, 1);
  insertUser.run('Volunteer', now, 0, 0);
}
// Existing data (from before multi-user support) is attributed to whoever
// was the first/seed user -- originally always named "Alberto", but that's
// just a name on a row someone can (and did) change, so don't assume it's
// still there; fall back to the earliest-created user if not.
const defaultUserId = (
  db.prepare('SELECT id FROM users WHERE name = ?').get('Alberto') ||
  db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() ||
  {}
).id;

const walkColumns = db.prepare('PRAGMA table_info(walks)').all().map((c) => c.name);
if (!walkColumns.includes('user_id')) {
  db.exec('ALTER TABLE walks ADD COLUMN user_id INTEGER REFERENCES users(id)');
  db.prepare('UPDATE walks SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
}
// manual_entry: logged after the fact via "Add Past Walk" rather than a live
// scan. edited: times were corrected after the walk was originally recorded.
// Both surface as a small badge so it's clear the record isn't a live scan.
if (!walkColumns.includes('manual_entry')) {
  db.exec('ALTER TABLE walks ADD COLUMN manual_entry INTEGER NOT NULL DEFAULT 0');
}
if (!walkColumns.includes('edited')) {
  db.exec('ALTER TABLE walks ADD COLUMN edited INTEGER NOT NULL DEFAULT 0');
}
// Set once, the first time a walk's times are actually changed (not just
// re-saved unchanged) — preserves the original scanned-in times forever so
// an edit can always be reviewed against what was originally recorded.
if (!walkColumns.includes('original_started_at')) {
  db.exec('ALTER TABLE walks ADD COLUMN original_started_at TEXT');
}
if (!walkColumns.includes('original_ended_at')) {
  db.exec('ALTER TABLE walks ADD COLUMN original_ended_at TEXT');
}

// shelter_events: a shared, global feed (the Updates tab) of shelter-level
// happenings -- a new dog listed, one removed, one adopted, one returned.
// Superseded the older per-user "notifications" topbar bell entirely (kind
// 'adoption' rows there, one per user who'd walked that dog, get collapsed
// here into one shared row per dog adoption instead -- personalization for
// "a dog I walked was adopted" now happens at read time in server.js by
// joining against walks + notification_prefs, not by duplicating rows).
db.exec(`
  CREATE TABLE IF NOT EXISTS shelter_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    dog_id INTEGER REFERENCES dogs(shelter_buddy_id),
    title TEXT,
    detail TEXT,
    occurred_at TEXT NOT NULL
  );
`);
const oldNotifColumns = db.prepare("PRAGMA table_info(notifications)").all().map((c) => c.name);
if (oldNotifColumns.length > 0) {
  const oldRows = db.prepare(
    "SELECT dog_id, MIN(detected_at) AS detected_at FROM notifications WHERE kind = 'adoption' GROUP BY dog_id"
  ).all();
  const reinsert = db.prepare(
    "INSERT INTO shelter_events (kind, dog_id, occurred_at) VALUES ('adopted', ?, ?)"
  );
  for (const row of oldRows) reinsert.run(row.dog_id, row.detected_at);
  db.exec('DROP TABLE notifications');
}
const oldAdoptionNotifColumns = db.prepare("PRAGMA table_info(adoption_notifications)").all().map((c) => c.name);
if (oldAdoptionNotifColumns.length > 0) {
  db.exec('DROP TABLE adoption_notifications');
}

// Granular, per-category opt-in notification settings -- a small key/value
// table rather than one column per category, so adding a new push-notice
// type later doesn't need a migration. Unknown/missing keys default to off
// (see server.js's notification-prefs endpoints).
db.exec(`
  CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id INTEGER NOT NULL REFERENCES users(id),
    pref_key TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, pref_key)
  );
`);

// Web Push subscriptions (one browser/device registration per row). A user
// can have several (multiple devices); a dead one (push service returns
// 404/410) gets deleted rather than retried forever -- see sendPushToUser
// in push.js.
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Missed-scrape counter: a dog is only treated as gone after being absent
// from consecutive scrapes (or confirmed on the shelter's adopted list), so
// a single flaky/partial listing can't mass-delist dogs, fire false
// "returned" events, and bank phantom days into previous_days_in_shelter.
if (!dogColumns.includes('missed_scrapes')) {
  db.exec('ALTER TABLE dogs ADD COLUMN missed_scrapes INTEGER NOT NULL DEFAULT 0');
}

// One row per scrape attempt -- feeds the /healthz endpoint and the
// external health check (stale or repeatedly failing scrapes get noticed
// instead of silently leaving the dog list frozen).
db.exec(`
  CREATE TABLE IF NOT EXISTS scrape_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER NOT NULL DEFAULT 0,
    dog_count INTEGER,
    note TEXT
  );
`);

// Small key/value store for app-level flags (e.g. "wiki already seeded").
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Guide / wiki: staff-editable sections shown in the app's Guide view.
// body is lightweight markdown (see renderMarkdown in app.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS wiki_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    icon TEXT,
    body TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );
`);

// Per-dog notes between walkers (see notes.js): 'public' tips everyone can
// read (never shown with an author), and one 'private' note per walker per dog
// that only its author can ever read.
db.exec(`
  CREATE TABLE IF NOT EXISTS dog_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dog_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dog_notes_dog ON dog_notes(dog_id, visibility);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dog_notes_private ON dog_notes(dog_id, user_id) WHERE visibility = 'private';
`);

// Walks stop on their own after AUTO_STOP_MINUTES (see server.js) unless the
// walker extends them. auto_stopped flags one the system ended (so the record
// and the stats can say so), extend_minutes is the total time added by hand,
// warned marks that the "about to stop" notice already went out.
if (!walkColumns.includes('auto_stopped')) db.exec('ALTER TABLE walks ADD COLUMN auto_stopped INTEGER NOT NULL DEFAULT 0');
if (!walkColumns.includes('extend_minutes')) db.exec('ALTER TABLE walks ADD COLUMN extend_minutes INTEGER NOT NULL DEFAULT 0');
if (!walkColumns.includes('warned')) db.exec('ALTER TABLE walks ADD COLUMN warned INTEGER NOT NULL DEFAULT 0');

// Indexes for the queries every screen leans on (all were full table scans).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_walks_dog ON walks(dog_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_walks_user ON walks(user_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_walks_started ON walks(started_at);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON shelter_events(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_dogs_listed ON dogs(still_listed);
`);

module.exports = db;
