// Shelter renames: the old name is kept (previous_names) so the app can show
// "aka <old name>" and still find the dog by it.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-names-')), 'test.db');
process.env.DB_PATH = dbFile;
const db = require('../src/db');
const { runScrape } = require('../src/scraper');
const { isRename, withPreviousName } = require('../src/dogNames');

let listing = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  // One listing per species; this fake shelter has no cats unless a test adds some.
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') return json({ data: JSON.parse(opts.body).species === 'Dog' ? listing : [] });
  if (u.includes('/api/animals/adopted')) return json({ data: [] });
  if (u.includes('/api/photos/')) return json({ large: [] });
  if (/\/api\/animals\/adopt\/\d+$/.test(u)) return json({ primaryBreed: 'Mix', tags: [] });
  return realFetch(url, opts);
};

const dogs = (names) => names.map((name, i) => ({ shelterBuddyId: 2000 + i, name, sex: 'Male', age: '3 Years', dateInShelter: '2026-08-01T00:00:00' }));
const previous = (id) => JSON.parse(db.prepare('SELECT previous_names p FROM dogs WHERE shelter_buddy_id = ?').get(id).p);

test('what counts as a rename', () => {
  assert.equal(isRename('Boscoe', 'Jed'), true);
  assert.equal(isRename('Cheech', 'Stinky'), true);
  assert.equal(isRename('Johnny', 'Johnny/aspen'), false, 'shelter added a second name itself');
  assert.equal(isRename('Layla', 'Laylah'), false, 'spelling fix');
  assert.equal(isRename("'roxy'", 'Roxy'), false, 'punctuation and case');
  assert.equal(isRename('Dog #273301', 'Jed'), false, 'kennel-card stand-in');
  assert.equal(withPreviousName('["Jed"]', 'Boscoe', 'Jed'), '["Boscoe"]', 'renamed back drops the name again');
});

test('the scraper keeps the old name when the shelter renames a dog', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `Pup${i}`);
  listing = dogs(['Boscoe', 'Johnny', ...names]);
  await runScrape();
  assert.deepEqual(previous(2000), []);

  listing = dogs(['Jed', 'Johnny/aspen', ...names]);
  await runScrape();
  assert.equal(db.prepare('SELECT name FROM dogs WHERE shelter_buddy_id = 2000').get().name, 'Jed');
  assert.deepEqual(previous(2000), ['Boscoe']);
  assert.deepEqual(previous(2001), [], 'not a rename');

  await runScrape();
  assert.deepEqual(previous(2000), ['Boscoe'], 'no duplicate on the next scrape');

  listing = dogs(['Rex', 'Johnny/aspen', ...names]);
  await runScrape();
  assert.deepEqual(previous(2000), ['Boscoe', 'Jed']);
});

test('renames from before the column existed are backfilled from the new_dog event', () => {
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, first_seen_at, last_seen_at) VALUES (3000, 'Stinky', 'x', 'x'), (3001, 'Guacamole/ Dusty', 'x', 'x')").run();
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('new_dog', 3000, 'Cheech was added to the shelter''s listing', 'x'), ('new_dog', 3001, 'Guacamole was added to the shelter''s listing', 'x')").run();
  db.prepare("DELETE FROM app_meta WHERE key = 'previous_names_backfilled'").run();
  execFileSync(process.execPath, ['-e', "require('./src/db')"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: dbFile } });
  assert.deepEqual(previous(3000), ['Cheech']);
  assert.deepEqual(previous(3001), []);
  assert.deepEqual(previous(2000), ['Boscoe', 'Jed'], 'already-recorded names left alone');
});
