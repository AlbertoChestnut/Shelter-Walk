// Audit 3, volunteer app (ui), in the browser:
//  - The eligibility status row: a solid strip that fits the card, "Not
//    eligible" + why (red) for a block, an amber caution for a dog listed
//    in foster (no "Not eligible", no hazard stripes, Start still on), solid
//    cards over the stripes, readable in light and dark.
//  - A refused Start refreshes the dog (no stale "Eligible").
//  - One default activity per species (Settings and onboarding).
//  - The new-version and offline banners; cat wording; Back-button steps
//    (visit day, Guide section, Delete my data's Cancel, Edit an earlier
//    activity mid-walk); locked stickers carry a 🔒; layout at 320 and on a
//    computer; 44px tap targets; Today with no walks; Together's averages;
//    an overnight daycation edited in Stats; the phone Playgroup editor;
//    the Guide's unsaved-edit guard; timers on the server's clock.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/audit3-ui.js
const { startSmoke, launch } = require('./_harness');
const Database = require('better-sqlite3');

const BEG = 'ui3beg@example.com';      // Beginner, dogs
const BOTH = 'ui3both@example.com';    // Established, dogs and cats
const CAT = 'ui3cat@example.com';      // cats only
const STAFF = 'ui3staff@example.com';  // edits the Guide
const NEWBOTH = 'ui3newboth@example.com';
const NEWCAT = 'ui3newcat@example.com';
const FRESH = 'ui3fresh@example.com';  // no walks at all
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

// The shelter's date and a wall-clock time on it, as an ISO string.
const shelterKey = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
function shelterIso(key, hh, mm) {
  // Guess UTC, correct by the zone's offset at that moment (DST-safe).
  let t = Date.UTC(...key.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)), hh, mm);
  for (let i = 0; i < 2; i += 1) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    t += Date.UTC(...key.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0)), hh, mm) - Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute);
  }
  return new Date(t).toISOString();
}

