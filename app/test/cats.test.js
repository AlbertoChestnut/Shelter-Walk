// Cats (species.js): what a cat can and can't do, who sees them, and the
// API side of the Dogs / Cats / Both setting. Boots the real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base; let dbFile; let server;

async function call(method, url, { user = 'beginner@example.com', body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}
const meOf = async (user) => (await call('GET', '/api/me', { user })).json;
const setPref = async (user, speciesPref) => {
  const me = await meOf(user);
  return call('PUT', `/api/users/${me.id}/settings`, { user, body: { speciesPref } });
};

test.before(async () => {
  server = await startServer({ prefix: 'sw-cats-' });
  ({ base, dbFile } = server);
  await meOf('beginner@example.com');
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  const recent = new Date(Date.now() - 2 * 864e5).toISOString(); // 2 days in: too soon for a Beginner dog walk
  const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at,
    blue_markers, poo_status, star_flag, pb_flag) VALUES (?, ?, ?, 'Female', ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
  ins.run(5001, 'Rex', 'dog', '3 Years', recent, now, now, '[]', 'none', 0, 0);
  // Sticker columns set on a cat (e.g. cats get stickers someday, then lose them): never shown while cats have none.
  ins.run(6001, 'Mittens', 'cat', '2 Months', recent, now, now, '["blue_evo"]', 'poo', 1, 1);
  ins.run(6002, 'Socks', 'cat', '4 Years', recent, now, now, '[]', 'none', 0, 0);
  db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, age, tags, date_in_shelter, still_listed, first_seen_at, last_seen_at)
    VALUES (6003, 'Pip', 'cat', '9 Weeks', '["Cat","Kitten","Shelter"]', ?, 1, ?, ?)`).run(recent, now, now);
  db.prepare("UPDATE users SET experience_level = 'beginner'").run();
  const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES (?, ?, ?, ?)');
  ev.run('new_dog', 5001, 'Rex was added', now);
  ev.run('new_dog', 6002, 'Socks was added', now);
  db.close();
});
test.after(async () => { if (server) await server.stop(); });

test('/api/me carries the species table and the volunteer\'s choice', async () => {
  const me = await meOf('beginner@example.com');
  assert.equal(me.speciesPref, 'dog', 'everyone starts on dogs');
  assert.deepEqual(me.species.cat.activities, ['cuddle', 'matchmaking']);
  assert.equal(me.species.cat.stickers, false);
  assert.equal(me.species.dog.stickers, true);
});

test('speciesPref is validated and saved', async () => {
  assert.equal((await setPref('beginner@example.com', 'hamsters')).status, 400);
  const r = await setPref('beginner@example.com', 'both');
  assert.equal(r.status, 200);
  assert.equal(r.json.speciesPref, 'both');
  assert.equal((await meOf('beginner@example.com')).speciesPref, 'both');
});

test('lists and Updates show only the species someone works with', async () => {
  const user = 'lists@example.com';
  const ids = async () => (await call('GET', '/api/dogs', { user })).json.dogs.map((d) => d.id).sort();
  const news = async () => (await call('GET', '/api/updates', { user })).json.updates.map((u) => u.dog_id).sort();
  assert.deepEqual(await ids(), [5001], 'dog people see dogs');
  assert.deepEqual(await news(), [5001]);
  await setPref(user, 'cat');
  assert.deepEqual(await ids(), [6001, 6002, 6003], 'cat people see cats');
  assert.deepEqual(await news(), [6002]);
  const me = await meOf(user);
  assert.equal((await call('GET', `/api/updates/unread-count?userId=${me.id}`, { user })).status, 200);
  await setPref(user, 'both');
  assert.deepEqual(await ids(), [5001, 6001, 6002, 6003]);
  assert.deepEqual(await news(), [5001, 6002]);
  // A scan finds any animal, whatever the setting.
  await setPref(user, 'dog');
  assert.equal((await call('GET', '/api/dogs/6002', { user })).status, 200);
});

test('a cat has no stickers and any level may visit it, kittens included', async () => {
  const { dog: cat } = (await call('GET', '/api/dogs/6001')).json;
  assert.equal(cat.species, 'cat');
  assert.deepEqual(cat.blueMarkers, []);
  assert.equal(cat.pooStatus, 'none');
  assert.equal(cat.starFlag, false);
  assert.equal(cat.pbFlag, false);
  assert.equal(cat.eligible, true, 'a Beginner can see a 2-day-in cat');
  assert.equal(cat.tooYoung, false, 'no age rule for cats');
  const { dog } = (await call('GET', '/api/dogs/5001')).json;
  assert.equal(dog.eligible, false, 'the dog rules still apply to dogs');
  assert.equal(dog.notEligibleReason, 'days');
});

test("a cat's stickers can't be set", async () => {
  const r = await call('PUT', '/api/dogs/6002/markers', { body: { blueMarkers: ['blue'], pooStatus: 'none', starFlag: false, pbFlag: false } });
  assert.equal(r.status, 400);
  assert.equal((await call('PUT', '/api/dogs/5001/markers', { body: { blueMarkers: [], pooStatus: 'poo', starFlag: false, pbFlag: false } })).status, 200);
});

test('cats can only be cuddled or matchmade', async () => {
  const user = 'cuddler@example.com';
  const me = await meOf(user);
  const walk = await call('POST', '/api/walks/start', { user, body: { dogId: 6002, userId: me.id, activity: 'walk' } });
  assert.equal(walk.status, 400);
  assert.match(walk.json.error, /cuddle, matchmaking/);
  // No activity sent: a cat gets a cuddle, not a walk.
  const started = await call('POST', '/api/walks/start', { user, body: { dogId: 6002, userId: me.id } });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const { walks } = (await call('GET', `/api/walks?userId=${me.id}`, { user })).json;
  assert.equal(walks.find((w) => w.id === started.json.walkId).activity, 'cuddle');
  assert.equal((await call('PUT', `/api/walks/${started.json.walkId}`, { user, body: { activity: 'playgroup' } })).status, 400);
  assert.equal((await call('PUT', `/api/walks/${started.json.walkId}`, { user, body: { activity: 'matchmaking' } })).status, 200);
  await call('DELETE', `/api/walks/${started.json.walkId}`, { user });
  // The kitten (2 months) too: the puppy age rule is a dog rule.
  const kitten = await call('POST', '/api/walks/start', { user, body: { dogId: 6001, userId: me.id, activity: 'cuddle' } });
  assert.equal(kitten.status, 200, JSON.stringify(kitten.json));
  await call('DELETE', `/api/walks/${kitten.json.walkId}`, { user });
  const manual = await call('POST', '/api/walks/manual', { user, body: { dogId: 6002, userId: me.id, activity: 'daycation', startedAt: new Date(Date.now() - 3600e3).toISOString(), endedAt: new Date(Date.now() - 1800e3).toISOString() } });
  assert.equal(manual.status, 400);
});

test('a new kennel card can be filed as a cat', async () => {
  const user = 'cardcat@example.com';
  const me = await meOf(user);
  const r = await call('POST', '/api/walks/start', { user, body: { dogId: 777001, userId: me.id, unlisted: true, species: 'cat', activity: 'matchmaking' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { dog } = (await call('GET', '/api/dogs/777001', { user })).json;
  assert.equal(dog.species, 'cat');
  assert.equal(dog.name, 'Cat #777001');
  await call('DELETE', `/api/walks/${r.json.walkId}`, { user });
  const bad = await call('POST', '/api/walks/start', { user, body: { dogId: 777002, userId: me.id, unlisted: true, species: 'cat', activity: 'walk' } });
  assert.equal(bad.status, 400, "a cat card can't be walked either");
});

test('scrape status counts dogs and cats apart', async () => {
  const s = (await call('GET', '/api/scrape/status')).json;
  assert.equal(s.dogCount, 1);
  assert.equal(s.catCount, 3);
});

test('cat rooms are A to D, dog wings A to E', async () => {
  const cat = await call('PUT', '/api/dogs/6002/location', { body: { location: 'E' } });
  assert.equal(cat.status, 400);
  assert.match(cat.json.error, /A to D/);
  assert.equal((await call('PUT', '/api/dogs/6002/location', { body: { location: 'D' } })).json.location, 'D');
  assert.equal((await call('PUT', '/api/dogs/5001/location', { body: { location: 'E' } })).json.location, 'E');
  assert.deepEqual((await meOf('beginner@example.com')).species.cat.kennels, ['A', 'B', 'C', 'D']);
});

test('a kitten after an adult cat carries a warning; kitten first does not', async () => {
  const user = 'handler@example.com';
  const me = await meOf(user);
  const kitten = async () => (await call('GET', '/api/dogs/6003', { user })).json.dog;
  assert.equal((await kitten()).isYoung, true);
  assert.equal((await kitten()).handlingWarning, null, 'nobody handled yet');
  // Kitten first, then an adult: fine, and the adult never warns.
  const k = await call('POST', '/api/walks/start', { user, body: { dogId: 6003, userId: me.id, activity: 'cuddle' } });
  await call('PUT', `/api/walks/${k.json.walkId}/end`, { user, body: {} });
  assert.equal((await kitten()).handlingWarning, null, 'kitten to kitten is fine');
  const a = await call('POST', '/api/walks/start', { user, body: { dogId: 6002, userId: me.id, activity: 'cuddle' } });
  assert.equal((await call('GET', '/api/dogs/6002', { user })).json.dog.handlingWarning, null, 'adults never warn');
  await call('PUT', `/api/walks/${a.json.walkId}/end`, { user, body: {} });
  // Now back to the kitten: warned, naming the adult.
  const w = (await kitten()).handlingWarning;
  assert.equal(w && w.name, 'Socks');
  assert.equal(w.young, 'kitten');
  // A warning, not a block.
  const again = await call('POST', '/api/walks/start', { user, body: { dogId: 6003, userId: me.id, activity: 'cuddle' } });
  assert.equal(again.status, 200);
  await call('DELETE', `/api/walks/${again.json.walkId}`, { user });
  // Someone else's adult cat doesn't count for this volunteer.
  assert.equal((await call('GET', '/api/dogs/6003', { user: 'other@example.com' })).json.dog.handlingWarning, null);
});

test('time with cats does not count toward moving up a dog level', async () => {
  const user = 'catlover@example.com';
  const me = await meOf(user);
  const db = new Database(dbFile);
  db.prepare("UPDATE users SET experience_level = 'beginner', level_up_offered_at = NULL WHERE id = ?").run(me.id);
  const ins = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, '2026-10-01T14:00:00Z', '2026-10-01T15:00:00Z', ?, 'cuddle')");
  ins.run(6002, me.id, 25 * 3600);
  db.close();
  assert.equal((await meOf(user)).levelUpOffer, false, '25 cat hours: no level-up offer');
  const db2 = new Database(dbFile);
  db2.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (5001, ?, '2026-10-02T14:00:00Z', '2026-10-02T15:00:00Z', ?, 'walk')").run(me.id, 21 * 3600);
  db2.close();
  assert.equal((await meOf(user)).levelUpOffer, true, '21 dog hours do');
});
