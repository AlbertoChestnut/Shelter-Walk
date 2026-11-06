// Shelter hours, special days and alerts, end to end: staff close today and
// send an alert from /staff (Hours & alerts); a volunteer opening the app
// gets the "closed today" notice once, sees the alert under Updates ->
// Alerts, and has shelter alerts on in Settings (the admin-only signup
// toggle shows only for privileged accounts).
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/shelter-hours.js
process.env.TZ = 'America/New_York';
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3993, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_shelterhours.db', EMAIL = 'v@example.com', STAFF = 's@example.com';
const SHOTS = process.env.SHOTS || '/tmp';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    for (const e of [EMAIL, STAFF]) await fetch(base + '/api/me', { headers: { 'x-auth-email': e } });
    const db = new Database(DB);
    db.prepare("UPDATE users SET experience_level='beginner', onboarding_completed=1").run();
    db.close();
    const b = await chromium.launch();

    // Staff: close today with a note and an alert, send a second alert, change Sunday's hours.
    const sctx = await b.newContext({ viewport: { width: 1400, height: 1000 }, timezoneId: 'America/New_York', extraHTTPHeaders: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } });
    const s = await sctx.newPage(); const serrs = []; s.on('pageerror', (e) => serrs.push(e.message));
    s.on('dialog', (d) => d.accept());
    await s.goto(base + '/staff', { waitUntil: 'networkidle' });
    await s.click('.tab-btn[data-section="hours"]');
    await s.waitForSelector('#weeklyRows tr');
    ok(await s.locator('#weeklyRows tr').count() === 7, 'staff see all 7 weekdays');
    await s.fill('#specialNote', 'Emergency renovation');
    await s.check('#specialNotify');
    await s.click('#specialForm button[type="submit"]');
    await s.waitForFunction(() => /Saved/.test(document.getElementById('specialStatus').textContent));
    await s.waitForFunction(() => /Closed/.test(document.getElementById('hoursToday').textContent));
    ok(/Emergency renovation/.test(await s.textContent('#specialList')), 'today listed as a closed special day');
    await s.fill('#alertTitle', 'Volunteers please stay home');
    await s.fill('#alertBody', 'The parking lot is flooded.');
    await s.click('#alertForm button[type="submit"]');
    await s.waitForFunction(() => /Sent/.test(document.getElementById('alertStatus').textContent));
    await s.waitForFunction(() => document.querySelectorAll('#alertList li').length === 2);
    ok(true, 'two alerts listed (the closure one and the typed one)');
    await s.fill('#weeklyRows tr[data-dow="0"] .wk-open', '09:00');
    await s.fill('#weeklyRows tr[data-dow="0"] .wk-close', '17:00');
    await s.click('#weeklyForm button[type="submit"]');
    await s.waitForFunction(() => document.getElementById('weeklyStatus').textContent === 'Saved.');
    ok(true, 'weekly hours saved');
    await s.screenshot({ path: `${SHOTS}/staff-hours.png`, fullPage: true });
    ok(!serrs.length, 'no staff page errors' + (serrs.length ? ': ' + serrs.join('; ') : ''));

    // Volunteer: the day notice, once.
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York', extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#appDialog:not(.hidden)');
    ok(/closed today/.test(await p.textContent('#appDialogTitle')), 'opening the app on a closed day says so');
    ok(/Emergency renovation/.test(await p.textContent('#appDialogMessage')), '...with the staff note');
    await p.screenshot({ path: `${SHOTS}/day-notice.png` });
    await p.click('#appDialogOk');
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    ok(await p.locator('#appDialog:not(.hidden)').count() === 0, 'the same notice does not show again');

    // Updates: alerts, with their own chip.
    await p.click('.tab-btn[data-tab="updates"]');
    await p.waitForSelector('.update-alert');
    ok(await p.locator('.update-alert').count() === 2, 'both alerts are in Updates');
    ok(/parking lot is flooded/.test(await p.textContent('.update-alert >> nth=0')), 'the alert message shows');
    await p.click('[data-updates-kind="alert"]');
    await p.waitForFunction(() => /2 alerts/.test((document.querySelector('.result-count') || {}).textContent || ''));
    ok(true, 'the Alerts chip filters to alerts');
    await p.screenshot({ path: `${SHOTS}/updates-alerts.png` });

    // Settings: shelter alerts on by default; admin toggle hidden for a non-admin.
    await p.click('#settingsBtn');
    await p.waitForSelector('#settingsSheet:not(.hidden)');
    await p.waitForFunction(() => document.getElementById('settingsPrefShelterAlerts').checked);
    ok(true, 'shelter alerts are on by default');
    ok(await p.locator('#settingsNewSignupsRow.hidden').count() === 1, 'non-admins do not see the signup toggle');
    ok(!errs.length, 'no app page errors' + (errs.length ? ': ' + errs.join('; ') : ''));

    // Admin sees the signup toggle.
    const db2 = new Database(DB); db2.prepare("UPDATE users SET is_privileged = 1 WHERE name = 'V'").run(); db2.close();
    await p.reload({ waitUntil: 'networkidle' });
    await p.click('#settingsBtn');
    await p.waitForSelector('#settingsSheet:not(.hidden)');
    await p.waitForFunction(() => !document.getElementById('settingsNewSignupsRow').classList.contains('hidden'));
    ok(await p.isChecked('#settingsPrefNewSignups'), 'admins see the signup toggle, on by default');
    await p.screenshot({ path: `${SHOTS}/settings-admin.png`, fullPage: true });
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
