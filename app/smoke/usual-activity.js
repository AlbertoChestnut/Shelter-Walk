// Picking the current activity: one tap switches just this one, tapping the
// picked chip again (or a double tap) also makes it your usual -- on the
// start screen and on the one in progress. The row stays open after a tap,
// so a double tap never lands on Start.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/usual-activity.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'ua@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='U', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (81, 'Biscuit', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    db.close();
    const usual = () => new Database(DB, { readonly: true }).prepare('SELECT default_activity AS a FROM users WHERE id = ?').get(me.id).a;
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.locator('.avail-card[data-id="81"] .walk-edit-btn').click();
    await p.waitForSelector('#startWalkBtn');
    await p.click('#changeActivityBtn');
    await p.click('#activityPickRow [data-activity="cuddle"]');
    ok(/Start cuddle/.test(await p.textContent('#startWalkBtn')), 'one tap: this one is a cuddle');
    ok(await p.isVisible('#activityPickRow'), 'the row stays open after a tap');
    ok(/Tap again to set as default/.test(await p.textContent('#activityPickRow [data-activity="cuddle"]')), 'the tapped chip says to tap again for the usual');
    ok(/Default/.test(await p.textContent('#activityPickRow [data-activity="walk"]')), 'the usual one is labelled');
    ok(/Picked 🤗 Cuddle for this one\. Tap it again to set it as your default\./.test(await p.textContent('#toast')), 'and a toast says so');
    ok(usual() === 'walk', 'one tap leaves the usual alone');
    await p.screenshot({ path: h.shot('usual-start.png') });
    await p.dblclick('#activityPickRow [data-activity="matchmaking"]');
    await p.waitForFunction(() => /Default/.test(document.querySelector('#activityPickRow [data-activity="matchmaking"]').textContent));
    ok(usual() === 'matchmaking', 'double tap: matchmaking is now the usual');
    ok(/Start matchmaking/.test(await p.textContent('#startWalkBtn')) && await p.isVisible('#activityPickRow'), 'and this one, without starting it');
    await p.click('#startWalkBtn');
    await p.waitForSelector('#activityChoice');
    ok(await p.isVisible('.walk-head-photo') && /dog-silhouettes\/81\.svg/.test(await p.getAttribute('.walk-head-photo', 'src')), 'the walk screen shows the animal (its silhouette when it has no photo)');
    await p.screenshot({ path: h.shot('walk-head.png') });
    await p.click('#activityChoice [data-activity="walk"]');
    await p.waitForFunction(() => /End walk/.test(document.getElementById('endWalkBtn').textContent));
    ok(/Tap again to set as default/.test(await p.textContent('#activityChoice [data-activity="walk"]')), 'mid-session, the chip says to tap again too');
    ok(usual() === 'matchmaking', 'mid-session, one tap switches only this one');
    await p.click('#activityChoice [data-activity="walk"]');
    await p.waitForFunction(() => /Default/.test(document.querySelector('#activityChoice [data-activity="walk"]').textContent));
    ok(usual() === 'walk', 'tapping the picked one again makes it the usual');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
    console.log('usual-activity: all good');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
