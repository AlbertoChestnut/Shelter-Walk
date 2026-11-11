// Flow fixes (2026-11-10, round 3): End ends the walk on the server at once
// (finishLater) and its end screen comes back until saved (wrap_up_pending),
// foster dogs aren't eligible but can still be started from the card,
// switching activity can't pass the 3-hour cap, account deletion's 5xx
// messages reach the person, Guide markdown can't break out of an
// attribute, and Together says what its averages are of.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { startServer } = require('./_helpers');

let base, dbFile, server;
const WALKER = 'walker.flow@example.com';
const OTHER = 'other.flow@example.com';
const LEAVER = 'leaver.flow@example.com';

async function call(method, url, { user = WALKER, body } = {}) {
  const h = { 'x-auth-email': user };
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json, text };
}
const withDb = (fn) => { const db = new Database(dbFile); try { return fn(db); } finally { db.close(); } };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

const ids = {};
test.before(async () => {
  server = await startServer({ prefix: 'sw-flow-' });
  ({ base, dbFile } = server);
  for (const [k, e] of [['walker', WALKER], ['other', OTHER], ['leaver', LEAVER]]) ids[k] = (await call('GET', '/api/me', { user: e })).json.id;
  withDb((db) => {
    const now = new Date().toISOString();
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, location, first_seen_at, last_seen_at) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?, ?)");
    for (let d = 1; d <= 6; d += 1) dog.run(d, `Dog${d}`, 'Kennel B', now, now);
    dog.run(7, 'Lexi', 'In Foster', now, now);
    db.prepare("UPDATE users SET experience_level = 'expert', onboarding_completed = 1 WHERE id IN (?, ?)").run(ids.walker, ids.other);
  });
});
test.after(() => server && server.stop());

const start = (dogId, user = WALKER, activity = 'walk') => call('POST', '/api/walks/start', { user, body: { dogId, userId: user === WALKER ? ids.walker : ids.other, activity } });
const read = (id) => withDb((db) => db.prepare('SELECT * FROM walks WHERE id = ?').get(id));

// ---- #1 End ends the walk at once; the end screen comes back until saved ----
test('#1 End (finishLater) frees the dog for everyone at once; the end screen comes back until Save & finish', async () => {
  const s = await start(1);
  assert.equal(s.status, 200, s.text);
  withDb((db) => db.prepare('UPDATE walks SET started_at = ? WHERE id = ?').run(ago(20), s.json.walkId));
  const tap = ago(0.5);
  const end = await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { endTappedAt: tap, finishLater: true } });
  assert.equal(end.status, 200, end.text);
  assert.ok(Math.abs(new Date(end.json.endedAt) - new Date(tap)) < 1000, 'ended at the tap');
  assert.equal(read(s.json.walkId).wrap_up_pending, 1);

  // Another volunteer sees the dog free and can take them out.
  const seen = await call('GET', '/api/dogs/1', { user: OTHER });
  assert.equal(seen.json.dog.currentWalk, null, 'not shown as out');
  const theirs = await start(1, OTHER);
  assert.equal(theirs.status, 200, 'another volunteer can start the same dog right away');

  // Reopening the app: the end screen again, for notes only (not auto-stopped).
  const active = await call('GET', `/api/walks/active?userId=${ids.walker}`);
  assert.equal(active.json.walk, null);
  assert.equal(active.json.wrapUp.id, s.json.walkId);
  assert.equal(active.json.wrapUp.autoStopped, false);
  assert.equal(active.json.wrapUp.ended_at, end.json.endedAt);

  // End again (a second tap, another tab): already ended, and says so.
  const again = await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { endTappedAt: tap, finishLater: true } });
  assert.equal(again.status, 409);
  assert.equal(again.json.alreadyEnded, true);
  assert.equal(again.json.wrapUpPending, true);

  // Save & finish: the note through the edit route; twice (a double tap) is fine.
  for (let i = 0; i < 2; i += 1) {
    const save = await call('PUT', `/api/walks/${s.json.walkId}`, { body: { notes: 'Loved the field', wrapUpDone: true } });
    assert.equal(save.status, 200, save.text);
    assert.equal(save.json.levelUpOffer, false);
  }
  const row = read(s.json.walkId);
  assert.equal(row.notes, 'Loved the field');
  assert.equal(row.wrap_up_pending, 0);
  assert.equal(row.ended_at, end.json.endedAt, 'saving notes never moves the end');
  assert.equal(row.edited, 0, 'nor marks it edited');
  assert.equal((await call('GET', `/api/walks/active?userId=${ids.walker}`)).json.wrapUp, null, 'asked only until saved');
  await call('PUT', `/api/walks/${theirs.json.walkId}/end`, { user: OTHER, body: {} });
});

