// Stats by species (Dogs / Cats / Both), the breakdowns (engagement type,
// POO vs non-POO at the time, kittens vs adults, dogs vs cats), "at the
// shelter right now", and "@" tags in tips and end-of-walk notes.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/stats-species-tags.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3993, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_stats_species.db', EMAIL = 'both@example.com';
const SHOTS = process.env.SHOTS || '/tmp';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name='Both', experience_level='beginner', onboarding_completed=1, species_pref='both' WHERE id=?").run(me.id);
    const now = new Date().toISOString(), old = new Date(Date.now() - 30 * 864e5).toISOString();
    const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, species, sex, age, tags, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, poo_status)
      VALUES (?, ?, ?, 'Female', ?, ?, ?, 1, ?, ?, 'B', ?)`);
    ins.run(5001, 'Biscuit', 'dog', '3 Years', '["Dog"]', old, now, now, 'poo');
    ins.run(5002, 'Rocket', 'dog', '3 Years', '["Dog"]', old, now, now, 'none');
    ins.run(6001, 'Mittens', 'cat', '3 Years', '["Cat"]', old, now, now, 'none');
    ins.run(6002, 'Socks', 'cat', '3 Years', '["Cat"]', old, now, now, 'none');
    ins.run(6003, 'Pip', 'cat', '9 Weeks', '["Cat","Kitten"]', old, now, now, 'none');
    // Biscuit got POO a few days ago: the walk before it counts as non-POO.
    db.prepare("INSERT INTO shelter_events (kind, dog_id, title, detail, occurred_at) VALUES ('sticker_on', 5001, 'POO', 'poo', ?)").run(new Date(Date.now() - 3 * 864e5).toISOString());
    const w = db.prepare('INSERT INTO walks (dog_id, user_id, started_at, ended_at, duration_seconds, activity, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    w.run(5001, me.id, ago(10 * 1440), ago(10 * 1440 - 20), 1200, 'walk', null);
    w.run(5001, me.id, ago(200), ago(180), 1200, 'walk', null);
    w.run(5002, me.id, ago(170), ago(150), 1200, 'cuddle', null);
    w.run(6001, me.id, ago(100), ago(92), 480, 'cuddle', 'Shares a condo with @[6002]');
    w.run(6003, me.id, ago(90), ago(84), 360, 'cuddle', null);
    db.close();

    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]');
    await p.waitForSelector('[data-stats-species]');
    ok(await p.$eval('.seg-btn[data-stats-species="all"]', (e) => e.classList.contains('on')), 'someone with both starts on Both');
    const text = async () => p.textContent('#app');
    ok(/Dogs vs cats/.test(await text()), 'Both shows dogs vs cats');
    ok(/By engagement type/.test(await text()), 'engagement types on today');
    ok(/Kittens vs adult cats/.test(await text()) && /POO vs non-POO dogs/.test(await text()), 'POO and kitten splits on Both');
    ok(/At the shelter right now/.test(await text()), 'shelter right now');
    await p.screenshot({ path: `${SHOTS}/stats-both-today.png`, fullPage: true });

    await p.click('.seg-btn[data-stats-species="dog"]');
    await p.waitForFunction(() => document.querySelector('.seg-btn[data-stats-species="dog"].on'));
    ok(!/Kittens vs adult cats/.test(await text()) && !/Dogs vs cats/.test(await text()), 'Dogs hides cat splits');
    ok(/Walkable for your level/.test(await text()) && /Non-POO dogs/.test(await text()), 'walkable / POO / non-POO tiles');
    ok(/Today's Walks/.test(await text()), 'Dogs talks about walks');
    await p.screenshot({ path: `${SHOTS}/stats-dogs-today.png`, fullPage: true });

    await p.click('#statsRangeToggle');
    await p.waitForSelector('#statsByDogHeading');
    const poo = await p.$$eval('.bd-row', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
    ok(poo.some((r) => /^POO/.test(r) && /1 engagement/.test(r)) && poo.some((r) => /^Non-POO/.test(r) && /2 engagements/.test(r)), 'lifetime POO counts the sticker as it was at the time');
    await p.screenshot({ path: `${SHOTS}/stats-dogs-lifetime.png`, fullPage: true });

    await p.click('.seg-btn[data-stats-species="cat"]');
    await p.waitForFunction(() => document.querySelector('.seg-btn[data-stats-species="cat"].on'));
    ok((await p.textContent('#statsByDogHeading')).trim() === 'By Cat', 'By Cat, not By Dog');
    ok(/Kittens vs adult cats/.test(await text()) && !/POO vs non-POO/.test(await text()), 'cats get kittens, not POO');
    const names = await p.$$eval('#byDogList .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]).sort().join(','));
    ok(names === 'Mittens,Pip', 'only cats listed');
    await p.screenshot({ path: `${SHOTS}/stats-cats-lifetime.png`, fullPage: true });

    // Together follows the same switch.
    await p.click('.seg-btn[data-scope="together"]');
    await p.waitForSelector('text=Since we started tracking');
    ok(await p.$eval('.seg-btn[data-stats-species="cat"]', (e) => e.classList.contains('on')), 'Together keeps the species');
    await p.click('.seg-btn[data-stats-species="all"]');
    await p.waitForFunction(() => document.querySelector('.seg-btn[data-stats-species="all"].on') && /By engagement type/.test(document.getElementById('app').textContent));
    ok(!/undefined/.test(await text()), 'Together breakdown reads cleanly (no "undefined")');
    await p.click('.seg-btn[data-stats-species="cat"]');
    await p.waitForFunction(() => document.querySelector('.seg-btn[data-stats-species="cat"].on'));
    await p.screenshot({ path: `${SHOTS}/together-cats.png`, fullPage: true });

    // Tags: the walk note shows as a name, and Socks lists it under "Tagged in".
    await p.click('.seg-btn[data-scope="mine"]');
    await p.click('#statsRangeToggle');
    await p.waitForSelector('.note-tag[data-tag-animal="6002"]');
    ok((await p.textContent('.note-tag[data-tag-animal="6002"]')).trim() === '@Socks', 'tag in a walk note reads @Socks');
    await p.click('.note-tag[data-tag-animal="6002"]');
    await p.waitForSelector('#profileSheet .notes-label');
    await p.waitForSelector('text=Tagged in other notes');
    ok(true, 'tapping the tag opens Socks, with the note under Tagged in other notes');

    // Writing a tip with an @ tag.
    const box = '#profileSheet .tip-add-main .pg-text';
    await p.click(box);
    await p.keyboard.type('Gets along with @Pi');
    await p.waitForSelector('#profileSheet .tip-add-main .pg-suggest:not(.hidden) .pg-suggest-item');
    await p.click('#profileSheet .tip-add-main .pg-suggest-item');
    await p.keyboard.type('in the condo');
    await p.click('#profileSheet .tip-add-btn');
    await p.waitForSelector('#profileSheet .tip-item .note-tag[data-tag-animal="6003"]');
    const tip = await (await fetch(base + '/api/dogs/6002/notes', { headers: { 'x-auth-email': EMAIL } })).json();
    ok(tip.sharedTips[0].body === 'Gets along with @[6003] in the condo', 'tip saved as @[id]');
    await p.screenshot({ path: `${SHOTS}/tags-profile.png`, fullPage: true });
    const pip = await (await fetch(base + '/api/dogs/6003/notes', { headers: { 'x-auth-email': EMAIL } })).json();
    ok(pip.mentions.length === 1 && pip.mentions[0].from.name === 'Socks', 'Pip lists the tip that tags it');

    // A name typed without "@" is offered as a tag, and "Don't tag" leaves it as text.
    await p.click(box);
    await p.keyboard.type('Mittens likes the window ');
    await p.waitForSelector('#profileSheet .tip-add-main .pg-autotag');
    await p.click('#profileSheet .tip-add-main .pg-autotag');
    await p.waitForSelector('.pg-autotag-pop');
    ok(/Don't tag/.test(await p.textContent('.pg-autotag-pop')) && !/Not a dog/.test(await p.textContent('.pg-autotag-pop')), 'plain-name suggestion, worded for any animal');
    await p.click('.pg-autotag-pop [data-id="6001"]');
    await p.click('#profileSheet .tip-add-btn');
    await p.waitForSelector('#profileSheet .tip-item .note-tag[data-tag-animal="6001"]');
    const socks = await (await fetch(base + '/api/dogs/6002/notes', { headers: { 'x-auth-email': EMAIL } })).json();
    ok(socks.sharedTips[0].body === '@[6001] likes the window', 'confirming the suggestion saves a real tag');

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('stats-species-tags: all good');
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
