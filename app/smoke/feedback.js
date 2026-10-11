// My Account → Feedback & bug reports: a volunteer sends one anonymously,
// staff read and resolve it in the Feedback inbox. Also checks the activity
// picker: Walk on its own full-width line, Play Group with the ball.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/feedback.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3995, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_fb.db', EMAIL = 'v@example.com', STAFF = 's@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const staff = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } })).json();
    const db = new Database(DB);
    const setup = db.prepare("UPDATE users SET name = ?, experience_level='experienced', onboarding_completed=1 WHERE id = ?");
    setup.run('Val', me.id); setup.run('Sky', staff.id);
    const ts = new Date().toISOString();
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (70, 'Pepper', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    db.close();
    const b = await chromium.launch();
    const page = async (email, headers = {}) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': email, ...headers }, serviceWorkers: 'block' });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base, { waitUntil: 'networkidle' });
      return { p, ctx, errs };
    };

    let { p, ctx, errs } = await page(EMAIL);
    await p.click('.walk-edit-btn[data-id="70"]'); await p.waitForSelector('#startWalkBtn');
    await p.click('#changeActivityBtn');
    const box = async (k) => p.locator(`#activityPickRow [data-activity="${k}"]`).boundingBox();
    const [walk, cuddle, match, play, day] = await Promise.all(['walk', 'cuddle', 'matchmaking', 'playgroup', 'daycation'].map(box));
    ok(walk.width > cuddle.width * 1.8 && walk.y < cuddle.y, 'Walk is double wide on its own line');
    ok(Math.abs(cuddle.y - match.y) < 2 && Math.abs(play.y - day.y) < 2 && play.y > cuddle.y, 'the other four are two per line');
    ok(Math.abs(cuddle.width - day.width) < 2, 'the other four are the same width');
    ok(/🥎/.test(await p.textContent('#activityPickRow [data-activity="playgroup"]')), 'Play Group shows the ball');
    await p.locator('#backToScanBtn2').scrollIntoViewIfNeeded();
    await p.screenshot({ path: '/tmp/_fb1.png' });

    await p.click('#userBtn');
    ok(await p.locator('#feedbackInboxRow').isHidden(), 'volunteers don\'t see the Feedback inbox');
    await p.click('.account-menu-row[data-page="feedback"]');
    await p.click('#feedbackKindPicker [data-kind="idea"]');
    await p.fill('#feedbackBody', 'A dark mode map of the kennels would help.');
    await p.click('#sendFeedbackBtn');
    await p.waitForFunction(() => /Sent/.test(document.getElementById('feedbackStatus').textContent));
    ok(await p.inputValue('#feedbackBody') === '', 'sent, and the box clears');
    await p.screenshot({ path: '/tmp/_fb2.png' });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();

    ({ p, ctx, errs } = await page(STAFF, { 'x-auth-staff': '1' }));
    await p.click('#userBtn');
    await p.click('#feedbackInboxRow');
    await p.waitForSelector('.feedback-item');
    ok(/💡 Idea/.test(await p.textContent('.feedback-item')) && /dark mode map/.test(await p.textContent('.feedback-item')), 'staff see the report in the inbox');
    ok(!/Val|v@example/.test(await p.textContent('#feedbackInboxList')), 'no sender shown');
    await p.click('.feedback-item [data-action="resolve"]');
    await p.waitForSelector('.feedback-item.resolved');
    ok(true, 'staff can mark it resolved');
    await p.screenshot({ path: '/tmp/_fb3.png' });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();

    // A "new feedback" notification opens the inbox: /?open=feedback.
    ({ p, ctx, errs } = await page(STAFF, { 'x-auth-staff': '1' }));
    await p.goto(base + '/?open=feedback', { waitUntil: 'networkidle' });
    await p.waitForSelector('#accountPageFeedbackInbox:not(.hidden) .feedback-item');
    ok(true, 'the notification link opens the inbox');
    await ctx.close();
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
