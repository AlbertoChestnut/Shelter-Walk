// "🦮 Eligible to walk" chip and preset: ✓ shows only dogs cleared for the
// volunteer's level right now (the Eligible ✓ badge), ✕ shows the rest.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/walkable-filter.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='beginner', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, blue_markers) VALUES (?, ?, 'Female', ?, ?, 1, ?, ?, ?)");
    ins.run(80, 'Pepper', '2 Years', '2026-07-01T00:00:00', ts, ts, '[]');
    ins.run(81, 'Biscuit', '2 Years', '2026-07-01T00:00:00', ts, ts, JSON.stringify(['blue_c']));
    ins.run(82, 'Tiny', '3 Months', '2026-07-01T00:00:00', ts, ts, '[]');
    ins.run(83, 'Newbie', '2 Years', ts, ts, ts, '[]');
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    const names = async () => (await p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]))).sort().join(',');
    const shows = (n) => p.waitForFunction((n) => document.querySelectorAll('.avail-card').length === n, n);

    await p.click('#toggleMoreFiltersBtn');
    await p.click('[data-filter-key="walkable"]');
    await shows(1);
    ok(await names() === 'Pepper', '✓ Eligible to walk shows only the dog cleared for a Beginner');
    await p.locator('[data-filter-key="walkable"]').scrollIntoViewIfNeeded();
    await p.screenshot({ path: h.shot('walkable1.png') });
    await p.click('[data-filter-key="walkable"]');
    await shows(3);
    ok(await names() === 'Biscuit,Newbie,Tiny', '✕ shows the blue-marker, too-young and too-new dogs');

    await p.click('#clearFiltersBtn');
    await p.click('[data-filters-tab="presets"]');
    await p.click('[data-preset-key="__walkable"]');
    await shows(1);
    ok(await names() === 'Pepper', 'Eligible to Walk preset');
    await p.click('[data-filters-tab="presets"]');
    ok(!(await p.$('[data-preset-key="__not_walkable"]')), 'no Not Eligible to Walk preset');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
