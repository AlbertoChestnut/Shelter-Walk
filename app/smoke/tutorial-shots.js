// Tutorial screenshots: boots the real server on a throwaway DB full of demo
// dogs, then walks through every screen in headless Chromium at phone size
// and saves a PNG of each to docs/tutorial/. The Scan step is a real scan: a
// fake camera plays a kennel card with a QR code on it.
// Needs Playwright, which isn't an app dependency:
//   npm i --no-save playwright@1 && npx playwright install chromium
//   node smoke/tutorial-shots.js
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-shots-'));
const dbFile = path.join(dir, 'shots.db');
const outDir = path.join(__dirname, '..', '..', 'docs', 'tutorial');
const EMAIL = 'tutorial@example.com';
const NEW_EMAIL = 'newcomer@example.com';
const SCAN_ID = 262826; // Axel Rose, the dog on the kennel card photo

// The kennel card photo (docs/tutorial/kennel-card.jpg) has a QR code and a
// barcode that both hold the dog's ID. Each fake-camera "video" is a still
// crop of one of them, in the y4m format Chromium's fake camera plays.
const CARD_PHOTO = path.join(outDir, 'kennel-card.jpg');
const CROPS = { qr: [929, 466, 320, 240], barcode: [729, 881, 320, 240] }; // x, y, w, h in the photo

async function writeCameraVideos(browser) {
  const page = await browser.newPage();
  await page.setContent('<canvas></canvas>');
  const img = fs.readFileSync(CARD_PHOTO).toString('base64');
  const files = {};
  for (const [name, crop] of Object.entries(CROPS)) {
    const W = 640, H = 480;
    const rgba = await page.evaluate(async ({ img, crop, W, H }) => {
      const im = new Image(); im.src = `data:image/jpeg;base64,${img}`; await im.decode();
      const cv = document.querySelector('canvas'); cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.drawImage(im, crop[0], crop[1], crop[2], crop[3], 0, 0, W, H);
      return Array.from(g.getImageData(0, 0, W, H).data);
    }, { img, crop, W, H });
    const Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        Y[y * W + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        if (y % 2 === 0 && x % 2 === 0) {
          const j = (y / 2) * (W / 2) + x / 2;
          U[j] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
          V[j] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
        }
      }
    }
    const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, U, V]);
    files[name] = path.join(dir, `${name}.y4m`);
    fs.writeFileSync(files[name], Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(10).fill(frame)]));
  }
  await page.close();
  return files;
}

