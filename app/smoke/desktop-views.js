// Start page on a computer: staff land on the staff dashboard by default, can
// switch with the bar at the top of each desktop page, and tick "Open this
// page first" to land on the play group desk instead. The app's Settings has
// the same choice. Walkers get the app and the desk, never the staff page.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/desktop-views.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB;
const SHOTS = process.env.SHOTS_DIR;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    for (const e of ['boss@example.com', 'vol@example.com']) await fetch(base + '/api/me', { headers: { 'x-auth-email': e } });
    const db = new Database(DB);
    db.prepare("UPDATE users SET experience_level='expert', onboarding_completed=1").run();
    db.close();

    const b = await launch();
    const errs = [];
    const ctxFor = async (email, staff) => {
      const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, userAgent: DESKTOP_UA, extraHTTPHeaders: { 'x-auth-email': email, ...(staff ? { 'x-auth-staff': '1' } : {}) }, serviceWorkers: 'block' });
      const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
      return p;
    };

    // Staff
    const p = await ctxFor('boss@example.com', true);
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    ok(new URL(p.url()).pathname === '/staff', 'staff on a computer land on the staff dashboard by default');
    await p.waitForSelector('#deskNav .desk-nav-link');
    const staffLinks = await p.$$eval('#deskNav .desk-nav-link', (els) => els.map((e) => e.textContent.trim()));
    ok(staffLinks.join('|') === 'Volunteer app|Play group desk|Staff dashboard', 'switcher on the staff page lists all three');
    ok(await p.isChecked('#deskNavStart'), '"Open this page first" is ticked there (the default)');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/views-staff.png`, clip: { x: 0, y: 0, width: 1366, height: 120 } });
    await p.click('#deskNav a:has-text("Play group desk")');
    await p.waitForSelector('#deskNavStart');
    ok(new URL(p.url()).pathname === '/playgroup' && !(await p.isChecked('#deskNavStart')), 'switcher goes to the play group desk, not ticked yet');
    await p.check('#deskNavStart');
    await p.waitForTimeout(500);
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    ok(new URL(p.url()).pathname === '/playgroup', 'after ticking it, the site opens on the play group desk');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/views-desk.png`, clip: { x: 0, y: 0, width: 1366, height: 120 } });
    await p.click('#deskNav a:has-text("Volunteer app")');
    await p.waitForSelector('#settingsBtn');
    ok(new URL(p.url()).pathname === '/app', 'Volunteer app opens the app at /app (no bounce back)');

    // Settings in the app shows and changes the same thing.
    await p.click('#settingsBtn');
    await p.waitForSelector('#desktopViewSection:not(.hidden)');
    ok(await p.inputValue('#desktopViewSelect') === 'playgroup', 'Settings shows "On a computer, open: Play group desk"');
    await p.selectOption('#desktopViewSelect', 'app');
    await p.waitForTimeout(800);
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    ok(new URL(p.url()).pathname === '/', 'chose the app in Settings: the site opens on the app');
    await p.click('#userBtn');
    ok(await p.isVisible('#staffDashLink'), 'staff have a Staff dashboard link in the account menu');

    // Walker
    const w = await ctxFor('vol@example.com', false);
    await w.goto(base + '/playgroup', { waitUntil: 'networkidle' });
    await w.waitForSelector('#deskNav .desk-nav-link');
    const walkerLinks = await w.$$eval('#deskNav .desk-nav-link', (els) => els.map((e) => e.textContent.trim()));
    ok(walkerLinks.join('|') === 'Volunteer app|Play group desk', 'a walker\'s switcher has no staff dashboard');
    await w.check('#deskNavStart');
    await w.waitForTimeout(500);
    await w.goto(base + '/', { waitUntil: 'networkidle' });
    ok(new URL(w.url()).pathname === '/playgroup', 'a walker can make the desk their start page');
    await w.uncheck('#deskNavStart');
    await w.waitForTimeout(500);
    await w.goto(base + '/', { waitUntil: 'networkidle' });
    ok(new URL(w.url()).pathname === '/', 'unticking goes back to the app');

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('desktop views smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
