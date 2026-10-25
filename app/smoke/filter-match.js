// "Show dogs that match: All / Any ✓ filter": ✓ criteria AND by default and
// OR in Any mode, while ✕ filters and the kennel wing still narrow the list.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/filter-match.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3990, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_fmatch.db', EMAIL = 'v@example.com';
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
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location) VALUES (?, ?, ?, '2 Years', '2026-07-01T00:00:00', 1, ?, ?, ?)");
    ins.run(80, 'Pepper', 'Female', ts, ts, 'A1'); ins.run(81, 'Biscuit', 'Male', ts, ts, 'B1'); ins.run(82, 'Mochi', 'Male', ts, ts, 'A2');
    db.prepare('INSERT INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, ?, ?)').run(me.id, 81, ts);
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const names = async () => (await p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.replace(/[♥♡]/g, '').trim()))).sort().join(',');
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('#toggleMoreFiltersBtn');
    ok(await p.isVisible('.seg-btn.on[data-filter-match="all"]'), '"All ✓ filters" is the default');
    await p.click('[data-filter-key="female"]');
    await p.click('[data-filter-key="favorite"]');
    await p.waitForSelector('.empty-state');
    ok(true, 'All: female AND favorite matches nobody');
    await p.click('[data-filter-match="any"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 2);
    ok(await names() === 'Biscuit,Pepper', 'Any: female OR favorite shows Pepper and Biscuit');
    await p.screenshot({ path: '/tmp/_fmatch1.png' });
    await p.click('[data-location-key="A"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 1);
    ok(await names() === 'Pepper', 'kennel wing still narrows in Any mode');
    await p.click('[data-location-key="A"]');
    await p.click('[data-filter-key="male"]'); await p.click('[data-filter-key="male"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 1);
    ok(await names() === 'Pepper', 'a ✕ filter still hides dogs that match a ✓ one');
    await p.click('#clearFiltersBtn');
    ok(await p.isVisible('.seg-btn.on[data-filter-match="all"]'), 'Clear Filters goes back to All');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
