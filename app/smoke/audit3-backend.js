// Audit 3 (backend fixes that reach the app), in the browser:
//   1. a crafted /?endWalk link does nothing; the service worker's own
//      (with its nonce) ends the walk at the kept tap time;
//   2. "End walk" tapped on a notification with the app closed and no
//      connection is kept and sent once back online;
//   3. a shared phone: an End tapped offline by one walker is still sent
//      after the next one signs in;
//   4. an auto-stopped walk's end screen defaults to "At [limit]" unless the
//      walker is back within a few minutes;
//   5. a walk held to closing shows the official closing time, never the
//      quiet stop a little after it.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit3-backend.js   (SMOKE_SHOTS_DIR=... keeps the screenshots)
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB;
const U1 = 'a3.one@example.com', U2 = 'a3.two@example.com', U3 = 'a3.three@example.com', STAFF = 'a3.staff@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
const api = async (method, url, email, body, extra = {}) => {
  const res = await fetch(base + url, { method, headers: { 'x-auth-email': email, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const row = (id) => { const db = new Database(DB, { readonly: true }); try { return db.prepare('SELECT * FROM walks WHERE id = ?').get(id); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new Database(DB); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
const MIN = 60000;
const hhmm24 = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date(ms));
const clock12 = (ms) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).format(new Date(ms)).replace(/\s?[AP]M$/i, '');

(async () => {
  const h = await startSmoke({ env: { WALK_HOURS: '07:00-19:00' } }); ({ base, dbFile: DB } = h);
  try {
    const me = {};
    for (const [k, e] of [['u1', U1], ['u2', U2], ['u3', U3], ['staff', STAFF]]) me[k] = (await api('GET', '/api/me', e)).json;
    {
      const db = new Database(DB); const now = new Date().toISOString();
      db.prepare("UPDATE users SET experience_level='expert', onboarding_completed=1").run();
      const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, still_listed, first_seen_at, last_seen_at, date_in_shelter, kennel_location) VALUES (?, ?, 'Male', '3 Years', 'Mix', 1, ?, ?, '2026-08-01T00:00:00', 'B')");
      for (let i = 0; i < 8; i += 1) dog.run(811 + i, `Dog${811 + i}`, now, now);
      db.close();
    }
    const start = async (email, userId, dogId) => (await api('POST', '/api/walks/start', email, { dogId, userId, activity: 'walk' })).json;
    const b = await launch();
    const context = async (email, opts = {}) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': email }, ...opts });
      const errs = [];
      ctx.on('page', (pg) => pg.on('pageerror', (e) => errs.push(e.message)));
      return { ctx, errs };
    };

    // 1 + 2: crafted link, then the worker's own link while offline.
    {
      const { ctx, errs } = await context(U1, { serviceWorkers: 'allow' });
      const w = await start(U1, me.u1.id, 811);
      run('UPDATE walks SET started_at = ? WHERE id = ?', new Date(Date.now() - 10 * MIN).toISOString(), w.walkId);
      let p = await ctx.newPage();
      await p.goto(base, { waitUntil: 'networkidle' }); await p.waitForSelector('#endWalkBtn');
      await p.evaluate(() => navigator.serviceWorker.ready);
      await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('#endWalkBtn'); // controlled now
      const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');

      const crafted = new Date(Date.now() - 9 * MIN).toISOString();
      await p.goto(`${base}/?endWalk=${w.walkId}&at=${encodeURIComponent(crafted)}`, { waitUntil: 'networkidle' });
      await p.waitForSelector('#endWalkBtn'); await p.waitForTimeout(800);
      ok(!row(w.walkId).ended_at, 'a crafted /?endWalk link does not end the walk');
      await p.goto(`${base}/?endWalk=${w.walkId}&nonce=${'0'.repeat(32)}`, { waitUntil: 'networkidle' });
      await p.waitForSelector('#endWalkBtn'); await p.waitForTimeout(800);
      ok(!row(w.walkId).ended_at, 'nor does one with a made-up nonce');

      await p.close();
      const tap = new Date(Date.now() - 3000).toISOString();
      const nonce = await sw.evaluate(async ({ walkId, at }) => stashEndTap(walkId, at), { walkId: w.walkId, at: tap });
      await ctx.setOffline(true);
      p = await ctx.newPage();
      await p.goto(`${base}/?endWalk=${w.walkId}&nonce=${nonce}`, { waitUntil: 'load' });
      await p.waitForSelector('#saveWalkBtn', { timeout: 10000 });
      ok(true, 'offline, the notification\'s End opens the end screen from the phone\'s copy');
      await p.waitForTimeout(500);
      ok(!row(w.walkId).ended_at, 'and keeps the End on the phone for now');
      await ctx.setOffline(false);
      await p.waitForFunction(async (id) => { try { return (await (await fetch(`/api/walks/active?userId=${id}`)).json()).wrapUp != null; } catch (e) { return false; } }, me.u1.id, { timeout: 15000 });
      const ended = row(w.walkId);
      ok(ended.ended_at && Math.abs(new Date(ended.ended_at) - new Date(tap)) < 2000, `back online: ended at the tapped time (${ended.ended_at})`);
      await p.screenshot({ path: h.shot('01-offline-notification-end-sent.png') });
      ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
      await ctx.close();
    }

    // 3. A shared phone: U2 taps End offline; U3 signs in once it's back.
    {
      const { ctx, errs } = await context(U2, { serviceWorkers: 'allow' });
      const w = await start(U2, me.u2.id, 812);
      run('UPDATE walks SET started_at = ? WHERE id = ?', new Date(Date.now() - 12 * MIN).toISOString(), w.walkId);
      const p = await ctx.newPage();
      await p.goto(base, { waitUntil: 'networkidle' }); await p.waitForSelector('#endWalkBtn');
      await p.evaluate(() => navigator.serviceWorker.ready);
      await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('#endWalkBtn');
      await p.waitForTimeout(500);
      await ctx.setOffline(true);
      const tapAt = Date.now();
      await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn'); await p.waitForTimeout(500);
      ok(!row(w.walkId).ended_at, 'U2\'s End is kept on the shared phone');
      await p.close();
      await ctx.setExtraHTTPHeaders({ 'x-auth-email': U3 });
      await ctx.setOffline(false);
      const p2 = await ctx.newPage();
      await p2.goto(base, { waitUntil: 'networkidle' });
      await p2.waitForFunction(async () => true);
      for (let i = 0; i < 30 && !row(w.walkId).ended_at; i += 1) await p2.waitForTimeout(200);
      const ended = row(w.walkId);
      ok(ended.ended_at && Math.abs(new Date(ended.ended_at) - tapAt) < 3000, `U3 signed in: U2's End was still sent (${ended.ended_at})`);
      ok(ended.user_id === me.u2.id, 'and the walk is still U2\'s');
      ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
      await ctx.close();
    }

    // 4. The end screen of an auto-stopped walk.
    {
      const { ctx, errs } = await context(U1, { serviceWorkers: 'block' });
      run('UPDATE walks SET wrap_up_pending = 0 WHERE user_id = ?', me.u1.id);
      const late = run('INSERT INTO walks (dog_id, user_id, started_at) VALUES (813, ?, ?)', me.u1.id, new Date(Date.now() - 65 * MIN).toISOString()).lastInsertRowid;
      const p = await ctx.newPage();
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#endTimeChoice');
      const active = () => p.$eval('#endTimeChoice .active', (el) => el.dataset.end);
      ok(await active() === 'limit', 'back 20 minutes after the stop: "At [limit]" is preselected');
      ok(/Walk time: 45 min/.test(await p.textContent('#walkEndSummary')), 'and the summary says 45 min, not 1h 5m');
      await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn, #summaryDoneBtn');
      ok(row(late).duration_seconds === 45 * 60, 'saved as the 45-minute limit');

      const soon = run('INSERT INTO walks (dog_id, user_id, started_at) VALUES (814, ?, ?)', me.u1.id, new Date(Date.now() - 47 * MIN).toISOString()).lastInsertRowid;
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#endTimeChoice');
      ok(await active() === 'now', 'back 2 minutes after the stop: "Just now" is preselected');
      await p.click('#endTimeChoice [data-end="limit"]');
      await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn, #summaryDoneBtn');
      ok(row(soon).ended_at, 'saved');
      ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
      await ctx.close();
    }

    // 5. Held to closing: the timer names the official closing time.
    {
      const { ctx, errs } = await context(U3, { serviceWorkers: 'block' });
      const closeMs = Math.floor(Date.now() / MIN) * MIN + 10 * MIN;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
      const day = await api('PUT', `/api/staff/schedule/days/${today}`, STAFF, { mode: 'hours', open: '07:00', close: hhmm24(closeMs) }, { 'x-auth-staff': '1' });
      ok(day.status === 200, 'staff close today in 10 minutes');
      const w = await start(U3, me.u3.id, 815);
      ok(w.walkId && w.closesAt === new Date(closeMs).toISOString(), 'a walk starts, held to that closing time');
      const p = await ctx.newPage();
      await p.goto(base, { waitUntil: 'networkidle' }); await p.waitForSelector('#autoStopText');
      await p.waitForTimeout(1200);
      const text = await p.textContent('#autoStopText');
      ok(text.includes(clock12(closeMs)) && !text.includes(clock12(closeMs + 20 * MIN)), `the timer names closing time: "${text}"`);
      await p.screenshot({ path: h.shot('05-held-to-closing.png') });
      await api('DELETE', `/api/walks/${w.walkId}`, U3);
      await api('DELETE', `/api/staff/schedule/days/${today}`, STAFF, undefined, { 'x-auth-staff': '1' });
      ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
      await ctx.close();
    }
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
