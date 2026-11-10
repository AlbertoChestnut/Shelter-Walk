// Playgroup presets: "Playgroup Eligible" leaves out dogs who are PB only,
// best without other dogs, or adopted; "Not Playgroup Eligible" shows only them.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/playgroup-presets.js
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
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, pb_flag, tags) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, ?, ?)");
    ins.run(80, 'Pepper', ts, ts, 0, '[]');
    ins.run(81, 'Biscuit', ts, ts, 1, '[]');
    ins.run(82, 'Mochi', ts, ts, 0, JSON.stringify(['Best in Home without Dogs']));
    ins.run(83, 'Tofu', ts, ts, 0, JSON.stringify(["I'm getting adopted!"]));
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    const names = () => p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]).sort());

    await p.click('#toggleMoreFiltersBtn');
    await p.click('[data-filters-tab="presets"]');
    await p.click('[data-preset-key="__playgroup"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 1);
    ok(JSON.stringify(await names()) === '["Pepper"]', 'Playgroup Eligible shows only the dog with no PB, no-dogs tag, or adoption');
    await p.screenshot({ path: h.shot('playgroup1.png') });

    await p.click('[data-filters-tab="presets"]');
    await p.click('[data-preset-key="__not_playgroup"]');
    await p.waitForFunction(() => document.querySelectorAll('.avail-card').length === 3);
    ok(JSON.stringify(await names()) === '["Biscuit","Mochi","Tofu"]', 'Not Playgroup Eligible shows the PB, no-dogs, and adopted dogs');
    await p.screenshot({ path: h.shot('playgroup2.png') });

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
