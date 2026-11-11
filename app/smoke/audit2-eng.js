// Audit 2 (2026-11-10), eng area, in the browser:
//  1. The real notificationclick "End walk" branch in sw.js (dispatched as a
//     NotificationEvent on the worker, since headless Chromium can't tap a
//     notification button), with the worker's clock pinned like the page's.
//  2. Notification times are the shelter's clock even on a phone in another
//     time zone (sw.js clockLabel).
//  3. Available draws a long list in chunks: the first cards at once, every
//     card in the end, and the buttons on late cards still work.
//  4. The scanner library isn't loaded until a scan opens.
//  5. Stats › Playgroup notes come a page at a time ("Show older notes"),
//     with each dog's full note count; searching fetches the rest.
//  6. The app reads the shared numbers from /api/config.
// Service-worker clock: Playwright's init scripts don't reach a worker, so
// the smoke pins it itself (pinWorkerClock). A worker that restarts loses
// the pin; nothing else in the smokes depends on the worker's clock.
//   node smoke/audit2-eng.js
const { startSmoke, launch } = require('./_harness');
const Database = require('better-sqlite3');

const EMAIL = 'eng2@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

// The same fixed offset _harness.js gives every page.
async function pinWorkerClock(sw) {
  const offset = Number(process.env.TEST_CLOCK_OFFSET_MS);
  if (process.env.TEST_CLOCK === 'real' || !Number.isFinite(offset) || offset === 0) return;
  await sw.evaluate((ms) => {
    if (self.__pinned) return;
    const RealDate = Date;
    class TestDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(RealDate.now() + ms); else super(...args); }
      static now() { return RealDate.now() + ms; }
    }
    self.Date = TestDate;
    self.__pinned = true;
  }, offset);
}

