// Available shows "Showing N of M dogs" for the current search, and Stats >
// Shelter draws the listing and in/out charts from the event log.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/shelter-trends.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3991, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_trends.db', EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='beginner', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, blue_markers) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, '[]')");
    ['Pepper', 'Biscuit', 'Bella', 'Max'].forEach((n, i) => ins.run(90 + i, n, ts, ts));
    db.prepare("UPDATE dogs SET location = 'In Foster' WHERE shelter_buddy_id = 93").run();
    // A past day with a foster count on record; the rest are gaps.
    const tenAgo = new Date(Date.now() - 10 * 86400000);
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(tenAgo);
    db.prepare('INSERT INTO shelter_daily_counts (date_key, listed, in_foster, recorded_at) VALUES (?, 4, 1, ?)').run(key, tenAgo.toISOString());
    const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, occurred_at) VALUES (?, NULL, ?)');
    for (let d = 1; d <= 40; d++) {
      const at = new Date(Date.now() - d * 86400000).toISOString();
      for (let k = 0; k < d % 4; k++) ev.run('new_dog', at);
      for (let k = 0; k < (d + 1) % 3; k++) ev.run('adopted', at);
    }
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    const count = () => p.$eval('.result-count', (e) => e.textContent.trim());
    ok(await count() === 'Showing 3 of 4 dogs', 'count with no search (the foster dog is hidden by default)');
    await p.fill('#availableSearchInput', 'b');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 2);
    ok(await count() === 'Showing 2 of 4 dogs', 'count follows the search');
    await p.fill('#availableSearchInput', 'zzz');
    await p.waitForSelector('.empty-state');
    ok(await count() === 'Showing 0 of 4 dogs', 'count shows 0 when nothing matches');

    await p.click('.tab-btn[data-tab="stats"]');
    await p.click('.seg-btn[data-scope="shelter"]');
    await p.waitForSelector('.trend-chart');
    ok(await p.locator('.trend-chart').count() === 2, 'two trend charts');
    ok(await p.locator('.trend-line').count() === 3, 'listed line + brought in + adopted lines');
    ok(await p.locator('.trend-point.floor').count() === 2, 'floor shows as points on its two known days, gaps elsewhere');
    const tiles = await p.$$eval('.stat-tile .value', (els) => els.map((e) => e.textContent));
    ok(tiles[0] === '3' && tiles[1] === '4', 'on the floor now (listed minus foster) and listed now tiles');
    await p.locator('.trend-chart').nth(1).scrollIntoViewIfNeeded();
    const box = await p.locator('.trend-chart').nth(1).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    ok(await p.locator('.trend-chart').nth(1).locator('.trend-tip:not(.hidden)').count() === 1, 'hover shows a tooltip');
    await p.screenshot({ path: '/tmp/_trends1.png', fullPage: true });
    await p.click('[data-shelter-range="0"]');
    await p.waitForSelector('[data-shelter-range="0"].on');
    ok(await p.locator('.trend-table tbody tr').count() >= 37, 'All range lists every tracked day');
    await p.emulateMedia({ colorScheme: 'dark' });
    await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await p.screenshot({ path: '/tmp/_trends2.png', fullPage: true });
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
