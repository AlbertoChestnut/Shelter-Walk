// Animal cards everywhere: tapping the photo shows it full screen, tapping the
// name or anything else in the info area opens the profile. A card with no
// photo yet opens the profile from the picture too; controls keep their taps.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/card-taps.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs'); const path = require('path');
const PORT = 3996, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_taps.db', EMAIL = 'taps@example.com';
const IMG = path.join(__dirname, '..', 'data', 'images', '99901.jpg');
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  fs.mkdirSync(path.dirname(IMG), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon-512.png'), IMG); // any real image will do
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='Taps', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location)
      VALUES (?, ?, 'Female', '3 Years', 'Lab', ?, 1, ?, ?, 'B')`);
    ins.run(99901, 'Photo', old, now, now);   // has a cached photo
    ins.run(99902, 'NoPhoto', old, now, now); // drawn silhouette only
    db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('new_dog', 99901, 'Photo was added to the shelter''s listing', ?)").run(now);
    db.close();

    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const lightboxOpen = () => p.isVisible('#imageLightbox:not(.hidden)');
    const profileOpen = async () => { await p.waitForTimeout(500); return p.isVisible('#profileSheet:not(.hidden)'); };
    const closeAll = async () => {
      if (await lightboxOpen()) await p.click('#closeImageLightboxBtn');
      if (await p.isVisible('#profileSheet:not(.hidden)')) await p.keyboard.press('Escape').catch(() => {});
      await p.goto(base, { waitUntil: 'networkidle' });
    };
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('.avail-card[data-id="99901"]');

    // Available
    await p.click('.avail-card[data-id="99901"] .dog-photo'); await p.waitForTimeout(400);
    ok(await lightboxOpen(), 'Available: photo opens full screen');
    ok(/cached-images\/99901/.test(await p.getAttribute('#imageLightboxImg', 'src')), 'with that animal\'s photo');
    ok(!(await p.isVisible('#profileSheet:not(.hidden)')), 'and not the profile');
    await closeAll(); await p.waitForSelector('.avail-card[data-id="99901"]');
    await p.click('.avail-card[data-id="99901"] .dog-meta'); ok(await profileOpen(), 'Available: the info line opens the profile');
    await closeAll(); await p.waitForSelector('.avail-card[data-id="99902"]');
    await p.click('.avail-card[data-id="99902"] .dog-photo'); ok(await profileOpen() && !(await lightboxOpen()), 'no photo yet: the picture opens the profile');
    await closeAll(); await p.waitForSelector('.avail-card[data-id="99901"]');
    await p.click('.avail-card[data-id="99901"] .checkoff-check'); await p.waitForTimeout(400);
    ok(!(await p.isVisible('#profileSheet:not(.hidden)')) && await p.isChecked('.avail-card[data-id="99901"] .checkoff-check'), 'the Out box still just ticks');
    await p.click('.avail-card[data-id="99901"] .checkoff-check'); await p.waitForTimeout(300);

    // Walk/Edit screen
    await p.click('.avail-card[data-id="99901"] .walk-edit-btn'); await p.waitForSelector('#startWalkBtn');
    await p.click('.walk-confirm .dog-photo'); await p.waitForTimeout(400);
    ok(await lightboxOpen(), 'Walk/Edit screen: photo opens full screen');
    await p.click('#closeImageLightboxBtn'); await p.waitForTimeout(300);
    await p.click('.walk-confirm .dog-meta'); ok(await profileOpen(), 'Walk/Edit screen: info opens the profile');
    await closeAll();

    // Updates
    await p.click('.tab-btn[data-tab="updates"]'); await p.waitForSelector('#app .dog-card .dog-photo');
    await p.click('#app .dog-card .dog-photo'); await p.waitForTimeout(400);
    ok(await lightboxOpen(), 'Updates: photo opens full screen');
    await p.click('#closeImageLightboxBtn'); await p.waitForTimeout(300);
    await p.click('#app .dog-card .dog-meta'); ok(await profileOpen(), 'Updates: info opens the profile');

    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); fs.rmSync(IMG, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
