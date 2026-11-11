// Audit 2 (backend + walk screen): Start never re-saves stickers a screen
// opened before staff changed them; a stale Save is refused and the dog
// refreshed; stickers a volunteer's level can't take off are greyed out.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit2-backend.js
const { startSmoke, launch } = require('./_harness');
const Database = require('better-sqlite3');

const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke();
  const { base, dbFile } = h;
  try {
    const BEG = 'a2s.beginner@example.com';
    const EST = 'a2s.established@example.com';
    const STAFF = 'a2s.staff@example.com';
    const me = async (email, staff) => (await fetch(base + '/api/me', { headers: { 'x-auth-email': email, ...(staff ? { 'x-auth-staff': '1' } : {}) } })).json();
    const beg = await me(BEG); const est = await me(EST); await me(STAFF, true);
    const db = new Database(dbFile);
    db.prepare("UPDATE users SET experience_level='beginner', onboarding_completed=1 WHERE id=?").run(beg.id);
    db.prepare("UPDATE users SET experience_level='established', onboarding_completed=1 WHERE id=?").run(est.id);
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, blue_markers) VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', 1, ?, ?, ?)");
    ins.run(601, 'Mj', now, now, '[]');
    ins.run(602, 'Locky', now, now, '["blue_r"]');
    ins.run(603, 'Button', now, now, '[]');
    db.close();
    const staffMarkers = (id, patch) => fetch(`${base}/api/dogs/${id}/markers`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-auth-email': STAFF, 'x-auth-staff': '1' }, body: JSON.stringify({ patch })
    });
    const markersOf = (id) => { const c = new Database(dbFile, { readonly: true }); try { return JSON.parse(c.prepare('SELECT blue_markers FROM dogs WHERE shelter_buddy_id = ?').get(id).blue_markers); } finally { c.close(); } };
    const eventsOf = (id) => { const c = new Database(dbFile, { readonly: true }); try { return c.prepare("SELECT kind, detail FROM shelter_events WHERE dog_id = ? AND kind LIKE 'sticker_%'").all(id); } finally { c.close(); } };

    const b = await launch();
    const page = async (email) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': email }, serviceWorkers: 'block' });
      const p = await ctx.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base, { waitUntil: 'networkidle' });
      return { p, ctx, errs };
    };

    // 1. A Beginner opens Mj; staff then add Reactive; the Beginner taps Start.
    {
      const { p, ctx, errs } = await page(BEG);
      await p.click('.walk-edit-btn[data-id="601"]');
      await p.waitForSelector('#startWalkBtn');
      await p.waitForTimeout(300);
      ok(!(await p.isDisabled('#startWalkBtn')), 'Mj is walkable when the screen opens');
      ok((await staffMarkers(601, { blueMarkers: { add: ['blue_r'] } })).status === 200, 'staff add Reactive meanwhile');
      await p.click('#startWalkBtn');
      await p.waitForTimeout(800);
      ok(!(await p.$('#endWalkBtn')), 'the walk did not start');
      ok(markersOf(601).includes('blue_r'), 'Reactive is still on Mj');
      ok(!eventsOf(601).some((e) => e.kind === 'sticker_off'), 'no sticker_off was logged');
      ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
      await ctx.close();
    }

    // 2. Locked stickers are greyed out, with a hint.
    {
      const { p, ctx, errs } = await page(BEG);
      await p.click('.walk-edit-btn[data-id="602"]');
      await p.waitForSelector('#startWalkBtn');
      ok(await p.isDisabled('.marker-shape[data-value="blue_r"]'), "a Beginner can't untick Reactive");
      ok(!(await p.isDisabled('.marker-shape[data-value="blue_c"]')), 'but can add another sticker');
      ok(await p.isVisible('.marker-lock-hint'), 'the hint says only staff or a privileged volunteer can');
      ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
      await ctx.close();
    }

    // 3. A stale Save: refused, the dog refreshed, with a clear message.
    {
      const { p, ctx, errs } = await page(EST);
      await p.click('.walk-edit-btn[data-id="603"]');
      await p.waitForSelector('#startWalkBtn');
      ok((await staffMarkers(603, { blueMarkers: { add: ['blue_c'] } })).status === 200, 'staff add Difficult to collar meanwhile');
      await p.click('.marker-shape[data-group="star"]');
      await p.waitForSelector('#saveAllBtn', { state: 'visible' });
      await p.click('#saveAllBtn');
      await p.waitForSelector('#appDialogOk', { state: 'visible' });
      ok(/changed this dog's stickers/.test(await p.textContent('#appDialog')), 'Save says someone changed the stickers');
      await p.click('#appDialogOk');
      ok(await p.isVisible('.marker-shape.active[data-value="blue_c"]'), 'the screen now shows the new sticker');
      ok(!(await p.isVisible('.marker-shape.active[data-group="star"]')), 'the stale tap was dropped');
      ok(markersOf(603).includes('blue_c'), 'the new sticker is still saved');
      // Saving again from the fresh screen works, and sends only the change.
      await p.click('.marker-shape[data-group="star"]');
      await p.click('#saveAllBtn');
      await p.waitForTimeout(600);
      const c = new Database(dbFile, { readonly: true });
      const row = c.prepare('SELECT star_flag, blue_markers FROM dogs WHERE shelter_buddy_id = 603').get();
      c.close();
      ok(row.star_flag === 1 && JSON.parse(row.blue_markers).includes('blue_c'), 'the star saved, the staff sticker kept');
      ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
      await ctx.close();
    }

    // 4. Sign-out with an End tapped offline: blocked until it can be sent,
    //    then sent first (the walk doesn't stay open for the next person).
    {
      const start = await fetch(`${base}/api/walks/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-email': EST }, body: JSON.stringify({ dogId: 603, userId: est.id }) });
      const walkId = (await start.json()).walkId;
      ok(!!walkId, 'a walk is running');
      const { p, ctx, errs } = await page(EST);
      await p.route('https://login.shelterwalk.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>signed out</p>' }));
      await p.waitForSelector('#endWalkBtn');
      await ctx.setOffline(true);
      await p.click('#endWalkBtn');
      await p.waitForSelector('#saveWalkBtn');
      await p.waitForTimeout(400);
      const endedAt = () => { const c = new Database(dbFile, { readonly: true }); try { return c.prepare('SELECT ended_at FROM walks WHERE id = ?').get(walkId).ended_at; } finally { c.close(); } };
      ok(!endedAt(), 'offline: the End is only on the phone');
      await p.evaluate(() => document.getElementById('signOutLink').click());
      await p.waitForSelector('#appDialogOk', { state: 'visible' });
      ok(/hasn't reached the server yet/.test(await p.textContent('#appDialog')), 'sign-out says the End has to be sent first');
      await p.click('#appDialogOk');
      ok(p.url().startsWith(base), 'still signed in, on the app');
      ok(!endedAt(), 'and the walk is still open on the server');
      await ctx.setOffline(false);
      await p.evaluate(() => document.getElementById('signOutLink').click());
      await p.waitForURL(/login\.shelterwalk\.com/, { timeout: 10000 });
      ok(!!endedAt(), 'back online, signing out sent the End first');
      ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
      await ctx.close();
    }

    await b.close();
    console.log('audit2-backend smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
