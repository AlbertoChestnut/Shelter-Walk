// The scraper with two species: cats come from their own listing, and a bad
// listing for one species never delists (or freezes) the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolateEnv } = require('./_helpers');

const { dbFile } = isolateEnv('sw-scraper-cats-');
const db = require('../src/db');
const { runScrape } = require('../src/scraper');

const lists = { Dog: [], Cat: [] };
const failing = new Set(); // species whose list request errors
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') {
    const kind = JSON.parse(opts.body).species;
    return failing.has(kind) ? json({}, 404) : json({ data: lists[kind] || [] });
  }
  if (u.includes('/api/animals/adopted')) return json({ data: [] });
  if (u.includes('/api/photos/')) return json({ large: [] });
  const m = /\/api\/animals\/adopt\/(\d+)$/.exec(u);
  if (m) {
    const id = Number(m[1]);
    // The detail's first tag is the species; 9999 is a cat the dog list wrongly includes.
    const kind = id >= 2000 || id === 9999 ? 'Cat' : 'Dog';
    return json({ primaryBreed: 'Mix', location: 'Shelter', tags: [kind, 'Shelter'], sex: 'Female', age: '2 Years' });
  }
  return realFetch(url, opts);
};

const animals = (from, n, name) => Array.from({ length: n }, (_, i) => ({ shelterBuddyId: from + i, name: `${name}${i}`, sex: 'Female', age: '2 Years', dateInShelter: '2026-08-01T00:00:00' }));
const listed = (species) => db.prepare('SELECT COUNT(*) c FROM dogs WHERE still_listed = 1 AND species = ?').get(species).c;

test('cats are scraped from their own listing, as cats', async () => {
  lists.Dog = animals(1000, 25, 'Dog');
  lists.Cat = animals(2000, 22, 'Cat');
  const r = await runScrape();
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { dog: 25, cat: 22 });
  assert.equal(listed('dog'), 25);
  assert.equal(listed('cat'), 22);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM shelter_events WHERE kind = 'new_dog'").get().c, 47, 'new cats show in Updates too');
});

test('a failed cat listing keeps the cats and still refreshes the dogs', async () => {
  failing.add('Cat');
  lists.Dog = animals(1000, 26, 'Dog');
  for (let i = 0; i < 3; i += 1) {
    const r = await runScrape();
    assert.equal(r.ok, false, 'the run is marked failed');
    assert.match(r.error, /cat list fetch failed/);
  }
  assert.equal(listed('cat'), 22, 'no cat was delisted');
  assert.equal(listed('dog'), 26, 'the new dog arrived anyway');
  failing.delete('Cat');
});

test('an empty dog listing keeps the dogs while the cats refresh', async () => {
  lists.Dog = [];
  lists.Cat = animals(2000, 21, 'Cat');
  for (let i = 0; i < 3; i += 1) {
    await runScrape();
    // Time between scheduled scrapes: a second miss only delists after ~50 minutes unseen.
    db.prepare('UPDATE dogs SET last_seen_at = ? WHERE still_listed = 1').run(new Date(Date.now() - 2 * 3600000).toISOString());
  }
  assert.equal(listed('dog'), 26);
  assert.equal(listed('cat'), 21, 'a cat that left the cat listing is delisted as usual');
});

test("the detail's species tag wins over the list it came from", async () => {
  lists.Dog = [...animals(1000, 26, 'Dog'), { shelterBuddyId: 9999, name: 'Whiskers', dateInShelter: '2026-08-01T00:00:00' }];
  await runScrape();
  assert.equal(db.prepare('SELECT species FROM dogs WHERE shelter_buddy_id = 9999').get().species, 'cat');
});
