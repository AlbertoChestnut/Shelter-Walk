// A dog not cleared for a walker's level cannot be started at all -- Start
// Walk is disabled, not just a "walk anyway" confirm. Also covers the live
// bar: ticking PB flips the badge/button the instant it's tapped, and
// starting the walk saves that marker change before re-checking eligibility.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/eligibility-block.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB;
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const estEmail = 'est@example.com', begEmail = 'beg@example.com';
    const est = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': estEmail } })).json();
    const beg = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': begEmail } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET experience_level='established', onboarding_completed=1 WHERE id=?").run(est.id);
    db.prepare("UPDATE users SET experience_level='beginner', onboarding_completed=1 WHERE id=?").run(beg.id);
    const now = new Date().toISOString();
    // Brand new (0 days): not eligible for anyone yet on days alone.
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (501, 'Newt', 'Male', '2 Years', ?, 1, ?, ?)").run(now, now, now);
    db.close();

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': estEmail }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });

    await p.click('.walk-edit-btn[data-id="501"]');
    await p.waitForSelector('#startWalkBtn');
    await p.waitForTimeout(300); // let loadExperienceLevels() resolve
    ok(await p.isDisabled('#startWalkBtn'), 'too few days: Start Walk is disabled outright, not just a confirm');
    ok((await p.textContent('#eligibilityBadge')).includes('day'), 'the bar explains why');

    // Tick PB: established is allowed PB dogs, which excuses the days wait
    // -- the bar should flip the instant it's tapped, before any save.
    await p.click('.marker-shape[data-group="pb"]');
    await p.waitForTimeout(150);
    ok(!(await p.isDisabled('#startWalkBtn')), 'ticking PB immediately re-enables Start Walk');
    ok((await p.textContent('#eligibilityBadge')).includes('Eligible'), 'and flips the badge to Eligible');
    ok(await p.isVisible('#pbWarningBanner'), 'the potty-break-only reminder shows too');

    // Nothing persisted yet -- only tapping Start (or Save Changes) does.
    const beforeSave = await (await fetch(base + '/api/dogs/501', { headers: { 'x-auth-email': estEmail } })).json();
    ok(beforeSave.dog.pbFlag === false, 'merely ticking the marker does not save it');

    // Untick it again: back to blocked immediately.
    await p.click('.marker-shape[data-group="pb"]');
    await p.waitForTimeout(150);
    ok(await p.isDisabled('#startWalkBtn'), 'unticking PB immediately disables Start Walk again');
    await p.click('.marker-shape[data-group="pb"]'); // tick it back on for the real start below
    await p.waitForTimeout(150);

    // Start never saves stickers by itself (audit2): it asks first.
    await p.click('#startWalkBtn');
    await p.waitForSelector('#appDialogOk', { state: 'visible' });
    ok(/Save them before you start/.test(await p.textContent('#appDialog')), 'Start asks before saving the unsaved PB tap');
    await p.click('#appDialogOk');
    await p.waitForSelector('#endWalkBtn');
    const afterStart = await (await fetch(base + '/api/dogs/501', { headers: { 'x-auth-email': estEmail } })).json();
    ok(afterStart.dog.pbFlag === true, 'saying yes saved the PB marker before starting');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await ctx.close();

    // A beginner still can't walk this PB dog at all -- no override exists.
    const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': begEmail }, serviceWorkers: 'block' });
    const p2 = await ctx2.newPage(); const errs2 = []; p2.on('pageerror', (e) => errs2.push(e.message));
    const db2 = new Database(DB);
    db2.prepare('DELETE FROM walks WHERE dog_id = 501').run(); // free the dog up again
    db2.close();
    await p2.goto(base, { waitUntil: 'networkidle' });
    await p2.click('.walk-edit-btn[data-id="501"]');
    await p2.waitForSelector('#startWalkBtn');
    await p2.waitForTimeout(300);
    ok(await p2.isDisabled('#startWalkBtn'), 'a beginner still cannot start this PB dog at all');
    ok((await p2.textContent('#eligibilityBadge')).includes('Potty break only'), 'the bar says why');
    ok(errs2.length === 0, 'no page errors ' + JSON.stringify(errs2));
    await ctx2.close();

    // Server-side belt-and-suspenders: even a direct API call is refused.
    const direct = await fetch(base + '/api/walks/start', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-email': begEmail },
      body: JSON.stringify({ dogId: 501, userId: beg.id })
    });
    ok(direct.status === 403, 'the server refuses to start it too, not just the UI');
    const directJson = await direct.json();
    ok(directJson.notEligibleReason === 'pb_restricted', 'with the right reason');

    await b.close();
    console.log('eligibility-block smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
