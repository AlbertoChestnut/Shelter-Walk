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
// Deleted rows (a deleted account, an erased note) are overwritten with
// zeros instead of lingering in the file's free pages until reused.
db.pragma('secure_delete = ON');

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
// walk_alert_minutes: up to 3 walk lengths (a JSON list of minutes, e.g.
// [7, 10]) at which the walker wants a push notification. Empty = none.
// default_activity: what the scan screen's start button offers first
// (walk, cuddle, matchmaking or playgroup).
if (!userColumns.includes('default_activity')) {
  db.exec("ALTER TABLE users ADD COLUMN default_activity TEXT NOT NULL DEFAULT 'walk'");
}
if (!userColumns.includes('walk_alert_minutes')) {
  db.exec("ALTER TABLE users ADD COLUMN walk_alert_minutes TEXT NOT NULL DEFAULT '[]'");
}
// level_up_offered_at: when a Beginner who passed 20 hours of walks was
// asked (once) whether to move up to Established, whatever they answered.
if (!userColumns.includes('level_up_offered_at')) {
  db.exec('ALTER TABLE users ADD COLUMN level_up_offered_at TEXT');
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
// a dog as cleared for a short, bathroom-only walk, which also clears the
// days-in-shelter wait for levels allowed to walk PB dogs (see server.js).
if (!dogColumns.includes('pb_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN pb_flag INTEGER NOT NULL DEFAULT 0');
}
// pb_early_flag: leftover from the retired "PB-E" (Potty Break Early)
// marker, folded back into plain PB. The column stays so older backups
// still load; any dog still carrying it is moved over to pb_flag here.
if (!dogColumns.includes('pb_early_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN pb_early_flag INTEGER NOT NULL DEFAULT 0');
}
db.exec('UPDATE dogs SET pb_flag = 1, pb_early_flag = 0 WHERE pb_early_flag = 1');
// Alumni (returned dog): adds bonus days on top of actual days-in-shelter
// for eligibility purposes only — gated to privileged users, see users
// migration below.
if (!dogColumns.includes('alumni_flag')) {
  db.exec('ALTER TABLE dogs ADD COLUMN alumni_flag INTEGER NOT NULL DEFAULT 0');
}
if (!dogColumns.includes('alumni_bonus_days')) {
  db.exec('ALTER TABLE dogs ADD COLUMN alumni_bonus_days INTEGER NOT NULL DEFAULT 0');
}
// Separate from the bonus days above: a privileged user vouching that a
// dog doesn't need to sit out a stray hold the shelter's site still shows
// (e.g. a known returning dog). Independent on purpose -- bonus days and
// the stray-hold bypass are two different calls a staff member can make
// about the same dog, either, neither, or both.
if (!dogColumns.includes('alumni_bypass_stray_hold')) {
  db.exec('ALTER TABLE dogs ADD COLUMN alumni_bypass_stray_hold INTEGER NOT NULL DEFAULT 0');
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
// A kennel card scanned before the shelter's listing has the dog: a stand-in
// row (still_listed = 0, so it's in no list) keyed by the card's Animal ID,
// so a walk can start and be filed under that ID. The scraper fills in the
// real details when the listing arrives and clears this (see scraper.js).
if (!dogColumns.includes('awaiting_listing')) {
  db.exec('ALTER TABLE dogs ADD COLUMN awaiting_listing INTEGER NOT NULL DEFAULT 0');
}
// Kennel locations went from exact spots ("B17") to just the wing letter
// ("B"). Folds any older full code down to its letter, including the
// kennel-card "Da12" quirk (a redundant leading D); anything that isn't
// an A-E code is cleared. Walk history keeps whatever was recorded then.
db.exec(`
  UPDATE dogs SET kennel_location = CASE
    WHEN upper(trim(kennel_location)) GLOB 'D[A-E][0-9]*' THEN substr(upper(trim(kennel_location)), 2, 1)
    WHEN upper(substr(trim(kennel_location), 1, 1)) IN ('A','B','C','D','E') THEN upper(substr(trim(kennel_location), 1, 1))
    ELSE NULL
  END
  WHERE kennel_location IS NOT NULL AND length(kennel_location) != 1
     OR kennel_location IS NOT NULL AND upper(kennel_location) NOT IN ('A','B','C','D','E')
     OR kennel_location IS NOT NULL AND kennel_location != upper(kennel_location)
`);
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
// A fresh database starts with no users at all: everyone is created on first
// sign-in, unprivileged. (It used to seed a privileged "Alberto" and a
// "Volunteer", which the first sign-in with a matching name could claim;
// databases that already have those rows keep them exactly as they are.)
// Permissions are granted afterwards from the auth service's staff panel.
//
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
  if (defaultUserId != null) db.prepare('UPDATE walks SET user_id = ? WHERE user_id IS NULL').run(defaultUserId);
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
// A shelter alert stops showing in the Updates feed at expires_at (see
// shelterSchedule.js). about_date ties an alert sent for a special day to
// that date, so changing or removing the day can retire the alert with it.
const eventColumns = db.prepare('PRAGMA table_info(shelter_events)').all().map((c) => c.name);
if (!eventColumns.includes('expires_at')) db.exec('ALTER TABLE shelter_events ADD COLUMN expires_at TEXT');
if (!eventColumns.includes('about_date')) db.exec('ALTER TABLE shelter_events ADD COLUMN about_date TEXT');
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

// Scraper news found during quiet hours (adopted, pending, back at the
// shelter), held until the morning instead of buzzing anyone overnight; see
// sendScraperPush in scraper.js. Rows are deleted as they're sent, and with
// the account (account.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS queued_pushes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    queued_at TEXT NOT NULL
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

// End-of-day listing counts for Stats > Shelter, written after each good
// scrape (the day's last one wins). It's the only record of how many listed
// dogs were in foster on a past day; total listed is rebuilt from events.
db.exec(`
  CREATE TABLE IF NOT EXISTS shelter_daily_counts (
    date_key TEXT PRIMARY KEY,
    listed INTEGER NOT NULL,
    in_foster INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
  );
`);
// The same per species (Stats > Shelter has cat trends too, owner 2026-11-09).
// shelter_daily_counts was dogs only and is no longer written; its days are
// copied in as the dog rows (never over a newer count).
db.exec(`
  CREATE TABLE IF NOT EXISTS shelter_species_counts (
    date_key TEXT NOT NULL,
    species TEXT NOT NULL,
    listed INTEGER NOT NULL,
    in_foster INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (date_key, species)
  );
  INSERT OR IGNORE INTO shelter_species_counts (date_key, species, listed, in_foster, recorded_at)
    SELECT date_key, 'dog', listed, in_foster, recorded_at FROM shelter_daily_counts;
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

// Playgroup notes (see playgroupNotes.js): dated entries, one per session
// or pasted history, readable by every walker. Anonymous unless the writer
// chose to sign it (signed = 1 shows their name). Tags of other dogs are
// written into the body as @[dogId]; playgroup_mentions indexes them so each
// dog can list what other dogs' notes said about it.
db.exec(`
  CREATE TABLE IF NOT EXISTS playgroup_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dog_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    signed INTEGER NOT NULL DEFAULT 0,
    note_date TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_playgroup_notes_dog ON playgroup_notes(dog_id);
  CREATE TABLE IF NOT EXISTS playgroup_mentions (
    note_id INTEGER NOT NULL REFERENCES playgroup_notes(id) ON DELETE CASCADE,
    dog_id INTEGER NOT NULL,
    PRIMARY KEY (note_id, dog_id)
  );
  CREATE INDEX IF NOT EXISTS idx_playgroup_mentions_dog ON playgroup_mentions(dog_id);
`);
// Set once anyone but the writer changes a Playgroup note's text: from then
// on the writer can't sign it, or their name would go on someone else's words.
if (!db.prepare('PRAGMA table_info(playgroup_notes)').all().some((c) => c.name === 'edited_by_other')) {
  db.exec('ALTER TABLE playgroup_notes ADD COLUMN edited_by_other INTEGER NOT NULL DEFAULT 0');
}

// Dogs a walker has hearted. Personal, like private notes: drives the
// "My favorites" filter and the favorite_* push notices (see scraper.js).
// Kept after a dog leaves the listing, so a favorite that comes back is
// still a favorite.
db.exec(`
  CREATE TABLE IF NOT EXISTS favorite_dogs (
    user_id INTEGER NOT NULL REFERENCES users(id),
    dog_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, dog_id)
  );
  CREATE INDEX IF NOT EXISTS idx_favorite_dogs_dog ON favorite_dogs(dog_id);
`);

// Feedback and bug reports from My Account. Deliberately no user column:
// like shared tips, a report can never be traced back to whoever sent it.
// device is the browser's user agent, only when the sender ticks the box.
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'idea', 'other')),
    body TEXT NOT NULL,
    device TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
`);

// Walks stop on their own after AUTO_STOP_MINUTES (see server.js) unless the
// walker extends them. auto_stopped flags one the system ended (so the record
// and the stats can say so), extend_minutes is the total time added by hand,
// warned marks that the "about to stop" notice already went out.
if (!walkColumns.includes('auto_stopped')) db.exec('ALTER TABLE walks ADD COLUMN auto_stopped INTEGER NOT NULL DEFAULT 0');
if (!walkColumns.includes('extend_minutes')) db.exec('ALTER TABLE walks ADD COLUMN extend_minutes INTEGER NOT NULL DEFAULT 0');
if (!walkColumns.includes('warned')) db.exec('ALTER TABLE walks ADD COLUMN warned INTEGER NOT NULL DEFAULT 0');
// wrap_up_pending: the time limit stopped this walk and the walker hasn't
// said yet when it really ended (they get the end screen next time they
// open the app, as if the walk were still going).
if (!walkColumns.includes('wrap_up_pending')) db.exec('ALTER TABLE walks ADD COLUMN wrap_up_pending INTEGER NOT NULL DEFAULT 0');
// alerted_minutes: the latest of the walker's length alerts already sent
// for this walk, so each one goes out once.
// activity: what the volunteer did with the dog. Every kind counts as time
// with the dog exactly like a walk; only the label/emoji differs.
if (!walkColumns.includes('activity')) db.exec("ALTER TABLE walks ADD COLUMN activity TEXT NOT NULL DEFAULT 'walk'");
// closes_at: the official closing time in force when the walk started.
// Staff changing that day's hours later never ends or shortens a walk
// already out (server.js walkClosesMs). Open walks from before this column
// are filled in at startup, once the staff hours are loaded (server.js).
if (!walkColumns.includes('closes_at')) db.exec('ALTER TABLE walks ADD COLUMN closes_at TEXT');
// end_token: a random secret handed to the phone that started the walk. An
// End tapped there offline can still be sent after someone else signs in on
// that (shared) phone: the token stands in for the walker's sign-in, for
// ending it at the tap and nothing else (server.js PUT /api/walks/:id/end).
if (!walkColumns.includes('end_token')) db.exec('ALTER TABLE walks ADD COLUMN end_token TEXT');
if (!walkColumns.includes('alerted_minutes')) db.exec('ALTER TABLE walks ADD COLUMN alerted_minutes INTEGER NOT NULL DEFAULT 0');

// Names the shelter used for a dog before renaming them (JSON array, see
// dogNames.js). Backfilled once from each dog's "<name> was added to the
// shelter's listing" event, for renames that happened before this column.
if (!dogColumns.includes('previous_names')) {
  db.exec("ALTER TABLE dogs ADD COLUMN previous_names TEXT NOT NULL DEFAULT '[]'");
}
// species: 'dog' or 'cat' (species.js). The table keeps its old name -- it
// holds every animal now -- and everything from before cats is a dog.
if (!dogColumns.includes('species')) {
  db.exec("ALTER TABLE dogs ADD COLUMN species TEXT NOT NULL DEFAULT 'dog'");
}
// species_pref: who this volunteer works with -- 'dog', 'cat' or 'both'.
// Decides which animals their lists and Updates show (scanning works for any).
if (!userColumns.includes('species_pref')) {
  db.exec("ALTER TABLE users ADD COLUMN species_pref TEXT NOT NULL DEFAULT 'dog'");
}
// desktop_view: the page this person starts on when they open the site on a
// computer (desktopViews.js). NULL = the default for who they are.
if (!userColumns.includes('desktop_view')) {
  db.exec('ALTER TABLE users ADD COLUMN desktop_view TEXT');
}
// default_activity_cat (audit 3, ui): the cats' own default activity, so a
// "both" volunteer's Matchmaking for cats doesn't turn every dog into
// matchmaking (default_activity stays the dogs'). NULL = the cats' first
// activity (cuddle). A cat-only volunteer's current default, when cats can
// do it, becomes their cat default.
if (!userColumns.includes('default_activity_cat')) {
  db.exec('ALTER TABLE users ADD COLUMN default_activity_cat TEXT');
  db.exec("UPDATE users SET default_activity_cat = default_activity WHERE species_pref = 'cat' AND default_activity IN ('cuddle', 'matchmaking')");
}
// video_url: a YouTube link found in the dog's summary on the shelter's own
// page (scraper.js), so their profile can link straight to it.
if (!dogColumns.includes('video_url')) {
  db.exec('ALTER TABLE dogs ADD COLUMN video_url TEXT');
}
if (!db.prepare("SELECT 1 FROM app_meta WHERE key = 'previous_names_backfilled'").get()) {
  const { isRename, withPreviousName } = require('./dogNames');
  const firstNames = db.prepare(`
    SELECT d.shelter_buddy_id AS id, d.name, d.previous_names, e.title
    FROM dogs d JOIN shelter_events e ON e.dog_id = d.shelter_buddy_id AND e.kind = 'new_dog'
    WHERE d.previous_names = '[]'
      AND e.id = (SELECT MIN(id) FROM shelter_events WHERE dog_id = d.shelter_buddy_id AND kind = 'new_dog')
  `).all();
  const setPrevious = db.prepare('UPDATE dogs SET previous_names = ? WHERE shelter_buddy_id = ?');
  db.transaction(() => {
    for (const r of firstNames) {
      const m = /^(.*) was added to the shelter's listing$/.exec(r.title || '');
      if (m && isRename(m[1], r.name)) setPrevious.run(withPreviousName('[]', m[1], r.name), r.id);
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('previous_names_backfilled', '1')").run();
  })();
}

// Wake County's own bios end with a "reach out to our volunteer
// matchmakers" pitch naming the dog and its shelter id (e.g. "Victorious,
// 271977") -- it only makes sense on the shelter's own site, which already
// has a contact form wired to that address. scraper.js now strips it before
// a summary is ever stored (see stripMatchmakerPitch there); this one-time
// pass cleans it out of summaries that were already saved before that.
if (!db.prepare("SELECT 1 FROM app_meta WHERE key = 'matchmaker_pitch_stripped'").get()) {
  const MATCHMAKER_PITCH_RE = /(?:<br\s*\/?>\s*){0,2}If you(?:'|&#0?39;|&rsquo;)re interested in learning more about [\w\s]{1,20}?,\s*please reach out to our volunteer matchmakers at wcac\.matchmaker@gmail\.com with the subject line\s*["“][^"”]{1,80}["”]\.?\s*(?:<br\s*\/?>\s*){0,2}/gi;
  const dirtyRows = db.prepare("SELECT shelter_buddy_id AS id, summary FROM dogs WHERE summary LIKE '%wcac.matchmaker@gmail.com%'").all();
  const setSummary = db.prepare('UPDATE dogs SET summary = ? WHERE shelter_buddy_id = ?');
  db.transaction(() => {
    for (const row of dirtyRows) {
      const cleaned = row.summary.replace(MATCHMAKER_PITCH_RE, '').trim();
      setSummary.run(cleaned || null, row.id);
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('matchmaker_pitch_stripped', '1')").run();
  })();
}

// Sticker on/off events (see server.js logStickerChanges) only exist from
// when that logging started -- a dog already wearing a sticker (star, PB,
// POO, a blue letter, EVO included) before then would otherwise show no
// history for it at all on the timeline. One-time backfill: for every
// sticker currently on with no sticker_on event yet, add one dated to this
// stay's start -- the earliest point being on it can honestly be pinned to.
if (!db.prepare("SELECT 1 FROM app_meta WHERE key = 'sticker_events_backfilled'").get()) {
  const { STICKER_LABELS } = require('./constants'); // the same labels server.js logs
  const stickerRows = db.prepare(`
    SELECT shelter_buddy_id AS id, blue_markers, poo_status, star_flag, pb_flag,
           COALESCE(date_in_shelter, first_seen_at) AS since
    FROM dogs
  `).all();
  const hasStickerEvent = db.prepare(
    "SELECT 1 FROM shelter_events WHERE dog_id = ? AND kind = 'sticker_on' AND detail = ? LIMIT 1"
  );
  const insertBackfillEvent = db.prepare(
    "INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES ('sticker_on', ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (const row of stickerRows) {
      if (!row.since) continue;
      const keys = JSON.parse(row.blue_markers || '[]').filter((m) => m !== 'blue');
      if (row.star_flag) keys.push('star');
      if (row.pb_flag) keys.push('pb');
      if (row.poo_status === 'poo') keys.push('poo');
      if (row.poo_status === 'priority') keys.push('poo_priority');
      for (const key of keys) {
        if (hasStickerEvent.get(row.id, key)) continue;
        insertBackfillEvent.run(row.id, STICKER_LABELS[key] || key, key, row.since);
      }
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('sticker_events_backfilled', '1')").run();
  })();
}

// A staff-saved report "shape" (which sections, granularity, optionally a
// few individual dogs) for the staff dashboard's report builder -- shared
// across every staff account like wiki_sections, not scoped to one person
// (deliberately no user_id). Never stores a date range, so reloading one is
// immediately useful against "now" rather than a frozen historical window.
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_staff_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sections TEXT NOT NULL,
    granularity TEXT NOT NULL DEFAULT 'day',
    dog_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
// Which animals a saved report format is for ('dog' | 'cat' | 'all'), so a
// saved "cats" format reloads as cats. Older rows were all made as dog reports.
if (!db.prepare('PRAGMA table_info(saved_staff_reports)').all().some((c) => c.name === 'species')) {
  db.exec("ALTER TABLE saved_staff_reports ADD COLUMN species TEXT NOT NULL DEFAULT 'dog'");
}

// Staff-set walking hours (see shelterSchedule.js). One row per weekday
// (0 = Sunday) for the usual week, and one per date that's different:
// closed, other hours, or just a note (null times = that weekday's hours).
// Times are minutes past midnight, shelter time.
db.exec(`
  CREATE TABLE IF NOT EXISTS shelter_weekly_hours (
    dow INTEGER PRIMARY KEY,
    open_minutes INTEGER NOT NULL,
    close_minutes INTEGER NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS shelter_special_days (
    date_key TEXT PRIMARY KEY,
    closed INTEGER NOT NULL DEFAULT 0,
    open_minutes INTEGER,
    close_minutes INTEGER,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
`);

// A longer, optional message for a special day, shown in the app's notice
// that day and in the shelter alert about it (`note` stays the short label).
if (!db.prepare('PRAGMA table_info(shelter_special_days)').all().some((c) => c.name === 'message')) {
  db.exec("ALTER TABLE shelter_special_days ADD COLUMN message TEXT NOT NULL DEFAULT ''");
}

// Indexes for the queries every screen leans on (all were full table scans).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_walks_dog ON walks(dog_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_walks_user ON walks(user_id, ended_at);
  CREATE INDEX IF NOT EXISTS idx_walks_started ON walks(started_at);
  CREATE INDEX IF NOT EXISTS idx_events_occurred ON shelter_events(occurred_at);
  CREATE INDEX IF NOT EXISTS idx_dogs_listed ON dogs(still_listed);
  CREATE INDEX IF NOT EXISTS idx_events_dog_kind ON shelter_events(dog_id, kind, occurred_at);
`);

// At most one walk still going per walker and per dog, enforced by the
// database too (the routes already check, but two taps can race). Only
// created when the data already obeys it: existing rows are never changed
// or deleted here, so if there are duplicates it logs them and carries on
// (the route checks still apply); once they're fixed, the next server
// restart creates the index.
for (const [name, column] of [['idx_walks_one_open_per_user', 'user_id'], ['idx_walks_one_open_per_dog', 'dog_id']]) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)) continue;
  const dupes = db.prepare(`
    SELECT ${column} AS id, COUNT(*) AS n FROM walks WHERE ended_at IS NULL AND ${column} IS NOT NULL
    GROUP BY ${column} HAVING COUNT(*) > 1
  `).all();
  if (dupes.length) {
    console.warn(`[db] not creating ${name}: more than one open walk for ${column} ${dupes.map((d) => `${d.id} (${d.n})`).join(', ')}`);
    continue;
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON walks(${column}) WHERE ended_at IS NULL`);
}

// Floor returns used to read "<name> is back on the adoption floor"; they now
// say how long the animal was gone (see the 'returned' logEvent in
// scraper.js). Rewords the old rows the same way, counting from the
// "Taken off the floor" event just before each return. Only touches rows
// still in the old wording, so it's a no-op after the first run.
{
  const SUFFIX = ' is back on the adoption floor';
  const oldRows = db.prepare(`
    SELECT e.id, e.title, e.occurred_at,
      (SELECT MAX(r.occurred_at) FROM shelter_events r
        WHERE r.dog_id = e.dog_id AND r.kind = 'removed' AND r.occurred_at < e.occurred_at) AS left_at
    FROM shelter_events e
    WHERE e.kind = 'returned' AND e.title LIKE '%' || ?
  `).all(SUFFIX);
  const setTitle = db.prepare('UPDATE shelter_events SET title = ? WHERE id = ?');
  for (const r of oldRows) {
    const name = r.title.slice(0, -SUFFIX.length);
    const ms = r.left_at ? new Date(r.occurred_at) - new Date(r.left_at) : 0;
    const days = ms > 0 ? Math.floor(ms / (24 * 60 * 60 * 1000)) : 0;
    setTitle.run(days > 0 ? `${name} returned to the shelter after ${days} day${days === 1 ? '' : 's'}` : `${name} returned to the shelter`, r.id);
  }
}

// The module system (src/modules.js): which optional modules (app/modules/*)
// are turned on, and their admin-entered config. A dedicated table rather
// than the dead `settings` KV table or app_meta, matching this app's usual
// one-table-per-concern style (see shelter_weekly_hours above). A module's
// own tables are created by the module itself via its `migrate()` context
// helper, tracked here per (module, migration) so re-enabling a module after
// a code update only re-applies what's new.
db.exec(`
  CREATE TABLE IF NOT EXISTS modules (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS module_migrations (
    module_id TEXT NOT NULL,
    migration_id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module_id, migration_id)
  );
`);

module.exports = db;
