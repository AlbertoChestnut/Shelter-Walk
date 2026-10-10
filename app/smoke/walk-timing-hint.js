// The walk screen's timing tip from the "Which dogs should I walk?" sign:
// a POO dog's 2nd walk mid-day gets a "consider waiting" nudge linking to the
// Guide section; a first walk, or the evening, gets none.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/walk-timing-hint.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3994, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_wth.db', EMAIL = 't@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    ok(db.prepare("SELECT COUNT(*) AS n FROM wiki_sections WHERE title = 'Which dogs should I walk?'").get().n === 1, 'Guide has the Which dogs section');
    db.prepare("UPDATE users SET name='T', experience_level='experienced', onboarding_completed=1 WHERE id=?").run(me.id);
    // 1pm and 5:30pm shelter time (EDT, UTC-4) on 2026-10-10; Pepper's first walk was at 8am.
    const ts = '2026-10-10T12:00:00.000Z';
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, 'poo')").run(ts, ts);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (71, 'Rocky', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?, 'poo')").run(ts, ts);
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (70, ?, 'D', '2026-10-10T12:00:00.000Z', '2026-10-10T12:20:00.000Z', 1200, 'walk')").run(me.id);
    db.close();
    const b = await chromium.launch();
    const open = async (iso, dogId) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York', extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.clock.install({ time: new Date(iso) });
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click(`.walk-edit-btn[data-id="${dogId}"]`); await p.waitForSelector('#startWalkBtn');
      return { p, ctx, errs };
    };
    let { p, ctx, errs } = await open('2026-10-10T17:00:00.000Z', 70);
    ok(/Consider waiting: POO dogs' last walk is best after 4pm/.test(await p.textContent('.timing-hint')), 'mid-day 2nd walk of a POO dog gets the tip');
    await p.screenshot({ path: '/tmp/_wth1.png' });
    await p.click('#timingHintGuideBtn'); await p.waitForSelector('.guide-article');
    ok(/Which dogs should I walk\?/.test(await p.textContent('.guide-article h2')), 'tip link opens the Guide section');
    await p.screenshot({ path: '/tmp/_wth2.png', fullPage: true });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();
    ({ p, ctx, errs } = await open('2026-10-10T17:00:00.000Z', 71));
    ok((await p.locator('.timing-hint').count()) === 0, 'first walk of the day gets no tip');
    await ctx.close();
    ({ p, ctx, errs } = await open('2026-10-10T21:30:00.000Z', 70));
    ok((await p.locator('.timing-hint').count()) === 0, 'POO dog in the evening gets no tip');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
