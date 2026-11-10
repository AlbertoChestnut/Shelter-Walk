// The youtube-channel module's staff review queue and dog-profile display,
// end to end over HTTP: confirm/dismiss, and that disabling the module
// takes the matches routes and the profile videos away immediately.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;
const WALKER = 'walker@example.com';
const STAFF = 'staff@example.com';

async function call(method, url, { user = WALKER, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

let matchConfirmId;
let matchDismissId;

test.before(async () => {
  server = await startServer({ prefix: 'sw-ytmodule-', env: { DISABLE_MODULE_JOBS: '1' } });
  ({ base, dbFile } = server);
  await call('GET', '/api/me');
  await call('GET', '/api/me', { user: STAFF });

  // Enabling the module (over HTTP, like an admin would) makes it run its
  // migration and create its tables -- the direct-DB seeding below then
  // just needs the schema, which it set up by this point.
  const enabled = await call('PUT', '/api/modules/youtube-channel', { staff: true, body: { enabled: true, config: { channelId: 'UCfake' } } });
  assert.equal(enabled.status, 200);

  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Biscuit', 'Female', '2 Years', '2026-01-01T00:00:00', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO yt_videos (video_id, title, description, url, published_at, discovered_at) VALUES ('vidConfirm', 'Meet Biscuit', 'desc', 'https://www.youtube.com/watch?v=vidConfirm', ?, ?)").run(now, now);
  db.prepare("INSERT INTO yt_videos (video_id, title, description, url, published_at, discovered_at) VALUES ('vidDismiss', 'Random video', 'desc', 'https://www.youtube.com/watch?v=vidDismiss', ?, ?)").run(now, now);
  matchConfirmId = db.prepare("INSERT INTO yt_matches (video_id, dog_id, matched_text, status, created_at) VALUES ('vidConfirm', 1, 'Biscuit', 'pending', ?)").run(now).lastInsertRowid;
  matchDismissId = db.prepare("INSERT INTO yt_matches (video_id, dog_id, matched_text, status, created_at) VALUES ('vidDismiss', 1, 'Biscuit', 'pending', ?)").run(now).lastInsertRowid;
  db.close();
});
test.after(async () => { if (server) { await server.stop(); server = null; } });

test('the pending review queue is staff-only and lists seeded matches', async () => {
  assert.equal((await call('GET', '/api/modules/youtube-channel/matches')).status, 403, 'non-staff refused');
  const r = await call('GET', '/api/modules/youtube-channel/matches', { staff: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.matches.length, 2);
  const row = r.json.matches.find((m) => m.id === matchConfirmId);
  assert.equal(row.dogName, 'Biscuit');
  assert.equal(row.videoTitle, 'Meet Biscuit');
});

test('confirming a match makes it show on the dog profile', async () => {
  assert.equal((await call('PUT', `/api/modules/youtube-channel/matches/${matchConfirmId}`, { body: { action: 'confirm' } })).status, 403, 'non-staff refused');
  const confirm = await call('PUT', `/api/modules/youtube-channel/matches/${matchConfirmId}`, { staff: true, body: { action: 'confirm' } });
  assert.equal(confirm.status, 200);

  const dog = (await call('GET', '/api/dogs/1')).json.dog;
  assert.equal(dog.videos.length, 1);
  assert.equal(dog.videos[0].videoId, 'vidConfirm');

  // No longer pending.
  const pending = await call('GET', '/api/modules/youtube-channel/matches', { staff: true });
  assert.ok(!pending.json.matches.some((m) => m.id === matchConfirmId));
});

test('dismissing a match never shows it, and the id can\'t be re-actioned', async () => {
  const dismiss = await call('PUT', `/api/modules/youtube-channel/matches/${matchDismissId}`, { staff: true, body: { action: 'dismiss' } });
  assert.equal(dismiss.status, 200);
  const dog = (await call('GET', '/api/dogs/1')).json.dog;
  assert.equal(dog.videos.length, 1, 'still just the confirmed one -- the dismissed one never joins it');
  assert.ok(!dog.videos.some((v) => v.videoId === 'vidDismiss'));

  // Already resolved -- acting on it again is refused, not silently redone.
  const again = await call('PUT', `/api/modules/youtube-channel/matches/${matchDismissId}`, { staff: true, body: { action: 'confirm' } });
  assert.equal(again.status, 404);
});

test('an unknown action is rejected', async () => {
  const r = await call('PUT', '/api/modules/youtube-channel/matches/999999', { staff: true, body: { action: 'sometimes' } });
  assert.equal(r.status, 400);
});

test('disabling the module takes the matches route and the profile videos away immediately, no restart', async () => {
  const off = await call('PUT', '/api/modules/youtube-channel', { staff: true, body: { enabled: false } });
  assert.equal(off.status, 200);

  assert.equal((await call('GET', '/api/modules/youtube-channel/matches', { staff: true })).status, 404);
  const dog = (await call('GET', '/api/dogs/1')).json.dog;
  assert.equal(dog.videos, undefined, 'the enricher is skipped while disabled');

  // Turning it back on brings both back, still with no restart.
  await call('PUT', '/api/modules/youtube-channel', { staff: true, body: { enabled: true } });
  assert.equal((await call('GET', '/api/modules/youtube-channel/matches', { staff: true })).status, 200);
  assert.equal((await call('GET', '/api/dogs/1')).json.dog.videos.length, 1);
});
