// Notes carry dates, and Stats → Notes lists every dog's notes in one place
// (tips, walk notes, your private note), searchable, tapping a dog opens it.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/all-notes.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3994, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_alln.db', EMAIL = 'n@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); const ts = new Date().toISOString();
    db.prepare("UPDATE users SET name='N', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id);
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', ?, ?, ?)");
    dog.run(70, 'Pepper', 1, ts, ts); dog.run(71, 'Biscuit', 1, ts, ts); dog.run(72, 'Gone', 0, ts, ts);
    const tip = db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    tip.run(70, me.id, 'public', 'Loves squeaky toys', '2026-09-20T15:00:00Z', '2026-09-20T15:00:00Z');
    tip.run(71, me.id, 'public', 'Pulls toward cats', '2026-10-01T15:00:00Z', '2026-10-03T15:00:00Z');
    tip.run(70, me.id, 'private', 'Bring treats', ts, ts);
    tip.run(72, me.id, 'public', 'Adopted dog tip', ts, ts);
    const end = new Date(Date.now() - 60000), start = new Date(end - 20 * 60000);
    db.prepare("INSERT INTO walks (dog_id, user_id, location, started_at, ended_at, duration_seconds, notes, activity) VALUES (71, ?, 'D', ?, ?, 1200, 'great walk today', 'walk')").run(me.id, start.toISOString(), end.toISOString());
    db.close();
    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]'); await p.click('.seg-btn[data-scope="notes"]');
    await p.waitForSelector('.all-notes-dog');
    const names = await p.$$eval('.all-notes-dog .dog-name', (els) => els.map((e) => e.textContent.trim()));
    ok(names.join() === 'Pepper,Biscuit', 'listed dogs only, newest note first: ' + names);
    const text = await p.textContent('#allNotesList');
    ok(/Sep 20/.test(text) && /edited/.test(text) === false && /Oct 1/.test(text), 'each note shows its date');
    ok(/Private · only you/.test(text) && /From a walk/.test(text), 'private and walk notes are labeled');
    await p.screenshot({ path: '/tmp/_alln1.png' });
    await p.fill('#allNotesSearch', 'cats');
    ok((await p.$$('.all-notes-dog')).length === 1, 'search narrows the list');
    await p.fill('#allNotesSearch', '');
    await p.click('.all-notes-dog[data-dogid="71"] .all-notes-head');
    await p.waitForSelector('#profileSheet .tip-item[data-tip]');
    const prof = await p.textContent('#profileSheet .dog-notes-mount');
    ok(/Oct 1 · edited Oct 3/.test(prof), 'profile tips show date and edit date');
    await p.screenshot({ path: '/tmp/_alln2.png' });
    await p.fill('#profileSheet .tip-add-row:not(.private-note-add-row) .tip-input', 'Fresh tip'); await p.click('#profileSheet .tip-add-btn');
    await p.waitForFunction(() => /Fresh tip/.test(document.querySelector('#profileSheet .dog-notes-mount').textContent));
    await p.click('#closeProfileBtn');
    await p.waitForFunction(() => /Fresh tip/.test(document.getElementById('allNotesList').textContent));
    ok(true, 'list refreshes after closing the dog');
    await p.click('.notes-scope-btn[data-mine="1"]');
    await p.waitForFunction(() => /My notes/.test((document.querySelector('.section-heading') || {}).textContent && document.getElementById('allNotesList') ? document.querySelector('.section-heading').textContent : ''));
    const mineText = await p.textContent('#allNotesList');
    ok(/Bring treats/.test(mineText) && /great walk today/.test(mineText) && /From your walk/.test(mineText), 'My notes: private note and own walk note');
    ok(!/Loves squeaky toys|Pulls toward cats|Fresh tip/.test(mineText), 'My notes: no shared tips');
    await p.screenshot({ path: '/tmp/_alln3.png' });
    await p.click('.notes-scope-btn[data-mine="0"]');
    await p.waitForFunction(() => /Fresh tip/.test((document.getElementById('allNotesList') || {}).textContent || ''));
    ok(true, 'back to All notes');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
