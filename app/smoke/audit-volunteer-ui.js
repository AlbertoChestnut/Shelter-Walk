// 2026-11-10 audit, volunteer app: the shelter's date on a phone in another
// time zone, camera-blocked help (html5-qrcode rejects with a string), no raw
// server errors (friendly text + Try again), and the finished-walk screens
// (titles, Delete kept away from Save / Done).
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit-volunteer-ui.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
const EMAIL = 'vui@example.com';
(async () => {
  const h = await startSmoke(); const { base } = h;
  let b;
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(h.dbFile);
    db.prepare("UPDATE users SET name='Sam', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 40 * 864e5).toISOString();
    db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, tags, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location)
      VALUES (7001, 'Biscuit', 'dog', 'Male', '3 Years', '["Dog"]', ?, 1, ?, ?, 'B')`).run(old, now, now);
    db.close();
    b = await launch();
    const page = async (opts = {}) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block', ...opts });
      const p = await ctx.newPage(); return p;
    };

    // A phone set to Tokyo still asks for the shelter's day.
    const p1 = await page({ timezoneId: 'Asia/Tokyo' });
    const urls = []; p1.on('request', (r) => urls.push(r.url()));
    await p1.goto(base, { waitUntil: 'networkidle' }); await p1.waitForSelector('.avail-card');
    const ny = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const fd = new URL(urls.find((u) => u.includes('/api/walks/for-day')));
    const fromNy = new Date(fd.searchParams.get('fromUtc')).toLocaleString('en-US', { timeZone: 'America/New_York', hourCycle: 'h23' });
    ok(fd.searchParams.get('dateKey') === ny && /, 00:00:00$/.test(fromNy), `Tokyo phone: for-day is the shelter's ${ny} from ET midnight`);
    ok(await p1.textContent('#topbarTitle') === 'Dogs to walk', 'sentence-case title');

    // Walk through to the end: titles and the delete buttons.
    await p1.click('.avail-card .walk-edit-btn'); await p1.click('#startWalkBtn'); await p1.waitForSelector('#endWalkBtn');
    ok(await p1.textContent('#topbarTitle') === 'Walk in progress', 'Walk in progress');
    await p1.click('#endWalkBtn'); await p1.waitForSelector('#saveWalkBtn');
    ok(await p1.textContent('#topbarTitle') === 'Finish walk' && /Delete this walk/.test(await p1.textContent('#cancelWalkBtn')), 'ending: Finish walk, "Delete this walk…"');
    const gap = await p1.evaluate(() => document.getElementById('cancelWalkBtn').getBoundingClientRect().top - document.getElementById('saveWalkBtn').getBoundingClientRect().bottom);
    ok(gap >= 24, 'Delete sits well away from Save');
    await p1.click('#saveWalkBtn'); await p1.waitForSelector('#summaryDoneBtn');
    ok(await p1.textContent('#topbarTitle') === 'Walk complete', 'Walk complete, with a plain Done');
    await p1.click('#summaryDoneBtn'); await p1.waitForSelector('.avail-card');

    // Camera blocked: the library's string rejection still gets the help.
    const p2 = await page();
    await p2.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
    await p2.goto(base, { waitUntil: 'networkidle' }); await p2.click('.tab-btn[data-tab="walk"]');
    await p2.waitForSelector('#scanError .error-card');
    const camText = await p2.textContent('#scanError');
    ok(/Camera access is blocked/.test(camText) && !/userMedia|error =/.test(camText), 'camera blocked: help shown, no library text');

    // Server errors: friendly copy and Try again, never the raw body.
    const p3 = await page();
    await p3.route('**/api/dogs?*', (r) => r.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }));
    await p3.goto(base, { waitUntil: 'networkidle' }); await p3.waitForSelector('#retryLoadBtn');
    ok(!/Internal Server Error|Request failed/.test(await p3.textContent('#app')), '500: friendly text, Try again');
    await p3.unroute('**/api/dogs?*'); await p3.click('#retryLoadBtn'); await p3.waitForSelector('.avail-card');
    ok(true, 'Try again recovers');
    console.log('Volunteer UI audit smoke passed.');
  } catch (e) { console.error(e.message); process.exitCode = 1; } finally { if (b) await b.close(); await h.stop(); }
})();
