// Fixing a session logged as the wrong activity from Stats → By activity:
// the drill-down is one list of your sessions (by animal, or by date with
// two or more animals) that edits only the session -- no Start / Edit or
// notes for the animal -- and switching one from cuddle to walk saves
// without touching its times.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/fix-activity.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'fa@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='F', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (71, 'Henrietta', 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const started = ago(3 * 1440); const ended = ago(3 * 1440 - 10);
    db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (72, 'Cauldron', 'Male', '4 Years', '2026-07-01T00:00:00', 1, ?, ?)").run(ts, ts);
    const walkId = db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (71, ?, ?, ?, 600, 'cuddle')").run(me.id, started, ended).lastInsertRowid;
    db.prepare("INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity) VALUES (72, ?, ?, ?, 600, 'walk')").run(me.id, ago(2 * 1440), ago(2 * 1440 - 10));
    db.close();
    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]');
    await p.click('#statsRangeToggle');
    await p.click('.bd-row[data-bd-activity="cuddle"]');
    await p.waitForSelector(`.edit-times-btn[data-id="${walkId}"]`);
    ok(/Your cuddles/.test(await p.textContent('#app')), 'the cuddle drill-down lists your cuddles');
    ok(await p.locator('[data-activity-group]').count() === 0, 'one animal: no By dog / By date switch');
    ok(await p.locator('#app .walk-edit-btn, #app .dog-notes-btn').count() === 0, 'no Start / Edit or animal notes, only the session');
    ok(await p.locator('#app .animal-edit-btn').count() === 1, 'one separate Edit dog button');
    await p.click('#app .animal-edit-btn');
    await p.waitForSelector('#editPopupSaveBtn');
    ok(!/still out with/.test(await p.textContent('#markerInfoPopupContent')), 'Edit dog from Stats: no "still out with" line');
    await p.screenshot({ path: h.shot('fix-activity-editdog.png') });
    await p.keyboard.press('Escape');
    await p.waitForSelector('#editPopupSaveBtn', { state: 'detached' }).catch(() => {});
    ok(await p.locator('#app .session-row').count() === 1 && await p.locator('#app .dog-photo').count() === 1, 'the animal is shown once, its session under it');
    await p.click(`.edit-times-btn[data-id="${walkId}"]`);
    await p.selectOption(`.edit-times-row[data-id="${walkId}"] .edit-activity`, 'walk');
    await p.screenshot({ path: h.shot('fix-activity.png'), fullPage: true });
    await p.click(`.save-times-btn[data-id="${walkId}"]`);
    await p.waitForFunction((id) => !document.querySelector(`.edit-times-btn[data-id="${id}"]`), walkId);
    const row = new Database(DB, { readonly: true }).prepare('SELECT activity, started_at, ended_at, edited FROM walks WHERE id = ?').get(walkId);
    ok(row.activity === 'walk', 'saved as a walk');
    ok(row.started_at === started && row.ended_at === ended && !row.edited, 'times untouched, not marked edited');
    // Now two walks with two dogs: the switch, and the date grouping.
    await p.click('#backToActivityBtn');
    await p.click('.bd-row[data-bd-activity="walk"]');
    await p.waitForSelector('[data-activity-group="date"]');
    ok(/By dog/.test(await p.textContent('[data-activity-group="dog"]')), 'two animals: the switch says By dog / By date');
    ok(await p.locator('#app .animal-edit-btn').count() === 2, 'By dog: an Edit dog button per dog');
    await p.click('[data-activity-group="date"]');
    await p.waitForSelector('[data-activity-group="date"].on');
    const names = await p.$$eval('#byDogList > .card .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s+/).slice(-2).join(' ')));
    ok(names.length === 2 && /Cauldron/.test(names[0]) && /Henrietta/.test(names[1]), 'By date: newest first, one card each ' + JSON.stringify(names));
    await p.screenshot({ path: h.shot('fix-activity-date.png'), fullPage: true });
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
    console.log('fix-activity: all good');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
