// "Combine filters with: And / Or": every filter (✓, ✕, kennel wing) is one
// condition, all required with And, any one enough with Or.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/filter-match.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='expert', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location) VALUES (?, ?, ?, '2 Years', '2026-07-01T00:00:00', 1, ?, ?, ?)");
    ins.run(80, 'Pepper', 'Female', ts, ts, 'A1'); ins.run(81, 'Biscuit', 'Male', ts, ts, 'B1'); ins.run(82, 'Mochi', 'Male', ts, ts, 'A2');
    db.prepare('INSERT INTO favorite_dogs (user_id, dog_id, created_at) VALUES (?, ?, ?)').run(me.id, 81, ts);
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const names = async () => (await p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.replace(/[♥♡]/g, '').trim()))).sort().join(',');
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('#toggleMoreFiltersBtn');
    const shows = async (n) => p.waitForFunction((n) => document.querySelectorAll('.avail-card').length === n, n);
    ok(await p.isVisible('.seg-btn.on[data-filter-match="all"]'), 'And is the default');
    await p.click('[data-filter-key="female"]');
    await p.click('[data-filter-key="favorite"]');
    await p.waitForSelector('.empty-state');
    ok(true, 'And: ✓ female, ✓ favorite matches nobody');
    await p.click('[data-filter-match="any"]');
    await shows(2);
    ok(await names() === 'Biscuit,Pepper', 'Or: ✓ female, ✓ favorite shows Pepper and Biscuit');
    await p.screenshot({ path: h.shot('fmatch1.png') });
    await p.click('[data-location-key="A"]');
    await shows(3);
    ok(await names() === 'Biscuit,Mochi,Pepper', 'Or: the kennel wing adds its dogs too');
    await p.click('#clearFiltersBtn');
    // ✕ male, ✕ favorite: And = female non-favorites; Or = not male or not a favorite.
    await p.click('[data-filter-key="male"]'); await p.click('[data-filter-key="male"]');
    await p.click('[data-filter-key="favorite"]'); await p.click('[data-filter-key="favorite"]');
    await shows(1);
    ok(await names() === 'Pepper', 'And: ✕ male, ✕ favorite shows only Pepper');
    await p.click('[data-filter-match="any"]');
    await shows(2);
    ok(await names() === 'Mochi,Pepper', 'Or: ✕ male, ✕ favorite shows Pepper and Mochi');
    await p.click('#clearFiltersBtn');
    ok(await p.isVisible('.seg-btn.on[data-filter-match="all"]'), 'Clear Filters goes back to And');
    ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
