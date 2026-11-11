// Audit 2, volunteer app (ui): the server pieces Stats needs, and a few
// client rules checked from the source (the browser side is in
// smoke/audit2-ui.js).
//  - /api/walks pages with ?offset=, so a history over 1000 isn't cut off.
//  - /api/shelter-trends says when tracking starts (`since`), even on a
//    species' first day, when there are no days to show yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

let base; let dbFile; let server; let me;
const USER = 'audit2.ui@example.com';
const call = async (url) => {
  const res = await fetch(base + url, { headers: { 'x-auth-email': USER } });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test.before(async () => {
  server = await startServer({ prefix: 'sw-audit2-ui-' });
  ({ base, dbFile } = server);
  me = (await call('/api/me')).json;
  const db = new Database(dbFile);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (1, 'Max', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(now, now);
  const add = db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (1, ?, 'C', ?, ?, 1200, 'walk')");
  db.transaction(() => {
    // 1005 walks, two of them at the very same minute (ties must not repeat or drop across pages).
    for (let i = 0; i < 1005; i += 1) {
      const start = new Date(Date.UTC(2026, 8, 1) + Math.min(i, 1003) * 3600000);
      add.run(me.id, start.toISOString(), new Date(start.getTime() + 1200000).toISOString());
    }
  })();
  db.close();
});
test.after(async () => { if (server) { await server.stop(); fs.rmSync(server.dir, { recursive: true, force: true }); } });

test('/api/walks pages past 1000 with ?offset, no row twice or missing', async () => {
  const first = (await call(`/api/walks?limit=1000&offset=0&userId=${me.id}`)).json.walks;
  const second = (await call(`/api/walks?limit=1000&offset=1000&userId=${me.id}`)).json.walks;
  assert.equal(first.length, 1000);
  assert.equal(second.length, 5);
  const ids = new Set([...first, ...second].map((w) => w.id));
  assert.equal(ids.size, 1005);
  // No offset: the first page, as before.
  assert.equal((await call(`/api/walks?limit=1000&userId=${me.id}`)).json.walks[0].id, first[0].id);
});

test('/api/shelter-trends names the first tracked day', async () => {
  const { json } = await call('/api/shelter-trends?species=cat');
  assert.match(json.since, /^\d{4}-\d{2}-\d{2}$/);
  const dogs = (await call('/api/shelter-trends?species=dog')).json;
  assert.match(dogs.since, /^\d{4}-\d{2}-\d{2}$/);
  // At least today is listed (audit3: this used to assert only "if any").
  assert.ok(dogs.days.length > 0, 'dog trends list at least today');
  assert.ok(dogs.days[0].dateKey >= dogs.since);
});

test('ages read "1 year", "1 month", never "1 years"', () => {
  const line = APP_JS.split('\n').findIndex((l) => l.includes('const fmtAge ='));
  assert.ok(line > 0);
  const src = APP_JS.split('\n').slice(line, line + 3).join('\n');
  const fmtAge = vm.runInNewContext(`${src}; fmtAge`);
  assert.equal(fmtAge('1 Years and 1 Months'), '1 year and 1 month');
  assert.equal(fmtAge('7 Years and 1 Months'), '7 years and 1 month');
  assert.equal(fmtAge('11 Months'), '11 months');
  assert.equal(fmtAge('1 Week'), '1 week');
});

// Owner, 2026-11-11: called 4-7, but counts anything started before the
// 7:15 stop time -- and the 7:15 is never shown. The app reads the served
// slots (its fallback copy is pinned by test/audit2-eng.test.js).
test('the last session is labelled 4-7 pm and counts to 7:15', async () => {
  const cfg = (await call('/api/config')).json;
  assert.deepEqual(cfg.slots[cfg.slots.length - 1], { label: '4-7p', from: 16, to: 19.25 });
});

// Kept as a source check: the preset names are only text in app.js, and a
// browser test would read the same strings back.
test('presets are in sentence case', () => {
  const names = [...APP_JS.matchAll(/^\s+name: '([^']+)',$/gm)].map((m) => m[1]);
  for (const n of ['Avoid beginner dogs', 'Eligible to walk', 'Playgroup eligible', 'Long-stay cats']) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => /\b(Dogs|Cats|Walk|Eligible)\b/.test(n.slice(1)) && !/^POO|Non-POO|Not Playgroup/.test(n)), names.join(', '));
});

// The auto-tagger never moving the caret into a box that lost focus, and
// "This week" in the shelter's time zone on a phone in LA, are checked in a
// browser: smoke/audit2-ui.js (audit3 dropped the regexes over the source).

// Kept as a source check: these are banned phrases, which only the source
// can show are gone everywhere (like test/wording.test.js).
test('copy: no "Showing cached data", "not in the database", "(newest 150 shown)" or "by app update"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /Showing cached data/);
  assert.doesNotMatch(APP_JS, /not in the database anymore/);
  assert.doesNotMatch(APP_JS, /newest 150 shown/);
  // No Guide section says "by app update" (or "by demo").
  assert.match(APP_JS, /\['demo', 'app update'\]\.includes\(section\.updatedBy\)/);
});