(async () => {
  const h = await startSmoke();
  const { base, dbFile } = h;
  let browser;
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(dbFile);
    const now = new Date().toISOString();
    const dog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, still_listed, first_seen_at, last_seen_at, date_in_shelter, kennel_location)
      VALUES (?, ?, 'Male', '3 Years', 'Hound Mix', 1, ?, ?, '2026-08-01T00:00:00', 'B')`);
    for (let i = 0; i < 75; i += 1) dog.run(300000 + i, `Pup ${String(i).padStart(2, '0')}`, now, now);
    db.prepare("UPDATE users SET name = 'Eng', experience_level = 'expert', onboarding_completed = 1 WHERE id = ?").run(me.id);
    // 180 Playgroup notes over 60 dogs, a day apart.
    const note = db.prepare('INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)');
    for (let i = 0; i < 180; i += 1) {
      const day = new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10);
      note.run(300000 + (i % 60), me.id, day, i === 179 ? 'zebra crossing, the oldest note' : `Played nicely, session ${i}`, now, now);
    }
    db.close();

    browser = await launch({ channel: 'chromium' }); // the new headless: notifications work (as notification-actions.js)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, timezoneId: 'America/Los_Angeles', permissions: ['notifications'] });
    await ctx.grantPermissions(['notifications'], { origin: base });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(base, { waitUntil: 'networkidle' });

    // 6. Shared numbers.
    ok(urls.some((u) => u.endsWith('/api/config')), 'the app asks /api/config for the shared numbers');

    // 3. Available in chunks.
    await page.waitForSelector('.avail-card');
    await page.waitForFunction(() => document.querySelectorAll('.avail-card').length === 75, null, { timeout: 10000 });
    ok(true, 'all 75 cards end up drawn');
    const last = page.locator('.avail-card').last();
    await last.locator('.walk-edit-btn').click();
    await page.waitForSelector('#startWalkBtn');
    ok(true, 'a card drawn in a later chunk still opens its walk screen');

    // 4. Scanner library: not on the page until a scan opens.
    // (Audit 3: it is fetched once the page is idle, so the service worker
    // has it for Scan offline, but never run until a scan opens.)
    ok(await page.evaluate(() => typeof Html5Qrcode === 'undefined' && !document.querySelector('script[src*="html5-qrcode"]')), 'html5-qrcode not loaded on start');

    // 1. A walk, an alert with the buttons, and the real "End walk" handler.
    await page.click('#startWalkBtn');
    await page.waitForSelector('#endWalkBtn');
    const walkId = await page.evaluate(async () => (await (await fetch('/api/walks/active')).json()).walk.id);
    ok(Number.isInteger(walkId), `walk ${walkId} running`);
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#endWalkBtn'); // controlled by the worker now
    await pinWorkerClock(sw);
    // 2. Shelter clock in the worker, on a phone set to Los Angeles.
    ok(await sw.evaluate(() => clockLabel('2026-11-10T17:00:00Z')).then((s) => /^12:00\s?PM$/i.test(s)), 'notification times are shelter time (noon ET), not the phone\'s 9 am');

    await page.waitForTimeout(3000);
    const tapAt = await sw.evaluate(async (id) => {
      await showPush({ title: 'Pup: 10 minutes', body: 'x', tag: 'walk', walkId: id, dogName: 'Pup', actions: [{ action: 'extend', title: '+10 min' }, { action: 'end', title: 'End walk' }] });
      const [n] = await self.registration.getNotifications({ tag: 'walk' });
      const at = new Date().toISOString();
      // The listener's own waitUntil throws for a script-made event, after it
      // has already handed openApp() the end-walk message.
      self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n, action: 'end' }));
      return at;
    }, walkId);
    await page.waitForSelector('#saveWalkBtn', { timeout: 10000 });
    ok(true, 'End walk from the alert: the open app jumps to the notes screen');
    await page.click('#saveWalkBtn');
    await page.waitForSelector('#doneBtn, #summaryDoneBtn');
    const r = new Database(dbFile, { readonly: true });
    const ended = r.prepare('SELECT ended_at FROM walks WHERE id = ?').get(walkId).ended_at;
    r.close();
    ok(Math.abs(new Date(ended) - new Date(tapAt)) < 3000, `ended at the tap on the pinned clock (${ended} vs ${tapAt})`);

    // 5. Playgroup notes, a page at a time.
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('.tab-btn[data-tab="stats"]');
    await page.click('.seg-btn[data-scope="playgroup"]');
    await page.waitForSelector('#pgStatsMore');
    const firstEntries = await page.locator('#pgStatsList .pg-entry').count();
    ok(firstEntries === 150, `first page: 150 of 180 notes (${firstEntries})`);
    const counts = await page.locator('#pgStatsList .all-notes-dog .dog-meta').allTextContents();
    ok(counts.every((t) => /^3 notes/.test(t)), 'each dog says its full count (3 notes), even with some on the next page');
    await page.click('#pgStatsMore');
    await page.waitForFunction(() => document.querySelectorAll('#pgStatsList .pg-entry').length === 180);
    ok(!(await page.$('#pgStatsMore')), 'Show older notes: the rest, then the button goes');
    // Searching from a fresh first page fetches what isn't loaded yet.
    await page.click('.seg-btn[data-scope="mine"]');
    await page.click('.seg-btn[data-scope="playgroup"]');
    await page.waitForSelector('#pgStatsMore');
    await page.fill('#pgStatsSearch', 'zebra');
    await page.waitForFunction(() => /zebra crossing/.test(document.getElementById('pgStatsList').textContent));
    ok(true, 'a search finds a note that was on a later page');

    // 4 again: opening a scan loads the scanner library.
    await page.click('.tab-btn[data-tab="walk"]');
    await page.waitForFunction(() => typeof Html5Qrcode !== 'undefined', null, { timeout: 10000 });
    ok(urls.some((u) => /html5-qrcode\.min\.js/.test(u)), 'opening Scan loads html5-qrcode');

    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  } finally {
    if (browser) await browser.close();
    await h.stop();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
