// Cats: the Dogs / Cats switch (and the title following it), cat-only filters, a cat's walk screen (no stickers, only
// cuddle or matchmaking, no level badge), Settings' "I volunteer with", and
// the onboarding step that asks it.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/cats.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3995, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_cats.db', EMAIL = 'both@example.com', NEW = 'newcat@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='Both', experience_level='beginner', onboarding_completed=1, species_pref='both' WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, poo_status, blue_markers)
      VALUES (?, ?, ?, 'Female', '3 Years', ?, ?, 1, ?, ?, 'B', ?, ?)`);
    ins.run(5001, 'Biscuit', 'dog', 'Lab', old, now, now, 'poo', '["blue_c"]');
    ins.run(5002, 'Rocket', 'dog', 'Hound', old, now, now, 'none', '[]');
    ins.run(6001, 'Mittens', 'cat', 'Domestic Short Hair', old, now, now, 'poo', '[]'); // a stray sticker value never shows on a cat
    ins.run(6002, 'Socks', 'cat', 'Domestic Long Hair', old, now, now, 'none', '[]');
    db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, age, tags, date_in_shelter, still_listed, first_seen_at, last_seen_at)
      VALUES (6003, 'Pip', 'cat', '9 Weeks', '["Cat","Kitten","Shelter"]', ?, 1, ?, ?)`).run(old, now, now);
    db.close();

    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('.avail-card');
    const names = async () => (await p.$$eval('.avail-card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]))).sort().join(',');
    ok(await p.isVisible('.species-switch'), 'someone with both sees the Dogs / Cats switch');
    ok(!(await p.$('.species-switch [data-species-view="all"]')), 'no All on the Available tab');
    ok(await names() === 'Biscuit,Rocket', 'dogs until they pick cats');
    ok(await p.textContent('#topbarTitle') === 'Dogs to Walk', 'title: Dogs to Walk');
    await p.click('[data-species-view="cat"]');
    ok(await p.textContent('#topbarTitle') === 'Cats to Play With', 'the title follows the switch');
    ok(/Kitten/.test(await p.textContent('.avail-card[data-id="6003"]')), 'kittens are marked');
    ok((await p.textContent('.avail-card[data-id="6001"]')).includes('🐈'), 'cats are tagged 🐈');
    ok(!(await p.$('.avail-card[data-id="6001"] .badge.eligible, .avail-card[data-id="6001"] .badge.not-eligible')), 'no level badge on a cat');
    ok(!(await p.$('.avail-card[data-id="6001"] .marker-dot')), 'no stickers on a cat');
    ok(/▶ Start \/ Edit/.test(await p.textContent('.avail-card[data-id="6001"] .walk-edit-btn')), 'a cat card says Start / Edit');
    ok(await p.getAttribute('.avail-card[data-id="6001"] .walk-history-btn', 'title') === 'Play session history', 'cat history button');
    await p.reload({ waitUntil: 'networkidle' }); await p.waitForSelector('.avail-card');
    ok(await names() === 'Mittens,Pip,Socks' && await p.textContent('#topbarTitle') === 'Cats to Play With', 'the choice and title survive a reload');
    await p.screenshot({ path: '/tmp/_cats1.png' });

    // POO "only" while on Dogs, then Cats: the hidden sticker filter must not empty the cat list.
    await p.click('[data-species-view="dog"]');
    ok(await names() === 'Biscuit,Rocket', 'Dogs shows only dogs');
    await p.click('#toggleMoreFiltersBtn');
    await p.click('[data-filter-key="poo"]');
    ok(await names() === 'Biscuit', 'POO filter on dogs');
    await p.click('[data-species-view="cat"]');
    ok(await names() === 'Mittens,Pip,Socks', 'Cats shows every cat despite the POO filter set on Dogs');
    ok(!(await p.$('[data-filter-key="poo"]')) && !(await p.$('[data-filter-key="walkable"]')), 'sticker and level filters are hidden for cats');
    ok(/Showing 3 of 3 cats/.test(await p.textContent('.result-count')), 'the count says cats');
    ok(!(await p.$('[data-filter-key="size_small"]')) && !(await p.$('[data-filter-key="tag:Dog Selective"]')) && !(await p.$('[data-filter-key="tag:Heartworm Positive"]')), 'no dog sizes or dog-only tags for cats');
    ok(!!(await p.$('[data-filter-key="tag:Best in Home without Cats"]')), 'shared home tags stay');
    const catFilters = await p.textContent('#app');
    ok(/Cats I've played with before/.test(catFilters) && /a play session logged/.test(catFilters) && !/visit/i.test(catFilters.replace(/shelter visit/gi, '')), 'cat filters say play, never visit');
    ok(/Room:/.test(await p.textContent('#app')) && !/Kennel wing/.test(await p.textContent('#app')), 'cats filter by Room');
    await p.click('[data-filter-key="young"]');
    ok(await names() === 'Pip', 'Kittens chip');
    await p.click('[data-filter-key="young"]');
    ok(await names() === 'Mittens,Socks', 'tapped again: adults only');
    await p.screenshot({ path: '/tmp/_cats2b.png', fullPage: true });
    await p.click('[data-filter-key="young"]');
    ok(!!(await p.$('[data-filter-key="pendingAdoption"]')), 'cats get a Being adopted chip');
    await p.click('[data-filters-tab="presets"]'); await p.waitForSelector('.preset-apply-btn');
    const presets = await p.textContent('#app');
    ok(/Kittens/.test(presets) && /Long-stay Cats/.test(presets) && !/POO Dogs|Beginner|Playgroup/.test(presets), 'cat presets only: ' + presets.replace(/\s+/g, ' ').slice(0, 600));
    await p.click('[data-filters-tab="filters"]');
    const wings = await p.$$eval('[data-location-key]', (els) => els.map((e) => e.dataset.locationKey).join(''));
    ok(wings === 'ABCD', 'cat rooms filter: A-D (' + wings + ')');
    await p.screenshot({ path: '/tmp/_cats2.png' });

    // A cat's screen: no stickers, cuddle first, only cuddle / matchmaking.
    await p.click('.avail-card[data-id="6002"] .walk-edit-btn');
    await p.waitForSelector('#startWalkBtn');
    ok(!(await p.$('.walk-confirm .marker-shape')), 'no sticker editor for a cat');
    ok(/Start Cuddle/.test(await p.textContent('#startWalkBtn')), 'a walker scanning a cat is offered a cuddle');
    await p.click('#changeActivityBtn');
    const acts = await p.$$eval('#activityPickRow [data-activity]', (els) => els.map((e) => e.dataset.activity).join(','));
    ok(acts === 'cuddle,matchmaking', 'only cuddle and matchmaking: ' + acts);
    ok(!(await p.$('.walk-confirm .badge.eligible, .walk-confirm .badge.caution')), 'no eligibility badge');
    const letters = await p.$$eval('#locationPicker [data-letter]', (els) => els.map((e) => e.dataset.letter).join(''));
    ok(letters === 'ABCD', 'a cat\'s kennel picker is A-D (' + letters + ')');
    await p.screenshot({ path: '/tmp/_cats3.png' });
    await p.click('#activityPickRow [data-activity="matchmaking"]');
    await p.click('#startWalkBtn');
    await p.waitForSelector('#endWalkBtn');
    const during = await p.$$eval('#activityChoice [data-activity]', (els) => els.map((e) => e.dataset.activity).join(','));
    ok(during === 'cuddle,matchmaking', 'mid-visit choices are the cat ones too');
    ok(/5 to 10 minutes is usually best/.test(await p.textContent('#visitHint')), 'cat visit length hint');
    // Pretend it started 11 minutes ago: the hint turns into a wrap-up nudge.
    const db4 = new Database(DB); db4.prepare("UPDATE walks SET started_at = ? WHERE dog_id = 6002 AND ended_at IS NULL").run(new Date(Date.now() - 11 * 60000).toISOString()); db4.close();
    await p.reload({ waitUntil: 'networkidle' }); await p.click('.tab-btn[data-tab="walk"]').catch(() => {}); await p.waitForSelector('#visitHint'); await p.waitForTimeout(1200);
    await p.screenshot({ path: '/tmp/_cats4b.png' });
    ok(/good time to say goodbye/.test(await p.textContent('#visitHint')) && await p.$('#timerDisplay.visit-long'), 'past 10 minutes: amber timer and nudge');
    await p.screenshot({ path: '/tmp/_cats4.png' });
    ok(await p.textContent('.tab-btn[data-tab="walk"] .tab-label') === 'Play', 'the tab says Play while out with a cat');
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn');
    ok((await p.$$('.wrap-up-checks input')).length === 3 && /latched/.test(await p.textContent('.wrap-up-checks')), 'end screen: latch / locks / hands checklist');
    ok(/purrs/.test(await p.getAttribute('#walkNotes', 'placeholder')), 'a cat note example, not a leash one');
    await p.screenshot({ path: '/tmp/_cats9.png' });
    await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    const db2 = new Database(DB);
    ok(db2.prepare('SELECT activity FROM walks WHERE dog_id = 6002').get().activity === 'matchmaking', 'saved as matchmaking');
    ok(db2.prepare('SELECT poo_status FROM dogs WHERE shelter_buddy_id = 6002').get().poo_status === 'none', 'nothing written to the cat\'s sticker columns');
    db2.close();
    await p.click('#doneBtn');

    // A both-species volunteer's own stats say "engage"; a cat profile says play.
    await p.click('.tab-btn[data-tab="stats"]'); await p.waitForTimeout(800);
    const statsText = await p.textContent('#app');
    ok(/Animals engaged with/.test(statsText) && /Total time engaging/.test(statsText) && !/Dogs walked/.test(statsText), 'Both: stats say engaged with');
    await p.click('.tab-btn[data-tab="available"]'); await p.waitForSelector('.avail-card[data-id="6002"]');
    await p.click('.avail-card[data-id="6002"] .view-profile-btn'); await p.waitForSelector('#profileEditBtn');
    const prof = await p.textContent('#profileSheet');
    ok(/▶ Start \/ Edit/.test(await p.textContent('#profileEditBtn')) && /Our play sessions together/.test(prof) && /Play session history/.test(prof) && /1× play session together/.test(prof), 'cat profile: Start / Edit, play sessions');
    ok(!/Behavior markers are set/.test(prof), 'no sticker hint on a cat profile');
    await p.click('#profileSheet .walk-history-btn'); await p.waitForTimeout(600);
    ok(/Socks's play sessions/.test(await p.textContent('#markerInfoPopupContent')), 'cat history popup says play sessions');
    await p.keyboard.press('Escape'); await p.goBack().catch(() => {}); await p.waitForTimeout(300);
    await p.reload({ waitUntil: 'networkidle' });

    // Pip the kitten after Socks (adult): warned on the card, the screen and before starting.
    await p.click('.tab-btn[data-tab="available"]'); await p.waitForSelector('.avail-card[data-id="6003"]');
    ok(/After an adult cat/.test(await p.textContent('.avail-card[data-id="6003"]')), 'the kitten card warns after an adult cat');
    await p.click('.avail-card[data-id="6003"] .walk-edit-btn'); await p.waitForSelector('.handling-warning');
    ok(/Socks/.test(await p.textContent('.handling-warning')), 'the kitten screen names the adult cat');
    await p.screenshot({ path: '/tmp/_cats7.png' });
    await p.click('#startWalkBtn'); await p.waitForTimeout(400);
    ok(/Going from an adult cat to a kitten/.test(await p.textContent('body')), 'starting asks first');
    await p.screenshot({ path: '/tmp/_cats8.png' });
    await p.locator('button:visible', { hasText: /^Cancel$/ }).first().click(); await p.waitForTimeout(300);
    ok(!(await p.$('#endWalkBtn')), 'cancel means no visit started');
    await p.click('#backToScanBtn2').catch(() => {});

    // Settings: cats only -> no switch, only cats, cat activities as usual choices.
    // The scan screens have no green bar (so no ⚙): open Settings from Available.
    await p.click('[data-tab="available"]'); await p.waitForTimeout(300);
    await p.click('#settingsBtn'); await p.waitForSelector('#speciesPrefPicker [data-species-pref]');
    ok(await p.isVisible('#speciesPrefPicker [data-species-pref="both"].active'), 'Settings shows Both');
    ok(await p.isVisible('#levelBothNote') && /\(dogs\)/.test(await p.textContent('#levelSection')), 'Both: levels are marked as dogs only');
    await p.click('#speciesPrefPicker [data-species-pref="cat"]');
    ok(!(await p.isVisible('#levelSection')), 'Cats only: no experience level');
    const usual = await p.$$eval('#defaultActivityPicker [data-activity]', (els) => els.map((e) => e.dataset.activity).join(','));
    ok(usual === 'cuddle,matchmaking', 'usual activity offers cat activities for cats only');
    await p.screenshot({ path: '/tmp/_cats5.png' });
    await p.waitForTimeout(800);
    await p.click('#closeSettingsBtn');
    await p.click('.tab-btn[data-tab="available"]'); await p.waitForSelector('.avail-card');
    ok(!(await p.$('.species-switch')), 'no switch for one species');
    ok(await names() === 'Mittens,Pip,Socks', 'cats only');
    ok(!(await p.textContent('.avail-card[data-id="6001"]')).includes('🐈'), 'no species tag when everything is a cat');
    await p.click('.tab-btn[data-tab="stats"]'); await p.waitForTimeout(800);
    ok(/Cats played with/.test(await p.textContent('#app')), 'Cats only: stats say played with');
    await p.click('#settingsBtn'); await p.waitForTimeout(300);
    ok(/a cat I've played with is adopted/.test(await p.textContent('#settingsSheet')) && /Alert me when a play session reaches/.test(await p.textContent('#settingsSheet')), 'Settings wording follows cats');
    await p.click('#closeSettingsBtn').catch(() => p.keyboard.press('Escape'));

    // Updates for cat people: the cat news only.
    const db3 = new Database(DB);
    const ev = db3.prepare('INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES (?, ?, ?, ?)');
    ev.run('new_dog', 5002, 'Rocket was added to the shelter\'s listing', now); ev.run('new_dog', 6001, 'Mittens was added to the shelter\'s listing', now);
    db3.close();
    await p.click('.tab-btn[data-tab="updates"]'); await p.waitForTimeout(800);
    const upd = await p.textContent('#app');
    ok(/Mittens/.test(upd) && !/Rocket/.test(upd), 'Updates shows cats only');

    // Onboarding: a new volunteer who picks Cats skips the level step.
    const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': NEW }, serviceWorkers: 'block' });
    const q = await ctx2.newPage(); q.on('pageerror', (e) => errs.push(e.message));
    await q.goto(base, { waitUntil: 'networkidle' });
    await q.waitForSelector('#onboardingNameNext');
    const inputs = await q.$$('#onboardingInner input[type="text"]');
    for (const [i, el] of inputs.entries()) await el.fill(i ? 'Cat' : 'Nina');
    await q.click('#onboardingNameNext');
    await q.waitForSelector('#onboardingSpeciesList');
    await q.screenshot({ path: '/tmp/_cats6.png' });
    await q.click('#onboardingSpeciesList [data-species-pref="cat"]');
    await q.click('#onboardingSpeciesNext');
    await q.waitForSelector('#onboardingActivityList');
    const oacts = await q.$$eval('#onboardingActivityList [data-activity]', (els) => els.map((e) => e.dataset.activity).join(','));
    ok(oacts === 'cuddle,matchmaking', 'cat-only onboarding goes straight to cat activities');
    ok(/with the cats/.test(await q.textContent('#onboardingInner h2')), 'asks about the cats');
    const nina = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': NEW } })).json();
    ok(nina.speciesPref === 'cat' && nina.experienceLevel === 'beginner', 'saved: cats, Beginner by default');

    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
