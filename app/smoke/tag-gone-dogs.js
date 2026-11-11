// @ tags reach dogs that left the shelter in the last 3 months: listed after
// the dogs still here, the longest gone last, each marked "Left <date>";
// dogs gone longer aren't offered (owner, 2026-11-11).
//   node smoke/tag-gone-dogs.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
const EMAIL = 'gone@example.com';
const SHOTS = process.env.SHOTS_DIR;
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); const { base, dbFile } = h;
  try {
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(dbFile);
    db.prepare("UPDATE users SET name='Pat', experience_level='expert', onboarding_completed=1 WHERE id=?").run(me.id);
    const now = new Date().toISOString(), ago = (d) => new Date(Date.now() - d * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, date_in_shelter, still_listed, first_seen_at, last_seen_at, removed_at, kennel_location)
      VALUES (?, ?, 'Female', '3 Years', 'Lab', ?, ?, ?, ?, ?, ?)`);
    ins.run(7001, 'Max', ago(200), 1, ago(200), now, null, 'B');
    ins.run(7002, 'Rosie', ago(200), 1, ago(200), now, null, 'C');
    ins.run(7003, 'Rocco', ago(200), 0, ago(200), ago(60), ago(60), null);
    ins.run(7004, 'Roxy', ago(200), 0, ago(200), ago(5), ago(5), null);
    ins.run(7005, 'Rory', ago(300), 0, ago(300), ago(120), ago(120), null);
    db.close();

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.waitForSelector('.avail-card[data-id="7001"]');
    await p.click('.avail-card[data-id="7001"] .dog-meta');
    await p.waitForSelector('#profileSheet:not(.hidden)');
    const box = '#profileSheet .tip-add-main .pg-text';
    await p.waitForSelector(box);
    await p.click(box);
    await p.keyboard.type('Plays well with @R');
    const items = '#profileSheet .tip-add-main .pg-suggest:not(.hidden) .pg-suggest-item';
    await p.waitForSelector(items);
    const rows = await p.$$eval(items, (els) => els.map((e) => ({ name: e.querySelector('.pg-suggest-name').textContent, gone: e.classList.contains('gone'), where: e.querySelector('.nowrap').textContent })));
    ok(rows.map((r) => r.name).join(',') === 'Rosie,Roxy,Rocco', `still here first, then most recently gone: ${rows.map((r) => r.name)}`);
    ok(!rows[0].gone && /🏠 C/.test(rows[0].where), 'Rosie shows her kennel');
    ok(rows[1].gone && /Left /.test(rows[1].where) && rows[2].gone, `gone dogs are marked: "${rows[1].where.trim()}"`);
    ok(!rows.some((r) => r.name === 'Rory'), 'a dog gone 4 months is not offered');
    if (SHOTS) await p.locator('#profileSheet .tip-add-main .pg-suggest').screenshot({ path: `${SHOTS}/tag-gone-dogs.png` });
    await p.click(`${items}:nth-child(2)`);
    await p.keyboard.type('last week');
    await p.click('#profileSheet .tip-add-btn');
    await p.waitForSelector('#profileSheet .note-tag[data-tag-animal="7004"]');
    ok(true, 'a tip tagging Roxy saves and shows the tag');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('tag-gone-dogs smoke passed');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