test('#1 "Delete this walk…" on the end screen deletes the ended walk; starting the next one clears a pending end screen', async () => {
  const s = await start(2);
  await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { endTappedAt: ago(0.1), finishLater: true } });
  const del = await call('DELETE', `/api/walks/${s.json.walkId}`);
  assert.equal(del.status, 200);
  assert.equal(read(s.json.walkId), undefined);
  assert.equal((await call('GET', `/api/walks/active?userId=${ids.walker}`)).json.wrapUp, null);

  const t = await start(3);
  await call('PUT', `/api/walks/${t.json.walkId}/end`, { body: { endTappedAt: ago(0.1), finishLater: true } });
  const next = await start(4);
  assert.equal(next.status, 200);
  assert.equal(read(t.json.walkId).wrap_up_pending, 0, 'out with the next dog: the old end screen is dropped');
  await call('DELETE', `/api/walks/${next.json.walkId}`);
});

test('#1 old clients (End with the notes, no finishLater) still end and finish in one go', async () => {
  const s = await start(2);
  const end = await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { notes: 'one go', endTappedAt: ago(0.1) } });
  assert.equal(end.status, 200);
  assert.equal(read(s.json.walkId).wrap_up_pending, 0);
  assert.equal(read(s.json.walkId).notes, 'one go');
});

test('#1 End tapped after the time limit stopped it: 409, and the stopped walk keeps its own end screen', async () => {
  const s = await start(5);
  withDb((db) => db.prepare('UPDATE walks SET started_at = ? WHERE id = ?').run(ago(50), s.json.walkId));
  await call('GET', `/api/walks/active?userId=${ids.walker}`); // the limit sweep stops it at 45 min
  assert.equal(read(s.json.walkId).auto_stopped, 1);
  const late = await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { endTappedAt: ago(1), finishLater: true } });
  assert.equal(late.status, 409);
  assert.equal(late.json.autoStopped, true);
  const active = await call('GET', `/api/walks/active?userId=${ids.walker}`);
  assert.equal(active.json.wrapUp.id, s.json.walkId);
  assert.equal(active.json.wrapUp.autoStopped, true, 'asks when it really ended');
  const wrap = await call('PUT', `/api/walks/${s.json.walkId}/end`, { body: { notes: '', endedAt: ago(10) } });
  assert.equal(wrap.status, 200);
});

// ---- #3 foster ----
test('#3 a dog listed as in foster is not eligible (reason in_foster), but can still be started from the card', async () => {
  const one = await call('GET', '/api/dogs/7');
  assert.equal(one.json.dog.eligible, false);
  assert.equal(one.json.dog.notEligibleReason, 'in_foster');
  const list = await call('GET', '/api/dogs');
  const lexi = list.json.dogs ? list.json.dogs.find((d) => d.id === 7) : list.json.find((d) => d.id === 7);
  assert.equal(lexi.eligible, false, 'the list (and so the Eligible to walk filter) agrees');
  const s = await start(7);
  assert.equal(s.status, 200, 'a scanned kennel card means the dog is here: not a hard block');
  await call('DELETE', `/api/walks/${s.json.walkId}`);
});

