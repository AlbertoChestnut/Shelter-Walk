// A dog that's off the shelter's site (say, adopted then returned before the
// listing caught up): the scan warns first to check the kennel card, then
// the walk goes ahead with a heads-up and is filed under the dog's ID.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/returned-dog.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs'); const QRCode = require('qrcode');
const PORT = 3995, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_ret.db', EMAIL = 'u@example.com', ID = 262999;
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
function video(file) {
  const W = 640, H = 480; const qr = QRCode.create(JSON.stringify({ Url: 'http://wakecounty.shelterbuddy.com', AnimalId: String(ID) }), { errorCorrectionLevel: 'M' }).modules;
  const sc = 7, px = qr.size * sc, x0 = (W - px) >> 1, y0 = (H - px) >> 1; const Y = Buffer.alloc(W * H, 235);
  for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.data[r * qr.size + c]) for (let y = 0; y < sc; y++) for (let x = 0; x < sc; x++) Y[(y0 + r * sc + y) * W + x0 + c * sc + x] = 20;
  const UV = Buffer.alloc(W * H / 4, 128); const f = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(f)]));
}
(async () => {
  fs.rmSync(DB, { force: true }); video('/tmp/_ret.y4m');
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); db.prepare("INSERT INTO dogs (shelter_buddy_id, name, age, date_in_shelter, still_listed, removed_at, first_seen_at, last_seen_at) VALUES (?, 'Girlfriend', '3 Years', '2026-07-01T00:00:00', 0, '2026-09-01', '2026-07-01', '2026-09-01')").run(ID); db.prepare("UPDATE users SET name='U', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id); db.close();
    const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/tmp/_ret.y4m'] });
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block', permissions: ['camera'] });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="walk"]');
    await p.waitForSelector('#appDialogOk', { state: 'visible', timeout: 15000 });
    ok(/not in the database anymore/.test(await p.textContent('#appDialogMessage')), 'warning popup shows first');
    await p.screenshot({ path: '/tmp/_ret0.png' });
    await p.click('#appDialogCancel'); await p.waitForTimeout(800);
    ok(!(await p.$('.walk-confirm')), 'Scan again goes back instead of opening the dog');
    await p.waitForSelector('#appDialogOk', { state: 'visible', timeout: 15000 });
    await p.click('#appDialogOk');
    await p.waitForSelector('.walk-confirm', { timeout: 15000 });
    ok(/Girlfriend isn't on the shelter's site right now/.test(await p.textContent('.walk-confirm')), 'confirm screen shows the heads-up');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn', { timeout: 5000 }); await p.waitForTimeout(400);
    ok(await p.isVisible('.unlisted-note'), 'walk screen keeps the heads-up');
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn'); await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    const n = new Database(DB).prepare('SELECT COUNT(*) c FROM walks WHERE dog_id=? AND ended_at IS NOT NULL').get(ID).c;
    ok(n === 1, 'walk saved under their ID');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
