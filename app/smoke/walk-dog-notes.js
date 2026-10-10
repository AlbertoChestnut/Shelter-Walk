// Looking back at a walk in Stats: the dog's tips/private note open in a popup
// right from the walk card (the walk editor itself is times/activity only).
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/walk-dog-notes.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3993, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_wne.db', EMAIL = 'n@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='N', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    const end = new Date(Date.now() - 60000), start = new Date(end - 20 * 60000);
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, notes, activity) VALUES (70, ?, 'D', ?, ?, 1200, 'old note', 'walk')").run(me.id, start.toISOString(), end.toISOString());
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]'); await p.waitForSelector('.edit-times-btn');
    await p.locator('.dog-card[data-dogid]').screenshot({ path: '/tmp/_wne0.png' });
    await p.click('.edit-times-btn');
    ok(await p.isVisible('.edit-start-time') && (await p.locator('.edit-times-row textarea').count()) === 0, 'walk editor has no walk-notes box');
    await p.click('.dog-notes-btn'); await p.waitForSelector('#markerInfoPopup .private-note-input');
    ok(/Pepper's notes/.test(await p.textContent('#markerInfoPopupContent')), 'dog notes popup opens for the right dog');
    ok(/old note/.test(await p.textContent('#markerInfoPopupContent')), 'the earlier walk note is listed in the popup');
    await p.fill('.private-note-input', 'Use the harness'); await p.click('.private-note-add-btn');
    await p.waitForSelector('.tip-item[data-private]');
    ok(/Use the harness/.test(await p.textContent('.tip-item[data-private]')), 'private note saved from the popup');
    await p.screenshot({ path: '/tmp/_wne2.png' });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
