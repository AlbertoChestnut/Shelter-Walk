// A kennel card whose dog isn't in the shelter's listing yet: the scan shows
// the not-listed-yet screen, the walk starts on the card's Animal ID, and once
// the listing has the dog, the walk shows under the real dog.
// Needs Playwright: npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/unlisted-card.js
const { spawn } = require('child_process'); const { chromium } = require('playwright'); const Database = require('better-sqlite3'); const fs = require('fs'); const QRCode = require('qrcode');
const PORT = 3994, base = `http://127.0.0.1:${PORT}`, DB = '/tmp/_unl.db', EMAIL = 'u@example.com', ID = 262999;
const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };
function video(file) {
  const W = 640, H = 480; const qr = QRCode.create(JSON.stringify({ Url: 'http://wakecounty.shelterbuddy.com', AnimalId: String(ID) }), { errorCorrectionLevel: 'M' }).modules;
  const sc = 7, px = qr.size * sc, x0 = (W - px) >> 1, y0 = (H - px) >> 1; const Y = Buffer.alloc(W * H, 235);
  for (let r = 0; r < qr.size; r++) for (let c = 0; c < qr.size; c++) if (qr.data[r * qr.size + c]) for (let y = 0; y < sc; y++) for (let x = 0; x < sc; x++) Y[(y0 + r * sc + y) * W + x0 + c * sc + x] = 20;
  const UV = Buffer.alloc(W * H / 4, 128); const f = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(f)]));
}
(async () => {
  fs.rmSync(DB, { force: true }); video('/tmp/_unl.y4m');
  const srv = spawn('node', ['src/server.js'], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' }, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch (e) {} await new Promise((r) => setTimeout(r, 100)); }
    const me = await (await fetch(base + '/api/me', { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(DB); db.prepare("UPDATE users SET name='U', experience_level='beginner', onboarding_completed=1 WHERE id=?").run(me.id); db.close();
    const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=/tmp/_unl.y4m'] });
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block', permissions: ['camera'] });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base, { waitUntil: 'networkidle' });
    await p.click('.tab-btn[data-tab="walk"]');
    await p.waitForSelector('.unlisted-card', { timeout: 15000 });
    const txt = await p.textContent('.unlisted-card');
    ok(/ID 262999/.test(txt) && /don't have this dog's details yet/.test(txt), 'scan of an unknown card shows the not-listed-yet screen');
    await p.waitForTimeout(400); await p.screenshot({ path: '/tmp/_unl1.png' });
    await p.click('#locationPicker [data-letter="D"]');
    await p.click('#startWalkBtn'); await p.waitForSelector('#endWalkBtn'); await p.waitForTimeout(500);
    ok(/Dog #262999/.test(await p.textContent('.walk-dog-name')), 'walk started as Dog #262999');
    ok(/Return to:.*D/.test(await p.textContent('.walk-location')), 'return-to kennel D kept');
    ok(await p.isVisible('.unlisted-note'), 'walk screen says the details are coming');
    await p.screenshot({ path: '/tmp/_unl2.png' });
    await p.click('#endWalkBtn'); await p.waitForSelector('#saveWalkBtn'); await p.click('#saveWalkBtn'); await p.waitForSelector('#doneBtn');
    // The listing arrives: same row gets real details.
    const db2 = new Database(DB); db2.prepare("UPDATE dogs SET name='Biscuit', age='2 Years', breed='Lab', still_listed=1, awaiting_listing=0, date_in_shelter=? WHERE shelter_buddy_id=?").run(new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 19), ID); db2.close();
    await p.click('#doneBtn'); await p.click('.tab-btn[data-tab="stats"]'); await p.waitForSelector('.edit-times-btn');
    ok(/Biscuit/.test(await p.textContent('#app')), "today's walk now shows under the real dog in Stats");
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await b.close();
  } finally { srv.kill(); fs.rmSync(DB, { force: true }); }
})().catch((e) => { console.error(e.message); process.exit(1); });
