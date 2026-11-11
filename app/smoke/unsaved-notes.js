// Leaving a note typed but not saved asks first: Save, Discard or Keep
// editing. On the phone app: closing the dog's profile (✕ and Back), the tab
// bar, Cancel in the full-screen playgroup editor. On the playgroup desk:
// picking another dog, and the browser's own prompt when the page closes.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/unsaved-notes.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'un@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
// .pg-text is a contenteditable div (see playgroup-notes.js).
const pgType = async (p, sel, text) => { await p.click(sel); await p.keyboard.type(text); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='Uma', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, pb_flag)
      VALUES (?, ?, 'Female', '3 Years', 'Lab', ?, 1, ?, ?, ?, 0)`);
    ins.run(99931, 'Maple', old, now, now, 'A');
    ins.run(99932, 'Rocket', old, now, now, 'B');
    db.close();
    const tips = () => new Database(DB).prepare("SELECT body FROM dog_notes WHERE dog_id = 99931 AND visibility <> 'private'").all().map((r) => r.body);
    const pgNotes = (id) => new Database(DB).prepare('SELECT body FROM playgroup_notes WHERE dog_id = ?').all(id).map((r) => r.body);
    const dialogUp = (p) => p.waitForSelector('#appDialog:not(.hidden) #appDialogAlt:not(.hidden)');

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    const openProfile = async () => {
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.click('.avail-card[data-id="99931"] .dog-meta');
      await p.waitForSelector('#profileSheet:not(.hidden) .tip-add-main .tip-input');
      await p.waitForTimeout(300);
    };

    // ✕ on the profile: Keep editing leaves it open with the text; Save adds the tip.
    await openProfile();
    await pgType(p, '.tip-add-main .tip-input', 'Likes the blue ball');
    await p.click('#closeProfileBtn');
    await dialogUp(p);
    ok(/haven't saved/.test(await p.textContent('#appDialogMessage')), 'closing the profile with a typed tip asks first');
    ok((await p.textContent('#appDialogOk')) === 'Save' && (await p.textContent('#appDialogAlt')) === 'Discard' && (await p.textContent('#appDialogCancel')) === 'Keep editing', 'offering Save, Discard and Keep editing');
    await p.click('#appDialogCancel');
    await p.waitForTimeout(400);
    ok(await p.isVisible('#profileSheet') && /Likes the blue ball/.test(await p.textContent('.tip-add-main .tip-input')), 'Keep editing: still open, text kept');
    await p.click('#closeProfileBtn');
    await dialogUp(p);
    await p.click('#appDialogOk');
    await p.waitForSelector('#profileSheet', { state: 'hidden' });
    ok(tips().includes('Likes the blue ball'), 'Save: the tip is saved and the profile closes');

    // Back: Discard closes without saving.
    await openProfile();
    await pgType(p, '.tip-add-main .tip-input', 'Pulls hard');
    await p.goBack();
    await dialogUp(p);
    ok(await p.isVisible('#profileSheet'), 'Back with a typed tip asks first, profile still showing');
    await p.click('#appDialogAlt');
    await p.waitForSelector('#profileSheet', { state: 'hidden' });
    ok(!tips().includes('Pulls hard'), 'Discard: closed, nothing saved');
    await p.waitForTimeout(300);
    ok(!(await p.isVisible('#appDialog')), 'and nothing asks again');

    // Nothing typed: closes straight away.
    await openProfile();
    await p.click('#closeProfileBtn');
    await p.waitForSelector('#profileSheet', { state: 'hidden' });
    ok(!(await p.isVisible('#appDialog')), 'an empty note box never asks');

    // Full-screen playgroup editor: Cancel with text, then Save from the dialog.
    await openProfile();
    await p.click('#profileSheet .playgroup-notes-btn');
    await p.waitForSelector('#playgroupPopup:not(.hidden) .pg-add-btn');
    await p.click('.pg-add-btn');
    await p.waitForSelector('#pgEditorOverlay:not(.hidden) .pg-text');
    await pgType(p, '#pgEditorOverlay .pg-text', 'Great with Rocket');
    await p.click('#pgEditorOverlay [data-act="cancel"]');
    await dialogUp(p);
    await p.click('#appDialogOk');
    await p.waitForSelector('#pgEditorOverlay', { state: 'hidden' });
    ok(pgNotes(99931).includes('Great with Rocket'), 'playgroup editor: Cancel asks, Save from there saves it');
    ok(await p.isVisible('#playgroupPopup'), 'and only the editor closed');
    await p.click('.pg-add-btn');
    await p.waitForSelector('#pgEditorOverlay:not(.hidden) .pg-text');
    await pgType(p, '#pgEditorOverlay .pg-text', 'Napped after');
    await p.goBack();
    await dialogUp(p);
    await p.click('#appDialogOk');
    await p.waitForSelector('#pgEditorOverlay', { state: 'hidden' });
    ok(pgNotes(99931).includes('Napped after') && await p.isVisible('#playgroupPopup'), 'playgroup editor: Back asks too, Save saves and closes just the editor');

    // Tab bar, from a dog's notes on the walk screen.
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.avail-card[data-id="99932"] .walk-edit-btn');
    await p.waitForSelector('.dog-notes-compact .tip-input');
    await pgType(p, '.dog-notes-compact .tip-add-main .tip-input', 'Shy at first');
    await p.click('.tab-btn[data-tab="stats"]');
    await dialogUp(p);
    await p.click('#appDialogAlt');
    await p.waitForFunction(() => document.querySelector('.tab-btn[data-tab="stats"]').classList.contains('active'));
    ok(true, 'switching tabs with a typed tip asks; Discard switches');
    ok(errs.length === 0, 'no page errors on the phone ' + JSON.stringify(errs));

    // Playgroup desk on a computer.
    const desk = await b.newContext({ viewport: { width: 1366, height: 860 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const d = await desk.newPage(); const derrs = []; d.on('pageerror', (e) => derrs.push(e.message));
    await d.goto(base + '/playgroup', { waitUntil: 'networkidle' });
    await d.click('#dogList .dog-row[data-dog="99932"]');
    await d.waitForSelector('#dogPane .new-note .pg-text');
    await pgType(d, '#dogPane .new-note .pg-text', 'Zoomies all session');
    await d.click('#dogList .dog-row[data-dog="99931"]');
    await d.waitForSelector('#unsavedDialog[open]');
    ok(true, 'desk: picking another dog with a typed note asks first');
    await d.click('#unsavedDialog [value="stay"]');
    await d.waitForTimeout(300);
    ok(/Rocket/.test(await d.textContent('#dogPane h2')) && /Zoomies/.test(await d.textContent('#dogPane .new-note .pg-text')), 'desk: Keep editing stays on the dog with the text');
    await d.click('#dogList .dog-row[data-dog="99931"]');
    await d.waitForSelector('#unsavedDialog[open]');
    await d.click('#unsavedDialog [value="save"]');
    await d.waitForFunction(() => /Maple/.test(document.querySelector('#dogPane h2')?.textContent || ''));
    ok(pgNotes(99932).includes('Zoomies all session'), 'desk: Save saves it, then opens the other dog');

    // Closing the page: the browser's own prompt.
    await d.waitForSelector('#dogPane .new-note .pg-text');
    await pgType(d, '#dogPane .new-note .pg-text', 'Half written');
    let prompted = null;
    d.on('dialog', async (dlg) => { prompted = dlg.type(); await dlg.dismiss(); });
    await d.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 500));
    ok(prompted === 'beforeunload', 'desk: closing the page with a typed note gets the browser prompt');
    ok(derrs.length === 0, 'no page errors on the desk ' + JSON.stringify(derrs));
    await b.close();
  } finally { await h.stop(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
