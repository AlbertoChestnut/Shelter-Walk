// Browser smoke test: boots the real server on a throwaway DB, then drives
// the app in headless Chromium through the main volunteer flow (Available
// list + filters, starting a session, switching activity, ending it, Stats).
// Needs Playwright, which isn't an app dependency:
//   npm i --no-save playwright@1 && npx playwright install chromium
//   npm run smoke
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const PORT = 3900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-smoke-'));
const dbFile = path.join(dir, 'smoke.db');
const EMAIL = 'smoke@example.com';

async function main() {
  const server = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', WALK_HOURS: '00:00-24:00' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  let browser;
  const errors = [];
  try {
    for (let i = 0; i < 50; i += 1) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const me = await (await fetch(`${base}/api/me`, { headers: { 'x-auth-email': EMAIL } })).json();
    const db = new Database(dbFile);
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT INTO dogs (shelter_buddy_id, name, sex, age, breed, weight, desexed, location, date_in_shelter, still_listed, first_seen_at, last_seen_at, kennel_location, tags) VALUES (?, ?, ?, '3 Years', ?, ?, ?, 'Shelter', '2026-01-01T00:00:00', 1, ?, ?, 'B', ?)");
    ins.run(101, 'Biscuit', 'Male', 'Labrador', '55 lbs', 'Yes', now, now, JSON.stringify(['Dog', 'Shelter', 'Labrador']));
    ins.run(102, 'Pepper', 'Female', 'Beagle', '22 lbs', 'No', now, now, JSON.stringify(['Dog', 'Shelter', 'Beagle', 'Best in Home without Cats']));
    db.prepare("UPDATE users SET name = 'Smoke Test', experience_level = 'expert', onboarding_completed = 1 WHERE id = ?").run(me.id);
    db.close();

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { 'x-auth-email': EMAIL }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const step = (name) => console.log(`  ✓ ${name}`);

    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector('.avail-card');
    assert.equal(await page.locator('.avail-card').count(), 2);
    step('Available list shows both dogs');

    await page.click('#toggleMoreFiltersBtn');
    await page.click('.filter-chip[data-filter-key="male"]');
    assert.equal(await page.locator('.avail-card').count(), 1);
    await page.click('.advanced-filters summary');
    await page.click('.filter-chip[data-filter-key="male"]');
    await page.click('.filter-chip[data-filter-key="male"]');
    await page.click('.filter-chip[data-filter-key="size_small"]');
    assert.equal(await page.locator('.avail-card').count(), 1);
    await page.click('#clearFiltersBtn');
    assert.equal(await page.locator('.avail-card').count(), 2);
    step('Filters narrow and clear the list');

    await page.locator('.avail-card[data-id="101"] .walk-edit-btn').click();
    await page.waitForSelector('#startWalkBtn');
    await page.click('#changeActivityBtn');
    await page.click('#activityPickRow [data-activity="cuddle"]');
    assert.match(await page.textContent('#startWalkBtn'), /Start Cuddle/);
    await page.click('#startWalkBtn');
    await page.waitForSelector('#activityChoice');
    assert.match(await page.textContent('#endWalkBtn'), /End Cuddle/);
    step('Started a cuddle from the Available list');

    await page.click('#activityChoice [data-activity="playgroup"]');
    await page.waitForFunction(() => /End Play Group/.test(document.getElementById('endWalkBtn').textContent));
    step('Switched to play group mid-session');

    await page.click('#endWalkBtn');
    await page.waitForSelector('#saveWalkBtn');
    await page.click('#saveWalkBtn');
    await page.waitForSelector('#doneBtn');
    assert.match(await page.textContent('.walk-dog-name'), /play group with Biscuit/);
    await page.click('#doneBtn');
    step('Ended and saved it');

    await page.click('.tab-btn[data-tab="stats"]');
    await page.waitForSelector('.edit-times-btn');
    assert.match(await page.textContent('.dog-card .dog-name'), /🎾/);
    step('Stats lists it with the play group emoji');

    assert.deepEqual(errors, [], 'no JavaScript errors on the page');
    console.log('Smoke test passed.');
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('Smoke test FAILED:', err.message); process.exit(1); });
