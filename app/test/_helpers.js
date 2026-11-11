// Shared helpers for tests: boot the real server on a free port against a
// throwaway DB and image folders, and isolate in-process tests the same way.
// Not a test file itself (node --test only picks up *.test.js).
const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, '..');
const STARTUP_TIMEOUT_MS = 30000;
const OUTPUT_LIMIT = 64 * 1024;

// A throwaway folder with its own DB path and image folders.
function tempDirs(prefix = 'sw-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    dbFile: path.join(dir, 'test.db'),
    imagesDir: path.join(dir, 'images'),
    wikiImagesDir: path.join(dir, 'wiki-images')
  };
}

// For tests that require src/ modules directly (scraper, db): point every
// path the app writes to at a temp folder and turn scraper pauses off.
// Call before the first require of ../src/*. Returns the temp paths.
function isolateEnv(prefix = 'sw-test-', { dbFile } = {}) {
  const t = tempDirs(prefix);
  if (dbFile) t.dbFile = dbFile;
  process.env.DB_PATH = t.dbFile;
  process.env.IMAGES_DIR = t.imagesDir;
  process.env.WIKI_IMAGES_DIR = t.wikiImagesDir;
  process.env.SCRAPER_DELAY_SCALE = '0';
  return t;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Starts src/server.js. Options:
//   env     extra env vars (override the defaults below)
//   dbFile  reuse an existing DB file (e.g. to restart on the same data)
//   prefix  mkdtemp prefix for the temp folder
//   dir     reuse an existing temp folder
// Returns { base, port, dbFile, dir, proc, output(), stop() }. Throws with the
// server's output if it doesn't answer /healthz within 30 s or exits early.
async function startServer({ env = {}, dbFile, prefix = 'sw-test-', dir } = {}) {
  const t = dir ? { dir, dbFile: path.join(dir, 'test.db'), imagesDir: path.join(dir, 'images'), wikiImagesDir: path.join(dir, 'wiki-images') } : tempDirs(prefix);
  if (dbFile) t.dbFile = dbFile;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await freePort();
    try {
      return await boot(port, t, env);
    } catch (err) {
      lastError = err;
      if (!err.addrInUse) throw err;
    }
  }
  throw lastError;
}

async function boot(port, t, env) {
  let out = '';
  const keep = (chunk) => { out += chunk; if (out.length > OUTPUT_LIMIT) out = out.slice(-OUTPUT_LIMIT); };
  const proc = spawn(process.execPath, ['src/server.js'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DISABLE_SCRAPER: '1',
      WALK_HOURS: '00:00-24:00',
      SCRAPER_DELAY_SCALE: '0',
      IMAGES_DIR: t.imagesDir,
      WIKI_IMAGES_DIR: t.wikiImagesDir,
      ...env,
      PORT: String(port),
      DB_PATH: t.dbFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.setEncoding('utf8').on('data', keep);
  proc.stderr.setEncoding('utf8').on('data', keep);
  let exited = null;
  const exitPromise = new Promise((r) => proc.on('exit', (code, signal) => { exited = { code, signal }; r(); }));
  const killOnExit = () => { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } };
  process.on('exit', killOnExit);

  const base = `http://127.0.0.1:${port}`;
  const server = {
    base,
    port,
    dbFile: t.dbFile,
    dir: t.dir,
    proc,
    output: () => out,
    async stop() {
      process.removeListener('exit', killOnExit);
      if (!exited) { proc.kill(); await exitPromise; }
    }
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) break;
    // Any HTTP answer means it's listening (healthz may report a stale scrape
    // with a non-200, which is irrelevant with the scraper off).
    try {
      await (await fetch(`${base}/healthz`)).arrayBuffer();
      return server;
    } catch (e) { /* not up yet */ }
    await sleep(100);
  }
  await server.stop();
  const err = new Error(exited
    ? `server exited early (code ${exited.code}, signal ${exited.signal}). Output:\n${out}`
    : `server did not answer /healthz within ${STARTUP_TIMEOUT_MS / 1000} s. Output:\n${out}`);
  err.addrInUse = /EADDRINUSE/.test(out);
  throw err;
}

// A shelter-day key (YYYY-MM-DD) `days` days from today, by the test clock.
// Use it instead of a typed-out future date, which turns into "already
// passed" once the calendar catches up (audit3; CI runs npm run test:future).
function shelterDayFromToday(days = 0) {
  const { SHELTER_TZ } = require('../src/constants');
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: SHELTER_TZ });
  // Noon UTC of today's shelter date, then whole days: no DST edge in reach.
  const noon = Date.parse(`${fmt.format(new Date())}T12:00:00Z`);
  return new Date(noon + days * 86400000).toISOString().slice(0, 10);
}

module.exports = { startServer, isolateEnv, tempDirs, freePort, APP_DIR, shelterDayFromToday };
