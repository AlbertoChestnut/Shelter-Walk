// POO Dogs / Non-POO Dogs presets: POO dogs (plain or priority) for
// mornings and evenings, the rest for 11 to 4. Each shows "Now" in its hours.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/poo-presets.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
process.env.TZ = 'America/New_York'; // the fixed clock times below are shelter times, which the app shows on any device
let base, DB; const EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='established', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, ?)");
    ins.run(80, 'Pepper', ts, ts, 'none');
    ins.run(81, 'Biscuit', ts, ts, 'poo');
    ins.run(82, 'Rocket', ts, ts, 'priority');
    db.close();
    const b = await launch();
    const errs = [];
    const open = async (time) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
      const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
      await p.clock.setFixedTime(new Date(time));
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('.avail-card');
      await p.click('#toggleMoreFiltersBtn');
      await p.click('[data-filters-tab="presets"]');
      await p.waitForSelector('[data-preset-key="__non_poo"]');
      return p;
    };
    const nowOn = (p, key) => p.$eval(`[data-preset-key="${key}"]`, (btn) => !!btn.closest('.card').querySelector('.badge'));
    const names = async (p) => (await p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]))).sort().join(',');
    const shows = (p, n) => p.waitForFunction((n) => document.querySelectorAll('.avail-card').length === n, n);

    const morning = await open('2026-11-04T09:00:00');
    ok(await nowOn(morning, '__poo') && !(await nowOn(morning, '__non_poo')), '9am: POO Dogs marked Now');
    await morning.click('[data-preset-key="__poo"]');
    await shows(morning, 2);
    ok(await names(morning) === 'Biscuit,Rocket', 'POO Dogs preset shows POO and priority POO dogs');

    const midday = await open('2026-11-04T13:00:00');
    ok(await nowOn(midday, '__non_poo') && !(await nowOn(midday, '__poo')), '1pm: Non-POO Dogs marked Now');
    await midday.locator('[data-preset-key="__non_poo"]').scrollIntoViewIfNeeded();
    await midday.screenshot({ path: h.shot('poopresets.png') });
    await midday.click('[data-preset-key="__non_poo"]');
    await shows(midday, 1);
    ok(await names(midday) === 'Pepper', 'Non-POO Dogs preset hides both kinds of POO dog');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
