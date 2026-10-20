// Welcome screen, name step: the "keep my name private while I'm out with a
// dog" box (ticked by default, like new accounts) and the example dog card
// showing how the name appears on the Available list during a walk.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/welcome-name-privacy.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs');
const PORT = 3997, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_wnp.db';
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
(async () => {
  fs.rmSync(DB, { force: true });
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const b = await chromium.launch();
    const welcome = async (email) => {
      const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': email }, serviceWorkers: 'block' });
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.goto(base, { waitUntil: 'networkidle' });
      await p.waitForSelector('#onboardingNameInput');
      return { p, ctx, errs };
    };
    const preview = (p) => p.textContent('#onboardingNamePreview');
    const hidden = (name) => { const db = new Database(DB, { readonly: true }); const r = db.prepare('SELECT hide_name_while_walking AS h FROM users WHERE name = ?').get(name); db.close(); return r && r.h; };

    let { p, ctx, errs } = await welcome('jamie@example.com');
    ok(await p.isChecked('#onboardingHideName'), 'private is ticked by default, like new accounts');
    await p.fill('#onboardingNameInput', 'Jamie Rivera');
    ok(/Currently being walked by a Volunteer$/.test(await preview(p)), 'example card says "a Volunteer" while private');
    await p.screenshot({ path: '/tmp/_wnp1.png' });
    await p.uncheck('#onboardingHideName');
    ok(/Currently being walked by Jamie Rivera$/.test(await preview(p)), 'unticked: example card shows the typed name');
    await p.fill('#onboardingNameInput', 'Jamie R');
    ok(/by Jamie R$/.test(await preview(p)), 'example updates as the name is typed');
    await p.screenshot({ path: '/tmp/_wnp2.png' });
    await p.click('#onboardingNameNext');
    await p.waitForFunction(() => !document.getElementById('onboardingNameInput'));
    ok(hidden('Jamie R') === 0, 'unticked choice saved: name shown while walking');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();

    ({ p, ctx, errs } = await welcome('kim@example.com'));
    await p.fill('#onboardingNameInput', 'Kim');
    await p.click('#onboardingNameNext');
    await p.waitForFunction(() => !document.getElementById('onboardingNameInput'));
    ok(hidden('Kim') === 1, 'left ticked: name stays private');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await ctx.close();
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
