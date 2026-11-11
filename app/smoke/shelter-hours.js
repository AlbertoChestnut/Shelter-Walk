// Shelter hours, special days and alerts, end to end: staff close today and
// send an alert from /staff (Hours & alerts); a volunteer opening the app
// gets the "closed today" notice once, sees the alert under Updates ->
// Alerts, and has shelter alerts on in Settings (the admin-only signup
// toggle shows only for privileged accounts).
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/shelter-hours.js
process.env.TZ = 'America/New_York';
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'v@example.com', STAFF = 's@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    for (const e of [EMAIL, STAFF]) await fetch(base + '/api/me', { headers: { 'x-auth-email': e } });
    const db = new Database(DB);
    db.prepare("UPDATE users SET experience_level='beginner', onboarding_completed=1").run();
    db.close();
    const b = await launch();

    // Staff: close today with a note and an alert, send a second alert, change Sunday's hours.
    const sctx = await b.newContext({ viewport: { width: 1400, height: 1000 },extraHTTPHeaders: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } });
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
    await s.waitForFunction(() => /Alert sent/.test(document.getElementById('alertStatus').textContent));
    await s.waitForFunction(() => document.querySelectorAll('#alertList li').length === 2);
    ok(true, 'two alerts listed (the closure one and the typed one)');
    await s.fill('#weeklyRows tr[data-dow="0"] .wk-open', '09:00');
    await s.fill('#weeklyRows tr[data-dow="0"] .wk-close', '17:00');
    await s.click('#weeklyForm button[type="submit"]');
    await s.waitForFunction(() => document.getElementById('weeklyStatus').textContent === 'Saved.');
    ok(true, 'weekly hours saved');
    await s.screenshot({ path: h.shot('staff-hours.png'), fullPage: true });
    ok(!serrs.length, 'no staff page errors' + (serrs.length ? ': ' + serrs.join('; ') : ''));

    // Volunteer: the day notice, once.
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 },extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#appDialog:not(.hidden)');
    ok(/closed today/.test(await p.textContent('#appDialogTitle')), 'opening the app on a closed day says so');
    ok(/Emergency renovation/.test(await p.textContent('#appDialogMessage')), '...with the staff note');
    await p.screenshot({ path: h.shot('day-notice.png') });
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
    // One kind picked: just the total, no "· 2 alerts" repeating it (audit 2).
    await p.waitForFunction(() => /^2 updates/.test(((document.querySelector('.result-count') || {}).textContent || '').trim()) && document.querySelectorAll('.card:not(.update-alert) [data-dog-id], .card[data-dog-id]').length === 0);
    ok(true, 'the Alerts chip filters to alerts');
    await p.screenshot({ path: h.shot('updates-alerts.png') });

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
    await p.screenshot({ path: h.shot('settings-admin.png'), fullPage: true });
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