// ---- #6 activity switch clamp ----
test('#6 switching activity mid-walk never passes the 3-hour cap', async () => {
  const s = await start(6);
  // Extended as far as a walk goes: 45 + 135 = 180 minutes.
  withDb((db) => db.prepare('UPDATE walks SET extend_minutes = 135 WHERE id = ?').run(s.json.walkId));
  const sw = await call('PUT', `/api/walks/${s.json.walkId}`, { body: { activity: 'matchmaking' } });
  assert.equal(sw.status, 200, sw.text);
  const capMs = new Date(s.json.startedAt).getTime() + 180 * 60000;
  assert.ok(new Date(sw.json.stopsAt).getTime() <= capMs, `stops by the 3-hour cap (${sw.json.stopsAt})`);
  const ext = await call('POST', `/api/walks/${s.json.walkId}/extend`, { body: {} });
  assert.equal(ext.status, 409, 'and no more time can be added');
  await call('DELETE', `/api/walks/${s.json.walkId}`);
});

// ---- #7 account deletion messages ----
test('#7 account deletion failures are marked userFacing, and the app shows those even on a 5xx', async () => {
  const r = await call('DELETE', '/api/me', { user: LEAVER, body: { confirm: 'DELETE' } });
  assert.equal(r.status, 502);
  assert.equal(r.json.userFacing, true);
  assert.match(r.json.error, /NOT deleted/);
  const src = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const fn = /function httpErrorMessage\(status, body\) \{[\s\S]*?\n {2}\}/.exec(src);
  const httpErrorMessage = vm.runInNewContext(`(${fn[0]})`);
  assert.equal(httpErrorMessage(502, r.json), r.json.error);
  assert.equal(httpErrorMessage(500, { error: 'database is locked' }), 'Something went wrong on our end. Try again in a moment.', 'unmarked 5xx stays hidden');
  assert.equal(httpErrorMessage(400, { error: 'Fix this' }), 'Fix this');
});

// ---- #8 Guide markdown ----
function markdownRenderer() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const pick = (re) => { const m = re.exec(src); assert.ok(m, `${re} found`); return m[0]; };
  const code = [
    pick(/function esc\(str\) \{[\s\S]*?\n {2}\}/),
    pick(/function safeUrl\(url, allowContact\) \{[\s\S]*?\n {2}\}/),
    pick(/function renderMarkdown\(src\) \{[\s\S]*?\n {2}\}/)
  ].join('\n');
  return vm.runInNewContext(`${code}\nrenderMarkdown`);
}
test('#8 a link inside an image\'s address or alt text can\'t break out of the attribute', () => {
  const render = markdownRenderer();
  const attack = [
    // The QA case: a link in the alt text was made into an <a> inside alt="".
    '![a [l](https://x.example/y) b](https://img.example/i.png)',
    '![[k](https://b.example/" onerror="alert(1))](https://img.example/i.png)',
    '![x](https://a.example/[k](https://b.example/x"onerror="alert(1)))',
    '![a *b* [c](https://c.example)](https://img.example/i.png)',
    '![alt" onload="x](https://img.example/i.png)',
    '[label ![i](https://img.example/i.png)](https://link.example/)'
  ];
  // Every tag, with its quoted values blanked, must be a known tag with only
  // known attributes: anything else means a value broke out of its quotes.
  const TAG = /^<\/?(p|img|a|strong|em|br|ul|ol|li|div|h[2-4]|blockquote|hr)((\s(class|src|alt|href|target|rel|loading)="")*)\s*\/?>$/;
  for (const md of attack) {
    const html = render(md);
    const blanked = html.replace(/="[^"]*"/g, '=""');
    for (const tag of blanked.match(/<[^>]*>/g) || []) assert.match(tag, TAG, `${md}\n -> ${html}`);
    assert.ok(!/<[^>]*</.test(blanked), `no tag inside a tag: ${html}`);
    // The alt text is the text, not markup (no <em>/<a> in it).
    for (const m of html.matchAll(/\salt="([^"]*)"/g)) assert.doesNotMatch(m[1], /[<>]/, `alt of ${md}: ${m[1]}`);
  }
  assert.equal(render('Hi **there** [site](https://x.example/a?b=1&c=2)'),
    '<p>Hi <strong>there</strong> <a href="https://x.example/a?b=1&amp;c=2" target="_blank" rel="noopener">site</a></p>');
  assert.match(render('![Dog](/wiki-images/a.png)'), /<img class="guide-img photo-lightbox-trigger" src="\/wiki-images\/a.png" alt="Dog"/);
  assert.match(render('[*it*](https://x.example)'), /<a href="https:\/\/x.example"[^>]*><em>it<\/em><\/a>/, 'emphasis in a link label still works');
});

