// UI polish follow-ups that need the server: the volunteer app's Stats ›
// Play group list says "Adopted" / "Left shelter" by the same rule as the
// play group desk, so /api/playgroup-notes carries the same `adopted` flag
// as /api/playgroup-notes/counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base; let dbFile; let server;
const USER = 'polish.pg@example.com';

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': USER },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.before(async () => {
  server = await startServer({ prefix: 'sw-polish-' });
  ({ base, dbFile } = server);
  await call('GET', '/api/me');
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  // 1 still listed, 2 adopted, 3 gone without an adoption (transfer).
  for (const [id, name, listed] of [[1, 'Max', 1], [2, 'Biscuit', 1], [3, 'Rex', 1]]) {
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?)").run(id, name, listed, now, now);
  }
  db.close();
});
test.after(async () => { if (server) { await server.stop(); fs.rmSync(server.dir, { recursive: true, force: true }); } });

test('play group notes say adopted vs left shelter like the desk does', async () => {
  for (const id of [1, 2, 3]) assert.equal((await call('POST', `/api/dogs/${id}/playgroup-notes`, { body: 'Good day.', noteDate: '2026-10-01' })).status, 200);
  const db = new Database(dbFile);
  db.prepare('UPDATE dogs SET still_listed = 0 WHERE shelter_buddy_id IN (2, 3)').run();
  db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('adopted', 2, 'Biscuit adopted', '2026-10-05T12:00:00Z')").run();
  db.close();

  const { json } = await call('GET', '/api/playgroup-notes');
  assert.equal(json.dogs[1].adopted, false);
  assert.equal(json.dogs[1].stillListed, true);
  assert.equal(json.dogs[2].adopted, true);
  assert.equal(json.dogs[3].adopted, false);
  assert.equal(json.dogs[3].stillListed, false);
  assert.ok(!('lastEvent' in json.dogs[2]));

  // Same answer as the desk's own feed.
  const counts = (await call('GET', '/api/playgroup-notes/counts')).json.counts;
  for (const id of [1, 2, 3]) assert.equal(json.dogs[id].adopted, counts[id].adopted);
});
