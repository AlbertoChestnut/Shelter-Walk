// Together: past days are grouped by month (whole history, not just 30 days),
// only the newest month open; an opened month stays open after viewing a day.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/together-months.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 't@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='T', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Female', '2 Years', '2026-01-01T00:00:00', 1, ?, ?)");
    for (let i = 0; i < 3; i++) dog.run(70 + i, 'Dog' + i, ts, ts);
    const walk = db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, 'D', ?, ?, 1200, 'walk')");
    // 2026-03 is far past the old 30-day window.
    for (const d of ['2026-10-02', '2026-09-10', '2026-09-20', '2026-03-05']) for (let i = 0; i < 3; i++) walk.run(70 + i, me.id, `${d}T15:00:00Z`, `${d}T15:20:00Z`);
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]'); await p.click('.seg-btn[data-scope="together"]');
    await p.waitForSelector('.visit-month');
    const months = await p.$$eval('.visit-month', (els) => els.map((e) => `${e.dataset.month}:${e.open ? 'open' : 'shut'}`));
    ok(months.join() === '2026-10:open,2026-09:shut,2026-03:shut', 'whole history, by month, newest open: ' + months);
    ok(/2 days · 6 engagements/.test(await p.textContent('.visit-month[data-month="2026-09"] summary')), 'month row shows its totals');
    await p.screenshot({ path: h.shot('tm1.png'), fullPage: true });
    await p.click('.visit-month[data-month="2026-03"] summary');
    await p.click('.together-day[data-date="2026-03-05"]');
    await p.click('#togetherBack');
    await p.waitForSelector('.visit-month');
    ok(await p.$eval('.visit-month[data-month="2026-03"]', (e) => e.open), 'opened month stays open after viewing a day');
    // My stats' months are kept separately.
    await p.click('.seg-btn[data-scope="mine"]'); await p.click('#statsRangeToggle');
    await p.waitForSelector('.visit-month');
    ok(!(await p.$eval('.visit-month[data-month="2026-03"]', (e) => e.open)), 'Lifetime stats has its own open months');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
