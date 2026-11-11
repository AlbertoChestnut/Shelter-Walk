// Audit 3 (eng), in a real browser: the checks test/audit2-staff.test.js
// and test/audit2-ui.test.js used to make by matching the source code.
//   - A special day saved with "also send an alert" uses the same wording as
//     the alert form, counting real sends ("no phones" with push off).
//   - Playgroup desk: the writer's own note that someone else edited shows
//     "can't be signed" and no Sign box; an untouched one keeps the box.
//   - The walk screen's "+N min" button follows GET /api/config's
//     extendMinutes (the label used to be typed out as "+10 min").
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit3-eng.js        (SMOKE_SHOTS_DIR=... keeps screenshots)
const { startSmoke, launch } = require('./_harness');
const { shelterDayFromToday } = require('../test/_helpers');
const Database = require('better-sqlite3');

const STAFF = 'a3e.staff@example.com';
const ALICE = 'a3e.alice@example.com';
const BOB = 'a3e.bob@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  const h = await startSmoke();
  const { base, dbFile } = h;
  const api = async (method, url, email, body, extra = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-auth-email': email, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, json, text };
  };
  let b;
  try {
    await api('GET', '/api/me', STAFF, undefined, { 'x-auth-staff': '1' });
    const alice = (await api('GET', '/api/me', ALICE)).json;
    await api('GET', '/api/me', BOB);
    const db = new Database(dbFile);
    db.prepare("UPDATE users SET experience_level='expert', onboarding_completed=1").run();
    db.prepare("UPDATE users SET name='Alice' WHERE id = ?").run(alice.id);
    const now = new Date().toISOString();
    const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at, species)
      VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 'A', 1, ?, ?, 'dog')`);
    insDog.run(93101, 'Biscuit', now, now);
    insDog.run(93102, 'Juniper', now, now);
    db.close();

    b = await launch();
    const errs = [];
    const page = async (email, { staff = false, width = 1366, height = 900 } = {}) => {
      const ctx = await b.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'x-auth-email': email, ...(staff ? { 'x-auth-staff': '1' } : {}) }, serviceWorkers: 'block' });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errs.push(e.message));
      return p;
    };

    // ---- Staff: a special day's alert says what the alert form says ----
    const s = await page(STAFF, { staff: true });
    s.on('dialog', (d) => d.accept());
    await s.goto(base + '/staff', { waitUntil: 'networkidle' });
    await s.click('.tab-btn[data-section="hours"]');
    await s.waitForSelector('#weeklyRows tr');
    // A date weeks ahead, from the clock: a typed-out one would expire.
    await s.fill('#specialDate', shelterDayFromToday(30));
    await s.fill('#specialNote', 'Adoption event');
    await s.check('#specialNotify');
    await s.click('#specialForm button[type="submit"]');
    await s.waitForFunction(() => /Saved/.test(document.getElementById('specialStatus').textContent));
    const special = await s.textContent('#specialStatus');
    ok(/Alert sent\. It's in Updates, but no phones got a notification\.$/.test(special), `special day + alert: the alert form's wording, real sends ("${special}")`);
    ok(!/Pushed to/.test(special), '...never "Pushed to"');
    await s.screenshot({ path: h.shot('special-day-alert-wording.png') });
    await s.close();

    // ---- Playgroup desk: no signing someone else's words ----
    const edited = (await api('POST', '/api/dogs/93101/playgroup-notes', ALICE, { body: 'Alice wrote this', noteDate: shelterDayFromToday(-1) })).json.id;
    ok((await api('PUT', `/api/dogs/93101/playgroup-notes/${edited}`, BOB, { body: 'Bob changed this' })).status === 200, 'Bob rewrites Alice\'s anonymous note');
    await api('POST', '/api/dogs/93101/playgroup-notes', ALICE, { body: 'All mine', noteDate: shelterDayFromToday(-2) });
    const pg = await page(ALICE);
    await pg.goto(base + '/playgroup', { waitUntil: 'networkidle' });
    await pg.waitForSelector('#dogList .dog-row');
    await pg.click('#dogList .dog-row:has-text("Biscuit")');
    await pg.waitForSelector('#dogPane .notes .note');
    const noteWith = (text) => pg.locator('#dogPane .notes .note', { hasText: text });
    await noteWith('Bob changed this').locator('[data-act="edit"]').click();
    const lockedFoot = noteWith('Bob changed this').locator('.desk-editor-foot');
    await lockedFoot.waitFor();
    ok(/can't be signed/.test(await lockedFoot.textContent()), 'an edited note says it can\'t be signed');
    ok(await lockedFoot.locator('.pg-signed').count() === 0, '...and has no Sign box');
    await pg.screenshot({ path: h.shot('playgroup-sign-locked.png') });
    await lockedFoot.locator('[data-act="cancel"]').click();
    await noteWith('All mine').locator('[data-act="edit"]').click();
    const ownFoot = noteWith('All mine').locator('.desk-editor-foot');
    await ownFoot.waitFor();
    ok(await ownFoot.locator('.pg-signed').count() === 1, 'her own untouched note keeps the Sign box');
    await pg.close();

    // ---- Walk screen: the extend button reads the served extendMinutes ----
    const start = await api('POST', '/api/walks/start', ALICE, { dogId: 93102, userId: alice.id, activity: 'walk' });
    ok(start.status === 200, `a walk starts (${start.status} ${start.text.slice(0, 80)})`);
    const v = await page(ALICE, { width: 390, height: 844 });
    await v.goto(base, { waitUntil: 'networkidle' });
    await v.waitForSelector('#extendWalkBtn');
    ok((await v.textContent('#extendWalkBtn')).trim() === '＋10 min', 'the extend button says +10 min (the served value)');
    await v.route('**/api/config', async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      await route.fulfill({ response: res, json: { ...json, extendMinutes: 15 } });
    });
    await v.reload({ waitUntil: 'networkidle' });
    await v.waitForSelector('#extendWalkBtn');
    ok((await v.textContent('#extendWalkBtn')).trim() === '＋15 min', 'with extendMinutes 15 served, it says +15 min');
    await v.screenshot({ path: h.shot('walk-extend-label.png') });
    await v.close();

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    console.log('audit3-eng smoke passed');
  } finally {
    if (b) await b.close();
    await h.stop();
  }
})().catch((err) => { console.error(err.stack || err.message || err); process.exit(1); });