// ---- #9 Together averages ----
test('#9 Together: slices say how many their average is over, and a no-walk day names its own activity', async () => {
  withDb((db) => {
    const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, ?, ?, ?, ?)');
    // Yesterday-ish: four walks, two of them under a minute.
    const day = new Date(Date.now() - 3 * 24 * 3600000);
    day.setUTCHours(15, 0, 0, 0);
    const at = (m) => new Date(day.getTime() + m * 60000).toISOString();
    ins.run(1, ids.walker, at(0), at(26), 26 * 60, 'walk');
    ins.run(2, ids.walker, at(30), at(56), 26 * 60, 'walk');
    ins.run(3, ids.other, at(60), at(60.5), 30, 'walk');
    ins.run(4, ids.other, at(70), at(70.5), 30, 'walk');
    // A matchmaking-only day.
    const mm = new Date(Date.now() - 5 * 24 * 3600000);
    mm.setUTCHours(15, 0, 0, 0);
    for (let i = 0; i < 3; i += 1) ins.run(i + 1, ids.walker, new Date(mm.getTime() + i * 3600000).toISOString(), new Date(mm.getTime() + i * 3600000 + 40 * 60000).toISOString(), 40 * 60, 'matchmaking');
  });
  const r = await call('GET', '/api/impact?days=all&species=dog');
  const walkSlice = r.json.allTime.byActivity.find((a) => a.activity === 'walk');
  assert.ok(walkSlice.avgCount < walkSlice.count, 'the average leaves the under-a-minute ones out, and says how many it is over');
  const mmDay = r.json.days.find((d) => d.walks === 3 && d.byActivity.every((a) => a.activity === 'matchmaking'));
  assert.ok(mmDay, 'the matchmaking day is listed');
  assert.equal(mmDay.avgActivity, 'matchmaking', 'not an "average walk"');
  assert.equal(r.json.allTime.avgActivity, 'walk');
});

// ---- #5 Guide text ----
// wikiSeed.js holds the shelter's own text and isn't in the public repo (CI's clean clone).
const hasSeed = fs.existsSync(path.join(__dirname, '..', 'src', 'wikiSeed.js'));
test('#5 Guide: Experience levels says what stray hold and foster do, added once to databases seeded before', { skip: !hasSeed && 'wikiSeed.js not present' }, async () => {
  const seed = require('../src/wikiSeed');
  const levels = seed.demoSections().find((s) => s.title === 'Experience levels');
  assert.match(levels.body, /stray hold/);
  assert.match(levels.body, /in foster/);
  const swap = seed.replacedLines().find((r) => r.key === 'wiki_added_stray_hold_foster');
  assert.equal(swap.lines.length, 1);
  assert.ok(!levels.body.split('\n').includes(swap.lines[0][0]), 'the line it replaces is not in new databases, so it can never be added twice');
  const sections = (await call('GET', '/api/wiki')).json;
  const list = Array.isArray(sections) ? sections : sections.sections;
  const shown = list.find((s) => s.title === 'Experience levels');
  if (shown && shown.body) assert.equal(shown.body.split('stray hold').length, 2, 'once');
});
