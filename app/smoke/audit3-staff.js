// Audit 3 (2026-11-10), staff dashboard & Playgroup desk in a real browser:
//   - The live board's zoom grows back when the board gets shorter again
//     (it's measured from #app, not the document, whose body is 100vh tall).
//   - Laptops (1280x720, 1440x900) keep normal-size text; 1600+ still fits.
//   - A remembered TV mode is ignored on a phone (its button is hidden there).
//   - Reports: "Each animal served" shows ID and species; a Cats report has
//     no avg walk tile, no shelter context and marks a picked dog's chip.
//   - The Playgroup desk's header photo keeps its size at 390.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit3-staff.js        (SMOKE_SHOTS_DIR=... keeps screenshots)
const { startSmoke, launch } = require('./_harness');
const Database = require('better-sqlite3');

const STAFF = 'a3s.staff@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  const h = await startSmoke();
  const { base, dbFile } = h;
  let b;
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } })).json();
    // One walk out at a time per volunteer: 30 walkers for 30 walks out.
    const walkers = [];
    for (let i = 0; i < 30; i += 1) walkers.push((await (await fetch(base + '/api/me', { headers: { 'x-auth-email': `a3s.w${i}@example.com` } })).json()).id);
    const db = new Database(dbFile);
    db.prepare("UPDATE users SET name='Walker' || id, experience_level='expert', onboarding_completed=1").run();
    const now = new Date().toISOString();
    const insDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, kennel_location, still_listed, first_seen_at, last_seen_at, species, photo_url)
      VALUES (?, ?, 'Male', '3 Years', '2026-07-01T00:00:00', ?, 1, ?, ?, ?, '/icons/icon-192.png')`);
    insDog.run(501, 'Onyx', 'A', now, now, 'dog');
    insDog.run(502, 'Onyx', 'B', now, now, 'dog');
    insDog.run(504, 'Simba', 'C', now, now, 'cat');
    insDog.run(505, 'Bartholomew Montgomery Fluffington', 'D', now, now, 'dog');
    for (let i = 0; i < 30; i += 1) insDog.run(700 + i, `Pup${i}`, 'ABCDE'[i % 5], now, now, 'dog');
    const t = Date.now();
    const fin = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, location) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const add = (dogId, minsAgo, secs, activity = 'walk') => fin.run(dogId, me.id, new Date(t - minsAgo * 60000).toISOString(), new Date(t - minsAgo * 60000 + secs * 1000).toISOString(), secs, activity, 'A');
    add(501, 200, 1200); add(501, 180, 1200); add(502, 170, 900); add(504, 160, 600, 'cuddle'); add(504, 150, 600, 'cuddle'); add(504, 140, 600, 'cuddle');
    // 30 walks out right now: a tall live board.
    const out = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, activity, location) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 30; i += 1) out.run(700 + i, walkers[i], new Date(t - (5 + i) * 60000).toISOString(), 'walk', 'ABCDE'[i % 5]);
    db.close();

    b = await launch();
    const errs = [];
    const open = async (width, height, { tv = false } = {}) => {
      const ctx = await b.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'x-auth-email': STAFF, 'x-auth-staff': '1' }, serviceWorkers: 'block' });
      if (tv) await ctx.addInitScript(() => { try { localStorage.setItem('staffTvMode', '1'); } catch (e) { /* */ } });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base + '/staff', { waitUntil: 'networkidle' });
      await p.waitForSelector('#sparklineBars svg');
      await p.waitForTimeout(300);
      return p;
    };
    const zoomOf = (p) => p.evaluate(() => Number(document.documentElement.style.zoom || 1));

    // ---- Laptops: normal-size text ----
    for (const [w, hgt] of [[1280, 720], [1440, 900]]) {
      const p = await open(w, hgt);
      ok(await zoomOf(p) === 1, `laptop ${w}x${hgt}: no zoom (was ${w === 1280 ? '0.6' : '0.73'})`);
      if (w === 1280) await p.screenshot({ path: h.shot('live-1280x720-normal-size.png') });
      await p.close();
    }

    // ---- Phone with a remembered TV mode ----
    const phone = await open(390, 844, { tv: true });
    ok(await phone.evaluate(() => localStorage.getItem('staffTvMode')) === '1', 'TV mode is remembered on this phone');
    ok(await zoomOf(phone) === 1, 'phone (390): a remembered TV mode is ignored (no zoom, no hidden button to undo it)');
    await phone.screenshot({ path: h.shot('tv-mode-remembered-phone-390.png') });
    await phone.close();

    // ---- TV mode still works at 1024 ----
    const lap = await open(1024, 768, { tv: true });
    ok(await zoomOf(lap) < 1, 'TV mode at 1024 still shrinks the board to fit');
    await lap.close();

    // ---- Big screen: shrinks for the busy board, grows back when walks end ----
    const big = await open(1920, 1000);
    const busyZoom = await zoomOf(big);
    ok(busyZoom < 1, `1920x1000 with 30 walks out fits the board (zoom ${busyZoom.toFixed(2)})`);
    await big.screenshot({ path: h.shot('live-1920-busy.png') });
    const db2 = new Database(dbFile);
    db2.prepare("UPDATE walks SET ended_at = ?, duration_seconds = 600 WHERE ended_at IS NULL AND dog_id >= 705").run(new Date().toISOString());
    db2.close();
    await big.waitForFunction((z) => Number(document.documentElement.style.zoom || 1) > z + 0.05, busyZoom, { timeout: 15000 });
    const quietZoom = await zoomOf(big);
    ok(quietZoom > busyZoom, `the zoom grows back once 25 walks end (${busyZoom.toFixed(2)} -> ${quietZoom.toFixed(2)})`);
    await big.waitForTimeout(300);
    const fit = await big.evaluate(() => { const a = document.getElementById('app'); return { shown: Math.round((a.offsetTop + a.offsetHeight) * Number(document.documentElement.style.zoom || 1)), screen: window.innerHeight }; });
    ok(fit.shown <= fit.screen + 2, `the board still fits the screen (${fit.shown} of ${fit.screen}px)`);
    await big.screenshot({ path: h.shot('live-1920-quiet-grown-back.png') });
    await big.close();

    // ---- Reports ----
    const rep = await open(1280, 900);
    await rep.click('.tab-btn[data-section="reports"]');
    await rep.check('#sectionsGrid input[value="uniqueDogsServed"]');
    await rep.check('#sectionsGrid input[value="highlights"]');
    await rep.check('#sectionsGrid input[value="shelterContext"]');
    await rep.selectOption('#reportSpecies', 'all');
    await rep.waitForFunction(() => [...document.querySelectorAll('#reportOutput caption')].some((c) => /animals served/.test(c.textContent)));
    const heads = await rep.$$eval('#reportOutput table', (ts) => {
      const t = ts.find((x) => /served/.test(x.caption.textContent));
      return { cols: [...t.querySelectorAll('th')].map((th) => th.textContent), rows: [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)) };
    });
    ok(heads.cols.join('|') === 'Animal|ID|Species|Engagements|Hours', `Each animal served columns: ${heads.cols.join(', ')}`);
    ok(heads.rows.some((r) => r[0] === 'Onyx' && r[1] === '501') && heads.rows.some((r) => r[0] === 'Onyx' && r[1] === '502'), 'the two Onyxes are told apart by ID');
    ok(heads.rows.some((r) => r[0] === 'Simba' && r[2] === 'Cat'), 'the cat says Cat');
    await rep.locator('#reportOutput table', { hasText: 'served' }).scrollIntoViewIfNeeded();
    await rep.screenshot({ path: h.shot('report-each-animal-id-species.png') });

    // Pick a dog and a cat, then switch to Cats.
    await rep.fill('#dogPickerInput', 'ID 501');
    await rep.click('#addDogBtn');
    await rep.fill('#dogPickerInput', 'ID 504');
    await rep.click('#addDogBtn');
    await rep.waitForSelector('.dog-detail-card');
    await rep.selectOption('#reportSpecies', 'cat');
    await rep.waitForFunction(() => /Unique cats/.test(document.getElementById('reportOutput').textContent));
    const catView = await rep.evaluate(() => ({
      text: document.getElementById('reportOutput').textContent,
      cards: [...document.querySelectorAll('.dog-detail-card h4')].map((e) => e.textContent),
      off: [...document.querySelectorAll('.dog-chip-off')].map((e) => e.textContent)
    }));
    ok(!/Avg walk length/.test(catView.text), 'Cats report: no avg walk length tile');
    ok(!/Shelter context/.test(catView.text), 'Cats report: no "Shelter context (dogs only)"');
    ok(catView.cards.length === 1 && /Simba/.test(catView.cards[0]), `Cats report: only the picked cat's detail (${catView.cards.join('; ')})`);
    ok(catView.off.length === 1 && /Onyx/.test(catView.off[0]) && /not in a Cats report/.test(catView.off[0]), 'the picked dog\'s chip says it is not in a Cats report');
    await rep.screenshot({ path: h.shot('report-cats-no-dog-items.png'), fullPage: true });
    await rep.close();

    // ---- Playgroup desk at 390: the header photo keeps its size ----
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': STAFF, 'x-auth-staff': '1' }, serviceWorkers: 'block' });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(base + '/playgroup', { waitUntil: 'networkidle' });
    await pg.waitForSelector('#dogList .dog-row');
    await pg.click('#dogList .dog-row:has-text("Bartholomew")');
    await pg.waitForSelector('#dogPane .dog-head img');
    const box = await pg.$eval('#dogPane .dog-head img', (img) => { const r = img.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    ok(Math.abs(box.w - box.h) < 1 && box.w >= 55, `desk header photo stays square at 390 (${box.w}x${box.h})`);
    await pg.screenshot({ path: h.shot('pg-desk-390-photo.png') });
    await ctx.close();

    ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs.join(' | ') : ''}`);
    console.log('audit3-staff smoke: all passed');
  } finally {
    if (b) await b.close();
    await h.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
