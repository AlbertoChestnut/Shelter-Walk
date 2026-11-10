// Data-pipeline fixes from the 2026-11-10 audit that live outside the
// scraper loop: push TTL/urgency, /healthz noticing a scrape that "worked"
// with too few animals, and cat silhouettes.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const { isolateEnv, startServer } = require('./_helpers');

// push.js only turns on with VAPID keys; the push service itself is stubbed.
isolateEnv('sw-audit-data-push-');
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;
const sentOptions = [];
webpush.sendNotification = async (sub, body, options) => { sentOptions.push(options); };
const db = require('../src/db');
const push = require('../src/push');

test('pushes carry a TTL and urgency: a day by default, minutes for walk alerts', async () => {
  const now = new Date().toISOString();
  const userId = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('Walker', now).lastInsertRowid;
  db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, 'https://push.example/1', 'p', 'a', now);
  await push.sendPushToUser(userId, { title: 'x' });
  await push.sendPushToUser(userId, { title: 'y' }, push.WALK_ALERT_PUSH);
  assert.deepEqual(sentOptions, [{ TTL: 86400, urgency: 'normal' }, { TTL: 300, urgency: 'high' }]);
});

let server;
let sdb;
test.before(async () => {
  server = await startServer({ prefix: 'sw-audit-data-srv-' });
  sdb = new Database(server.dbFile);
});
test.after(async () => {
  if (sdb) sdb.close();
  if (server) await server.stop();
});

const addRun = (minutesAgo, ok, count) => {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  sdb.prepare('INSERT INTO scrape_runs (started_at, finished_at, ok, dog_count) VALUES (?, ?, ?, ?)').run(at, at, ok, count);
};

test('/healthz flags a successful scrape with no animals, or far fewer than usual', async () => {
  for (let i = 10; i >= 4; i -= 1) addRun(i * 30, 1, 200);
  let res = await fetch(`${server.base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  addRun(60, 1, 60); // under half the usual 200
  res = await fetch(`${server.base}/healthz`);
  let body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.match(body.problems[0], /60 animals, under half the usual 200/);
  assert.ok(body.lastSuccessfulScrapeAt, 'the usual fields are still there');

  addRun(30, 1, 0);
  body = await (await fetch(`${server.base}/healthz`)).json();
  assert.match(body.problems[0], /listed no animals/);

  addRun(1, 1, 198);
  assert.equal((await fetch(`${server.base}/healthz`)).status, 200, 'back to normal');
});

test('a cat without a photo gets a cat silhouette', async () => {
  const now = new Date().toISOString();
  const ins = sdb.prepare("INSERT INTO dogs (shelter_buddy_id, name, species, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, ?, '2026-08-01T00:00:00', 1, ?, ?)");
  ins.run(4801, 'Whiskers', 'cat', now, now);
  ins.run(4802, 'Rover', 'dog', now, now);
  const get = async (id) => (await (await fetch(`${server.base}/api/dogs/${id}`, { headers: { 'x-auth-email': 'walker@example.com' } })).json()).dog;
  assert.match((await get(4801)).photoUrl, /^\/dog-silhouettes\/cat-4801\.svg\?v=/);
  assert.match((await get(4802)).photoUrl, /^\/dog-silhouettes\/4802\.svg\?v=/);

  const svg = await fetch(`${server.base}/dog-silhouettes/cat-4801.svg?v=1`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /svg/);
  assert.match(await svg.text(), /Cat silhouette/);
  assert.equal((await fetch(`${server.base}/dog-silhouettes/dog-4801.svg`)).status, 404);
});
