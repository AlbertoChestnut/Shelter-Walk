// The walk screen's timing tip from the "Which dogs should I walk?" sign:
// a POO dog's mid-day walk (1st or 2nd) gets a "save this slot for a
// non-POO dog" nudge linking to the Guide section; a non-POO dog, or the
// evening, gets none. PB dogs count as POO. A POO* dog gets its own
// warning from 4 to 5:30pm and otherwise the POO tip.
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
    // That section comes from the shelter's own starter text (wikiSeed.js),
    // which isn't in the public repo.
    const hasSeed = fs.existsSync(require('path').join(__dirname, '..', 'src', 'wikiSeed.js'));
    if (hasSeed) {
      ok(db.prepare("SELECT COUNT(*) AS n FROM wiki_sections WHERE title = 'Which dogs should I walk?'").get().n === 1, 'Guide has the Which dogs section');
    }
    db.prepare("UPDATE users SET name='T', experience_level='experienced', onboarding_completed=1 WHERE id=?").run(me.id);
    // 1pm and 5:30pm shelter time (EDT, UTC-4) on 2026-10-10; Pepper's first walk was at 8am.
    const ts = '2026-10-10T12:00:00.000Z';
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, 'poo')").run(ts, ts);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (71, 'Rocky', 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?, 'poo')").run(ts, ts);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (72, 'Daisy', 'Female', '4 Years', '2026-07-01T00:00:00', 1, ?, ?, 'none')").run(ts, ts);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status) VALUES (73, 'Star', 'Male', '5 Years', '2026-07-01T00:00:00', 1, ?, ?, 'priority')").run(ts, ts);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status, pb_flag) VALUES (74, 'Bean', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?, 'none', 1)").run(ts, ts);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, poo_status, pb_flag) VALUES (75, 'Moose', 'Male', '6 Years', '2026-07-01T00:00:00', 1, ?, ?, 'priority', 1)").run(ts, ts);
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
    ok(/POOs will have a guaranteed walk from 4-7 PM/.test(await p.textContent('.timing-hint')), 'mid-day 2nd walk of a POO dog gets the tip');
    await p.screenshot({ path: '/tmp/_wth1.png' });
    await p.click('#timingHintGuideBtn');
    if (hasSeed) {
      await p.waitForSelector('.guide-article');
      ok(/Which dogs should I walk\?/.test(await p.textContent('.guide-article h2')), 'tip link opens the Guide section');
    } else {
      await p.waitForSelector('#guideList');
      ok(true, 'tip link opens the Guide (no Which dogs section without wikiSeed.js)');
    }
    await p.screenshot({ path: '/tmp/_wth2.png', fullPage: true });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();
    ({ p, ctx, errs } = await open('2026-10-10T17:00:00.000Z', 71));
    ok(/POOs will have a guaranteed walk from 4-7 PM/.test(await p.textContent('.timing-hint')), 'mid-day 1st walk of a POO dog now gets the tip too');
    await ctx.close();
    ({ p, ctx, errs } = await open('2026-10-10T17:00:00.000Z', 72));
    ok((await p.locator('.timing-hint').count()) === 0, 'mid-day 1st walk of a non-POO dog gets no tip');
    await ctx.close();
    ({ p, ctx, errs } = await open('2026-10-10T21:30:00.000Z', 70));
    ok((await p.locator('.timing-hint').count()) === 0, 'POO dog in the evening gets no tip');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();
    // POO* (Star, no walks yet): its own warning only from 4 to 5:30pm, the POO tip mid-day.
    // PB counts as yellow too: Bean (PB only) gets the POO tip, Moose (PB + POO*) the POO* one.
    const STAR = /POO\* dogs should be walked between 5:30-7 PM/;
    const POO = /POOs will have a guaranteed walk from 4-7 PM/;
    for (const [iso, dogId, want, what] of [
      ['2026-10-10T11:30:00.000Z', 73, null, 'POO* dog 7:30am walk'],
      ['2026-10-10T17:00:00.000Z', 73, POO, 'POO* dog 1pm walk'],
      ['2026-10-10T20:30:00.000Z', 73, STAR, 'POO* dog 4:30pm walk'],
      ['2026-10-10T21:45:00.000Z', 73, null, 'POO* dog 5:45pm walk'],
      ['2026-10-10T17:00:00.000Z', 74, POO, 'PB dog 1pm walk'],
      ['2026-10-10T21:00:00.000Z', 74, null, 'PB dog 5pm walk'],
      ['2026-10-10T21:00:00.000Z', 75, STAR, 'PB + POO* dog 5pm walk'],
    ]) {
      ({ p, ctx, errs } = await open(iso, dogId));
      const n = await p.locator('.timing-hint').count();
      ok(want ? n === 1 && want.test(await p.textContent('.timing-hint')) : n === 0, `${what}: ${want ? (want === STAR ? 'POO* warning' : 'POO tip') : 'no tip'}`);
      await ctx.close();
    }
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
