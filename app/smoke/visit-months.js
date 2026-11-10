// Lifetime stats: Shelter Visits are grouped by month, only the newest month
// open, so By Dog isn't buried under a long history. Opened months stay open
// after looking at a day and coming back.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/visit-months.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='V', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-01-01T00:00:00', 1, ?, ?)").run(ts, ts);
    const walk = db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (70, ?, 'D', ?, ?, 1200, 'walk')");
    for (const d of ['2026-10-02', '2026-10-05', '2026-09-10', '2026-09-12', '2026-09-20', '2026-08-03']) walk.run(me.id, `${d}T15:00:00Z`, `${d}T15:20:00Z`);
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]'); await p.click('#statsRangeToggle');
    await p.waitForSelector('.visit-month');
    const months = await p.$$eval('.visit-month', (els) => els.map((e) => `${e.dataset.month}:${e.open ? 'open' : 'shut'}`));
    ok(months.join() === '2026-10:open,2026-09:shut,2026-08:shut', 'one row per month, newest open: ' + months);
    ok(/3 shelter visits · 3 engagements/.test(await p.textContent('.visit-month[data-month="2026-09"] summary')), 'month row shows its counts');
    ok(await p.isVisible('.visit-month[data-month="2026-10"] [data-daykey]') && !(await p.isVisible('.visit-month[data-month="2026-09"] [data-daykey]')), 'days only show in open months');
    await p.screenshot({ path: h.shot('vm1.png'), fullPage: true });
    await p.click('.visit-month[data-month="2026-09"] summary');
    await p.click('[data-daykey="2026-09-12"]');
    await p.click('#backToStatsBtn');
    await p.waitForSelector('.visit-month');
    ok(await p.$eval('.visit-month[data-month="2026-09"]', (e) => e.open), 'opened month stays open after visiting a day');
    await p.screenshot({ path: h.shot('vm2.png'), fullPage: true });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
