// Playgroup presets: "Playgroup Eligible" leaves out dogs who are PB only,
// best without other dogs, or adopted; "Not Playgroup Eligible" shows only them.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/playgroup-presets.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3995, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_playgroup.db', EMAIL = 'v@example.com';
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
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, pb_flag, tags) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, ?, ?)");
    ins.run(80, 'Pepper', ts, ts, 0, '[]');
    ins.run(81, 'Biscuit', ts, ts, 1, '[]');
    ins.run(82, 'Mochi', ts, ts, 0, JSON.stringify(['Best in Home without Dogs']));
    ins.run(83, 'Tofu', ts, ts, 0, JSON.stringify(["I'm getting adopted!"]));
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    const names = () => p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]).sort());

    await p.click('#toggleMoreFiltersBtn');
    await p.click('[data-filters-tab="presets"]');
    await p.click('[data-preset-key="__playgroup"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 1);
    ok(JSON.stringify(await names()) === '["Pepper"]', 'Playgroup Eligible shows only the dog with no PB, no-dogs tag, or adoption');
    await p.screenshot({ path: '/tmp/_playgroup1.png' });

    await p.click('[data-filters-tab="presets"]');
    await p.click('[data-preset-key="__not_playgroup"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 3);
    ok(JSON.stringify(await names()) === '["Biscuit","Mochi","Tofu"]', 'Not Playgroup Eligible shows the PB, no-dogs, and adopted dogs');
    await p.screenshot({ path: '/tmp/_playgroup2.png' });

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
