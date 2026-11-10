// Stats by species and their breakdowns (statsBreakdown.js), and "@" tags in
// everyday notes (noteTags.js). Boots the real server against a throwaway DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const ids = {};

async function call(method, url, { user = ALICE, body } = {}) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-auth-email': user }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

test.before(async () => {
  server = await startServer({ prefix: 'sw-stats-tags-' });
  ({ base, dbFile } = server);
  ids.alice = (await call('GET', '/api/me')).json.id;
  ids.bob = (await call('GET', '/api/me', { user: BOB })).json.id;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, tags, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status)
    VALUES (?, ?, ?, 'Male', ?, ?, ?, 1, ?, ?, ?)`);
  ins.run(1, 'Rex', 'dog', '3 Years', '["Dog"]', old, now, now, 'poo');
  ins.run(2, 'Fido', 'dog', '3 Years', '["Dog"]', old, now, now, 'none');
  ins.run(3, 'Pip', 'cat', '9 Weeks', '["Cat","Kitten"]', old, now, now, 'none');
  ins.run(4, 'Tom', 'cat', '3 Years', '["Cat"]', old, now, now, 'none');
  // Listed but in foster: never in the "right now" counts, only inFoster.
  ins.run(5, 'Bo', 'dog', '3 Years', '["Dog"]', old, now, now, 'poo');
  ins.run(6, 'Mia', 'cat', '9 Weeks', '["Cat","Kitten"]', old, now, now, 'none');
  db.prepare("UPDATE dogs SET location = 'In Foster' WHERE shelter_buddy_id IN (5, 6)").run();
  // Rex got POO two days ago: his walk before that was a non-POO walk.
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES ('sticker_on', 1, 'POO', 'poo', ?)").run(new Date(Date.now() - 2 * 864e5).toISOString());
  const w = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, ?, ?)');
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  w.run(1, ids.alice, ago(5 * 1440), ago(5 * 1440 - 20), 1200, 'walk');
  w.run(1, ids.alice, ago(60), ago(40), 1200, 'walk');
  w.run(2, ids.alice, ago(39), ago(30), 540, 'cuddle');
  w.run(3, ids.alice, ago(25), ago(20), 300, 'cuddle');
  w.run(4, ids.alice, ago(15), ago(10), 300, 'matchmaking');
  db.close();
});
test.after(async () => { if (server) await server.stop(); });

test('stats narrow to one species, and Both adds them up', async () => {
  const dogs = (await call('GET', '/api/stats?userId=1&species=dog')).json;
  const cats = (await call('GET', '/api/stats?userId=1&species=cat')).json;
  const both = (await call('GET', '/api/stats?userId=1&species=all')).json;
  assert.equal(dogs.totals.totalWalks, 3);
  assert.equal(cats.totals.totalWalks, 2);
  assert.equal(both.totals.totalWalks, 5);
  assert.deepEqual(cats.perDog.map((d) => d.name).sort(), ['Pip', 'Tom']);
  assert.deepEqual(dogs.byActivity.map((a) => [a.activity, a.count]), [['walk', 2], ['cuddle', 1]]);
  assert.deepEqual(cats.byActivity.map((a) => a.activity).sort(), ['cuddle', 'matchmaking']);
  assert.deepEqual(both.bySpecies.map((s) => [s.species, s.count]), [['dog', 3], ['cat', 2]]);
  assert.equal((await call('GET', '/api/stats?userId=1')).json.totals.totalWalks, 5, 'no species means both');
});

test('POO is counted as the sticker was at the time; cats split into kittens and adults', async () => {
  const dogs = (await call('GET', '/api/stats?userId=1&species=dog')).json;
  assert.deepEqual(dogs.byPoo.map((p) => [p.status, p.count]), [['poo', 1], ['none', 2]]);
  assert.deepEqual(dogs.byAge, []);
  const cats = (await call('GET', '/api/stats?userId=1&species=cat')).json;
  assert.deepEqual(cats.byPoo, []);
  assert.deepEqual(cats.byAge.map((g) => [g.group, g.count]), [['young', 1], ['adult', 1]]);
  const walks = (await call('GET', '/api/walks?userId=1')).json.walks;
  assert.deepEqual(walks.filter((x) => x.dog_id === 1).map((x) => x.poo_then), ['poo', 'none']);
  assert.equal(walks.find((x) => x.dog_id === 3).is_young, true);
});

test('shelterNow: what is listed right now, and what this volunteer did today', async () => {
  const both = (await call('GET', '/api/stats?userId=1&species=all')).json;
  assert.deepEqual(both.shelterNow.dog.counts, { total: 2, walkable: 2, poo: 1, nonPoo: 1 });
  assert.deepEqual(both.shelterNow.dog.today, { total: 2, walkable: 2, poo: 1, nonPoo: 1 });
  assert.deepEqual(both.shelterNow.cat.counts, { total: 2, young: 1, adult: 1 });
  assert.equal(both.shelterNow.dog.inFoster, 1, 'a dog in foster is counted on its own');
  assert.equal(both.shelterNow.cat.inFoster, 1, 'so is a cat in foster');
  const bob = (await call('GET', '/api/stats?userId=1&species=dog', { user: BOB })).json;
  assert.equal(bob.totals.totalWalks, 0, 'stats are only ever your own');
  assert.deepEqual(bob.shelterNow.dog.today, {});
  assert.deepEqual(Object.keys((await call('GET', '/api/stats?userId=1&species=cat')).json.shelterNow), ['cat']);
});

test('Together narrows by species too', async () => {
  const cats = (await call('GET', '/api/impact?days=all&species=cat')).json;
  assert.equal(cats.allTime.walks, 2);
  assert.deepEqual(Object.keys(cats.shelterNow), ['cat']);
  assert.deepEqual(cats.shelterNow.cat.counts, { total: 2, young: 1, adult: 1 }, 'Together leaves foster cats out too');
  assert.equal(cats.shelterNow.cat.inFoster, 1);
  const dogs = (await call('GET', '/api/impact?days=all&species=dog')).json;
  assert.equal(dogs.allTime.walks, 3);
  assert.deepEqual(dogs.allTime.byPoo, [], 'slices under the minimum are left out');
});

test('@ tags: unknown ones are dropped, tagged animals list the note, names come along', async () => {
  const posted = await call('POST', '/api/dogs/3/notes', { body: { body: 'Shares a condo with @[4]. Not @[999], not herself @[3].' } });
  assert.equal(posted.status, 200);
  const pip = (await call('GET', '/api/dogs/3/notes')).json;
  assert.equal(pip.sharedTips[0].body, 'Shares a condo with @[4]. Not @999, not herself @3.');
  assert.equal(pip.tagged[4].name, 'Tom');
  const tom = (await call('GET', '/api/dogs/4/notes', { user: BOB })).json;
  assert.equal(tom.mentions.length, 1);
  assert.equal(tom.mentions[0].from.name, 'Pip');
  assert.equal(tom.mentions[0].kind, 'tip');
  assert.ok(!JSON.stringify(tom.mentions).includes('alice'), 'no author on a mention');
});

test('a private note tag is seen only by its writer', async () => {
  assert.equal((await call('PUT', '/api/dogs/1/private-note', { body: { body: 'Walk with @[2]' } })).status, 200);
  const mine = (await call('GET', '/api/dogs/2/notes')).json;
  assert.ok(mine.mentions.some((m) => m.kind === 'private' && m.from.name === 'Rex'));
  const bobs = (await call('GET', '/api/dogs/2/notes', { user: BOB })).json;
  assert.ok(!bobs.mentions.some((m) => m.kind === 'private'), "nobody else sees someone's private note through a tag");
});

test('end-of-walk notes keep good tags and show up in the walk list with names', async () => {
  const start = await call('POST', '/api/walks/start', { body: { dogId: 4, userId: 1, activity: 'cuddle' } });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  const end = await call('PUT', `/api/walks/${start.json.walkId}/end`, { body: { notes: 'Calmer next to @[3] and @[12345]' } });
  assert.equal(end.status, 200, JSON.stringify(end.json));
  const list = (await call('GET', '/api/walks?userId=1')).json;
  assert.equal(list.walks.find((x) => x.id === start.json.walkId).notes, 'Calmer next to @[3] and @12345');
  assert.equal(list.tagged[3].name, 'Pip');
  const exp = (await call('GET', '/api/me/export')).json;
  if (exp && exp.walks) assert.ok(exp.walks.some((x) => x.notes === 'Calmer next to @Pip and @12345'), 'exports read tags as names');
});
