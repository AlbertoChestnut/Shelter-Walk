// Audit 2, volunteer app (ui):
//  - Typing in the shared note and then tapping / clicking / tabbing to the
//    private note types into the PRIVATE note (the auto-tagger's blur used to
//    pull the cursor back into the shared box): the finish screen (with a
//    Playgroup note too) and the dog's notes popup (Tips, My private notes).
//  - Stats: averages leave out mis-scans under a minute and say so; the avg
//    chart draws only what it averaged; a history over 1000 isn't cut off;
//    Back from a drill-down stays on Stats; tiles work from the keyboard.
//  - A cat volunteer gets no Playgroup tab and cat wording on cards.
//  - A search the filters hide says so and offers Clear filters.
//  - Your own walk on your Available card: "You're out with them".
//  - Updates' "This week" label is the shelter's Sunday, on a phone in LA.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit2-ui.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
const EMAIL = 'ui2@example.com'; const CAT_EMAIL = 'ui2cat@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); const { base, dbFile: DB } = h;
  const get = (email, url) => fetch(base + url, { headers: { 'x-auth-email': email } }).then((r) => r.json());
  const post = (email, url, body) => fetch(base + url, { method: 'POST', headers: { 'x-auth-email': email, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const errs = [];
  try {
    const me = await get(EMAIL, '/api/me');
    const cat = await get(CAT_EMAIL, '/api/me');
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='Uma', experience_level='established', onboarding_completed=1 WHERE id=?").run(me.id);
    db.prepare("UPDATE users SET name='Cleo', experience_level='beginner', onboarding_completed=1, species_pref='cat' WHERE id=?").run(cat.id);
    const addDog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, species) VALUES (?, ?, 'Female', '1 Years', '2026-07-01T00:00:00', 1, ?, ?, ?, ?)");
    addDog.run(81, 'Pepper', ts, ts, 'C', 'dog');
    addDog.run(82, 'Maxwell', ts, ts, 'C', 'dog');
    addDog.run(83, 'Candy Corndog', ts, ts, 'C', 'dog');
    addDog.run(84, 'Percy', ts, ts, 'A', 'cat');
    // Today: a 20-minute walk, a 30-second mis-scan, a 10-minute matchmaking
    // (sections 1-2 add a Playgroup session and a walk, each seconds long).
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const addWalk = db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, 'C', ?, ?, ?, ?)");
    addWalk.run(81, me.id, ago(120), ago(100), 1200, 'walk');
    addWalk.run(82, me.id, ago(90), ago(89.5), 30, 'walk');
    addWalk.run(83, me.id, ago(80), ago(70), 600, 'matchmaking');
    // A long history: 1005 more 20-minute walks on earlier days (over one page).
    db.transaction(() => {
      for (let i = 0; i < 1005; i += 1) {
        const start = new Date(Date.now() - (3 + (i % 60)) * 86400000 - i * 60000);
        addWalk.run(81, me.id, start.toISOString(), new Date(start.getTime() + 1200000).toISOString(), 1200, 'walk');
      }
    })();
    addWalk.run(84, cat.id, ago(60), ago(50), 600, 'cuddle');
    db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('new_dog', 83, 'Candy Corndog is new', ?)").run(ago(30));
    db.close();

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const page = async (c = ctx) => { const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); return p; };

    // ---- 1. Shared vs private note, finish screen, by mouse (+ a Playgroup note) ----
    let started = await post(EMAIL, '/api/walks/start', { dogId: 82, userId: me.id, activity: 'playgroup', location: 'C' });
    ok(started.walkId || started.id, 'started a Playgroup session');
    let p = await page();
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn'); await p.click('#endWalkBtn');
    await p.waitForSelector('#walkPlaygroupNote .pg-text');
    await p.click('#walkPlaygroupNote .pg-text'); await p.keyboard.type('Played with Pepper');
    await p.click('#walkNotes'); await p.keyboard.type('Shared Pepper words');
    await p.click('#walkPrivateNote'); await p.keyboard.type('secret one');
    ok(await p.evaluate(() => document.activeElement.id === 'walkPrivateNote'), 'click: the private box keeps focus after leaving the shared box');
    await p.waitForTimeout(500); // past the auto-tagger's debounce
    await p.keyboard.type(' two');
    await p.screenshot({ path: h.shot('1-finish-boxes.png') });
    await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    await p.waitForTimeout(400);
    let d = new Database(DB, { readonly: true });
    let w = d.prepare('SELECT notes FROM walks WHERE dog_id = 82 AND activity = ? ORDER BY id DESC').get('playgroup');
    let priv = d.prepare("SELECT body FROM dog_notes WHERE dog_id = 82 AND visibility = 'private' AND user_id = ?").get(me.id);
    const pg = d.prepare('SELECT body FROM playgroup_notes WHERE dog_id = 82').get();
    d.close();
    ok(w && /Shared/.test(w.notes || '') && !/secret/.test(w.notes || ''), 'shared note has only the shared words: ' + (w && w.notes));
    ok(priv && priv.body === 'secret one two', 'private note has the private words: ' + (priv && priv.body));
    ok(pg && /Played with/.test(pg.body) && !/Shared|secret/.test(pg.body), 'Playgroup note kept its own words: ' + (pg && pg.body));
    await p.close();

    // ---- 2. Same, by Tab ----
    started = await post(EMAIL, '/api/walks/start', { dogId: 83, userId: me.id, activity: 'walk', location: 'C' });
    p = await page();
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('#endWalkBtn'); await p.click('#endWalkBtn');
    await p.waitForSelector('#walkNotes');
    await p.click('#walkNotes'); await p.keyboard.type('Tabbed Pepper share');
    // Tab until the private box has focus (the end-time chips may sit between).
    for (let i = 0; i < 6 && !(await p.evaluate(() => document.activeElement.id === 'walkPrivateNote')); i += 1) await p.keyboard.press('Tab');
    ok(await p.evaluate(() => document.activeElement.id === 'walkPrivateNote'), 'Tab: focus reaches the private box and stays there');
    await p.keyboard.type('tab secret');
    await p.waitForTimeout(500); await p.keyboard.type('!');
    await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn'); await p.waitForTimeout(400);
    d = new Database(DB, { readonly: true });
    w = d.prepare('SELECT notes FROM walks WHERE dog_id = 83 ORDER BY id DESC').get();
    priv = d.prepare("SELECT body FROM dog_notes WHERE dog_id = 83 AND visibility = 'private' AND user_id = ?").get(me.id);
    d.close();
    ok(w.notes === 'Tabbed Pepper share' && priv && priv.body === 'tab secret!', `Tab: shared "${w.notes}", private "${priv && priv.body}"`);
    await p.close();

    // ---- 3. Tips -> My private notes, by touch (the notes popup from Stats) ----
    const touch = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    p = await page(touch);
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.tap('.tab-btn[data-tab="stats"]'); await p.waitForSelector('.dog-notes-btn');
    await p.tap('.dog-card[data-dogid="81"] .dog-notes-btn');
    await p.waitForSelector('#markerInfoPopup .private-note-input');
    const tipBox = '#markerInfoPopup .tip-add-row:not(.private-note-add-row) .tip-input';
    await p.tap(tipBox); await p.keyboard.type('Tip about Maxwell here');
    await p.tap('#markerInfoPopup .private-note-input'); await p.keyboard.type('touch secret');
    await p.waitForTimeout(500); await p.keyboard.type('!');
    const tipText = await p.textContent(tipBox);
    ok(!/secret/.test(tipText), 'tap: nothing typed into the private box landed in the tip box: ' + tipText);
    await p.tap('#markerInfoPopup .private-note-add-btn'); await p.waitForSelector('.tip-item[data-private]');
    d = new Database(DB, { readonly: true });
    priv = d.prepare("SELECT body FROM dog_notes WHERE dog_id = 81 AND visibility = 'private' AND user_id = ?").get(me.id);
    const pub = d.prepare("SELECT COUNT(*) AS n FROM dog_notes WHERE visibility = 'public' AND body LIKE '%secret%'").get().n;
    d.close();
    ok(priv && priv.body === 'touch secret!' && pub === 0, 'tap: private note saved as typed, no shared tip has it');
    await p.screenshot({ path: h.shot('3-notes-popup-touch.png') });
    await touch.close();

    // ---- 4. Stats: mis-scans, labels, paging, Back, keyboard ----
    p = await page();
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]'); await p.waitForSelector('.stats-drilldown-tile[data-drill="avgChart"]');
    const avgTile = await p.textContent('.stats-drilldown-tile[data-drill="avgChart"]');
    ok(/20 min/.test(avgTile) && /Avg walk length/.test(avgTile), 'Today avg tile: walks only, mis-scan left out: ' + avgTile.trim());
    const bd = await p.textContent('.bd-card');
    ok(/Walk[\s\S]*avg 20 min, not counting 2 under a minute/.test(bd), 'Today breakdown Walk row agrees with the tile and says what it left out');
    ok(!/avg 0 min/.test(bd), 'no "avg 0 min" anywhere in the breakdown');
    // Keyboard: focus the tile, Enter opens the chart.
    await p.focus('.stats-drilldown-tile[data-drill="avgChart"]'); await p.keyboard.press('Enter');
    await p.waitForSelector('.bar-chart');
    ok(await p.locator('.bar-chart-bar').count() === 1, 'avg chart draws only the averaged walk (no mis-scan bar)');
    ok(/not counting 2 under a minute/.test(await p.textContent('#app')), 'and its caption says how many were left out');
    await p.goBack(); await p.waitForSelector('#statsRangeToggle');
    ok(await p.evaluate(() => document.querySelector('.tab-btn.active').dataset.tab === 'stats'), 'browser Back from a drill-down stays on Stats');
    await p.click('#statsRangeToggle'); await p.waitForSelector('[data-daykey]');
    // Lifetime: every walk counted, not just the first 1000.
    await p.click('.stats-drilldown-tile[data-drill="avgChart"]'); await p.waitForSelector('.bar-chart');
    const cap = await p.textContent('#app p.small.muted');
    ok(/^1006 walks/.test(cap.trim()), 'lifetime avg chart covers all 1006 walks (over one page): ' + cap.trim().slice(0, 60));
    const svgW = await p.$eval('.bar-chart svg', (s) => Number(s.getAttribute('width')));
    ok(svgW <= 1700, 'and stays a sane width: ' + svgW);
    await p.click('#backToStatsBtn'); await p.waitForSelector('[data-daykey]');
    // A visit day by keyboard, then Back.
    await p.focus('[data-daykey]'); await p.keyboard.press(' ');
    await p.waitForSelector('.shift-drilldown-tile');
    await p.goBack(); await p.waitForSelector('#statsRangeToggle');
    ok(await p.isVisible('[data-daykey]'), 'Space opens a visit day; Back returns to Lifetime');
    // Leaving Stats and coming back: the top, not a stale drill-down.
    await p.click('.stats-drilldown-tile[data-drill="byActivity"]'); await p.waitForSelector('#backToStatsBtn');
    await p.click('.tab-btn[data-tab="available"]'); await p.click('.tab-btn[data-tab="stats"]');
    await p.waitForSelector('#statsRangeToggle');
    ok(!(await p.$('#backToStatsBtn')), 'returning to Stats shows its top, not the old drill-down');
    await p.screenshot({ path: h.shot('4-stats.png') });

    // ---- 5. Own walk card + search hidden by filters ----
    await post(EMAIL, '/api/walks/start', { dogId: 81, userId: me.id, activity: 'walk', location: 'C' });
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="available"]');
    await p.waitForSelector('.avail-card[data-id="81"]');
    ok(/You're out with them/.test(await p.textContent('.avail-card[data-id="81"]')), 'own walk: "You\'re out with them"');
    await p.click('#toggleMoreFiltersBtn'); await p.click('[data-location-key="A"]');
    await p.fill('#availableSearchInput', 'Candy');
    await p.waitForSelector('.search-hidden-note');
    ok(/1 dog matches "Candy" but is hidden by your filters/.test(await p.textContent('.search-hidden-note')), 'search says a match is hidden by the filters');
    await p.screenshot({ path: h.shot('5-search-hidden.png') });
    await p.click('#searchClearFiltersBtn'); await p.waitForSelector('.avail-card[data-id="83"]');
    ok(true, 'Clear filters shows Candy Corndog, search kept');
    await p.close();

    // ---- 6. Cat volunteer ----
    const cctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': CAT_EMAIL }, serviceWorkers: 'block' });
    p = await page(cctx);
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]'); await p.waitForSelector('.dog-notes-btn');
    ok(!(await p.$('[data-scope="playgroup"]')), 'cat-only volunteer: no Playgroup tab');
    const card = await p.textContent('.dog-card[data-dogid="84"]');
    ok(/Cat notes/.test(card) && !/Dog notes/.test(card), 'cuddle card says "Cat notes"');
    ok(/Add a cuddle/.test(await p.textContent('#showAddWalkFormBtn')), 'add form says "Add a cuddle"');
    const tiles = await p.textContent('.stat-grid');
    ok(/Cat cuddled/.test(tiles) && !/1\s*Cats/.test(tiles), 'one cat reads "Cat cuddled", never "1 Cats"');
    await p.click('[data-scope="notes"]'); await p.waitForSelector('.notes-scope-btn');
    ok(!/Pepper|Maxwell/.test(await p.textContent('#app')), 'All cat notes lists no dogs');
    await p.screenshot({ path: h.shot('6-cat.png') });
    await cctx.close();

    // ---- 7. Updates "This week" from Los Angeles ----
    const la = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles', extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    p = await page(la);
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="updates"]'); await p.waitForSelector('[data-updates-range="week"]');
    await p.click('[data-updates-range="week"]'); await p.waitForSelector('.result-count');
    const wk = await p.textContent('.result-count');
    ok(/since Sun,/.test(wk), 'This week is since the shelter\'s Sunday, even in LA: ' + wk.trim());
    await la.close();

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('audit2-ui smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