(async () => {
  const h = await startSmoke(); const { base, dbFile: DB } = h;
  const api = (email, url, { method = 'GET', body, staff = false } = {}) => fetch(base + url, {
    method, headers: { 'x-auth-email': email, 'content-type': 'application/json', ...(staff ? { 'x-auth-staff': '1' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const errs = [];
  const b = await launch();
  try {
    const ids = {};
    for (const e of [BEG, BOTH, CAT, STAFF, FRESH]) ids[e] = (await api(e, '/api/me')).json.id;
    const db = new Database(DB); const ts = new Date().toISOString();
    const today = shelterKey(Date.now());
    const dayAgo = (n) => shelterKey(Date.now() - n * 86400000);
    db.prepare("UPDATE users SET name='Bea', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(ids[BEG]);
    db.prepare("UPDATE users SET name='Bo', experience_level='established', onboarding_completed=1, species_pref='both' WHERE id=?").run(ids[BOTH]);
    db.prepare("UPDATE users SET name='Cleo', experience_level='beginner', onboarding_completed=1, species_pref='cat' WHERE id=?").run(ids[CAT]);
    db.prepare("UPDATE users SET name='Stef', experience_level='expert', onboarding_completed=1 WHERE id=?").run(ids[STAFF]);
    db.prepare("UPDATE users SET name='Fran', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(ids[FRESH]);
    const addDog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, species, location, blue_markers)
      VALUES (?, ?, 'Female', '3 Years', 'Terrier', ?, 1, ?, ?, 'C', ?, ?, ?)`);
    addDog.run(3101, 'Rex', '2026-06-01T00:00:00', ts, ts, 'dog', 'Shelter', '[]');
    addDog.run(3102, 'Fido', '2026-06-01T00:00:00', ts, ts, 'dog', 'In Foster', '[]');
    addDog.run(3103, 'Newbie', `${today}T00:00:00`, ts, ts, 'dog', 'Shelter', '[]');
    addDog.run(3104, 'Lockey', '2026-06-01T00:00:00', ts, ts, 'dog', 'Shelter', '["blue_c"]');
    addDog.run(3105, 'Stella', '2026-06-01T00:00:00', ts, ts, 'dog', 'Shelter', '[]');
    addDog.run(3201, 'Percy', '2026-06-01T00:00:00', ts, ts, 'cat', 'Cat Room', '[]');
    const addWalk = db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, activity) VALUES (?, ?, 'C', ?, ?, ?, ?)");
    const walkOn = (dog, user, key, hh, mm, secs, activity = 'walk') => {
      const s = shelterIso(key, hh, mm);
      addWalk.run(dog, user, s, new Date(new Date(s).getTime() + secs * 1000).toISOString(), secs, activity);
    };
    // Bea: walks on 12 earlier days (a list long enough to scroll), and an
    // overnight daycation 6:30 pm to 1:30 am two days ago.
    for (let i = 3; i < 15; i += 1) walkOn(3101, ids[BEG], dayAgo(i), 10, 0, 1200);
    walkOn(3105, ids[BEG], dayAgo(2), 18, 30, 7 * 3600, 'daycation');
    // Together, yesterday: three walks with Stella by others, one of them 90 s.
    walkOn(3105, ids[STAFF], dayAgo(1), 9, 0, 90);
    walkOn(3105, ids[CAT], dayAgo(1), 11, 0, 1200);
    walkOn(3105, ids[FRESH], dayAgo(1), 14, 0, 1500);
    // A Playgroup note of Bea's that someone else has edited (can't be signed now).
    db.prepare("INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at, edited_by_other) VALUES (3105, ?, 0, ?, 'Stella played nicely', ?, ?, 1)").run(ids[BEG], today, ts, ts);
    // Something new for the cat people's Updates.
    db.prepare("INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES ('new_dog', 3201, 'Percy was added to the shelter''s listing', ?)").run(ts);
    db.close();

    const ctxFor = (email, o = {}) => b.newContext({ viewport: { width: o.w || 390, height: o.h || 844 }, colorScheme: o.dark ? 'dark' : 'light', extraHTTPHeaders: { 'x-auth-email': email, ...(o.staff ? { 'x-auth-staff': '1' } : {}) }, serviceWorkers: 'block' });
    const pageFor = async (email, o) => { const c = await ctxFor(email, o); const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message)); return p; };
    const scanTo = async (p, name) => {
      await p.click('.tab-btn[data-tab="walk"]');
      await p.waitForSelector('#manualSearchInput');
      await p.click('#manualSearchInput');
      await p.waitForTimeout(800);
      await p.fill('#manualSearchInput', name);
      await p.waitForSelector('.search-result');
      await p.click('.search-result .dog-meta');
      await p.waitForSelector('#startWalkBtn');
      await p.waitForTimeout(500);
    };
    const contrastOf = (p, sel) => p.$eval(sel, (el) => {
      const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
      const cs = getComputedStyle(el);
      const [x, y] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))];
      return { ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), size: parseFloat(cs.fontSize), bg: cs.backgroundColor };
    });

    // ---- 1. The eligibility status row, light and dark ----
    for (const dark of [false, true]) {
      const tag = dark ? 'dark' : 'light';
      const p = await pageFor(BEG, { dark, w: 360, h: 760 });
      await p.goto(base, { waitUntil: 'networkidle' });
      await scanTo(p, 'Newbie');
      ok(await p.$('#eligibilityBadge .elig-status.elig-block'), `${tag}: a dog not cleared gets the red status row`);
      ok(/Not eligible/.test(await p.textContent('#eligibilityBadge')) && /more day/.test(await p.textContent('#eligibilityBadge')), `${tag}: it says "Not eligible" and why`);
      ok(await p.isDisabled('#startWalkBtn'), `${tag}: Start is off`);
      ok(await p.$eval('#app', (el) => el.classList.contains('caution-stripes')), `${tag}: the page has the hazard stripes`);
      let c = await contrastOf(p, '#eligibilityBadge .elig-status');
      ok(c.ratio >= 4.5 && c.size >= 13.6, `${tag}: the row is ${c.ratio.toFixed(1)}:1 at ${c.size}px`);
      ok(await p.$eval('.walk-confirm .card', (el) => /^rgb\(/.test(getComputedStyle(el).backgroundColor)), `${tag}: the cards over the stripes are solid, not see-through`);
      await p.screenshot({ path: h.shot(`1-not-eligible-${tag}.png`) });
      await scanTo(p, 'Fido');
      ok(await p.$('#eligibilityBadge .elig-status.elig-caution'), `${tag}: listed in foster gets the amber caution row`);
      const foster = await p.textContent('#eligibilityBadge');
      ok(!/Not eligible/.test(foster) && /In foster care \(not at the shelter\)/.test(foster) && /check the kennel card/.test(foster), `${tag}: foster says what to do, never "Not eligible": ${foster.trim()}`);
      ok(!(await p.$eval('#app', (el) => el.classList.contains('caution-stripes'))), `${tag}: no hazard stripes for foster`);
      ok(!(await p.isDisabled('#startWalkBtn')), `${tag}: and Start stays on (it asks to check the card)`);
      c = await contrastOf(p, '#eligibilityBadge .elig-status');
      ok(c.ratio >= 4.5, `${tag}: the caution row is ${c.ratio.toFixed(1)}:1`);
      await p.screenshot({ path: h.shot(`1-foster-${tag}.png`) });
      // Available: the same rows, no white circle behind an icon.
      await p.click('.tab-btn[data-tab="available"]'); await p.waitForSelector('.avail-card');
      ok(await p.$('.avail-card[data-id="3103"] .elig-status.elig-block'), `${tag}: Available uses the same row`);
      ok(!(await p.$('.badge-icon')), `${tag}: no white-circle icon left`);
      await p.close();
    }

    // ---- 2. A refused Start refreshes the dog ----
    {
      const p = await pageFor(BEG);
      await p.goto(base, { waitUntil: 'networkidle' });
      await scanTo(p, 'Rex');
      ok(/Eligible to walk/.test(await p.textContent('#eligibilityBadge')), 'Rex is eligible at first');
      const d = new Database(DB); d.prepare("UPDATE dogs SET blue_markers='[\"blue_d\"]' WHERE shelter_buddy_id=3101").run(); d.close();
      await p.click('#startWalkBtn');
      await p.waitForSelector('#appDialogOk', { state: 'visible' });
      await p.click('#appDialogOk');
      await p.waitForTimeout(300);
      ok(/Not eligible/.test(await p.textContent('#eligibilityBadge')) && await p.isDisabled('#startWalkBtn'), 'after the refusal the screen shows Not eligible and Start is off');
      const d2 = new Database(DB); d2.prepare("UPDATE dogs SET blue_markers='[]' WHERE shelter_buddy_id=3101").run(); d2.close();
      // ---- 3. Locked stickers carry a 🔒 ----
      await scanTo(p, 'Lockey');
      ok(await p.$('.marker-shape[data-value="blue_c"] .marker-lock'), 'the locked sticker has a 🔒');
      ok(/Stickers with a lock are there/.test(await p.textContent('.marker-lock-hint')), 'and the hint points at the lock');
      ok(/Behavior stickers/.test(await p.textContent('#app')) && !/Behavior markers/.test(await p.textContent('#app')), '"stickers", not "markers"');
      await p.screenshot({ path: h.shot('3-locked-sticker.png') });
      await p.close();
    }

    // ---- 4. One default per species ----
    {
      const p = await pageFor(BOTH);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('.avail-card');
      await p.click('#settingsBtn');
      await p.waitForSelector('#defaultActivityPicker [data-species="cat"] [data-activity="matchmaking"]');
      ok(await p.$('#defaultActivityPicker [data-species="dog"] [data-activity="walk"].active'), 'Settings: a row for dogs (Walk)');
      await p.click('#defaultActivityPicker [data-species="cat"] [data-activity="matchmaking"]');
      await p.waitForTimeout(500);
      await p.screenshot({ path: h.shot('4-settings-two-defaults.png') });
      const me = (await api(BOTH, '/api/me')).json;
      ok(me.defaultActivityCat === 'matchmaking' && me.defaultActivity === 'walk', 'cats: Matchmaking; dogs: still Walk');
      await p.click('#closeSettingsBtn');
      await scanTo(p, 'Rex');
      ok(await p.$eval('#startWalkBtn', (el) => el.dataset.activity) === 'walk', 'a dog offers Start walk');
      await scanTo(p, 'Percy');
      ok(await p.$eval('#startWalkBtn', (el) => el.dataset.activity) === 'matchmaking', 'a cat offers Start matchmaking');
      // Double tap Cuddle on a cat: only the cats' default changes.
      await p.click('#changeActivityBtn');
      await p.click('#activityPickRow [data-activity="cuddle"]');
      await p.click('#activityPickRow [data-activity="cuddle"]');
      await p.waitForTimeout(500);
      const me2 = (await api(BOTH, '/api/me')).json;
      ok(me2.defaultActivityCat === 'cuddle' && me2.defaultActivity === 'walk', "a cat's chip sets only the cats' default");
      await p.close();
    }
    {
      const p = await pageFor(NEWBOTH);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#onboardingNameNext');
      const inputs = await p.$$('#onboardingInner input[type="text"]');
      for (const [i, el] of inputs.entries()) await el.fill(i ? 'Both' : 'Nico');
      await p.click('#onboardingNameNext');
      await p.waitForSelector('#onboardingSpeciesList');
      await p.click('#onboardingSpeciesList [data-species-pref="both"]');
      await p.click('#onboardingSpeciesNext');
      await p.waitForSelector('#onboardingLevelList .level-pick-btn');
      await p.click('#onboardingLevelList .level-pick-btn');
      await p.click('#onboardingLevelNext');
      await p.waitForSelector('#onboardingActivityList [data-species="cat"]');
      ok(await p.$('#onboardingActivityList [data-species="dog"]'), 'onboarding asks once per species');
      await p.click('#onboardingActivityList [data-species="cat"] [data-activity="matchmaking"]');
      await p.screenshot({ path: h.shot('4-onboarding-both.png') });
      await p.click('#onboardingActivityNext');
      await p.waitForTimeout(600);
      const me = (await api(NEWBOTH, '/api/me')).json;
      ok(me.defaultActivity === 'walk' && me.defaultActivityCat === 'matchmaking', 'saved: dogs walk, cats matchmaking');
      await p.close();
    }

    // ---- 5. Cat wording: the title after onboarding, scan search, Updates ----
    {
      const p = await pageFor(NEWCAT);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#onboardingNameNext');
      const inputs = await p.$$('#onboardingInner input[type="text"]');
      for (const [i, el] of inputs.entries()) await el.fill(i ? 'Cat' : 'Nina');
      await p.click('#onboardingNameNext');
      await p.waitForSelector('#onboardingSpeciesList');
      await p.click('#onboardingSpeciesList [data-species-pref="cat"]');
      await p.click('#onboardingSpeciesNext');
      await p.waitForSelector('#onboardingActivityNext'); await p.click('#onboardingActivityNext');
      for (const next of ['#onboardingPasskeySkip', '#onboardingNotifNext', '#onboardingInfoNext', '#onboardingFinishBtn']) {
        const el = await p.waitForSelector(next, { timeout: 5000 }).catch(() => null);
        if (next === '#onboardingNotifNext') await p.uncheck('#onboardingPrefAlerts').catch(() => {});
        if (el) { await el.click(); await p.waitForTimeout(300); }
      }
      await p.waitForSelector('.avail-card, .empty-state', { timeout: 8000 });
      const title = await p.textContent('.topbar h1');
      ok(/^Cats to cuddle/.test(title), `straight after onboarding the title is "${title}"`);
      await p.close();
    }
    {
      const p = await pageFor(CAT);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click('.tab-btn[data-tab="walk"]');
      await p.click('#manualSearchInput'); await p.waitForTimeout(800);
      await p.fill('#manualSearchInput', 'zzzz'); await p.waitForTimeout(300);
      ok(/No matching cats\./.test(await p.textContent('#app')), 'scan search: "No matching cats."');
      await p.click('.tab-btn[data-tab="updates"]'); await p.waitForTimeout(800);
      ok(/✨ New/.test(await p.textContent('#app')) && !/🐶 New/.test(await p.textContent('#app')), 'Updates: "✨ New", no dog emoji');
      await p.close();
    }

    // ---- 6. Banners ----
    {
      const started = await api(BOTH, '/api/walks/start', { method: 'POST', body: { dogId: 3101, userId: ids[BOTH], activity: 'walk', location: 'C' } });
      ok(started.status === 200, 'Bo starts a walk with Rex');
      const p = await pageFor(BOTH, { w: 320, h: 640 });
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#endWalkBtn');
      await p.route('**/api/**', async (r) => { const resp = await r.fetch(); r.fulfill({ response: resp, headers: { ...resp.headers(), 'x-app-build': 'newbuild-ui3' } }); });
      await p.click('#extendWalkBtn');
      await p.waitForSelector('#newBuildBanner', { timeout: 5000 });
      await p.unroute('**/api/**');
      ok(/A new version is ready\. Reload when you're done\./.test(await p.textContent('#newBuildBanner')), 'new version: two sentences');
      const btn = await p.$eval('#newBuildBanner .btn', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      ok(btn.h >= 44 && btn.w < 200, `Reload is ${Math.round(btn.w)}×${Math.round(btn.h)} (auto width, 44px tall)`);
      let c = await contrastOf(p, '#newBuildBanner');
      ok(c.ratio >= 4.5, `banner text ${c.ratio.toFixed(1)}:1`);
      await p.screenshot({ path: h.shot('6-new-version-320.png') });
      const tops = await p.$$eval('#activityChoice [data-activity="cuddle"], #activityChoice [data-activity="matchmaking"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      ok(tops.length === 2 && tops[0] === tops[1], `at 320 Cuddle and Matchmaking share a row, like the others (${tops})`);
      await p.context().setOffline(true); await p.waitForTimeout(400);
      c = await contrastOf(p, '#offlineBanner');
      ok(await p.isVisible('#offlineBanner') && c.ratio >= 4.5, `offline banner ${c.ratio.toFixed(1)}:1`);
      await p.context().setOffline(false); await p.waitForTimeout(300);

      // ---- 7. Back from "Edit an earlier activity" mid-walk: the walk ----
      await p.evaluate(() => document.getElementById('newBuildBanner') && document.getElementById('newBuildBanner').remove());
      await p.click('#earlierWalksBtn');
      await p.waitForSelector('.stat-grid');
      await p.goBack(); await p.waitForTimeout(500);
      ok(await p.isVisible('#endWalkBtn'), 'phone Back from Stats returns to the walk in progress');
      await p.close();
      await api(BOTH, `/api/walks/${started.json.walkId}`, { method: 'DELETE' });
    }

    // ---- 8. Timers on the server's clock (a phone 5 minutes fast) ----
    {
      const started = await api(BOTH, '/api/walks/start', { method: 'POST', body: { dogId: 3105, userId: ids[BOTH], activity: 'walk', location: 'C' } });
      const c = await ctxFor(BOTH);
      await c.addInitScript(() => {
        const Real = Date;
        class Fast extends Real {
          constructor(...a) { if (a.length === 0) super(Real.now() + 5 * 60000); else super(...a); }
          static now() { return Real.now() + 5 * 60000; }
        }
        globalThis.Date = Fast;
      });
      const p = await c.newPage(); p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#timerDisplay'); await p.waitForTimeout(1500);
      const shown = await p.textContent('#timerDisplay');
      ok(/^00:0\d$/.test(shown.trim()), `a phone 5 minutes fast still shows the real elapsed time: ${shown}`);
      ok(/4\d:\d\d left/.test(await p.textContent('#autoStopText')), 'and about 45 minutes left: ' + (await p.textContent('#autoStopText')));
      await c.close();
      await api(BOTH, `/api/walks/${started.json.walkId}`, { method: 'DELETE' });
    }

    // ---- 9. Stats: Today with no walks; a visit day's Back; overnight daycation ----
    {
      const p = await pageFor(FRESH);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click('.tab-btn[data-tab="stats"]');
      await p.waitForSelector('.stat-tile[data-drill="avgChart"]');
      ok((await p.textContent('.stat-tile[data-drill="avgChart"] .value')).trim() === '–', 'Today, no walks: the average is "–", not "0 min"');
      await p.click('.stat-tile[data-drill="avgChart"]'); await p.waitForTimeout(400);
      ok(!/tap a bar/.test(await p.textContent('#app')), 'and its empty chart has no "tap a bar"');
      await p.close();
    }
    {
      const p = await pageFor(BEG);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click('.tab-btn[data-tab="stats"]');
      await p.waitForSelector('#statsRangeToggle'); await p.click('#statsRangeToggle');
      await p.waitForSelector('[data-daykey]');
      // The last visit day showing (older months start folded away).
      const key = await p.evaluate(() => {
        const shown = [...document.querySelectorAll('[data-daykey]')].filter((el) => el.checkVisibility());
        const el = shown[shown.length - 1];
        el.scrollIntoView({ block: 'center' });
        return el.dataset.daykey;
      });
      await p.waitForTimeout(300);
      const top = await p.$eval('#app', (el) => el.scrollTop);
      await p.click(`[data-daykey="${key}"]`);
      await p.waitForSelector('#backToStatsBtn');
      const heading = await p.textContent('#app h2.section-heading');
      await p.click('#backToStatsBtn'); await p.waitForTimeout(600);
      const back = await p.$eval('#app', (el) => el.scrollTop);
      ok(Math.abs(back - top) < 40 && top > 100, `← Back to Stats lands on the same spot (${top} → ${back})`);
      await p.goBack(); await p.waitForTimeout(600);
      ok(!(await p.textContent('#app')).includes(heading), 'and the phone Back after it doesn\'t show the same day again');

      // The daycation 6:30 pm–1:30 am: move its start to 6 pm.
      await p.click('.tab-btn[data-tab="stats"]');
      await p.waitForSelector('#statsRangeToggle');
      if (!(await p.$('[data-daykey]'))) await p.click('#statsRangeToggle');
      await p.waitForSelector('[data-daykey]');
      await p.evaluate(() => document.querySelectorAll('details.visit-month').forEach((d) => { d.open = true; }));
      await p.click(`[data-daykey="${dayAgo(2)}"]`);
      await p.waitForSelector('.edit-times-btn');
      await p.click('.edit-times-btn');
      await p.fill('.edit-times-row:not(.hidden) .edit-start-time', '18:00');
      await p.click('.edit-times-row:not(.hidden) .save-times-btn');
      await p.waitForTimeout(800);
      ok(!(await p.isVisible('#appDialog')), 'saving it raises no "end has to be after the start"');
      const d = new Database(DB, { readonly: true });
      const w = d.prepare("SELECT started_at, ended_at FROM walks WHERE activity = 'daycation' AND user_id = ?").get(ids[BEG]); d.close();
      ok(w.started_at === shelterIso(dayAgo(2), 18, 0) && w.ended_at === shelterIso(dayAgo(1), 1, 30), `the end rolls to the next morning: ${w.started_at} → ${w.ended_at}`);

      // Add a walk at 320: both time boxes stay inside the card.
      await p.setViewportSize({ width: 320, height: 700 });
      await p.click('#showAddWalkFormBtn');
      const fit = await p.evaluate(() => {
        const card = document.getElementById('addWalkForm').getBoundingClientRect();
        const end = document.getElementById('addWalkEnd').getBoundingClientRect();
        return end.right <= card.right + 0.5 && end.left >= card.left;
      });
      ok(fit, 'Add a walk at 320: "Ended" fits in the card');
      await p.screenshot({ path: h.shot('9-add-walk-320.png') });
      await p.close();
    }

    // ---- 10. Together: the server's flag decides, "(1 dog)" ----
    {
      const p = await pageFor(BEG);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click('.tab-btn[data-tab="stats"]');
      await p.waitForSelector('.seg-btn[data-scope="together"]'); await p.click('.seg-btn[data-scope="together"]');
      await p.waitForSelector(`.together-day[data-date="${dayAgo(1)}"]`);
      ok(/\(1 dog\)/.test(await p.textContent(`.together-day[data-date="${dayAgo(1)}"]`)), 'one dog walked three times: "(1 dog)"');
      await p.click(`.together-day[data-date="${dayAgo(1)}"]`);
      await p.waitForSelector('#togetherBack');
      ok(!/under a minute/.test(await p.textContent('#app')), "the 90-second walk isn't called a mis-scan");
      await p.close();
    }

    // ---- 11. Guide: a section is a Back step; unsaved edits ask first ----
    {
      const p = await pageFor(STAFF, { staff: true });
      await p.goto(base + '/app', { waitUntil: 'networkidle' }); // staff land on /staff
      await p.click('#guideBtn'); await p.waitForSelector('.guide-card[data-id]');
      await p.click('.guide-card[data-id]');
      await p.waitForSelector('.guide-article');
      await p.goBack(); await p.waitForTimeout(500);
      ok(await p.isVisible('#guideList'), 'phone Back from a section: the Guide list, still in the Guide');
      await p.click('.guide-card[data-id]'); await p.waitForSelector('#guideEdit');
      await p.click('#guideEdit'); await p.waitForSelector('#guideBody');
      await p.fill('#guideIcon', '🧑‍🦯');
      ok(await p.inputValue('#guideIcon') === '🧑‍🦯', 'the icon box keeps a multi-part emoji');
      await p.fill('#guideBody', 'A change I have not saved');
      await p.click('.tab-btn[data-tab="updates"]');
      await p.waitForSelector('#appDialog:not(.hidden)', { timeout: 3000 });
      ok(true, 'switching tabs with an unsaved edit asks first');
      await p.click('#appDialogCancel'); await p.waitForTimeout(300);
      ok(await p.inputValue('#guideBody') === 'A change I have not saved', 'Keep editing keeps the draft');
      await p.close();
    }

    // ---- 12. Cancel on Delete my data reopens Privacy & data ----
    {
      const p = await pageFor(BEG);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click('#userBtn'); await p.click('.account-menu-row[data-page="privacy"]');
      await p.click('#deleteMyDataBtn');
      await p.waitForSelector('#dangerConfirmPopup:not(.hidden)');
      await p.click('#dangerConfirmCancelBtn'); await p.waitForTimeout(500);
      ok(await p.isVisible('#accountPagePrivacy'), 'Cancel: back on Privacy & data');
      await p.close();
    }

    // ---- 13. Layout and tap targets ----
    {
      const p = await pageFor(BEG, { w: 1366, h: 900 });
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('.avail-card .view-profile-btn');
      await p.click('.avail-card .view-profile-btn');
      await p.waitForSelector('#profileSheet:not(.hidden)'); await p.waitForTimeout(400);
      const w = await p.$eval('#profileSheetInner', (el) => el.getBoundingClientRect().width);
      ok(w <= 700, `on a computer the profile sheet is the app's width (${Math.round(w)}px)`);
      await p.screenshot({ path: h.shot('13-profile-1366.png') });
      await p.close();
    }
    {
      const p = await pageFor(BEG, { w: 320, h: 700 });
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('.avail-card .stay-log-btn');
      const hit = await p.$eval('.avail-card .stay-log-btn', (el) => {
        const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
        const miss = [-14, 14].map((dy) => document.elementFromPoint(x, y + dy)).filter((t) => !t || t.closest('.stay-log-btn') !== el);
        return miss.length ? miss.map((t) => (t ? `${t.tagName}.${t.className}` : 'nothing')).join(', ') : '';
      });
      ok(!hit, '📜 answers a tap 14px above and below it' + (hit ? ` (hit ${hit})` : ''));
      await scanTo(p, 'Rex');
      await p.click('#changeActivityBtn');
      const lines = await p.$$eval('#activityPickRow .chip-main', (els) => els.map((e) => e.getBoundingClientRect().height));
      ok(lines.every((hgt) => hgt < 30), `every activity chip on one line at 320 (${lines.map(Math.round).join(', ')})`);
      await p.screenshot({ path: h.shot('13-chips-320.png') });
      await p.close();
    }
    {
      const started = await api(CAT, '/api/walks/start', { method: 'POST', body: { dogId: 3201, userId: ids[CAT], activity: 'cuddle', location: 'A' } });
      const p = await pageFor(CAT, { w: 360, h: 760 });
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#endWalkBtn'); await p.click('#endWalkBtn');
      await p.waitForSelector('.wrap-up-checks label');
      const hs = await p.$$eval('.wrap-up-checks label', (els) => els.map((e) => e.getBoundingClientRect().height));
      ok(hs.every((x) => x >= 44), `cat checklist rows are 44px+ (${hs.map(Math.round).join(', ')})`);
      await p.click('#saveWalkBtn').catch(() => {});
      await p.close();
      void started;
    }

    // ---- 14. The phone Playgroup editor ----
    {
      const p = await pageFor(BEG);
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.evaluate(() => { const x = document.createElement('button'); x.className = 'playgroup-notes-btn'; x.dataset.dogId = '3105'; document.body.append(x); x.click(); });
      await p.waitForSelector('#playgroupPopup:not(.hidden) .pg-entry [data-act="edit"]');
      await p.click('#playgroupPopup .pg-entry [data-act="edit"]');
      await p.waitForSelector('#pgEditorOverlay:not(.hidden) .pg-text');
      ok(!(await p.$('#pgEditorOverlay .pg-signed')), 'edited by someone else: no "Sign with my name" (it would be a 409)');
      await p.click('#pgEditorOverlay [data-act="cancel"]'); await p.waitForTimeout(300);
      await p.click('#playgroupPopup .pg-add-btn');
      await p.waitForSelector('#pgEditorOverlay:not(.hidden) .pg-text');
      await p.click('#pgEditorOverlay .pg-text'); await p.keyboard.type('A note');
      await p.route('**/api/dogs/3105/playgroup-notes', (r) => (r.request().method() === 'POST' ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"x"}' }) : r.continue()));
      await p.click('#pgEditorOverlay [data-act="save"]'); await p.waitForTimeout(800);
      ok(!(await p.isDisabled('#pgEditorOverlay [data-act="save"]')), 'Save works again after a failed save');
      await p.close();
    }

    const real = errs.filter((e) => !/Failed to load resource|Service Worker/.test(e));
    ok(real.length === 0, 'no page errors ' + JSON.stringify(real));
  } finally {
    await b.close();
    await h.stop();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
