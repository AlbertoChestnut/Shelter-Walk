// Stats by species (a Dogs / Cats switch only for someone with both), the
// breakdowns (engagement type, POO vs non-POO at the time, kittens vs
// adults), "at the shelter right now" -- walkable/POO/non-POO and
// kittens/adults, each tile opening the matching filtered Available list --
// living on the Shelter tab (not My stats or Together), cat trends on
// Shelter, and "@" tags in tips and end-of-walk notes.
// Needs Playwright (devDependency): npx playwright install chromium
//   node smoke/stats-species-tags.js
const { startSmoke, launch } = require('./_harness'); const Database = require('better-sqlite3');
let base, DB; const EMAIL = 'both@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  const h = await startSmoke(); ({ base, dbFile: DB } = h);
  try {
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
    ins.run(5003, 'Bo', 'dog', '3 Years', '["Dog"]', old, now, now, 'none');
    ins.run(6004, 'Mia', 'cat', '3 Years', '["Cat"]', old, now, now, 'none');
    ins.run(6005, 'Lou', 'cat', '3 Years', '["Cat"]', old, now, now, 'none');
    db.prepare("UPDATE dogs SET location = 'In Foster' WHERE shelter_buddy_id IN (5003, 6004, 6005)").run();
    // Cats arrive in one import (not "brought in"), then one the next day.
    const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, occurred_at) VALUES (?, ?, ?)');
    for (const id of [6001, 6002, 6004, 6005]) ev.run('new_dog', id, new Date(Date.now() - 2 * 864e5).toISOString());
    ev.run('new_dog', 6003, new Date(Date.now() - 864e5).toISOString());
    // Yesterday's cat count on record, so the foster and at-the-shelter charts
    // have the 2 days they need to draw (fewer shows "Not enough history").
    const yesterday = new Date(Date.now() - 864e5);
    db.prepare("INSERT INTO shelter_species_counts (date_key, species, listed, in_foster, recorded_at) VALUES (?, 'cat', 4, 2, ?)")
      .run(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(yesterday), yesterday.toISOString());
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

    const b = await launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]');
    await p.waitForSelector('[data-stats-species]');
    const switchKeys = await p.$$eval('[data-stats-species]', (els) => els.map((e) => e.dataset.statsSpecies).join(','));
    ok(switchKeys === 'dog,cat', 'switch is Dogs / Cats, no Both');
    ok(await p.$eval('.seg-btn[data-stats-species="dog"]', (e) => e.classList.contains('on')), 'starts on the species the lists show');
    const text = async () => p.textContent('#app');
    ok(/By activity/.test(await text()), 'engagement types on today');
    ok(!/At the shelter right now|Walkable for your level/.test(await text()), 'shelter-now tiles live on Shelter now, not My stats');
    ok(!/Kittens vs adult cats/.test(await text()) && !/Dogs vs cats/.test(await text()), 'Dogs hides cat splits');
    const tileText = async () => p.$$eval('.stat-tile', (els) => els.map((e) => [...e.children].map((c) => c.textContent.trim()).join(' ')));
    ok(/Today's engagements/.test(await text()), 'Dogs talks about engagements');
    await p.screenshot({ path: h.shot('stats-dogs-today.png'), fullPage: true });

    await p.click('#statsRangeToggle');
    await p.waitForSelector('#statsByDogHeading');
    const poo = await p.$$eval('.bd-row', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
    ok(poo.some((r) => /^POO/.test(r) && /1 walk\b/.test(r)) && poo.some((r) => /^Non-POO/.test(r) && /1 walk\b/.test(r)), "lifetime POO counts the sticker as it was at the time, walks only (Rocket's cuddle left out)");
    ok(await p.$eval('.bd-row[data-bd-activity="walk"]', (row) => {
      const next = row.nextElementSibling;
      return !!next && next.classList.contains('bd-sub') && /POO vs non-POO/.test(next.textContent) && /All 2 walks above/.test(next.textContent);
    }), 'the POO split sits right under the Walk row');
    await p.screenshot({ path: h.shot('stats-dogs-lifetime.png'), fullPage: true });

    await p.click('.seg-btn[data-stats-species="cat"]');
    await p.waitForFunction(() => document.querySelector('.seg-btn[data-stats-species="cat"].on'));
    ok((await p.textContent('#statsByDogHeading')).trim() === 'By Cat', 'By Cat, not By Dog');
    ok(/Kittens vs adult cats/.test(await text()) && !/POO vs non-POO/.test(await text()), 'cats get kittens, not POO');
    const names = await p.$$eval('#byDogList .dog-name', (els) => els.map((e) => e.textContent.trim().split(/\s/)[0]).sort().join(','));
    ok(names === 'Mittens,Pip', 'only cats listed');
    ok(!/Cats here now|Cats in foster/.test(await text()), 'no shelter-now tiles on My stats for cats either');
    await p.screenshot({ path: h.shot('stats-cats-lifetime.png'), fullPage: true });

    // Together follows the same switch.
    await p.click('.seg-btn[data-scope="together"]');
    await p.waitForSelector('text=Since');
    ok(await p.$eval('.seg-btn[data-stats-species="cat"]', (e) => e.classList.contains('on')), 'Together keeps the species');
    ok(!/undefined/.test(await text()), 'Together breakdown reads cleanly (no "undefined")');
    ok(!/Cats in foster/.test(await text()), 'Together has no shelter-now box either -- moved to Shelter');
    await p.screenshot({ path: h.shot('together-cats.png'), fullPage: true });

    // Shelter trends follow the switch: cats get their own charts, plus the
    // breakdown tiles that used to live on My stats and Together.
    await p.click('.seg-btn[data-scope="shelter"]');
    await p.waitForFunction(() => /Cats at the shelter/.test(document.getElementById('app').textContent));
    const shelterTiles = await tileText();
    ok(/^3 At the shelter now/.test(shelterTiles[0]) && /^2 In foster now/.test(shelterTiles[1]), 'cat tiles: at the shelter and in foster, separately');
    ok(/^1 Brought in/.test(shelterTiles[2]), 'the cat import day is not counted as brought in');
    ok(/Cats in foster/.test(await text()) && await p.locator('.trend-chart').count() === 3, 'shelter, in/out and foster charts');
    await p.waitForSelector('[data-shelter-drill]');
    ok(shelterTiles.some((t) => /^1 Kittens/.test(t)) && shelterTiles.some((t) => /^2 Adult cats/.test(t)), 'kittens vs adult cats, now on Shelter');
    await p.screenshot({ path: h.shot('shelter-cats.png'), fullPage: true });

    // Tapping a breakdown tile jumps to Available, filtered to just that
    // slice -- "how many" lives here, "which ones" is a tap away.
    await p.click('[data-shelter-drill]:has-text("Kittens")');
    await p.waitForSelector('.avail-card');
    ok(await p.locator('.avail-card').count() === 1, 'Kittens tile opens Available filtered to just the one kitten');
    ok((await p.textContent('.avail-card .dog-name')).trim().startsWith('Pip'), 'and it is Pip');
    ok(await p.$eval('.seg-btn[data-species-view="cat"]', (e) => e.classList.contains('on')), 'Available switched to cats too');

    await p.click('.tab-btn[data-tab="stats"]');
    await p.waitForFunction(() => /Cats at the shelter/.test(document.getElementById('app').textContent));
    await p.click('.seg-btn[data-stats-species="dog"]');
    await p.waitForFunction(() => /Dogs at the shelter/.test(document.getElementById('app').textContent));
    const dogShelterTiles = await tileText();
    ok(/^2 At the shelter now/.test(dogShelterTiles[0]), 'dogs on Shelter after switching');
    ok(dogShelterTiles.some((t) => /^1 POO dogs/.test(t)) && dogShelterTiles.some((t) => /^1 Non-POO dogs/.test(t)), 'POO / non-POO tiles, now on Shelter');

    await p.click('[data-shelter-drill]:has-text("Non-POO dogs")');
    await p.waitForSelector('.avail-card');
    ok(await p.locator('.avail-card').count() === 1, 'Non-POO dogs tile opens Available filtered to just one dog (the foster dog Bo is excluded by default)');
    ok((await p.textContent('.avail-card .dog-name')).trim().startsWith('Rocket'), 'and it is Rocket, not Biscuit (POO)');

    await p.click('.tab-btn[data-tab="stats"]');
    await p.click('.seg-btn[data-scope="shelter"]');
    await p.waitForFunction(() => /Dogs at the shelter/.test(document.getElementById('app').textContent));
    await p.click('.seg-btn[data-stats-species="cat"]');
    await p.waitForFunction(() => /Cats at the shelter/.test(document.getElementById('app').textContent));

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
    await p.screenshot({ path: h.shot('tags-profile.png'), fullPage: true });
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

    // Someone who only works with dogs gets no switch at all.
    const dogDb = new Database(DB);
    dogDb.prepare("UPDATE users SET species_pref='dog' WHERE id=?").run(me.id);
    dogDb.close();
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="stats"]');
    await p.click('.seg-btn[data-scope="mine"]');
    await p.waitForSelector("text=Today's Stats");
    ok(await p.locator('[data-stats-species]').count() === 0, 'dogs only: no Dogs / Cats switch');
    ok(!/Cats here now|Cats in foster/.test(await text()), 'dogs only: no cat numbers');
    await p.click('.seg-btn[data-scope="shelter"]');
    await p.waitForFunction(() => /Dogs at the shelter/.test(document.getElementById('app').textContent));
    ok(await p.locator('[data-stats-species]').count() === 0, 'dogs only: Shelter has no switch either');

    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await b.close();
    console.log('stats-species-tags: all good');
  } finally { await h.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
