// Numbers the server and the app must agree on, in one place. server.js,
// impact.js and staffDashboard.js import them; GET /api/config serves them
// (publicConfig below) so the app can read the live values; and
// test/audit2-eng.test.js fails if the app's fallback copies in
// public/js/app.js (SHARED_CONFIG) drift from these.

// The shelter's clock: every "day", "today" and walk window is in this zone,
// whatever zone the server or a phone runs in.
const SHELTER_TZ = 'America/New_York';

// The four daily walk windows, in shelter hours (a fraction is minutes:
// 19.25 is 7:15pm). The last one is called 4-7 but counts anything that
// starts before the 7:15 stop time; the label deliberately never says 7:15
// (owner, 2026-11-11).
const WALK_SLOTS = Object.freeze([
  Object.freeze({ label: '7-10a', from: 7, to: 10 }),
  Object.freeze({ label: '10-1p', from: 10, to: 13 }),
  Object.freeze({ label: '1-4p', from: 13, to: 16 }),
  Object.freeze({ label: '4-7p', from: 16, to: 19.25 })
]);
// The index of the window a time of day falls in (hours with a fraction, see
// shelterTime.shelterTimeOfDay), or -1 outside them.
const slotIndexOfHour = (hour) => WALK_SLOTS.findIndex((s) => hour >= s.from && hour < s.to);

// Walk time limits (server.js walkLimitMinutes). A walk, cuddle or Playgroup
// stops by itself after AUTO_STOP_MINUTES; matchmaking (meeting a possible
// adopter) runs longer by default; +10 min at a time up to MAX_TOTAL_MINUTES;
// a daycation runs up to DAYCATION_MINUTES with no extending.
const AUTO_STOP_MINUTES = 45; // was 30 until 2026-11-06 (owner)
const ACTIVITY_LIMIT_MINUTES = Object.freeze({ matchmaking: 60 }); // owner, 2026-11-06
const EXTEND_MINUTES = 10;
const MAX_TOTAL_MINUTES = 180;
const DAYCATION_MINUTES = 12 * 60;
// A walk already out at closing time may run this much past it, quietly:
// it keeps running and counts (owner, 2026-11-11). Never shown or mentioned
// in the app, the Guide or the docs -- every "stops at closing" message keeps
// showing the official closing time. Not served by /api/config.
const CLOSING_GRACE_MINUTES = 20;

// Averages leave out anything under a minute (an accidental scan ended right
// away); those still count in every total.
const MIN_AVG_SECONDS = 60;
// Someone else's engagement length is shown to the nearest 5 minutes.
const ROUND_SECONDS = 300;
const roundToStep = (seconds) => Math.round((seconds || 0) / ROUND_SECONDS) * ROUND_SECONDS;

// Labels for the "turned on/off" sticker events on a dog's timeline (db.js
// backfill and server.js logStickerChanges).
const STICKER_LABELS = Object.freeze({
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
});

// What GET /api/config returns (and what app.js keeps fallback copies of).
function publicConfig() {
  return {
    shelterTz: SHELTER_TZ,
    slots: WALK_SLOTS.map((s) => ({ ...s })),
    autoStopMinutes: AUTO_STOP_MINUTES,
    activityLimitMinutes: { ...ACTIVITY_LIMIT_MINUTES },
    extendMinutes: EXTEND_MINUTES,
    maxTotalMinutes: MAX_TOTAL_MINUTES,
    daycationMinutes: DAYCATION_MINUTES,
    minAvgSeconds: MIN_AVG_SECONDS,
    roundSeconds: ROUND_SECONDS
  };
}

module.exports = {
  SHELTER_TZ,
  WALK_SLOTS,
  slotIndexOfHour,
  AUTO_STOP_MINUTES,
  ACTIVITY_LIMIT_MINUTES,
  EXTEND_MINUTES,
  MAX_TOTAL_MINUTES,
  DAYCATION_MINUTES,
  CLOSING_GRACE_MINUTES,
  MIN_AVG_SECONDS,
  ROUND_SECONDS,
  roundToStep,
  STICKER_LABELS,
  publicConfig
};
