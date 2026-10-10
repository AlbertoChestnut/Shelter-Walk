// Tapping a dog anywhere opens its profile, and the profile always has an
// Edit button that lands on that dog's Walk/Edit screen.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/dog-tap-edit.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3992, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_dte.db', EMAIL = 't@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString(); const inShelter = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19);
    db.prepare("UPDATE users SET name='T', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status, star_flag) VALUES (?, ?, 'Female', '2 Years', ?, 1, ?, ?, ?, 1)");
    dog.run(81, 'Maple', inShelter, ts, ts, 'poo'); dog.run(82, 'Juniper', inShelter, ts, ts, 'none');
    const end = new Date(Date.now() - 60000), start = new Date(end - 20 * 60000);
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (81, ?, 'D', ?, ?, 1200, 'walk')").run(me.id, start.toISOString(), end.toISOString());
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const profileOpen = () => p.waitForSelector('#profileSheet:not(.hidden) #profileEditBtn');
    await p.goto(base, { waitUntil: 'networkidle' });

    // Available: name -> profile -> Edit
    await p.click('.tab-btn[data-tab="available"]');
    const maple = p.locator('.avail-card[data-id="81"]');
    await maple.locator('.marker-badges-toggle').click(); await p.waitForTimeout(400);
    ok(await p.isHidden('#profileSheet'), 'tapping a marker badge in the name still just shows the markers');
    await p.click('#closeMarkerInfoPopupBtn').catch(() => {}); await p.waitForTimeout(300);
    await maple.locator('.dog-name').click({ position: { x: 5, y: 5 } }); await profileOpen();
    ok(/Walk \/ Edit/.test(await p.textContent('#profileEditBtn')), 'Available: name opens the profile with Walk / Edit');
    await p.screenshot({ path: '/tmp/_dte1.png' });
    await p.click('#profileEditBtn'); await p.waitForSelector('#startWalkBtn');
    ok(await p.isHidden('#profileSheet') && /Maple/.test(await p.textContent('#app')), 'Edit lands on Maple\'s Walk/Edit screen');

    // Walk/Edit screen: name -> profile -> Edit just closes it
    await p.locator('#app .dog-name.photo-bio-trigger').click({ position: { x: 5, y: 5 } }); await profileOpen();
    ok((await p.textContent('#profileEditBtn')).includes('Edit'), 'Walk/Edit screen: name opens the profile');
    await p.click('#profileEditBtn'); await p.waitForTimeout(500);
    ok(await p.isHidden('#profileSheet') && await p.isVisible('#startWalkBtn'), 'Edit there closes the profile and stays on the screen');

    // Stats walk card: name -> profile -> Edit
    await p.click('.tab-btn[data-tab="stats"]'); await p.waitForSelector('.edit-times-btn');
    await p.locator('.dog-card[data-dogid="81"] .dog-name').click({ position: { x: 40, y: 5 } }); await profileOpen();
    ok(true, 'Stats: walk card name opens the profile with Edit');
    await p.click('#profileEditBtn'); await p.waitForSelector('#startWalkBtn');
    ok(/Maple/.test(await p.textContent('#app')), 'Edit from Stats lands on the Walk/Edit screen');

    // During a walk: own dog -> Back to your walk, another dog -> disabled
    await p.click('#locationPicker [data-letter="D"]').catch(() => {});
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn');
    await p.click('.tab-btn[data-tab="available"]');
    await p.locator('.avail-card[data-id="81"] .dog-name').click({ position: { x: 5, y: 5 } }); await profileOpen();
    ok(/Back to your walk/.test(await p.textContent('#profileEditBtn')), 'walking dog: profile offers Back to your walk');
    await p.click('#profileEditBtn'); await p.waitForSelector('#endWalkBtn');
    ok(true, 'and it returns to the running walk');
    await p.click('.tab-btn[data-tab="available"]');
    await p.locator('.avail-card[data-id="82"] .dog-name').click({ position: { x: 5, y: 5 } }); await profileOpen();
    ok(await p.isDisabled('#profileEditBtn'), 'another dog during a walk: Edit is disabled');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
