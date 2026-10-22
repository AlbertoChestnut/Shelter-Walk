// Renamed dogs: "aka <old name>" shows under the new name on the Available
// card and the profile, and searching the old name still finds them.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/dog-aka.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3994, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_aka.db', EMAIL = 'v@example.com';
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
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, previous_names, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'Male', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)");
    ins.run(273301, 'Jed', '["Boscoe"]', ts, ts); ins.run(71, 'Biscuit', '[]', ts, ts);
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });

    ok((await p.textContent('.avail-card[data-id="273301"] .dog-aka')).trim() === 'aka Boscoe', 'Available card shows "aka Boscoe"');
    ok(!(await p.locator('.avail-card[data-id="71"] .dog-aka').count()), 'a dog never renamed has no aka line');
    await p.fill('#availableSearchInput', 'bosc');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 1);
    ok((await p.textContent('.avail-card .dog-name')).includes('Jed'), 'searching the old name finds Jed');
    await p.screenshot({ path: '/tmp/_aka1.png' });

    await p.click('.avail-card[data-id="273301"] .dog-name');
    await p.waitForSelector('#closeProfileBtn');
    ok((await p.textContent('#profileSheet .dog-aka')).trim() === 'aka Boscoe', 'profile shows "aka Boscoe"');
    await p.screenshot({ path: '/tmp/_aka2.png' });
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
