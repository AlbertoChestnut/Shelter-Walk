// Daycation: a 🚗 activity that runs up to 12 hours. Switching an active walk
// to it moves the automatic stop out to 12 hours and hides "+10 min".
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/daycation.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3996, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_dc.db', EMAIL = 'd@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='D', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, activity) VALUES (70, ?, 'D', ?, 'walk')").run(me.id, new Date(Date.now() - 5 * 60000).toISOString());
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#activityChoice [data-activity="daycation"]');
    ok(/🚗 Daycation/.test(await p.textContent('#activityChoice [data-activity="daycation"]')), 'daycation is offered with a car');
    ok(await p.isVisible('#extendWalkBtn'), 'a walk has +10 min');
    await p.click('#activityChoice [data-activity="daycation"]');
    await p.waitForFunction(() => /12 hours/.test(document.getElementById('autoStopText').textContent));
    ok(!(await p.isVisible('#extendWalkBtn')), 'a daycation has no +10 min');
    ok(/End Daycation/.test(await p.textContent('#endWalkBtn')), 'end button says daycation');
    const stopsAt = (await (await fetch(base + `/api/walks/active?userId=${me.id}`, { headers: { 'x-auth-email': EMAIL } })).json()).walk.stopsAt;
    ok(new Date(stopsAt) - Date.now() > 11 * 3600000, 'server moved the stop out to 12 hours');
    await p.screenshot({ path: '/tmp/_dc1.png' });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForSelector('#autoStopText');
    await p.waitForFunction(() => /12 hours/.test(document.getElementById('autoStopText').textContent));
    ok(!(await p.isVisible('#extendWalkBtn')), 'still a daycation after reopening the app');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
