// The module system (src/modules.js): discovery, the Settings tab's API
// (staff-only, toggle + config, takes effect without a restart), and
// migration idempotency.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 4500 + Math.floor(Math.random() * 90);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-modules-'));
const dbFile = path.join(dir, 'test.db');
const base = `http://127.0.0.1:${PORT}`;
let proc;
const WALKER = 'walker@example.com';
const STAFF = 'staff@example.com';

async function call(method, url, { user = WALKER, staff = false, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-auth-email': user, ...(staff ? { 'x-auth-staff': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, json };
}

test.before(async () => {
  proc = spawn('node', ['src/server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), DB_PATH: dbFile, DISABLE_SCRAPER: '1', DISABLE_MODULE_JOBS: '1', WALK_HOURS: '00:00-24:00' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) { try { if ((await fetch(`${base}/healthz`)).ok) break; } catch (e) { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
  await call('GET', '/api/me');
  await call('GET', '/api/me', { user: STAFF });
});
test.after(async () => { if (proc) { proc.kill(); await new Promise((r) => proc.on('exit', r)); proc = null; } });

test('GET /api/modules is staff-only and lists the discovered module, disabled by default', async () => {
  assert.equal((await call('GET', '/api/modules')).status, 403, 'non-staff refused');
  const r = await call('GET', '/api/modules', { staff: true });
  assert.equal(r.status, 200);
  const yt = r.json.modules.find((m) => m.id === 'youtube-channel');
  assert.ok(yt, 'the youtube-channel module is discovered');
  assert.equal(yt.enabled, false, 'disabled until an admin turns it on');
  assert.deepEqual(yt.configSchema.map((f) => f.key), ['channelId']);
});

test('PUT /api/modules/:id is staff-only, toggles immediately, and validates config keys', async () => {
  assert.equal((await call('PUT', '/api/modules/youtube-channel', { body: { enabled: true } })).status, 403, 'non-staff refused');
  assert.equal((await call('PUT', '/api/modules/nope', { staff: true, body: { enabled: true } })).status, 404, 'unknown module id');
  assert.equal((await call('PUT', '/api/modules/youtube-channel', { staff: true, body: { config: { notAField: 'x' } } })).status, 400, 'unknown config key rejected');

  const put = await call('PUT', '/api/modules/youtube-channel', { staff: true, body: { enabled: true, config: { channelId: 'UCabc123' } } });
  assert.equal(put.status, 200);
  assert.equal(put.json.module.enabled, true);
  assert.equal(put.json.module.config.channelId, 'UCabc123');

  // Reflected immediately -- no restart, this is the same running server.
  const after = await call('GET', '/api/modules', { staff: true });
  const yt = after.json.modules.find((m) => m.id === 'youtube-channel');
  assert.equal(yt.enabled, true);
  assert.equal(yt.config.channelId, 'UCabc123');

  // Leave it off for the other test files in this suite that assume the
  // default state (and so the real network poll job, even disabled-guarded,
  // never has a live channelId to act on during the rest of this run).
  await call('PUT', '/api/modules/youtube-channel', { staff: true, body: { enabled: false } });
});

test('a migration only ever applies once, even called twice', async () => {
  // In-process, against a *separate* tmp db -- this exercises src/modules.js
  // directly rather than going through the spawned server, since it's
  // asserting something about ctx.migrate()'s own bookkeeping, not an HTTP
  // behavior.
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-migrate-')), 'test.db');
  process.env.DB_PATH = tmpDb;
  delete require.cache[require.resolve('../src/db')];
  const db = require('../src/db');
  const modulesCore = require('../src/modules');
  const state = { modules: new Map([['fake-module', { enabled: true, config: {} }]]), enrichers: [] };
  const ctx = modulesCore.buildModuleCtx('fake-module', { db, state, legacyExtras: {} });

  let runs = 0;
  const migrations = [{ id: 'count', up: () => { runs += 1; } }];
  ctx.migrate(migrations);
  ctx.migrate(migrations);
  assert.equal(runs, 1, 'up() only ran once across two migrate() calls');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM module_migrations WHERE module_id = 'fake-module' AND migration_id = 'count'").get().c, 1);
});
