// The blue "any" chip cycles like every other chip: once for dogs with any
// blue letter (EVO left alone), twice to hide every blue sticker, again to
// clear. The Beginner preset also hides adopted (pending adoption) dogs.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/blue-any-filter.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3991, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_blueany.db', EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='beginner', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, blue_markers, tags) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, ?, ?)");
    ins.run(80, 'Pepper', ts, ts, '[]', '[]');
    ins.run(81, 'Biscuit', ts, ts, JSON.stringify(['blue_c']), '[]');
    ins.run(82, 'Evie', ts, ts, JSON.stringify(['blue_evo']), '[]');
    ins.run(83, 'Goldie', ts, ts, '[]', JSON.stringify(["I'm getting adopted!"]));
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    const names = async () => (await p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]))).sort().join(',');
    const shows = (n) => p.waitForFunction((n) => document.querySelectorAll('.avail-card').length === n, n);
    const chip = '[data-filter-action="blue-any"]';

    await p.click('#toggleMoreFiltersBtn');
    await p.click(chip);
    await shows(1);
    ok(await names() === 'Biscuit', 'once: only dogs with a blue letter (not EVO)');
    ok(await p.$eval(chip, (e) => e.classList.contains('active')), 'chip shows ✓');
    await p.click(chip);
    await shows(2);
    ok(await names() === 'Goldie,Pepper', 'twice: hides every blue sticker, EVO included');
    ok(await p.$eval(chip, (e) => e.classList.contains('excluding')), 'chip shows ✕');
    await p.locator(chip).scrollIntoViewIfNeeded();
    await p.screenshot({ path: '/tmp/_blueany.png' });
    await p.click(chip);
    await shows(4);
    ok(!(await p.$eval(chip, (e) => e.className.match(/active|excluding/))), 'third tap clears');

    await p.click('[data-filters-tab="presets"]');
    await p.click('[data-preset-key="__beginner"]');
    await shows(1);
    ok(await names() === 'Pepper', 'Beginner preset hides blue and adopted dogs');
    ok(await p.$eval(chip, (e) => e.classList.contains('excluding')), 'blue chip shows ✕ under the Beginner preset');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
