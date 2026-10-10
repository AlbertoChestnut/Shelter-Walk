// Back from a dog opened off the Updates feed returns to the same scroll spot,
// and a puppy at exactly 6 months is walkable while 5 months isn't.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/updates-scroll.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3993, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_us.db', EMAIL = 't@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString(); const inShelter = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19);
    db.prepare("UPDATE users SET name='T', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Female', ?, ?, 1, ?, ?)");
    const ev = db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('new_dog', ?, ?, ?)");
    for (let i = 0; i < 30; i++) {
      dog.run(100 + i, 'Dog' + i, i === 0 ? '6 Months' : i === 1 ? '5 Months' : '2 Years', inShelter, ts, ts);
      ev.run(100 + i, 'New dog: Dog' + i, new Date(Date.now() - i * 60000).toISOString());
    }
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });

    await p.click('.tab-btn[data-tab="available"]');
    await p.waitForSelector('.avail-card[data-id="100"]');
    ok(!/Too young/.test(await p.textContent('.avail-card[data-id="100"]')), '6 months old: walkable');
    ok(/Too young/.test(await p.textContent('.avail-card[data-id="101"]')), '5 months old: too young');

    await p.click('.tab-btn[data-tab="updates"]'); await p.waitForSelector('#app .card[data-id="120"]');
    await p.locator('#app .card[data-id="120"]').scrollIntoViewIfNeeded();
    const before = await p.evaluate(() => document.getElementById('app').scrollTop);
    ok(before > 300, 'scrolled down the Updates feed (' + before + ')');
    await p.locator('#app .card[data-id="120"] .walk-edit-btn').click(); await p.waitForSelector('#startWalkBtn');
    ok(/Dog20/.test(await p.textContent('#app')), 'opened Dog20 from Updates');
    await p.goBack(); await p.waitForSelector('#app .card[data-id="120"]'); await p.waitForTimeout(300);
    const after = await p.evaluate(() => document.getElementById('app').scrollTop);
    ok(Math.abs(after - before) < 2, `Back returns to the same scroll spot (${before} -> ${after})`);
    await p.locator('#app .card[data-id="121"] .walk-edit-btn').click(); await p.waitForSelector('#startWalkBtn');
    ok(/Dog21/.test(await p.textContent('#app')), 'buttons still work on the restored list');
    // Back before the dog has even loaded: the late lookup mustn't paint the
    // dog over the feed (and drag the feed's remembered spot to the top).
    await p.goBack(); await p.waitForSelector('#app .card[data-id="120"]'); await p.waitForTimeout(300);
    const spot = await p.evaluate(() => document.getElementById('app').scrollTop);
    await p.route('**/api/dogs/122?*', async (r) => { await new Promise((x) => setTimeout(x, 800)); r.continue(); });
    await p.locator('#app .card[data-id="122"] .walk-edit-btn').click(); await p.waitForSelector('text=Looking up dog');
    await p.goBack(); await p.waitForTimeout(1200);
    ok(await p.$('#app .card[data-id="120"]') && !(await p.$('#startWalkBtn')), 'quick Back: still on the feed, not the dog');
    const spot2 = await p.evaluate(() => document.getElementById('app').scrollTop);
    ok(Math.abs(spot2 - spot) < 2, `quick Back keeps the scroll spot (${spot} -> ${spot2})`);
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
