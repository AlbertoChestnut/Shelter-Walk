// Audit 2 (2026-11-10), staff dashboard in a real browser:
//   - Fit-to-screen only on a big screen or in TV mode: a phone, a tablet and
//     a 1024 laptop keep normal-size text; TV mode shrinks the board at 1024.
//   - The hourly chart keeps a 6:30am walk (the axis follows the data).
//   - A failed poll shows a stale-data banner on the board at 768 and 390.
//   - A hidden tab stops polling and catches up when shown again.
//   - Demo mode follows the Dogs / Cats switch.
//   - The one-animal picker tells the two Dukes apart and adds the right one.
//   - Saved formats bring back their species; deleting one asks first.
//   - Alert wording counts real sends ("no phones" with push off).
//   - Phone header: two short rows; the weekly hours table says it scrolls.
//   - A session-expired 401 shows the signed-out bar (shared http-errors.js).
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit2-staff.js        (SMOKE_SHOTS_DIR=... keeps screenshots)
const { startSmoke, launch } = require('./_harness');
const Database = require('better-sqlite3');

const STAFF = 'a2s.staff@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

// A shelter wall-clock time today as an ISO instant (DST-safe).
function shelterTodayAt(hh, mm) {
  const tz = 'America/New_York';
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const guess = new Date(`${key}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(guess).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(guess.getTime() - offsetMin * 60000).toISOString();
}

(async () => {
  const h = await startSmoke();
  const { base, dbFile } = h;
  let b;
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } })).json();
    const db = new Database(dbFile);
    db.prepare("UPDATE users SET experience_level='expert', onboarding_completed=1").run();
    const now = new Date().toISOString();
    const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at, species)
      VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, ?, ?, ?, ?)`);
    insDog.run(270585, 'Duke', null, 0, now, now, 'dog');
    insDog.run(272583, 'Duke', 'E', 1, now, now, 'dog');
    for (let i = 1; i <= 8; i += 1) insDog.run(100 + i, `Pup${i}`, 'ABCDE'[i % 5], 1, now, now, 'dog');
    const ins = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const early = shelterTodayAt(6, 30);
    ins.run(101, me.id, early, new Date(new Date(early).getTime() + 1200000).toISOString(), 1200, 'walk', 'A');
    const t = Date.now();
    for (let i = 2; i <= 6; i += 1) ins.run(100 + i, me.id, new Date(t - (60 + i) * 60000).toISOString(), new Date(t - (40 + i) * 60000).toISOString(), 1200, 'walk', 'B');
    db.prepare('INSERT INTO walks (dog_id, user_id, started_at, activity, location) VALUES (?, ?, ?, ?, ?)').run(108, me.id, new Date(t - 300000).toISOString(), 'walk', 'C');
    db.close();

    b = await launch();
    const errs = [];
    const open = async (width, height) => {
      const ctx = await b.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'x-auth-email': STAFF, 'x-auth-staff': '1' }, serviceWorkers: 'block' });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base + '/staff', { waitUntil: 'networkidle' });
      await p.waitForSelector('#sparklineBars svg');
      return p;
    };
    const zoomOf = (p) => p.evaluate(() => Number(document.documentElement.style.zoom || 1));

    // ---- Phone ----
    const phone = await open(390, 844);
    ok(await zoomOf(phone) === 1, 'phone (390): the live board keeps normal-size text (no zoom)');
    const headerH = await phone.evaluate(() => document.querySelector('.topbar').offsetHeight + document.querySelector('.subbar').offsetHeight);
    ok(headerH <= 130, `phone header is compact (${headerH}px, was about 210)`);
    ok(!(await phone.isVisible('#tvModeBtn')), 'TV mode is not offered on a phone');
    ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways page scroll at 390');
    await phone.screenshot({ path: h.shot('live-390.png') });
    await phone.click('.tab-btn[data-section="hours"]');
    await phone.waitForSelector('#weeklyRows tr');
    await phone.waitForFunction(() => !document.getElementById('weeklyScrollHint').classList.contains('hidden'));
    ok(true, 'phone: the weekly hours table says it scrolls to the Closed column');
    await phone.locator('#weeklyForm').scrollIntoViewIfNeeded();
    await phone.screenshot({ path: h.shot('hours-390-weekly-hint.png') });
    await phone.evaluate(() => { const s = document.querySelector('.weekly-scroll'); s.scrollLeft = s.scrollWidth; s.dispatchEvent(new Event('scroll')); });
    await phone.waitForFunction(() => document.getElementById('weeklyScrollHint').classList.contains('hidden'));
    ok(true, '...and the hint goes once the Closed column is in view');
    // Stale banner at 390 too.
    await phone.click('.tab-btn[data-section="live"]');
    await phone.route('**/api/staff/live*', (r) => r.abort());
    await phone.waitForSelector('#liveError:not(.hidden)', { timeout: 12000 });
    ok(await phone.isVisible('#liveError'), 'phone: a failed update shows the stale-data banner');
    await phone.screenshot({ path: h.shot('live-390-stale-banner.png') });
    await phone.close();

    // ---- 768: the error used to be invisible here ----
    const tab = await open(768, 1024);
    ok(await zoomOf(tab) === 1, 'tablet (768): no zoom');
    await tab.route('**/api/staff/live*', (r) => r.abort());
    await tab.waitForSelector('#liveError:not(.hidden)', { timeout: 12000 });
    const bannerText = await tab.textContent('#liveError');
    ok(/Not updating: this is the board as of/.test(bannerText) && /may be out of date/.test(bannerText), `768: stale banner says what happened ("${bannerText.slice(0, 60)}...")`);
    await tab.screenshot({ path: h.shot('live-768-stale-banner.png') });
    await tab.unroute('**/api/staff/live*');
    await tab.waitForSelector('#liveError.hidden', { state: 'attached', timeout: 12000 });
    ok(true, 'the banner clears on the next good update');

    // Hidden tab: no polling; shown again: catches up at once.
    let polls = 0;
    tab.on('request', (r) => { if (r.url().includes('/api/staff/live')) polls += 1; });
    await tab.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    polls = 0;
    await tab.waitForTimeout(11000);
    ok(polls === 0, `a hidden tab doesn't poll (${polls} requests in 11 s)`);
    await tab.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tab.waitForTimeout(800);
    ok(polls >= 1, 'showing it again updates right away');
    await tab.close();

    // ---- 1024 laptop: no zoom unless TV mode ----
    const lap = await open(1024, 768);
    ok(await zoomOf(lap) === 1, 'laptop (1024x768): no zoom by default');
    // The 6:30am walk is on the chart.
    const labels = await lap.$$eval('#sparklineBars .spark-x-label', (els) => els.map((e) => e.textContent));
    const sixBar = await lap.$$eval('#sparklineBars rect title', (els) => els.map((e) => e.textContent).find((x) => x.startsWith('6a - ')));
    ok(labels[0] === '6a' && sixBar === '6a - 1 engagement', `hourly chart starts at 6a with the 6:30am walk (${sixBar})`);
    const total = await lap.textContent('#statWalksToday');
    const barSum = await lap.$$eval('#sparklineBars rect title', (els) => els.reduce((s, e) => s + Number((/- (\d+)/.exec(e.textContent) || [])[1] || 0), 0));
    ok(Number(total) === barSum, `the bars add up to the tile (${barSum} = ${total})`);
    await lap.screenshot({ path: h.shot('live-1024.png') });
    await lap.click('#tvModeBtn');
    await lap.waitForFunction(() => Number(document.documentElement.style.zoom || 1) < 1);
    ok(await lap.getAttribute('#tvModeBtn', 'aria-pressed') === 'true', 'TV mode at 1024 shrinks the board to fit');
    await lap.screenshot({ path: h.shot('live-1024-tv-mode.png') });
    await lap.click('#tvModeBtn');
    await lap.waitForFunction(() => Number(document.documentElement.style.zoom || 1) === 1);
    ok(true, 'TV mode off: back to normal size');

    // Demo mode per species.
    await lap.click('#demoToggleBtn');
    await lap.waitForSelector('#demoBanner:not(.hidden)');
    ok(/Buddy/.test(await lap.textContent('#locationGrid')), 'demo mode: dogs by default');
    await lap.click('.species-btn[data-species="cat"]');
    await lap.waitForFunction(() => /Mittens/.test(document.getElementById('locationGrid').textContent));
    const catGrid = await lap.textContent('#locationGrid');
    ok(!/Buddy|Rocky/.test(catGrid), 'demo mode in Cats shows cats, no dogs');
    ok(await lap.textContent('#statActiveCount') === '3', 'Cats out now = 3 in the cat demo');
    await lap.screenshot({ path: h.shot('demo-cats-1024.png') });
    await lap.click('.species-btn[data-species="all"]');
    ok(await lap.textContent('#statActiveCount') === '10', 'Dogs and cats demo: 7 + 3');
    await lap.click('.species-btn[data-species="dog"]');
    await lap.click('#demoToggleBtn');

    // ---- Reports: picker and saved formats ----
    await lap.click('.tab-btn[data-section="reports"]');
    await lap.waitForFunction(() => document.querySelectorAll('#dogPickerList option').length >= 2);
    const options = await lap.$$eval('#dogPickerList option', (els) => els.map((e) => e.value).filter((v) => v.startsWith('Duke')));
    ok(options.length === 2 && options.some((o) => /ID 272583 · kennel E/.test(o)) && options.some((o) => /ID 270585 · no longer listed/.test(o)),
      `picker options tell the Dukes apart (${options.join(' | ')})`);
    await lap.fill('#dogPickerInput', 'Duke');
    await lap.click('#addDogBtn');
    ok(/2 animals are named "Duke"/.test(await lap.textContent('#dogPickerError')), 'a bare duplicate name asks which one');
    await lap.fill('#dogPickerInput', options.find((o) => o.includes('272583')));
    await lap.click('#addDogBtn');
    await lap.waitForSelector('.dog-chip');
    ok(/ID 272583/.test(await lap.textContent('#dogChips')), 'picking the current Duke adds that Duke (by ID)');
    await lap.screenshot({ path: h.shot('report-picker-duke.png') });
    await lap.click('#dogChips button[data-remove]');

    await lap.selectOption('#reportSpecies', 'cat');
    await lap.fill('#saveReportName', 'Cat format');
    await lap.click('#saveReportBtn');
    await lap.waitForFunction(() => [...document.querySelectorAll('#savedReportSelect option')].some((o) => o.textContent === 'Cat format'));
    await lap.selectOption('#reportSpecies', 'dog');
    const fmtId = await lap.$eval('#savedReportSelect', (s) => [...s.options].find((o) => o.textContent === 'Cat format').value);
    await lap.selectOption('#savedReportSelect', fmtId);
    await lap.click('#loadSavedReportBtn');
    ok(await lap.inputValue('#reportSpecies') === 'cat', 'loading a saved cats format brings back Cats');
    let dialogText = '';
    lap.once('dialog', (d) => { dialogText = d.message(); d.dismiss(); });
    await lap.click('#deleteSavedReportBtn');
    await lap.waitForTimeout(300);
    ok(/Delete the saved format "Cat format"/.test(dialogText) && /every staff member/.test(dialogText), 'deleting a shared format asks first');
    ok(await lap.$eval('#savedReportSelect', (s) => [...s.options].some((o) => o.textContent === 'Cat format')), '...and Cancel keeps it');

    // ---- Alerts: one wording, real sends ----
    await lap.click('.tab-btn[data-section="hours"]');
    await lap.waitForSelector('#weeklyRows tr');
    ok(await lap.isHidden('#weeklyScrollHint'), 'no scroll hint when the table fits');
    lap.once('dialog', (d) => d.accept());
    await lap.fill('#alertTitle', 'Smoke alert');
    await lap.click('#alertForm button[type="submit"]');
    await lap.waitForFunction(() => /Alert sent/.test(document.getElementById('alertStatus').textContent));
    const alertText = await lap.textContent('#alertStatus');
    ok(alertText === "Alert sent. It's in Updates, but no phones got a notification.", `alert wording counts real sends ("${alertText}")`);

    // ---- Signed out: the shared helper's bar ----
    await lap.click('.tab-btn[data-section="live"]');
    await lap.route('**/api/staff/live*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Your sign-in has expired. Reload the page to sign in again.', sessionExpired: true }) }));
    await lap.waitForSelector('.session-expired-bar', { timeout: 12000 });
    ok(/sign-in has expired/.test(await lap.textContent('.session-expired-bar')), 'an expired sign-in shows the Reload bar');
    await lap.screenshot({ path: h.shot('session-expired-1024.png') });
    await lap.close();

    // ---- Wide screen: still fits to the screen ----
    const tv = await open(1920, 600);
    await tv.waitForTimeout(500);
    ok(await zoomOf(tv) < 1, 'a wide screen (1920) still fits the board to one screen');
    await tv.close();

    // ---- Playgroup desk loads with the shared helper ----
    const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'x-auth-email': STAFF, 'x-auth-staff': '1' }, serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(base + '/playgroup', { waitUntil: 'networkidle' });
    ok(await pg.evaluate(() => typeof window.ShelterHttp.request === 'function'), 'the Playgroup desk loads http-errors.js');
    await pg.close();

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    console.log('audit2-staff smoke passed');
  } finally {
    if (b) await b.close();
    await h.stop();
  }
})().catch((err) => { console.error(err.stack || err.message || err); process.exit(1); });
