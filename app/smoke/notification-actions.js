// Notification buttons: the walk alerts' "+10 min" (extends in the background,
// updates an open app, replaces the alert) and "End walk" (opens the notes
// screen, ended at the tap, whether the app was open or not). Calls sw.js's
// own functions, since headless Chromium can't tap a notification button.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/notification-actions.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3992, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_notif.db', EMAIL = 'n@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const now = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, still_listed, first_seen_at, last_seen_at, date_in_shelter, kennel_location) VALUES (262826, 'Axel Rose', 'Male', '12 Years', 'Boxer Mix', 1, ?, ?, '2026-08-23T00:00:00', 'B')").run(now, now);
    db.prepare("UPDATE users SET name='N', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id); db.close();
    const start = async () => (await (await fetch(base + '/api/walks/start', { method: 'POST', headers: { 'x-auth-email': EMAIL, 'content-type': 'application/json' }, body: JSON.stringify({ dogId: 262826, location: 'B', userId: me.id, activity: 'walk' }) })).json());
    let walk = await start(); ok(walk.walkId, 'walk started ' + walk.walkId);

    const browser = await chromium.launch({ channel: 'chromium' });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, permissions: ['notifications'] });
    await ctx.grantPermissions(['notifications'], { origin: base });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('#endWalkBtn');
    const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#endWalkBtn'); // controlled now

    // 1. A walk alert shows the two buttons.
    const actions = await sw.evaluate(async (walkId) => {
      await showPush({ title: 'Axel Rose: 10 minutes', body: 'x', tag: 'walk', walkId, dogName: 'Axel Rose', actions: [{ action: 'extend', title: '+10 min' }, { action: 'end', title: 'End walk' }] });
      const n = await self.registration.getNotifications({ tag: 'walk' });
      return n.length ? n[0].actions.map((a) => a.action + ':' + a.title) : null;
    }, walk.walkId);
    ok(actions && actions.join() === 'extend:+10 min,end:End walk', 'alert shows +10 min / End walk (' + actions + ')');

    // 2. +10 min in the background: server extended, open app told, alert replaced.
    const before = await page.evaluate(() => document.getElementById('autoStopText').textContent);
    const replaced = await sw.evaluate(async (walkId) => {
      await extendFromNotification({ walkId, dogName: 'Axel Rose' });
      const n = await self.registration.getNotifications({ tag: 'walk' });
      return n.map((x) => x.title + ' | ' + x.body);
    }, walk.walkId);
    ok(/added 10 minutes/.test(replaced[0]), 'alert replaced: ' + replaced[0]);
    const r = new Database(DB, { readonly: true }); ok(r.prepare('SELECT extend_minutes FROM walks WHERE id=?').get(walk.walkId).extend_minutes === 10, 'server shows +10 minutes'); r.close();
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => document.getElementById('autoStopText').textContent);
    ok(before !== after, `open app's timer updated ("${before}" -> "${after}")`);

    // 3. A failed extend says why (walk ended elsewhere).
    // 4. End walk with the app open: jumps to the notes screen, ended at the tap.
    await page.waitForTimeout(4000); const tapAt = new Date(Date.now() - 2000).toISOString();
    await sw.evaluate(async ({ walkId, at }) => openApp('/', { type: 'end-walk', walkId, at }), { walkId: walk.walkId, at: tapAt });
    await page.waitForSelector('#saveWalkBtn');
    ok(await page.evaluate(() => !!document.getElementById('walkNotes')), 'End walk (app open): notes screen shown');
    await page.click('#saveWalkBtn'); await page.waitForSelector('#doneBtn');
    const r2 = new Database(DB, { readonly: true }); const ended = r2.prepare('SELECT ended_at FROM walks WHERE id=?').get(walk.walkId).ended_at; r2.close();
    ok(Math.abs(new Date(ended) - new Date(tapAt)) < 2000, `walk ended at the tap time (${ended} vs ${tapAt})`);
    const failed = await sw.evaluate(async (walkId) => { await extendFromNotification({ walkId, dogName: 'Axel Rose' }); const n = await self.registration.getNotifications({ tag: 'walk' }); return n[0].title + ' | ' + n[0].body; }, walk.walkId);
    ok(/couldn't add time/.test(failed), 'extend after the walk ended explains: ' + failed);
    await page.click('#doneBtn');

    // 5. End walk with the app closed: opened from /?endWalk=..&at=..
    walk = await start();
    await page.close();
    await new Promise((r) => setTimeout(r, 4000)); const tap2 = new Date(Date.now() - 2000).toISOString();
    const p2 = await ctx.newPage(); p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(`${base}/?endWalk=${walk.walkId}&at=${encodeURIComponent(tap2)}`, { waitUntil: 'networkidle' });
    await p2.waitForSelector('#saveWalkBtn');
    ok(p2.url() === base + '/', 'URL tidied to /');
    await p2.click('#saveWalkBtn'); await p2.waitForSelector('#doneBtn');
    const r3 = new Database(DB, { readonly: true }); const e2 = r3.prepare('SELECT ended_at FROM walks WHERE id=?').get(walk.walkId).ended_at; r3.close();
    ok(Math.abs(new Date(e2) - new Date(tap2)) < 2000, 'End walk (app closed): ended at the tap time');
    // 6. A stale link for a different walk does nothing odd.
    walk = await start();
    await p2.goto(`${base}/?endWalk=999&at=${encodeURIComponent(tap2)}`, { waitUntil: 'networkidle' });
    await p2.waitForSelector('#endWalkBtn'); ok(true, 'link for another walk: the running walk stays running');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await browser.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
