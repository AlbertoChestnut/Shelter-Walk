// Shared harness for browser smokes: boots the server on a free port against a
// throwaway DB and image folders (via test/_helpers.js), and launches Chromium
// with the shelter's time zone (or SMOKE_TZ) unless a context sets its own.
//
//   const { startSmoke, launch } = require('./_harness');
//   const h = await startSmoke();          // { base, dbFile, dir, shot(), stop() }
//   const b = await launch();              // newContext()/newPage() get timezoneId
//   await p.screenshot({ path: h.shot('name.png') });
//
// Screenshots go to the temp folder (deleted on stop) unless SMOKE_SHOTS_DIR is
// set, in which case they're kept there as <script>-<name>.
// Needs Playwright (a devDependency): npx playwright install chromium
// The same pinned clock as npm test (test/_clock.js): this process, the
// server it starts and every browser context run at noon at the shelter on
// today's date, so smokes that seed walks "an hour ago" also pass just after
// midnight. TEST_CLOCK=real turns it off.
require('../test/_clock');
const path = require('path');
const fs = require('fs');
const { startServer } = require('../test/_helpers');

const SMOKE_TZ = process.env.SMOKE_TZ || 'America/New_York';
const SCRIPT = path.basename(require.main ? require.main.filename : 'smoke', '.js');

async function startSmoke({ env = {}, prefix } = {}) {
  const server = await startServer({ env, prefix: prefix || `sw-smoke-${SCRIPT}-` });
  const shotsDir = process.env.SMOKE_SHOTS_DIR;
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  let stopped = false;
  return {
    ...server,
    shot: (name) => (shotsDir ? path.join(shotsDir, `${SCRIPT}-${name}`) : path.join(server.dir, name)),
    async stop() {
      if (stopped) return;
      stopped = true;
      await server.stop();
      fs.rmSync(server.dir, { recursive: true, force: true });
    }
  };
}

// chromium.launch(), with newContext()/newPage() defaulting timezoneId to
// SMOKE_TZ. An explicit timezoneId in the options still wins.
async function launch(opts) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch(opts);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (o = {}) => {
    const ctx = await newContext({ timezoneId: SMOKE_TZ, ...o });
    // Every page (and frame) gets the same fixed offset as this process, so
    // its clock keeps ticking in step with the server's across reloads and
    // new pages. (Playwright's own clock restarts on each new page.) Smokes
    // that call page.clock themselves still override it.
    const offset = Number(process.env.TEST_CLOCK_OFFSET_MS);
    if (process.env.TEST_CLOCK !== 'real' && Number.isFinite(offset) && offset !== 0) {
      await ctx.addInitScript((ms) => {
        const RealDate = Date;
        class TestDate extends RealDate {
          constructor(...args) { if (args.length === 0) super(RealDate.now() + ms); else super(...args); }
          static now() { return RealDate.now() + ms; }
        }
        globalThis.Date = TestDate;
      }, offset);
    }
    return ctx;
  };
  browser.newPage = async (o = {}) => {
    const ctx = await browser.newContext(o);
    const page = await ctx.newPage();
    // Like Browser.newPage(): closing the page closes its own context.
    page.on('close', () => { ctx.close().catch(() => {}); });
    return page;
  };
  return browser;
}

module.exports = { startSmoke, launch, SMOKE_TZ };
