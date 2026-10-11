// Favorites: heart a dog on the Available list, filter to "My favorites",
// the heart on the profile stays in step, and the three favorite
// notification settings save.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/favorites.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3996, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_fav.db', EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='expert', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)");
    ins.run(70, 'Pepper', ts, ts); ins.run(71, 'Biscuit', ts, ts); ins.run(72, 'Mochi', ts, ts);
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });

    await p.click('.avail-card[data-id="71"] .fav-btn');
    await p.waitForSelector('.avail-card[data-id="71"] .fav-btn.on');
    ok(!(await p.isVisible('#profileSheet:not(.hidden) #closeProfileBtn')), 'tapping the heart does not open the profile');
    await p.screenshot({ path: '/tmp/_fav1.png' });

    await p.click('#toggleMoreFiltersBtn');
    await p.click('[data-filter-key="favorite"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 1);
    ok((await p.textContent('.avail-card .dog-name')).includes('Biscuit'), '"My favorites" shows only the hearted dog');
    await p.screenshot({ path: '/tmp/_fav2.png' });

    await p.click('.avail-card[data-id="71"] .dog-name');
    await p.waitForSelector('#closeProfileBtn');
    ok(await p.isVisible('#profileSheet .fav-btn.on'), 'the profile shows the heart filled');
    await p.click('#profileSheet .fav-btn');
    await p.waitForSelector('#profileSheet .fav-btn:not(.on)');
    ok(!(await p.locator('.avail-card[data-id="71"] .fav-btn.on').count()), 'un-hearting on the profile updates the card too');
    await p.screenshot({ path: '/tmp/_fav3.png' });
    await p.click('#closeProfileBtn');

    await p.click('#settingsBtn');
    await p.waitForSelector('#settingsPrefFavAdopted');
    await p.check('#settingsPrefFavAdopted'); await p.check('#settingsPrefFavPending');
    await p.locator('#settingsPrefFavReturned').scrollIntoViewIfNeeded();
    await p.screenshot({ path: '/tmp/_fav4.png' });
    await p.click('#saveSettingsBtn');
    await p.waitForTimeout(800);
    const { prefs } = await (await fetch(`${base}/api/users/${me.id}/notification-prefs`, { headers: { 'x-auth-email': EMAIL } })).json();
    ok(prefs.favorite_adopted && prefs.favorite_pending && !prefs.favorite_returned, 'favorite notification settings save');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
