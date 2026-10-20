// Small phones: Start / End / Save & Finish stay on screen without scrolling
// (pinned above the tab bar), and the Available list shows only shift boxes
// for walks logged in the app -- no per-dog walk totals that would read as
// the whole truth when dogs also get walked outside the app.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/action-dock.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3993, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_ad.db', EMAIL = 't@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='T', experience_level='experienced', onboarding_completed=1 WHERE id=?").run(me.id);
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location) VALUES (70, 'Pepper', 'Female', '2 Years', 'Boxer Mix', '2026-07-01T00:00:00', 1, ?, ?, 'D')").run(ts, ts);
    // 10:00-10:20am shelter time (EDT) on 2026-10-10; the page's clock is 11am.
    const start = '2026-10-10T14:00:00.000Z', end = '2026-10-10T14:20:00.000Z';
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (70, ?, 'D', ?, ?, 1200, 'walk')").run(me.id, start, end);
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 375, height: 667 }, timezoneId: 'America/New_York', extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.clock.install({ time: new Date('2026-10-10T15:00:00.000Z') });
    const onScreen = async (sel) => {
      const r = await p.locator(sel).boundingBox(); const bar = await p.locator('.tabbar').boundingBox();
      return r && r.y >= 0 && r.y + r.height <= bar.y + 1;
    };
    await p.goto(base, { waitUntil: 'networkidle' });
    const card = await p.textContent('.avail-card[data-id="70"]');
    ok(!/Walked \d+×/.test(card) && !/this week/.test(card) && !/today/.test(card), 'dog card has no walk totals: ' + card.replace(/\s+/g, ' ').trim().slice(0, 120));
    ok((await p.locator('.avail-card[data-id="70"] .slot-box.filled').count()) === 1, 'shift box still filled for the logged walk');
    ok(/walked outside the app/.test(await p.textContent('#app')), 'list explains boxes are only walks logged in the app');
    const sorts = await p.$$eval('#availableSortSelect option', (os) => os.map((o) => o.value));
    ok(!sorts.includes('lastWalked') && !sorts.includes('attention'), 'walk-count sorts are off the menu: ' + sorts.join(', '));
    await p.screenshot({ path: '/tmp/_ad0.png' });
    await p.click('.walk-edit-btn[data-id="70"]'); await p.waitForSelector('#startWalkBtn');
    ok(await onScreen('#startWalkBtn'), 'Start is on screen without scrolling');
    await p.screenshot({ path: '/tmp/_ad1.png' });
    await p.click('#changeActivityBtn');
    ok(await onScreen('#startWalkBtn') && await onScreen('#activityPickRow'), 'Change opens the activities above Start, both on screen');
    await p.screenshot({ path: '/tmp/_ad1b.png' });
    await p.click('#changeActivityBtn');
    await p.evaluate(() => { const m = document.getElementById('app'); m.scrollTop = m.scrollHeight; });
    ok(await onScreen('#backToScanBtn2'), 'scrolled to the end, "Scan a different dog" is reachable');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn');
    ok(await onScreen('#endWalkBtn'), 'End is on screen without scrolling');
    await p.screenshot({ path: '/tmp/_ad2.png' });
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    ok(await onScreen('#saveWalkBtn'), 'Save & Finish is on screen without scrolling');
    await p.screenshot({ path: '/tmp/_ad3.png' });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
