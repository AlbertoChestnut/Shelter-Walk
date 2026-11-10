// Round 4 fixes (2026-11-10), in the browser: another account signing in on
// a shared phone clears only the saved API answers (the app page stays, so
// the walk still opens offline); a walk deleted on another device takes this
// one back to normal (from the walk screen and from the finish screen); a
// new server build reloads an idle page and only shows a banner mid-walk;
// Sign out clears this person's walk copy, draft and saved answers; walker
// chat comes back by itself after its stream is refused.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit-round4.js     (SMOKE_SHOTS_DIR=... keeps the screenshots)
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB;
const A = 'a.r4@example.com', B = 'b.r4@example.com', STAFF = 'staff.r4@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
const as = (email, extra = {}) => ({ headers: { 'x-auth-email': email, 'content-type': 'application/json', ...extra } });
const api = async (method, url, email, body, extra) => {
  const res = await fetch(base + url, { method, ...as(email, extra), body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const run = (sql, ...args) => { const db = new Database(DB); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = {};
    for (const [k, e] of [['a', A], ['b', B]]) me[k] = (await api('GET', '/api/me', e)).json;
    me.staff = (await api('GET', '/api/me', STAFF, undefined, { 'x-auth-staff': '1' })).json;
    {
      const now = new Date().toISOString();
      const db = new Database(DB);
      db.prepare("UPDATE users SET experience_level='expert', onboarding_completed=1").run();
      const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, still_listed, first_seen_at, last_seen_at, date_in_shelter, kennel_location, location) VALUES (?, ?, 'Male', '3 Years', 'Boxer Mix', 1, ?, ?, '2026-08-01T00:00:00', 'B', 'Kennel B')");
      dog.run(801, 'Axel', now, now); dog.run(802, 'Bella', now, now); dog.run(803, 'Cody', now, now);
      db.close();
    }
    const b = await launch();
    const page = async (email, opts = {}) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': email }, serviceWorkers: 'block', ...opts });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      return { ctx, p, errs };
    };
    const startWalk = async (email, userId, dogId) => (await api('POST', '/api/walks/start', email, { dogId, userId, activity: 'walk' })).json.walkId;
    const cacheList = (p) => p.evaluate(async () => {
      const out = {};
      for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname);
      return out;
    });

    // 1. Shared phone: B signs in after A. Only the saved API answers go;
    //    the app page stays, so B's walk still opens with no connection.
    let { ctx, p, errs } = await page(A, { serviceWorkers: 'allow' });
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(500);
    const before = await cacheList(p);
    ok((before['shelter-walk-v10'] || []).includes('/'), 'the app page is in the offline cache');
    ok((before['shelter-walk-v10'] || []).some((u) => u.startsWith('/api/')), 'and some shared API answers');
    const walkB = await startWalk(B, me.b.id, 801);
    await ctx.setExtraHTTPHeaders({ 'x-auth-email': B });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn');
    await p.waitForTimeout(800);
    const after = await cacheList(p);
    const kept = after['shelter-walk-v10'] || [];
    ok(kept.includes('/') && kept.includes('/manifest.json'), `account switch keeps the app page and manifest (${kept.filter((u) => !u.startsWith('/api/')).join(', ')})`);
    ok(!(before['shelter-walk-v10'] || []).filter((u) => u.startsWith('/api/')).every((u) => kept.includes(u)), "A's saved API answers are gone");
    await ctx.setOffline(true);
    await p.reload({ waitUntil: 'load' });
    await p.waitForSelector('#endWalkBtn', { timeout: 8000 });
    ok(true, "offline reload on the shared phone still shows B's walk");
    await p.screenshot({ path: h.shot('01-offline-after-switch.png') });
    await ctx.setOffline(false);
    await ctx.close();
    await api('DELETE', `/api/walks/${walkB}`, B);

    // 2. Deleted on another device, while on the walk screen.
    let walkId = await startWalk(A, me.a.id, 802);
    ({ ctx, p, errs } = await page(A));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn');
    ok((await api('DELETE', `/api/walks/${walkId}`, A)).status === 200, 'walk cancelled on another device');
    await p.evaluate(() => window.dispatchEvent(new Event('focus')));
    await p.waitForFunction(() => /deleted on another device/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 5000 });
    await p.waitForTimeout(300);
    ok(!(await p.isVisible('#endWalkBtn')) && !(await p.isVisible('#saveWalkBtn')), 'back to the normal screen, not a finish screen');
    ok(await p.evaluate(() => !localStorage.getItem('dogwalk_current_walk')), "this phone's copy of the walk is gone");
    await p.screenshot({ path: h.shot('02-deleted-elsewhere.png') });

    // ... and while on the finish screen: Save gets a 404.
    await p.click('.walk-edit-btn[data-id="803"]'); await p.waitForSelector('#startWalkBtn');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn');
    walkId = (await api('GET', `/api/walks/active?userId=${me.a.id}`, A)).json.walk.id;
    run('UPDATE walks SET started_at = ? WHERE id = ?', new Date(Date.now() - 15 * 60000).toISOString(), walkId);
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    await p.waitForFunction(async (id) => (await (await fetch(`/api/walks/active?userId=${id}`)).json()).wrapUp != null, me.a.id);
    await p.click('#walkNotes'); await p.keyboard.type('Never saved');
    await api('DELETE', `/api/walks/${walkId}`, A);
    await p.waitForFunction(() => !document.getElementById('saveWalkBtn').disabled);
    await p.click('#saveWalkBtn');
    await p.waitForFunction(() => /deleted on another device/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 5000 });
    await p.waitForTimeout(300);
    ok(!(await p.isVisible('#saveWalkBtn')) && !(await p.isVisible('#appDialogOk')), 'Save on a deleted walk: a toast and back to normal, no error dialog');
    ok(await p.evaluate(() => !localStorage.getItem('dogwalk_end_draft')), 'its draft is gone too');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    // 3. A new server build: an idle page reloads itself (once).
    ({ ctx, p, errs } = await page(A));
    let fakeBuild = 'other-build';
    let swap = true;
    await ctx.route(/\/api\//, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: swap ? { ...res.headers(), 'x-app-build': fakeBuild } : res.headers() });
    });
    let loads = 0;
    p.on('load', () => { loads += 1; });
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#newBuildBanner', { timeout: 8000 });
    ok(loads === 2, `idle page reloaded once for the new build (${loads} loads), then no loop: banner instead`);
    ok(await p.evaluate(() => sessionStorage.getItem('dogwalk_build_reload')) === 'other-build', 'remembered which build it reloaded for');
    await ctx.close();

    // ... mid-walk: a banner, no reload.
    walkId = await startWalk(A, me.a.id, 801);
    ({ ctx, p, errs } = await page(A));
    swap = false;
    fakeBuild = 'newer-build';
    await ctx.route(/\/api\//, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: swap ? { ...res.headers(), 'x-app-build': fakeBuild } : res.headers() });
    });
    loads = 0;
    p.on('load', () => { loads += 1; });
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn');
    swap = true;
    await p.click('#extendWalkBtn');
    await p.waitForSelector('#newBuildBanner', { timeout: 5000 });
    ok(/reload when you finish/i.test(await p.textContent('#newBuildBanner')), 'mid-walk: "A new version is ready, reload when you finish"');
    await p.waitForTimeout(500);
    ok(loads === 1 && await p.isVisible('#endWalkBtn'), 'and the walk screen stays (no reload)');
    await p.screenshot({ path: h.shot('03-new-build-banner.png') });
    await ctx.close();
    await api('DELETE', `/api/walks/${walkId}`, A);

    // 4. Sign out clears this person's things from the phone.
    walkId = await startWalk(A, me.a.id, 802);
    ({ ctx, p, errs } = await page(A));
    await ctx.route(/login\.shelterwalk\.com/, (route) => route.abort());
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn');
    await p.evaluate(async () => {
      localStorage.setItem('dogwalk_end_draft', JSON.stringify({ walkId: 1, notes: { text: 'x' } }));
      sessionStorage.setItem('something', '1');
      const c = await caches.open('shelter-walk-v10');
      await c.put('/api/dogs', new Response('{}'));
      await c.put('/', new Response('<html></html>'));
    });
    ok(await p.evaluate(() => !!localStorage.getItem('dogwalk_current_walk') && !!localStorage.getItem('sw-last-user-id')), 'before: the walk copy and last user are on the phone');
    await p.evaluate(() => document.getElementById('signOutLink').click());
    await p.waitForURL((u) => !String(u).startsWith(base), { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(300);
    // Back on the app's origin to look (its /api blocked, so nothing new is written).
    await ctx.route(/\/api\//, (route) => route.abort());
    await p.goto(base, { waitUntil: 'load' });
    const left = await p.evaluate(async () => ({
      keys: ['dogwalk_current_walk', 'dogwalk_end_draft', 'sw-last-user-id'].filter((k) => localStorage.getItem(k) !== null),
      session: sessionStorage.length,
      cached: (await (await caches.open('shelter-walk-v10')).keys()).map((r) => new URL(r.url).pathname)
    }));
    ok(!left.keys.length, `sign out clears the walk copy, draft and last user (left: ${left.keys.join(', ') || 'none'})`);
    ok(left.session === 0, 'and sessionStorage');
    ok(!left.cached.includes('/api/dogs') && left.cached.includes('/'), 'saved API answers go, the app page stays');
    await ctx.close();
    await api('DELETE', `/api/walks/${walkId}`, A);

    // 5. Walker chat refused (429, too many tabs) comes back by itself.
    ok((await api('PUT', '/api/modules/walker-chat', STAFF, { enabled: true }, { 'x-auth-staff': '1' })).status === 200, 'walker chat on');
    const held = [];
    for (let i = 0; i < 6; i++) {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/modules/walker-chat/stream`, { headers: { 'x-auth-email': A }, signal: ac.signal });
      ok(res.status === 200, `stream ${i + 1} of 6 open elsewhere`);
      held.push(ac);
    }
    ({ ctx, p, errs } = await page(A));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForFunction(() => window.__wcStream && window.__wcStream.readyState === 2, null, { timeout: 8000 });
    ok(true, "the page's stream is refused (too many open)");
    held.shift().abort();
    await p.waitForFunction(() => window.__wcStream && window.__wcStream.readyState === 1, null, { timeout: 20000 });
    ok(true, 'a slot frees up: chat reconnects on its own');
    held.forEach((ac) => ac.abort());
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();

    await b.close();
    console.log('audit-round4 smoke OK');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
