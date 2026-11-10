// The 20-hour level-up offer: balloons and a "move up to Established?"
// dialog for a Beginner past 20 hours, on opening the app or when the walk
// that crosses the line ends. Asked once, whatever the answer.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/level-up.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB;
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const users = {};
    for (const e of ['yes@example.com', 'no@example.com', 'walk@example.com']) users[e] = (await (await fetch(base + '/api/me', { headers: { 'x-auth-email': e } })).json()).id;
    const db = new Database(DB);
    db.prepare("UPDATE users SET experience_level='beginner', onboarding_completed=1").run();
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    const hist = (email, hours) => db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds) VALUES (70, ?, '2026-08-01T14:00:00.000Z', '2026-08-01T15:00:00.000Z', ?)").run(users[email], Math.round(hours * 3600));
    hist('yes@example.com', 21); hist('no@example.com', 21); hist('walk@example.com', 20 - 1 / 3600); // one second short
    db.close();
    const b = await launch();
    const page = async (email) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': email }, serviceWorkers: 'block' });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base, { waitUntil: 'networkidle' });
      return { p, ctx, errs };
    };
    const dialogOpen = (p) => p.isVisible('#appDialog');

    let { p, ctx, errs } = await page('yes@example.com');
    await p.waitForSelector('#appDialog:not(.hidden)');
    ok(await p.locator('.celebrate-overlay .celebrate-piece').count() >= 30, 'balloons fill the screen');
    ok(/20 hours/.test(await p.textContent('#appDialogTitle')), 'dialog says 20 hours');
    await p.waitForTimeout(1200); await p.screenshot({ path: h.shot('lvl1.png') });
    await p.click('#appDialogOk');
    await p.waitForFunction(() => /Established/.test((document.getElementById('toast') || {}).textContent || ''));
    const me = await p.evaluate(() => fetch('/api/me').then((r) => r.json()));
    ok(me.experienceLevel === 'established', 'yes moves them to Established');
    await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(400);
    ok(!(await dialogOpen(p)), 'not asked again');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();

    ({ p, ctx, errs } = await page('no@example.com'));
    await p.waitForSelector('#appDialog:not(.hidden)');
    await p.click('#appDialogCancel'); await p.waitForTimeout(300);
    await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(400);
    ok(!(await dialogOpen(p)), 'Stay Beginner is not asked again');
    ok((await p.evaluate(() => fetch('/api/me').then((r) => r.json()))).experienceLevel === 'beginner', 'and they stay Beginner');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();

    ({ p, ctx, errs } = await page('walk@example.com'));
    await p.waitForTimeout(400);
    ok(!(await dialogOpen(p)), 'just under 20 hours: no offer');
    await p.click('.walk-edit-btn[data-id="70"]'); await p.waitForSelector('#startWalkBtn');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn');
    await p.waitForTimeout(1500);
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    await p.click('#saveWalkBtn');
    await p.waitForSelector('#appDialog:not(.hidden)');
    ok(await p.isVisible('#doneBtn') && await p.locator('.celebrate-piece').count() > 0, 'the walk that crosses 20 hours ends with balloons and the offer');
    await p.waitForTimeout(1200); await p.screenshot({ path: h.shot('lvl2.png') });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();
    await b.close();
    console.log('level-up smoke OK');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
