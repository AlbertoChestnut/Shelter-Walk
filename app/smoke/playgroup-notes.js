// Playgroup notes: the button on every dog's profile, the full-screen editor,
// the small button and compact notes on the scan screen (no green bar there),
// adding a dated note with an @ tag picked from the list,
// the tag showing on the tagged dog as a mention, and tapping through.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/playgroup-notes.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'pg@example.com';
const SHOTS = process.env.SHOTS_DIR;
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
// .pg-text is a contenteditable div now, not a <textarea> -- Playwright's
// fill()/inputValue() only work on real form controls, so these replace
// them: pgText() reads back exactly what body() will see (via the same
// richText() the app itself uses), pgFill() clicks in, selects everything
// and types the replacement, exercising the real typing path.
const pgText = (p, sel) => p.$eval(sel, (el) => window.PgTags.richText(el));
const pgFill = async (p, sel, text) => {
  await p.click(sel);
  await p.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+a');
  await p.keyboard.type(text);
};
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='Pat', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, pb_flag)
      VALUES (?, ?, 'Female', '3 Years', 'Lab', ?, 1, ?, ?, ?, ?)`);
    ins.run(99911, 'Max', old, now, now, 'B', 0);
    ins.run(99912, 'Bella', old, now, now, 'C', 0);
    ins.run(99913, 'Potty', old, now, now, 'D', 1);
    db.close();

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const openProfile = async (id) => {
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector(`.avail-card[data-id="${id}"]`);
      await p.click(`.avail-card[data-id="${id}"] .dog-meta`);
      await p.waitForSelector('#profileSheet:not(.hidden)');
      await p.waitForTimeout(300);
    };

    await openProfile(99913);
    ok(await p.isVisible('#profileSheet .playgroup-notes-btn'), 'every dog has the playgroup button, PB-only too');

    // Scan screen: no green bar, small playgroup button, compact notes.
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('.avail-card[data-id="99913"]');
    ok(await p.isVisible('.topbar'), 'green bar on Available');
    await p.click('.avail-card[data-id="99913"] .walk-edit-btn');
    await p.waitForSelector('#startWalkBtn');
    ok(!(await p.isVisible('.topbar')), 'no green bar on the scanned-dog screen');
    ok(await p.isVisible('.notes-card-head .pg-mini-btn'), 'small playgroup button on the scanned-dog screen');
    await p.waitForSelector('.dog-notes-compact .tip-input');
    ok(!(await p.isVisible('.dog-notes-compact .tip-help')), 'notes are compact there');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/scan-confirm.png` });
    await p.click('.notes-card-head .pg-mini-btn');
    await p.waitForSelector('#playgroupPopup:not(.hidden) .pg-add-btn');
    ok((await p.textContent('#playgroupPopupContent')).includes("Potty's playgroup notes"), 'it opens the notes popup');
    await p.click('#closePlaygroupPopupBtn');
    await p.click('[data-tab="available"]');
    await p.waitForTimeout(400);
    ok(await p.isVisible('.topbar'), 'green bar back on leaving the scan screen');

    await openProfile(99911);
    ok(await p.isVisible('#profileSheet .playgroup-notes-btn'), 'eligible dog: playgroup button on the profile');
    await p.click('#profileSheet .playgroup-notes-btn');
    await p.waitForSelector('#playgroupPopup:not(.hidden) .pg-add-btn');
    ok((await p.textContent('#playgroupPopupContent')).includes('No playgroup notes yet'), 'popup opens, empty');
    await p.click('.pg-add-btn');
    await p.waitForSelector('#pgEditorOverlay:not(.hidden) .pg-text');
    const box = await p.locator('#pgEditorOverlay .pg-text').boundingBox();
    ok(box.y < 220 && box.height > 250, `editor box is big and near the top, below the toolbar (y=${Math.round(box.y)}, h=${Math.round(box.height)})`);
    ok(await p.evaluate(() => document.activeElement.classList.contains('pg-text')), 'and focused');
    await p.fill('#pgEditorOverlay .pg-date', '2026-10-01');
    const ta = '#pgEditorOverlay .pg-text';
    await p.click(ta);
    await p.keyboard.type('Great session. Played with @Bel');
    await p.waitForSelector('#pgEditorOverlay .pg-suggest:not(.hidden) .pg-suggest-item');
    const sugg = await p.$$eval('#pgEditorOverlay .pg-suggest-item .pg-suggest-name', (els) => els.map((e) => e.textContent));
    ok(sugg.length === 1 && sugg[0] === 'Bella', '@Bel suggests Bella');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pg-suggest.png` });
    await p.click('#pgEditorOverlay .pg-suggest-item');
    await p.keyboard.type('for 20 minutes, very gentle.\nWatch for resource guarding around toys.');
    ok((await pgText(p, ta)).startsWith('Great session. Played with @Bella for 20'), 'picking inserts @Bella');
    await p.check('#pgEditorOverlay .pg-signed');
    await p.click('#pgEditorOverlay [data-act="save"]');
    await p.waitForSelector('#playgroupPopup .pg-entry');
    ok(!(await p.isVisible('#pgEditorOverlay')) && await p.isVisible('#playgroupPopup'), 'editor closes back to the notes');
    const entry = await p.textContent('#playgroupPopup .pg-entry');
    ok(/Oct 1/.test(entry) && entry.includes('@Bella') && entry.includes('Pat'), 'entry shows date, tag and signature');
    ok((await p.textContent('#profileSheet .playgroup-notes-btn')).includes('(1)'), 'profile button count updated');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pg-max.png` });

    await p.click('#playgroupPopup .pg-entry-body .pg-tag');
    await p.waitForSelector('#playgroupPopup .pg-section');
    const bella = await p.textContent('#playgroupPopupContent');
    ok(bella.includes("Bella's playgroup notes") && bella.includes("Mentioned in other dogs' notes (1)") && bella.includes("Max's notes"), 'tag opens Bella with the mention');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/pg-bella.png` });
    await p.click('#playgroupPopup .pg-back');
    await p.waitForTimeout(400);
    ok((await p.textContent('#playgroupPopupContent')).includes("Max's playgroup notes"), 'back link returns to Max');

    // Edit keeps the tag as @Bella and round-trips it.
    await p.click('#playgroupPopup .pg-entry [data-act="edit"]');
    await p.waitForSelector('#pgEditorOverlay:not(.hidden) .pg-text');
    const editText = await pgText(p, '#pgEditorOverlay .pg-text');
    ok(editText.includes('@Bella for 20') && !editText.includes('@['), 'editor shows @Bella, not the raw id');
    // A long note with blank lines, typed with pauses so the auto-tag rescan
    // re-renders: the caret has to stay put (it used to jump back one
    // character per blank line above it, splitting the "@" mid-word).
    await pgFill(p, ta, 'One.');
    for (const line of ['Two.', 'Three.', 'Played with']) {
      await p.waitForTimeout(500); await p.keyboard.press('Enter');
      await p.waitForTimeout(500); await p.keyboard.press('Enter');
      await p.waitForTimeout(500); await p.keyboard.type(line);
    }
    await p.waitForTimeout(500); await p.keyboard.type(' @');
    await p.waitForTimeout(500); await p.keyboard.type('Bel');
    ok(await p.isVisible('#pgEditorOverlay .pg-suggest:not(.hidden) .pg-suggest-item'), '@ still suggests after blank lines and pauses');
    ok(await pgText(p, ta) === 'One.\n\nTwo.\n\nThree.\n\nPlayed with @Bel', 'caret stays put through rescans');
    await p.keyboard.press('Escape');
    await pgFill(p, '#pgEditorOverlay .pg-text', editText + ' Better with @Bella than most.');
    await p.click('#pgEditorOverlay [data-act="save"]');
    await p.waitForTimeout(500);
    const notes = await (await fetch(base + '/api/dogs/99911/playgroup-notes', { headers: { 'x-auth-email': EMAIL } })).json();
    ok(notes.notes[0].body.includes('@[99912] for 20') && notes.notes[0].body.includes('Better with @[99912] than'), 'saved with the tags as ids');

    // During playgroup: the button on the active screen, and a note box
    // (with tagging) on the end screen that saves to playgroup notes.
    await p.close();
    const started = await (await fetch(base + '/api/walks/start', { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-email': EMAIL }, body: JSON.stringify({ dogId: 99912, userId: me.id, activity: 'playgroup', location: 'C' }) })).json();
    ok(started.walkId || started.id, 'started playgroup with Bella');
    const q = await ctx.newPage(); q.on('pageerror', (e) => errs.push(e.message));
    await q.goto(base, { waitUntil: 'networkidle' });
    await q.waitForSelector('#endWalkBtn');
    ok(await q.isVisible('#walkPlaygroupBtn'), 'active playgroup: playgroup notes button shown');
    await q.click('#endWalkBtn');
    await q.waitForSelector('#walkPlaygroupNote .pg-text');
    await q.click('#walkPlaygroupNote .pg-text');
    await q.keyboard.type('Ran with @Ma');
    await q.waitForSelector('#walkPlaygroupNote .pg-suggest:not(.hidden) .pg-suggest-item');
    await q.click('#walkPlaygroupNote .pg-suggest-item');
    await q.keyboard.type('the whole time.');
    if (SHOTS) await q.screenshot({ path: `${SHOTS}/pg-end.png` });
    await q.click('#saveWalkBtn');
    await q.waitForSelector('#doneBtn');
    await q.waitForTimeout(500);
    const bn = await (await fetch(base + '/api/dogs/99912/playgroup-notes', { headers: { 'x-auth-email': EMAIL } })).json();
    ok(bn.notes.length === 1 && bn.notes[0].body === 'Ran with @[99911] the whole time.' && bn.notes[0].author === null, 'end-screen note saved on Bella, tagged Max, anonymous');
    const mx = await (await fetch(base + '/api/dogs/99911/playgroup-notes', { headers: { 'x-auth-email': EMAIL } })).json();
    ok(mx.mentions.length === 1, 'and shows as a mention on Max');

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('playgroup notes smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
