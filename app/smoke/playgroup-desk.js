// Play group desk (/playgroup) on a computer screen: pick a dog, write a
// backdated note with an @ tag using only the keyboard, the date carries over
// to the next note, move a note to another day, All sessions + Excel export.
// Also the phone's Yesterday chip and tap-the-date-to-move.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/playgroup-desk.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
process.env.TZ = 'America/New_York'; // daysAgo() must agree with the app's shelter date, whatever the browser's zone
const ExcelJS = require('exceljs');
let base, DB; const EMAIL = 'desk@example.com';
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
const key = (d) => d.toLocaleDateString('en-CA');
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return key(d); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  const get = async (url) => (await fetch(base + url, { headers: { 'x-auth-email': EMAIL } })).json();
  try {
    const me = await get('/api/me');
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='Dana', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, pb_flag)
      VALUES (?, ?, 'Female', '3 Years', 'Lab', ?, ?, ?, ?, ?, 0)`);
    ins.run(99921, 'Biscuit', old, 1, now, now, 'A');
    ins.run(99922, 'Juniper', old, 1, now, now, 'B');
    ins.run(99923, 'Oldtimer', old, 0, now, now, 'C'); // adopted, has a note
    db.prepare("INSERT INTO playgroup_notes (dog_id, user_id, signed, note_date, body, created_at, updated_at) VALUES (99923, ?, 0, '2026-08-01', 'Left already', ?, ?)").run(me.id, now, now);
    db.close();

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 1366, height: 860 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block', acceptDownloads: true });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base + '/playgroup', { waitUntil: 'networkidle' });
    await p.waitForSelector('#dogList .dog-row');
    const names = await p.$$eval('#dogList .dog-row-name', (els) => els.map((e) => e.textContent.trim()));
    ok(names.includes('Biscuit') && names.some((n) => n.startsWith('Oldtimer') && /Adopted|Left shelter/.test(n)), 'dog list has listed dogs and ones who left with notes');

    // Keyboard only: / to search, Enter to open, type with @ tag, Enter picks, Ctrl+Enter saves.
    await p.keyboard.press('/');
    await p.keyboard.type('bisc');
    await p.keyboard.press('Enter');
    await p.waitForSelector('#dogPane .new-note .pg-text');
    ok(await p.evaluate(() => document.activeElement.classList.contains('pg-text')), 'opening a dog puts the cursor in the note box');
    await p.fill('#dogPane .new-note .pg-date', daysAgo(5));
    await p.click('#dogPane .new-note .pg-text');
    await p.keyboard.type('Great with @jun');
    await p.waitForSelector('#dogPane .pg-suggest:not(.hidden)');
    await p.keyboard.press('Enter');
    await p.keyboard.type('all session.');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/desk-write.png` });
    await p.keyboard.press('Control+Enter');
    await p.waitForSelector('#dogPane .notes .note');
    let notes = (await get('/api/dogs/99921/playgroup-notes')).notes;
    ok(notes.length === 1 && notes[0].body === 'Great with @[99922] all session.' && notes[0].noteDate === daysAgo(5), 'keyboard-only note saved, backdated, with the tag');
    ok(await p.inputValue('#dogPane .new-note .pg-date') === daysAgo(5), 'the next note starts on the same date');
    ok((await p.textContent('#dogList .dog-row.active .dog-row-count')).trim() === '1', 'dog list count updated');

    // Move it to another day from the list.
    await p.locator('#dogPane .notes .pg-redate').fill(daysAgo(9));
    await p.locator('#dogPane .notes .pg-redate').dispatchEvent('change');
    await p.waitForTimeout(600);
    ok((await get('/api/dogs/99921/playgroup-notes')).notes[0].noteDate === daysAgo(9), 'changing the date on a saved note moves it');

    // Edit in place.
    await p.click('#dogPane .notes [data-act="edit"]');
    ok((await pgText(p, '#dogPane .notes .pg-text')).startsWith('Great with @Juniper'), 'edit shows @Juniper');
    await pgFill(p, '#dogPane .notes .pg-text', 'Great with @Juniper, then tired.');
    await p.click('#dogPane .notes [data-act="save"]');
    await p.waitForTimeout(600);
    ok((await get('/api/dogs/99921/playgroup-notes')).notes[0].body === 'Great with @[99922], then tired.', 'edit saved');

    // Tag click opens the other dog, with the mention.
    await p.click('#dogPane .note-body .pg-tag');
    await p.waitForFunction(() => document.querySelector('#dogPane h2') && document.querySelector('#dogPane h2').textContent === 'Juniper');
    ok((await p.textContent('#dogPane')).includes("Mentioned in other dogs' notes (1)"), 'the tagged dog shows the mention');

    // All sessions + export.
    await p.click('[data-view="sessions"]');
    await p.waitForSelector('#sessionRows tr td.note-cell');
    ok((await p.textContent('#sessionCount')).startsWith('2 notes'), 'All sessions lists every note');
    await p.fill('#sessionSearch', 'juniper');
    await p.waitForTimeout(500);
    ok((await p.$$('#sessionRows td.note-cell')).length === 1, 'search narrows it');
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/desk-sessions.png` });
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportBtn')]);
    const wb = new ExcelJS.Workbook();
    const fail = await dl.failure(); if (fail) throw new Error('download failed: ' + fail + ' ' + dl.url());
    await wb.xlsx.readFile(await dl.path());
    const sheet = wb.getWorksheet('Play group notes');
    ok(sheet.rowCount === 2 && sheet.getRow(2).getCell(5).value === 'Great with @Juniper, then tired.', `Excel export has the filtered notes (${dl.suggestedFilename()})`);
    await p.click('#sessionRows [data-open-dog="99921"]');
    await p.waitForFunction(() => document.querySelector('#dogPane h2') && document.querySelector('#dogPane h2').textContent === 'Biscuit');
    ok(await p.isVisible('#writeView'), 'tapping a dog in the table opens it to write');

    // Phone: Yesterday chip, and tapping a note's date to move it.
    const phone = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const q = await phone.newPage(); q.on('pageerror', (e) => errs.push(e.message));
    await q.goto(base, { waitUntil: 'networkidle' });
    await q.waitForSelector('.avail-card[data-id="99922"]');
    await q.click('.avail-card[data-id="99922"] .dog-meta');
    await q.waitForSelector('#profileSheet .playgroup-notes-btn');
    await q.click('#profileSheet .playgroup-notes-btn');
    await q.waitForSelector('#playgroupPopup .pg-add-btn');
    ok(await q.isVisible('#playgroupPopup .pg-desk-link'), 'phone popup links to the desk');
    await q.click('.pg-add-btn');
    await q.waitForSelector('#pgEditorOverlay [data-pg-day="1"]');
    await q.click('#pgEditorOverlay [data-pg-day="1"]');
    ok(await q.inputValue('#pgEditorOverlay .pg-date') === daysAgo(1), 'Yesterday chip sets the date');
    await pgFill(q, '#pgEditorOverlay .pg-text', 'Phone note');
    await q.click('#pgEditorOverlay [data-act="save"]');
    await q.waitForSelector('#playgroupPopup .pg-redate');
    ok((await get('/api/dogs/99922/playgroup-notes')).notes[0].noteDate === daysAgo(1), 'saved for yesterday');
    await q.locator('#playgroupPopup .pg-redate').fill(daysAgo(3));
    await q.locator('#playgroupPopup .pg-redate').dispatchEvent('change');
    await q.waitForTimeout(600);
    ok((await get('/api/dogs/99922/playgroup-notes')).notes[0].noteDate === daysAgo(3), 'tapping the date on the phone moves the note');
    await q.click('.pg-add-btn');
    await q.waitForSelector('#pgEditorOverlay .pg-date');
    ok(await q.inputValue('#pgEditorOverlay .pg-date') === daysAgo(1), 'next phone note starts on the date just used');
    if (SHOTS) await q.screenshot({ path: `${SHOTS}/phone-dates.png` });

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('playgroup desk smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
