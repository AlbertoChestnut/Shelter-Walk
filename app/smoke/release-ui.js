// Release checks (.ai/RELEASE_CHECKS.md, "UI"): a fast sweep over the main
// screens -- volunteer app at 320 and 390 px, staff dashboard and play group
// desk at 1366 (and the desk at 390) -- asserting on every screen:
//   - no horizontal scroll (document scrollWidth <= clientWidth)
//   - no NaN / undefined / null / "Invalid Date" / "[object Object]" / "(add "
//     in the visible text
//   - no pageerror events
//   - every visible <img> has an alt attribute and has loaded (naturalWidth
//     > 0), or is showing the standard silhouette fallback
//   - every visible input / select / textarea has a label (label[for], a
//     wrapping <label>, aria-label or aria-labelledby)
//   - icon-only buttons (no letters or digits) have aria-label/-labelledby
//   - primary tap targets are at least 44 px (see TAP_ALLOW for exceptions)
// Seeds dogs with a real cached photo, no photo, and a photo that 404s.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/release-ui.js            (also run by npm run smoke:all)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startSmoke, launch } = require('./_harness');

const EMAIL = 'release.ui@example.com';
const STAFF = 'release.ui.staff@example.com';
const BAD_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|Invalid Date|\[object Object\]|\(add /;

// Primary tap targets: tab bars, header icon buttons, full-size buttons.
const TAP_SELECTOR = '.tabbar .tab-btn, .topbar button, .btn:not(.small-btn), .section-tabs .tab-btn, .sheet-close-btn';
// Allowed under 44 px, each with its reason. minWidth: only from that
// viewport width up.
const TAP_ALLOW = [
  // The staff dashboard and play group desk section tabs on a computer
  // (mouse pointer, >= 1000 px wide): 30-32 px tall, above the 24 px WCAG
  // 2.5.8 minimum. On a phone they still have to be 44.
  { selector: '.section-tabs .tab-btn', minWidth: 1000 }
];

// App bugs this sweep has found and reported, not fixed here (release
// checks don't change app code). Matching issues are printed as KNOWN BUG
// and don't fail the run; remove an entry once it's fixed so it can't come back.
const KNOWN_BUGS = [
];

async function sweep(page, label, issues) {
  await page.waitForTimeout(250);
  await page.evaluate(async () => {
    // Give images a moment to load (or fall back) before judging them.
    const imgs = [...document.images].filter((i) => !i.complete);
    await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), new Promise((r) => setTimeout(r, 3000))]);
    await new Promise((r) => setTimeout(r, 150)); // let a fallback src load
  });
  const found = await page.evaluate(({ tapSel, allow, badText }) => {
    const out = [];
    const visible = (el) => {
      if (!el.getClientRects().length) return false;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0;
    };
    const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 3).map((c) => `.${c}`).join('')}`;
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) {
      const wide = [...document.querySelectorAll('body *')].filter((el) => visible(el) && el.getBoundingClientRect().right > de.clientWidth + 1).slice(0, 3).map(desc);
      out.push(`horizontal scroll: ${de.scrollWidth} > ${de.clientWidth} (${wide.join(', ')})`);
    }
    const text = document.body.innerText;
    const bad = new RegExp(badText).exec(text);
    if (bad) out.push(`visible text has "${bad[0]}": …${text.slice(Math.max(0, bad.index - 40), bad.index + 40).replace(/\s+/g, ' ')}…`);
    for (const img of document.images) {
      if (!visible(img)) continue;
      if (!img.hasAttribute('alt')) out.push(`img without alt: ${desc(img)} ${img.getAttribute('src')}`);
      const fallback = img.classList.contains('photo-fallback') || /\/dog-silhouettes\//.test(img.src);
      if (!(img.complete && img.naturalWidth > 0) && !(fallback && img.complete)) out.push(`img not loaded: ${desc(img)} ${img.getAttribute('src')}`);
    }
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (el.type === 'hidden' || !visible(el)) continue;
      const named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.labels && el.labels.length) || el.closest('label');
      if (!named) out.push(`unlabeled ${desc(el)}${el.type ? `[type=${el.type}]` : ''}${el.placeholder ? ` placeholder="${el.placeholder}"` : ''}`);
    }
    for (const b of document.querySelectorAll('button, [role="button"], a.icon-btn')) {
      if (!visible(b)) continue;
      const words = (b.textContent || '').replace(/[^\p{L}\p{N}]/gu, '');
      if (!words && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby')) out.push(`icon-only button without aria-label: ${desc(b)} "${(b.innerText || '').trim()}"`);
    }
    for (const el of document.querySelectorAll(tapSel)) {
      if (!visible(el) || allow.some((a) => el.matches(a.selector) && window.innerWidth >= (a.minWidth || 0))) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 43.5 || r.width < 43.5) out.push(`tap target ${Math.round(r.width)}x${Math.round(r.height)}: ${desc(el)} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`);
    }
    return out;
  }, { tapSel: TAP_SELECTOR, allow: TAP_ALLOW, badText: BAD_TEXT.source });
  const fresh = found.map((f) => `[${label}] ${f.replace(/\s+/g, ' ')}`).filter((f) => {
    const known = KNOWN_BUGS.find((k) => k.re.test(f));
    if (known) { (known.seen = known.seen || []).push(f); return false; }
    return true;
  });
  issues.push(...fresh);
  console.log(`  ${fresh.length ? '✗' : '✓'} ${label}${fresh.length ? ` (${fresh.length} new issue(s))` : ''}${found.length > fresh.length ? ` [${found.length - fresh.length} known]` : ''}`);
}

(async () => {
  const h = await startSmoke();
  const { base } = h;
  let b;
  const issues = [];
  try {
    b = await launch();
    // A real JPEG for the cached photo, drawn by the browser itself.
    const scratch = await b.newPage();
    const dataUrl = await scratch.evaluate(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; const x = c.getContext('2d'); x.fillStyle = '#a0522d'; x.fillRect(0, 0, 64, 48); return c.toDataURL('image/jpeg'); });
    await scratch.close();
    const imgDir = path.join(h.dir, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, '9001.jpg'), Buffer.from(dataUrl.split(',')[1], 'base64'));

    const me = await (await fetch(`${base}/api/me`, { headers: { 'x-auth-email': EMAIL } })).json();
    const staff = await (await fetch(`${base}/api/me`, { headers: { 'x-auth-email': STAFF, 'x-auth-staff': '1' } })).json();
    const db = new Database(h.dbFile);
    db.prepare("UPDATE users SET name = 'Rae', experience_level = 'expert', onboarding_completed = 1, species_pref = 'both' WHERE id = ?").run(me.id);
    db.prepare("UPDATE users SET name = 'Stef', experience_level = 'expert', onboarding_completed = 1 WHERE id = ?").run(staff.id);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 40 * 864e5).toISOString();
    const dog = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, breed, tags, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, photo_url, poo_status)
      VALUES (?, ?, ?, 'Female', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`);
    dog.run(9001, 'Biscuit', 'dog', '3 Years', 'Labrador', '["Dog"]', old, now, now, 'A', 'https://example.invalid/biscuit.jpg', 'poo'); // cached photo
    dog.run(9002, 'Pepper', 'dog', '2 Years', 'Beagle', '["Dog"]', old, now, now, 'B', null, 'none'); // no photo
    dog.run(9003, 'Rocket', 'dog', '5 Years', 'Boxer', '["Dog"]', old, now, now, 'C', `${base}/cached-images/404404.jpg`, 'none'); // photo 404s
    dog.run(9101, 'Mittens', 'cat', '3 Years', 'Domestic Shorthair', '["Cat"]', old, now, now, 'A', null, 'none');
    dog.run(9102, 'Pip', 'cat', '9 Weeks', 'Domestic Shorthair', '["Cat","Kitten"]', old, now, now, 'B', null, 'none');
    const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES (?, ?, ?, ?, ?)');
    ev.run('new_dog', 9002, 'Pepper arrived', null, new Date(Date.now() - 2 * 864e5).toISOString());
    ev.run('sticker_on', 9001, 'POO: Potty Outside Only', 'poo', old);
    const walk = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    let n = 0;
    for (const d of [3, 2, 1]) {
      for (const [id, act, sec] of [[9001, 'walk', 1200], [9002, 'walk', 900], [9003, 'cuddle', 600], [9101, 'cuddle', 480]]) {
        const start = ago(d * 1440 + (n += 25));
        walk.run(id, me.id, start, new Date(new Date(start).getTime() + sec * 1000).toISOString(), sec, act, n === 25 ? 'Great on leash, loves @[9002]' : null);
      }
    }
    db.prepare("INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at) VALUES (9001, ?, 1, ?, 'Plays well with @[9002]', ?, ?)")
      .run(staff.id, new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()), now, now);
    const yesterday = new Date(Date.now() - 864e5);
    db.prepare("INSERT INTO shelter_species_counts (date_key, species, listed, in_foster, recorded_at) VALUES (?, 'dog', 3, 0, ?)")
      .run(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(yesterday), yesterday.toISOString());
    db.close();

    const errors = [];
    const open = async (width, height, { user = EMAIL, staffHeader = false } = {}) => {
      const ctx = await b.newContext({ viewport: { width, height }, extraHTTPHeaders: { 'x-auth-email': user, ...(staffHeader ? { 'x-auth-staff': '1' } : {}) }, serviceWorkers: 'block' });
      await ctx.addInitScript(() => { if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(`${width}px: ${e.message}`));
      return p;
    };

    for (const [w, ht] of [[320, 640], [390, 844]]) {
      console.log(`Volunteer app at ${w}px`);
      const p = await open(w, ht);
      const tab = async (name) => { await p.click(`.tab-btn[data-tab="${name}"]`); await p.waitForLoadState('networkidle'); };
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('.avail-card');
      await sweep(p, `${w} Available`, issues);
      // The photo cases themselves: cached photo loads; no photo and a 404
      // photo both end on the silhouette, at the same size.
      const photos = await p.evaluate(() => Object.fromEntries([9001, 9002, 9003].map((id) => {
        const img = document.querySelector(`.avail-card[data-id="${id}"] img`);
        if (!img) return [id, null];
        const r = img.getBoundingClientRect();
        return [id, { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0, fallback: img.classList.contains('photo-fallback') || /dog-silhouettes/.test(img.src), size: `${Math.round(r.width)}x${Math.round(r.height)}` }];
      })));
      const photoIssue = (m) => issues.push(`[${w} Available photos] ${m}: ${JSON.stringify(photos)}`);
      if (!photos[9001] || !/\/cached-images\/(?:thumbs\/)?9001\.jpg/.test(photos[9001].src) || !photos[9001].loaded) photoIssue('cached photo did not load');
      if (!photos[9002] || !photos[9002].fallback) photoIssue('no-photo dog is not on the silhouette');
      if (!photos[9003] || !photos[9003].fallback) photoIssue('404 photo did not fall back');
      if (photos[9002] && photos[9003] && photos[9002].size !== photos[9003].size) photoIssue('the two fallbacks differ in size');
      await p.click('#toggleMoreFiltersBtn');
      await sweep(p, `${w} Filters`, issues);
      await p.click('#toggleMoreFiltersBtn');
      await p.locator('.avail-card[data-id="9001"] .walk-edit-btn').click();
      await p.waitForSelector('#startWalkBtn');
      await sweep(p, `${w} Dog info / start`, issues);
      await tab('walk');
      await sweep(p, `${w} Scan (camera blocked)`, issues);
      await tab('stats');
      for (const scope of ['mine', 'together', 'notes', 'playgroup', 'shelter']) {
        await p.click(`.seg-btn[data-scope="${scope}"]`);
        await p.waitForLoadState('networkidle');
        await sweep(p, `${w} Stats › ${scope}`, issues);
      }
      await tab('updates');
      await sweep(p, `${w} Updates`, issues);
      await p.click('#guideBtn');
      await p.waitForLoadState('networkidle');
      await sweep(p, `${w} Guide`, issues);
      await tab('available');
      await p.click('#settingsBtn');
      await p.waitForSelector('#settingsSheet:not(.hidden)');
      await sweep(p, `${w} Settings`, issues);
      await p.keyboard.press('Escape');
      await p.evaluate(() => document.getElementById('settingsSheet').classList.add('hidden'));
      await p.click('#userBtn');
      await p.waitForTimeout(300);
      await sweep(p, `${w} My account`, issues);
      await p.context().close();
    }

    console.log('Staff dashboard at 1366px');
    const s = await open(1366, 900, { user: STAFF, staffHeader: true });
    await s.goto(`${base}/staff`, { waitUntil: 'networkidle' });
    for (const section of ['live', 'reports', 'hours', 'settings']) {
      await s.click(`.section-tabs .tab-btn[data-section="${section}"]`);
      await s.waitForLoadState('networkidle');
      await sweep(s, `1366 Staff › ${section}`, issues);
    }
    await s.context().close();

    for (const [w, ht] of [[1366, 900], [390, 844]]) {
      console.log(`Play group desk at ${w}px`);
      const g = await open(w, ht, { user: STAFF, staffHeader: true });
      await g.goto(`${base}/playgroup`, { waitUntil: 'networkidle' });
      await sweep(g, `${w} Play group desk`, issues);
      await g.context().close();
    }

    for (const e of errors) issues.push(`[pageerror] ${e}`);
    for (const k of KNOWN_BUGS.filter((x) => x.seen)) console.log(`KNOWN ${k.bug} (${k.seen.length}x, e.g. ${k.seen[0]})`);
    if (issues.length) {
      console.error(`\n${issues.length} issue(s):\n${issues.map((i) => `  - ${i}`).join('\n')}`);
      throw new Error(`FAIL: release UI sweep found ${issues.length} issue(s)`);
    }
    console.log('Release UI sweep passed.');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    if (b) await b.close();
    await h.stop();
  }
})();