// The photo with the two codes outlined, for the tutorial.
async function shotKennelCard(browser, file) {
  const page = await browser.newPage({ viewport: { width: 760, height: 1010 }, deviceScaleFactor: 1 });
  const img = fs.readFileSync(CARD_PHOTO).toString('base64');
  const box = (c, color, label) => `<div style="position:absolute;left:${c[0] - 6}px;top:${c[1] - 6}px;width:${c[2] + 12}px;height:${c[3] + 12}px;
    border:6px solid ${color};border-radius:10px;box-sizing:border-box"></div>
    <div style="position:absolute;left:${c[0] - 6}px;top:${c[1] + c[3] + 8}px;background:${color};color:#fff;font:bold 22px sans-serif;padding:4px 10px;border-radius:6px">${label}</div>`;
  await page.setContent(`<body style="margin:0"><div style="position:relative;width:760px;height:1010px;overflow:hidden">
    <img src="data:image/jpeg;base64,${img}" style="position:absolute;left:-10px;top:-80px;width:768px">
    ${box([506, 184, 58, 60], '#2f6f4f', 'QR code')}
    ${box([377, 383, 125, 80], '#c0392b', 'Barcode')}
    <div style="position:absolute;left:20px;bottom:20px;right:20px;background:rgba(0,0,0,.75);color:#fff;font:bold 26px sans-serif;padding:12px 16px;border-radius:10px;text-align:center">Scan either one. Both hold the dog's ID.</div>
  </div></body>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: file });
  await page.close();
}

// Hold back the scanner's "got it" until the camera screenshot is taken,
// so the picture shows the camera aimed at the code.
function holdScans() {
  let real;
  Object.defineProperty(window, 'Html5Qrcode', {
    configurable: true,
    get() { return real; },
    set(v) {
      real = v;
      const start = v.prototype.start;
      v.prototype.start = function (cam, cfg, ok, err) {
        return start.call(this, cam, cfg, (t) => { if (window.__allowScan) ok(t); }, err);
      };
    }
  });
}

function seed(db, meId) {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const DAY = 86400000;
  const ins = db.prepare(`INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, weight, desexed, location, date_in_shelter,
    summary, still_listed, first_seen_at, last_seen_at, kennel_location, tags, blue_markers, star_flag, pb_flag, poo_status)
    VALUES (?, ?, ?, ?, ?, ?, 'Yes', 'Shelter', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const dogs = [
    // id, name, sex, age, breed, weight, days in, kennel, blue, star, pb, poo, extra tags
    [SCAN_ID, 'Axel Rose', 'Male', '12 Years', 'Boxer Mix', '64 lbs', 39, 'B', [], 0, 0, 'poo', []],
    [48102, 'Pepper', 'Female', '2 Years', 'Beagle', '24 lbs', 23, 'A', ['blue', 'blue_j'], 0, 0, 'none', ['Best in Home without Cats']],
    [48377, 'Duke', 'Male', '5 Years', 'German Shepherd', '76 lbs', 64, 'C', ['blue', 'blue_evo', 'blue_r'], 0, 0, 'none', []],
    [48455, 'Luna', 'Female', '1 Year', 'Pit Bull Terrier', '48 lbs', 12, 'D', [], 1, 0, 'poo', []],
    [48510, 'Waffles', 'Male', '4 Months', 'Hound Mix', '19 lbs', 30, 'A', [], 0, 0, 'none', []],
    [48588, 'Rosie', 'Female', '7 Years', 'Boxer', '61 lbs', 9, 'E', [], 0, 1, 'none', []],
    [48631, 'Tank', 'Male', '6 Years', 'Mastiff Mix', '92 lbs', 112, 'C', ['blue', 'blue_p'], 0, 0, 'priority', []],
    [48702, 'Mabel', 'Female', '2 Years', 'Terrier Mix', '33 lbs', 3, 'B', [], 0, 0, 'none', []]
  ];
  for (const [id, name, sex, age, breed, weight, daysIn, kennel, blue, star, pb, poo, tags] of dogs) {
    ins.run(id, name, sex, age, breed, weight, iso(daysIn * DAY).slice(0, 19), `${name} is a sweet ${breed.toLowerCase()} looking for a home.`,
      iso(daysIn * DAY), iso(0), kennel, JSON.stringify(['Dog', 'Shelter', breed, ...tags]), JSON.stringify(blue), star, pb, poo);
  }

  // Other volunteers' walks (for Together and walk counts) and some of mine (for Stats).
  const others = ['Sam', 'Riley', 'Jordan'].map((n) =>
    db.prepare("INSERT INTO users (name, created_at, experience_level, onboarding_completed) VALUES (?, ?, 'established', 1)").run(n, iso(90 * DAY)).lastInsertRowid);
  const walk = db.prepare(`INSERT INTO walks (dog_id, location, started_at, ended_at, duration_seconds, notes, user_id, activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const walkable = dogs.filter((d) => d[4] !== 'Hound Mix');
  let k = 0;
  for (let day = 1; day <= 13; day += 1) {
    for (let i = 0; i < 5; i += 1) {
      const d = walkable[(day * 3 + i) % walkable.length];
      const mins = 12 + ((day * 7 + i * 5) % 22);
      const start = day * DAY - (9 + i) * 3600000;
      const user = (k += 1) % 4 === 0 ? meId : others[k % 3];
      const activity = k % 9 === 0 ? 'playgroup' : k % 7 === 0 ? 'cuddle' : 'walk';
      walk.run(d[0], d[7], iso(start), iso(start - mins * 60000), mins * 60, null, user, activity);
    }
  }
  walk.run(48102, 'A', iso(2 * 3600000), iso(2 * 3600000 - 18 * 60000), 18 * 60, 'Loves the side field. Jumps when excited, turn away and she settles.', meId, 'walk');
  walk.run(48455, 'D', iso(5 * 3600000), iso(5 * 3600000 - 25 * 60000), 25 * 60, null, others[0], 'walk');

  const note = db.prepare("INSERT INTO dog_notes (dog_id, user_id, visibility, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  note.run(SCAN_ID, others[0], 'public', 'Hears less than he used to. Let him see you before you touch him.', iso(3 * DAY), iso(3 * DAY));
  note.run(SCAN_ID, others[1], 'public', 'Walks calmly past barking dogs and doesn\'t pull. Loves full-body scratches.', iso(DAY), iso(DAY));

  const ev = db.prepare('INSERT INTO shelter_events (kind, dog_id, title, occurred_at) VALUES (?, ?, ?, ?)');
  ev.run('new_dog', 48702, 'Mabel arrived', iso(3 * DAY));
  ev.run('returned', 48588, 'Rosie came back', iso(2 * DAY));
  ev.run('new_dog', 48455, 'Luna arrived', iso(12 * DAY));
  db.prepare("UPDATE users SET name = 'Alex', experience_level = 'established', onboarding_completed = 1 WHERE id = ?").run(meId);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.rmSync(path.join(outDir, f));
  const server = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  let browser;
  try {
    for (let i = 0; i < 50; i += 1) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const me = await (await fetch(`${base}/api/me`, { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(dbFile);
    seed(db, me.id);
    db.close();

    const plain = await chromium.launch();
    const videos = await writeCameraVideos(plain);
    const cameraBrowser = (video) => chromium.launch({
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`]
    });
    browser = await cameraBrowser(videos.qr);
    const newCtx = (email) => browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': email },
      serviceWorkers: 'block', permissions: ['camera'], colorScheme: 'light'
    });
    let n = 0;
    const shot = async (page, name, opts = {}) => {
      n += 1;
      const file = path.join(outDir, `${String(n).padStart(2, '0')}-${name}.png`);
      if (opts.top) await page.evaluate(() => { document.getElementById('app').scrollTop = 0; });
      await page.waitForTimeout(opts.wait ?? 400);
      await page.screenshot({ path: file });
      console.log(`  ${path.basename(file)}`);
    };

    // First sign-in: the welcome steps.
    const fresh = await (await newCtx(NEW_EMAIL)).newPage();
    await fresh.goto(base, { waitUntil: 'networkidle' });
    await fresh.waitForSelector('#onboardingNameInput');
    await fresh.fill('#onboardingNameInput', 'Jamie');
    await shot(fresh, 'welcome-name');
    await fresh.click('#onboardingNameNext');
    await shot(fresh, 'welcome-experience', { wait: 700 });
    await fresh.close();

    const ctx = await newCtx(EMAIL);
    await ctx.addInitScript(holdScans);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.avail-card');
    await shot(page, 'available');
    await page.click('#toggleMoreFiltersBtn');
    await shot(page, 'available-filters');
    await page.click('#toggleMoreFiltersBtn');

    // Scanning a dog: the card, the QR code, then the barcode (its own
    // browser, since the fake camera's picture is set at launch).
    n += 1;
    await shotKennelCard(plain, path.join(outDir, `${String(n).padStart(2, '0')}-kennel-card.png`));
    console.log(`  ${String(n).padStart(2, '0')}-kennel-card.png`);
    await plain.close();
    await page.click('.tab-btn[data-tab="walk"]');
    await page.waitForSelector('#qr-reader video');
    await shot(page, 'scan-camera-qr', { wait: 1500 });
    const barcodeBrowser = await cameraBrowser(videos.barcode);
    try {
      const bctx = await barcodeBrowser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, extraHTTPHeaders: { 'x-auth-email': EMAIL },
        serviceWorkers: 'block', permissions: ['camera'], colorScheme: 'light'
      });
      await bctx.addInitScript(holdScans);
      const bpage = await bctx.newPage();
      await bpage.goto(base, { waitUntil: 'networkidle' });
      await bpage.click('.tab-btn[data-tab="walk"]');
      await bpage.waitForSelector('#qr-reader video');
      await shot(bpage, 'scan-camera-barcode', { wait: 1500 });
      await bpage.evaluate(() => { window.__allowScan = true; });
      await bpage.waitForSelector('#startWalkBtn', { timeout: 10000 });
      if (!/Axel Rose/.test(await bpage.textContent('.dog-name'))) throw new Error('barcode scan found the wrong dog');
      console.log('  (barcode scan found Axel Rose)');
    } finally {
      await barcodeBrowser.close();
    }
    await page.evaluate(() => { window.__allowScan = true; });
    await page.waitForSelector('#startWalkBtn', { timeout: 10000 });
    if (!/Axel Rose/.test(await page.textContent('.dog-name'))) throw new Error('QR scan found the wrong dog');
    await shot(page, 'scan-dog-found', { wait: 800 });
    await page.locator('#backToScanBtn2').scrollIntoViewIfNeeded();
    await shot(page, 'scan-start-walk');
    await page.click('#changeActivityBtn');
    await page.locator('#startWalkBtn').scrollIntoViewIfNeeded();
    await shot(page, 'scan-change-activity');
    await page.click('#changeActivityBtn');
    await page.click('#startWalkBtn');
    await page.waitForSelector('#endWalkBtn');
    await shot(page, 'walk-in-progress', { wait: 4000, top: true });
    await page.waitForTimeout(58000); // so the finished walk reads 1 min, not 0
    await page.click('#endWalkBtn');
    await page.waitForSelector('#saveWalkBtn');
    await page.fill('#walkNotes', 'Great walk! Calm around other dogs on the trail.');
    await shot(page, 'walk-end-notes', { top: true });
    await page.click('#saveWalkBtn');
    await page.waitForSelector('#doneBtn');
    await shot(page, 'walk-complete', { top: true });
    await page.click('#doneBtn');

    // Name search instead of the camera.
    await page.click('.tab-btn[data-tab="walk"]');
    await page.click('#manualSearchInput');
    await page.fill('#manualSearchInput', 'du');
    await page.waitForSelector('.search-result');
    await shot(page, 'scan-search-by-name', { wait: 700 });
    await page.click('.search-result .dog-meta');
    await page.waitForSelector('#startWalkBtn');
    await shot(page, 'scan-not-cleared', { wait: 600, top: true });

    // A dog that can't be walked at all.
    await page.click('.tab-btn[data-tab="available"]');
    await page.locator('.avail-card[data-id="48510"] .walk-edit-btn').click();
    await page.waitForSelector('#startWalkBtn');
    await shot(page, 'scan-too-young', { wait: 600, top: true });
    await page.click('.tab-btn[data-tab="available"]');

    // Dog info.
    await page.locator('.avail-card[data-id="48102"] .view-profile-btn').click();
    await shot(page, 'dog-info', { wait: 800 });
    await page.evaluate(() => history.back());
    await page.waitForTimeout(400);

    // The other tabs and menus.
    await page.click('.tab-btn[data-tab="stats"]');
    await page.waitForSelector('.edit-times-btn');
    await shot(page, 'stats', { top: true });
    const together = page.locator('text=Together').first();
    if (await together.count()) { await together.click(); await shot(page, 'stats-together', { wait: 800 }); }
    await page.click('.tab-btn[data-tab="updates"]');
    await shot(page, 'updates', { wait: 800 });
    await page.click('#guideBtn');
    await shot(page, 'guide', { wait: 800 });
    await page.click('.tab-btn[data-tab="available"]');
    await page.click('#settingsBtn');
    await shot(page, 'settings');
    await page.click('#closeSettingsBtn');
    await page.click('#userBtn');
    await shot(page, 'account');
    console.log(`Saved ${n} screenshots to ${outDir}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
