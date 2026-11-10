// Sticker events (see server.js logStickerChanges) only exist from when that
// logging started -- this is the one-time backfill in db.js that gives a
// dog already wearing a sticker beforehand some history on the timeline too.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { isolateEnv } = require('./_helpers');

const { dbFile } = isolateEnv('sw-sticker-backfill-');
const db = require('../src/db');

const rerunBackfill = () => {
  db.prepare("DELETE FROM app_meta WHERE key = 'sticker_events_backfilled'").run();
  execFileSync(process.execPath, ['-e', "require('./src/db')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: dbFile } });
};
const stickersOf = (id) => db.prepare(
  "SELECT detail, occurred_at AS occurredAt FROM shelter_events WHERE dog_id = ? AND kind = 'sticker_on' ORDER BY detail"
).all(id);

test('a dog already wearing stickers before this feature existed gets one sticker_on event per sticker, dated to its stay, including EVO', () => {
  const since = '2026-09-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, first_seen_at, last_seen_at, still_listed,
      blue_markers, poo_status, star_flag, pb_flag)
    VALUES (9001, 'Patched', 'Male', '3 Years', ?, ?, ?, 1, '["blue","blue_evo","blue_c"]', 'priority', 1, 1)
  `).run(since, since, since);
  // A plain dog with no stickers at all -- nothing to backfill.
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, first_seen_at, last_seen_at, still_listed)
    VALUES (9002, 'Plain', 'Male', '3 Years', ?, ?, ?, 1)
  `).run(since, since, since);

  rerunBackfill();

  const events = stickersOf(9001);
  assert.deepEqual(events.map((e) => e.detail), ['blue_c', 'blue_evo', 'pb', 'poo_priority', 'star'], 'EVO is backfilled like every other sticker, the plain blank "blue" is not');
  assert.ok(events.every((e) => e.occurredAt === since), 'dated to the start of this stay, the earliest point it can honestly be pinned to');
  assert.equal(stickersOf(9002).length, 0, 'no stickers, nothing backfilled');
});

test('a sticker that already has a real event is left alone, not duplicated', () => {
  const since = '2026-09-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, first_seen_at, last_seen_at, still_listed, pb_flag, star_flag)
    VALUES (9003, 'AlreadyLogged', 'Male', '3 Years', ?, ?, ?, 1, 1, 1)
  `).run(since, since, since);
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES ('sticker_on', 9003, 'PB: Potty break OK', 'pb', '2026-09-15T00:00:00.000Z')").run();

  rerunBackfill();

  const events = stickersOf(9003);
  assert.deepEqual(events.map((e) => e.detail), ['pb', 'star']);
  const pbEvent = events.find((e) => e.detail === 'pb');
  assert.equal(pbEvent.occurredAt, '2026-09-15T00:00:00.000Z', 'the real event is kept, not overwritten with a backfilled date');
  const starEvent = events.find((e) => e.detail === 'star');
  assert.equal(starEvent.occurredAt, since, 'star had no event yet, so it is backfilled');
});

test('running the backfill again is a no-op', () => {
  const before = db.prepare("SELECT COUNT(*) c FROM shelter_events WHERE kind = 'sticker_on'").get().c;
  rerunBackfill();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM shelter_events WHERE kind = 'sticker_on'").get().c, before);
});
