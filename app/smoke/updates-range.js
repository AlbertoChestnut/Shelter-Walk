// Updates time filter: All / Today / This week / Custom (from–to), with a
// count of what the range returns.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/updates-range.js
process.env.TZ = 'America/New_York'; // seed times in the same clock the browser uses
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3992, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_updrange.db', EMAIL = 'v@example.com';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00', TZ: 'America/New_York' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB);
    db.prepare("UPDATE users SET name = 'Val', experience_level='beginner', onboarding_completed=1 WHERE id = ?").run(me.id);
    const ts = new Date().toISOString();
    const dog = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, date_in_shelter, still_listed, first_seen_at, last_seen_at) VALUES (?, ?, 'Female', '2 Years', '2026-07-01T00:00:00', 1, ?, ?)");
    const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES (?, ?, ?, ?)');
    // Fixed local times relative to the browser's (and server's) clock.
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const at = (daysAgo, hour) => { const d = new Date(midnight); d.setDate(d.getDate() - daysAgo); d.setHours(hour); return d; };
    const sunday = new Date(midnight); sunday.setDate(sunday.getDate() - sunday.getDay());
    const seed = [['Today1', 'new_dog', at(0, 0)], ['Today2', 'adopted', at(0, 0)], ['TenDays', 'adopted', at(10, 9)], ['TwentyDays', 'returned', at(20, 15)]];
    seed.forEach(([name, kind, when], i) => { dog.run(100 + i, name, ts, ts); ev.run(kind, 100 + i, `${name} ${kind}`, when.toISOString()); });
    const weekExtra = new Date(sunday); weekExtra.setMinutes(1);
    if (weekExtra < midnight) { dog.run(110, 'ThisWeek', ts, ts); ev.run('new_dog', 110, 'ThisWeek new_dog', weekExtra.toISOString()); }
    db.close();
    const expectWeek = weekExtra < midnight ? 3 : 2;

    const b = await chromium.launch();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York', extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="updates"]');
    const count = async (n) => { await p.waitForFunction((n) => { const e = document.querySelector('.result-count strong'); return e && e.textContent === String(n); }, n); return p.$eval('.result-count', (e) => e.textContent.trim()); };
    ok((await count(4 + expectWeek - 2)).startsWith(`${4 + expectWeek - 2} updates`), 'All shows everything');
    await p.click('[data-updates-range="today"]');
    ok((await count(2)) === '2 updates · 1 adopted · 1 new', 'Today shows only today, with a breakdown');
    await p.click('[data-updates-range="week"]');
    ok((await count(expectWeek)).includes('since'), `This week shows ${expectWeek} since Sunday`);
    await p.click('[data-updates-range="custom"]');
    const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await p.fill('#updatesFromInput', local(at(25, 0))); await p.dispatchEvent('#updatesFromInput', 'change');
    await p.waitForSelector('#updatesToInput');
    await p.fill('#updatesToInput', local(at(5, 0))); await p.dispatchEvent('#updatesToInput', 'change');
    ok((await count(2)) === '2 updates · 1 adopted · 1 returned', 'Custom from–to shows only that window');
    await p.screenshot({ path: '/tmp/_updrange1.png' });
    await p.fill('#updatesFromInput', local(at(15, 0))); await p.dispatchEvent('#updatesFromInput', 'change');
    await p.fill('#updatesToInput', local(at(12, 0))); await p.dispatchEvent('#updatesToInput', 'change');
    await p.waitForFunction(() => /No updates in this time range/.test(document.body.textContent));
    ok(await p.locator('[data-updates-range="custom"].on').count() === 1, 'empty range keeps the filter bar');
    ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join('; ') : ''));
    await b.close();
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
