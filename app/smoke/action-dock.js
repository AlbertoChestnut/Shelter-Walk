// Small phones: Start / End / Save & Finish stay on screen without scrolling
// (pinned above the tab bar), and the Available list shows only shift boxes
// for walks logged in the app -- no per-dog walk totals that would read as
// the whole truth when dogs also get walked outside the app.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/action-dock.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 't@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='T', experience_level='experienced', onboarding_completed=1 WHERE id=?").run(me.id);
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location) VALUES (70, 'Pepper', 'Female', '2 Years', 'Boxer Mix', '2026-07-01T00:00:00', 1, ?, ?, 'D')").run(ts, ts);
    // 10:00-10:20am shelter time (EDT) on 2026-10-10; the page's clock is 11am.
    const start = '2026-10-10T14:00:00.000Z', end = '2026-10-10T14:20:00.000Z';
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (70, ?, 'D', ?, ?, 1200, 'walk')").run(me.id, start, end);
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 375, height: 667 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
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
    ok(sorts.includes('lastWalked') && !sorts.includes('attention'), '"longest since" is on the menu, the walk-count sort still is not: ' + sorts.join(', '));
    ok((await p.$eval('#availableSortSelect', (s) => s.value)) === 'lastWalked', '"longest since a logged walk" is the default sort');
    await p.screenshot({ path: h.shot('ad0.png') });
    await p.click('.walk-edit-btn[data-id="70"]'); await p.waitForSelector('#startWalkBtn');
    ok(await onScreen('#startWalkBtn'), 'Start is on screen without scrolling');
    await p.screenshot({ path: h.shot('ad1.png') });
    await p.click('#changeActivityBtn');
    ok(await onScreen('#startWalkBtn') && await onScreen('#activityPickRow'), 'Change opens the activities above Start, both on screen');
    await p.screenshot({ path: h.shot('ad1b.png') });
    await p.click('#changeActivityBtn');
    await p.evaluate(() => { const m = document.getElementById('app'); m.scrollTop = m.scrollHeight; });
    ok(await onScreen('#backToScanBtn2'), 'scrolled to the end, "Scan a different dog" is reachable');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn');
    ok(await onScreen('#endWalkBtn'), 'End is on screen without scrolling');
    // The bar sits flush on the tab bar while stuck, so it needs no solid
    // shadow below it to hide the gap -- that shadow used to paint over the
    // top of Cancel once scrolled to the end.
    await p.evaluate(() => { document.getElementById('app').scrollTop = 150; });
    const dock = await p.locator('.action-dock').boundingBox(), tabbar = await p.locator('.tabbar').boundingBox();
    ok(Math.abs(dock.y + dock.height - tabbar.y) < 1, 'mid-scroll, the bar sits right on the tab bar');
    ok(!/0px 24px 0px/.test(await p.$eval('.action-dock', (e) => getComputedStyle(e).boxShadow)), 'no solid shadow under the bar to cover Cancel');
    await p.screenshot({ path: h.shot('ad2.png') });
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    ok(await onScreen('#saveWalkBtn'), 'Save & Finish is on screen without scrolling');
    await p.screenshot({ path: h.shot('ad3.png') });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
