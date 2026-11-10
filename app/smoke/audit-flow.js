// Flow fixes (2026-11-10, round 3), in the browser: End ends the walk at
// once (the dog is free for others) and a reload brings its end screen back
// with the typed note; a double-tapped Save & finish saves once; the "Today
// is different" notice's OK leaves the walk screen up; switching activity
// can't pass the 3-hour cap; a foster dog asks to check the card; a picked
// end time before the start is refused inline; and a reload with no
// connection keeps the walk (End offline is sent once back online).
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit-flow.js     (SMOKE_SHOTS_DIR=... keeps the screenshots)
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB;
const WALKER = 'walker.flow@example.com', OTHER = 'other.flow@example.com', STAFF = 'staff.flow@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
const as = (email, extra = {}) => ({ headers: { 'x-auth-email': email, 'content-type': 'application/json', ...extra } });
const api = async (method, url, email, body, extra) => {
  const res = await fetch(base + url, { method, ...as(email, extra), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const row = (id) => { const db = new Database(DB, { readonly: true }); try { return db.prepare('SELECT * FROM walks WHERE id = ?').get(id); } finally { db.close(); } };
const run = (sql, ...args) => { const db = new Database(DB); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
// The shelter's clock reading of a moment, as an <input type="time"> value.
const shelterHHMM = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date(ms));

(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = {};
    for (const [k, e] of [['walker', WALKER], ['other', OTHER], ['staff', STAFF]]) me[k] = (await api('GET', '/api/me', e)).json;
    const now = new Date().toISOString();
    {
      const db = new Database(DB);
      db.prepare("UPDATE users SET experience_level='expert', onboarding_completed=1").run();
      const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, still_listed, first_seen_at, last_seen_at, date_in_shelter, kennel_location, location) VALUES (?, ?, 'Male', '3 Years', 'Boxer Mix', 1, ?, ?, '2026-08-01T00:00:00', 'B', ?)");
      dog.run(801, 'Axel', now, now, 'Kennel B');
      dog.run(802, 'Bella', now, now, 'Kennel B');
      dog.run(803, 'Lexi', now, now, 'In Foster');
      dog.run(804, 'Cody', now, now, 'Kennel C');
      db.close();
    }
    const b = await launch();
    const page = async (opts = {}) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': WALKER }, serviceWorkers: 'block', ...opts });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      return { ctx, p, errs };
    };
    const typeNote = async (p, sel, text) => { await p.click(sel); await p.keyboard.type(text); };

    // 1. End, then reload: the end screen again (with the note typed so far),
    //    and the dog is already free for everyone else.
    let { ctx, p, errs } = await page();
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.walk-edit-btn[data-id="801"]'); await p.waitForSelector('#startWalkBtn');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn');
    const walk1 = (await api('GET', `/api/walks/active?userId=${me.walker.id}`, WALKER)).json.walk.id;
    run('UPDATE walks SET started_at = ? WHERE id = ?', new Date(Date.now() - 20 * 60000).toISOString(), walk1);
    const tapAt = Date.now();
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    await p.waitForFunction(async (id) => (await (await fetch(`/api/walks/active?userId=${id}`)).json()).wrapUp != null, me.walker.id);
    const ended = row(walk1);
    ok(ended.ended_at && Math.abs(new Date(ended.ended_at) - tapAt) < 3000, `End ended the walk on the server at the tap (${ended.ended_at})`);
    const seen = (await api('GET', '/api/dogs/801', OTHER)).json.dog;
    ok(seen.currentWalk === null, 'another volunteer sees Axel as free right away');
    await typeNote(p, '#walkNotes', 'Pulled toward the field');
    await p.screenshot({ path: h.shot('01-end-tapped-finish-screen.png') });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForSelector('#saveWalkBtn');
    ok(/Pulled toward the field/.test(await p.textContent('#walkNotes')), 'after a reload: the end screen again, with the note typed so far');
    await p.screenshot({ path: h.shot('01-after-reload-finish-screen.png') });

    // 2. Double-tapped Save & finish: saved once, no error.
    await p.dblclick('#saveWalkBtn');
    await p.waitForSelector('#doneBtn');
    await p.waitForTimeout(500);
    ok(!(await p.isVisible('#appDialogOk')), 'no "already ended" error after a double tap');
    const saved = row(walk1);
    ok(saved.notes === 'Pulled toward the field' && saved.wrap_up_pending === 0, 'the note is saved and the end screen won\'t come back');
    await p.screenshot({ path: h.shot('09-double-tap-save-ok.png') });
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    // 3. "Today is different" mid-walk: OK returns to the walk screen.
    const special = await api('PUT', `/api/staff/schedule/days/${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())}`, STAFF, { mode: 'note', note: 'Adoption event in the lobby' }, { 'x-auth-staff': '1' });
    ok(special.status === 200, 'staff set a note on today');
    const walk2 = (await api('POST', '/api/walks/start', WALKER, { dogId: 802, userId: me.walker.id, activity: 'daycation' })).json;
    ({ ctx, p, errs } = await page());
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#appDialogOk', { state: 'visible' });
    ok(await p.isVisible('#endWalkBtn') || (await p.locator('#endWalkBtn').count()) === 1, 'the notice opens over the walk screen');
    await p.screenshot({ path: h.shot('04-day-notice-over-daycation.png') });
    await p.click('#appDialogOk');
    await p.waitForTimeout(600);
    ok(await p.isVisible('#endWalkBtn'), 'after OK: still on the walk screen');
    ok(/End daycation/.test(await p.textContent('#endWalkBtn')), 'the same daycation');
    await p.screenshot({ path: h.shot('04-after-ok-walk-screen.png') });

    // 4. Switching activity can't carry the walk past 3 hours.
    await p.click('#activityChoice [data-activity="walk"]');
    await p.waitForFunction(() => /End walk/.test(document.getElementById('endWalkBtn').textContent));
    run('UPDATE walks SET extend_minutes = 135 WHERE id = ?', walk2.walkId);
    await p.click('#activityChoice [data-activity="matchmaking"]');
    await p.waitForFunction(() => /End matchmaking/.test(document.getElementById('endWalkBtn').textContent));
    const stops = (await api('GET', `/api/walks/active?userId=${me.walker.id}`, WALKER)).json.walk.stopsAt;
    ok(new Date(stops).getTime() <= new Date(walk2.startedAt).getTime() + 180 * 60000, `matchmaking after a 3-hour walk still stops by 3 hours (${stops})`);
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();
    run('DELETE FROM shelter_special_days');
    await api('DELETE', `/api/walks/${walk2.walkId}`, WALKER);

    // 5. Wrap-up of a walk the time limit stopped: a picked time before the
    //    start is refused inline (not "23h 55m"), a good one saves.
    const startMs = Date.now() - 60 * 60000;
    const stoppedMs = startMs + 45 * 60000;
    const ins = run('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, auto_stopped, wrap_up_pending) VALUES (804, ?, ?, ?, 2700, \'walk\', 1, 1)',
      me.walker.id, new Date(startMs).toISOString(), new Date(stoppedMs).toISOString());
    ({ ctx, p, errs } = await page());
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endTimeChoice');
    await p.click('#endTimeChoice [data-end="pick"]');
    await p.fill('#walkEndTime', shelterHHMM(startMs - 30 * 60000));
    await p.waitForTimeout(200);
    const err = await p.textContent('#walkEndSummary');
    ok(/before the start/.test(err) && !/23h/.test(err), `a time before the start says so inline: "${err}"`);
    ok(await p.isDisabled('#saveWalkBtn'), 'and Save & finish waits for a good time');
    await p.screenshot({ path: h.shot('12-pick-before-start.png') });
    await p.fill('#walkEndTime', shelterHHMM(startMs + 30 * 60000));
    await p.waitForTimeout(200);
    ok(/Walk time: 30 min/.test(await p.textContent('#walkEndSummary')), 'a good time shows the length');
    await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    ok(Math.abs(row(ins.lastInsertRowid).duration_seconds - 1800) < 60, 'saved as 30 minutes');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));

    // 6. Foster: not eligible, but a scanned card can still start, after a check.
    await p.click('#doneBtn');
    await p.click('#manualSearchInput');
    await p.waitForTimeout(800); // the search's dog list loads first
    await p.fill('#manualSearchInput', 'Lexi');
    await p.waitForSelector('.search-result');
    await p.click('.search-result .dog-meta');
    await p.waitForSelector('#startWalkBtn');
    await p.waitForTimeout(400);
    ok(/In foster care \(not at the shelter\)/.test(await p.textContent('#eligibilityBadge')), 'the badge says in foster care');
    ok(!(await p.isDisabled('#startWalkBtn')), 'Start is not blocked outright');
    await p.screenshot({ path: h.shot('02-foster-confirm-screen.png') });
    await p.click('#startWalkBtn');
    await p.waitForSelector('#appDialogOk', { state: 'visible' });
    ok(/Listed as in foster/.test(await p.textContent('#appDialog')), 'Start asks to check the kennel card');
    await p.screenshot({ path: h.shot('02-foster-check-the-card.png') });
    await p.click('#appDialogCancel');
    await p.waitForSelector('#manualSearchInput');
    ok(!(await api('GET', `/api/walks/active?userId=${me.walker.id}`, WALKER)).json.walk, 'Scan again: nothing started');
    await p.waitForTimeout(800);
    await p.fill('#manualSearchInput', 'Lexi');
    await p.waitForSelector('.search-result');
    await p.click('.search-result .dog-meta');
    await p.waitForSelector('#startWalkBtn'); await p.waitForTimeout(400);
    await p.click('#startWalkBtn');
    await p.waitForSelector('#appDialogOk', { state: 'visible' });
    await p.click('#appDialogOk');
    await p.waitForSelector('#endWalkBtn');
    ok(true, 'It matches, continue: the walk starts');
    const fosterWalk = (await api('GET', `/api/walks/active?userId=${me.walker.id}`, WALKER)).json.walk;
    await api('DELETE', `/api/walks/${fosterWalk.id}`, WALKER);
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    // 7. Offline: reopening the app keeps the walk; End is sent once back online.
    ({ ctx, p, errs } = await page({ serviceWorkers: 'allow' }));
    await api('POST', '/api/walks/start', WALKER, { dogId: 801, userId: me.walker.id, activity: 'walk' });
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn');
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('#endWalkBtn'); // controlled now
    await p.waitForTimeout(500);
    await ctx.setOffline(true);
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('#endWalkBtn', { timeout: 10000 });
    ok(/Axel/.test(await p.textContent('.walk-head-name')), 'offline reload: still on the walk with Axel');
    ok(await p.isVisible('.offline-walk-note'), 'with a note that this is the copy on this phone');
    await p.screenshot({ path: h.shot('03-offline-reload-keeps-walk.png') });
    const walk3 = (await api('GET', `/api/walks/active?userId=${me.walker.id}`, WALKER)).json.walk;
    run('UPDATE walks SET started_at = ? WHERE id = ?', new Date(Date.now() - 15 * 60000).toISOString(), walk3.id);
    const offlineTap = Date.now();
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    await p.waitForTimeout(500);
    ok(!row(walk3.id).ended_at, 'offline: the end is kept on the phone for now');
    await typeNote(p, '#walkNotes', 'Ended offline');
    await p.waitForTimeout(1500);
    await ctx.setOffline(false);
    await p.waitForFunction(async (id) => (await (await fetch(`/api/walks/active?userId=${id}`)).json()).wrapUp != null, me.walker.id, { timeout: 10000 });
    const e3 = row(walk3.id);
    ok(e3.ended_at && Math.abs(new Date(e3.ended_at) - offlineTap) < 3000, `back online: ended at the offline tap (${e3.ended_at})`);
    await p.waitForSelector('#saveWalkBtn');
    await p.waitForFunction(() => !document.getElementById('saveWalkBtn').disabled);
    await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    ok(row(walk3.id).notes === 'Ended offline', 'and the note typed offline is saved');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    // 8. A second tab: the walk ended in one tab; the other goes to its end
    //    screen when it comes back into view (or when +10 is refused).
    await api('POST', '/api/walks/start', WALKER, { dogId: 802, userId: me.walker.id, activity: 'walk' });
    ({ ctx, p, errs } = await page());
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn');
    const walk4 = (await api('GET', `/api/walks/active?userId=${me.walker.id}`, WALKER)).json.walk;
    run('UPDATE walks SET started_at = ? WHERE id = ?', new Date(Date.now() - 10 * 60000).toISOString(), walk4.id);
    await api('PUT', `/api/walks/${walk4.id}/end`, WALKER, { endTappedAt: new Date().toISOString(), finishLater: true });
    await p.click('#extendWalkBtn');
    await p.waitForSelector('#saveWalkBtn', { timeout: 5000 });
    ok(true, '+10 on a walk ended elsewhere: straight to its end screen, not an error');
    await typeNote(p, '#walkNotes', 'From the other tab');
    await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    ok(row(walk4.id).notes === 'From the other tab', 'the note is still saved');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    await b.close();
    console.log('audit-flow smoke OK');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
