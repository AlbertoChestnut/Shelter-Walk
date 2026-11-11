// The module system: lets an optional feature live entirely under
// app/modules/<id>/ instead of being wired into core by hand. Formalizes the
// register(app, {db, ...}) convention every core feature file already uses
// (notes.js, playgroupNotes.js, wiki.js, ...) and adds what those don't need
// but a true plug-in does: its own schema migrations, its own scheduled job,
// a live enabled/disabled check an admin can flip without restarting the
// server, and a couple of small hooks (a dog-profile section, a settings
// form) so a module's UI doesn't require editing core HTML by hand either.
//
// A module is a directory with:
//   manifest.js  -- { id, name, description, version, configSchema?, clientAssets?, loadOrder? }
//   server.js    -- module.exports = { register(app, ctx) {...} }
//   public/      -- optional; served at /modules/<id>/<file>, and referenced
//                    by manifest.clientAssets (see assetTagsHtml/staffPanelHtml)
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const asyncRoute = require('./asyncRoute');
const { SHELTER_TZ } = require('./constants');

function requireStaff(req, res, next) {
  if (req.headers['x-auth-staff'] !== '1') return res.status(403).json({ error: 'Staff only.' });
  next();
}

// Reads app/modules/*/, requires each one's manifest + server, and returns
// them sorted (manifest.loadOrder, default 0, then id) so load order is
// deterministic without every module author needing to think about it.
function discoverModules(modulesDir) {
  if (!fs.existsSync(modulesDir)) return [];
  return fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(modulesDir, e.name);
      const manifest = require(path.join(dir, 'manifest.js'));
      // resolveConfig is optional: a module that wants its config validated
      // or normalized before it's saved (the youtube-channel module turns a
      // pasted channel link into the canonical id this way) exports it
      // alongside register(); most modules won't need one.
      const { register, resolveConfig } = require(path.join(dir, 'server.js'));
      if (manifest.id !== e.name) {
        throw new Error(`Module directory "${e.name}" has manifest.id "${manifest.id}" -- they must match.`);
      }
      return { id: manifest.id, dir, manifest, register, resolveConfig };
    })
    .sort((a, b) => (a.manifest.loadOrder || 0) - (b.manifest.loadOrder || 0) || a.id.localeCompare(b.id));
}

// One `modules` row per discovered module (first run only), then a live
// in-memory mirror -- this Map is what isEnabled()/getConfig() and every
// admin toggle actually read/write, so a change takes effect on the very
// next request/cron tick, not the next restart. `enrichers` is a shared
// list every module's registerDogEnricher() call appends to.
function loadModuleState(db, modules) {
  const insert = db.prepare("INSERT OR IGNORE INTO modules (id, enabled, config) VALUES (?, 0, '{}')");
  const get = db.prepare('SELECT enabled, config FROM modules WHERE id = ?');
  const moduleMap = new Map();
  for (const m of modules) {
    insert.run(m.id);
    const row = get.get(m.id);
    moduleMap.set(m.id, { enabled: !!row.enabled, config: JSON.parse(row.config || '{}') });
  }
  return { modules: moduleMap, enrichers: [] };
}

// migrations: [{ id, up(db) {} }]. Each is tracked in module_migrations by
// (moduleId, migrationId) and only ever runs once, inside its own
// transaction -- the same "ran already?" idea wiki.js already uses via
// app_meta flags for its one-time seeding, just generalized to real DDL and
// tracked per migration so a module can ship more of them later.
function migrate(db, moduleId, migrations) {
  const already = db.prepare('SELECT 1 FROM module_migrations WHERE module_id = ? AND migration_id = ?');
  const record = db.prepare('INSERT INTO module_migrations (module_id, migration_id, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations || []) {
    if (already.get(moduleId, m.id)) continue;
    db.transaction(() => {
      m.up(db);
      record.run(moduleId, m.id, new Date().toISOString());
    })();
  }
}

// Wraps node-cron with the same two idioms src/server.js's own scraper
// scheduling already uses (an in-flight guard so a slow run never overlaps
// itself; a DISABLE_*_JOBS env escape hatch for tests), plus one a single
// hardcoded job didn't need: a live isEnabled() check on every tick, so
// disabling a module stops its job on the next tick, not the next restart.
const jobsInFlight = new Set();
function schedule(moduleId, state, jobId, cronExpr, fn, opts = {}) {
  if (process.env.DISABLE_MODULE_JOBS) return;
  const { timezone = SHELTER_TZ, runOnBoot = false, bootDelayMs = 5000 } = opts;
  const key = `${moduleId}:${jobId}`;
  const run = () => {
    if (!(state.modules.get(moduleId) || {}).enabled) return;
    if (jobsInFlight.has(key)) { console.log(`[modules:${moduleId}] skipping ${jobId}, one already in flight`); return; }
    jobsInFlight.add(key);
    Promise.resolve().then(fn)
      .catch((err) => console.error(`[modules:${moduleId}] job ${jobId} failed:`, err))
      .finally(() => jobsInFlight.delete(key));
  };
  if (runOnBoot) setTimeout(run, bootDelayMs);
  cron.schedule(cronExpr, run, { timezone });
}

function enabledGuard(moduleId, state) {
  return (req, res, next) => {
    if (!(state.modules.get(moduleId) || {}).enabled) return res.status(404).json({ error: 'Not found.' });
    next();
  };
}

// The object passed to a module's register(app, ctx). `legacyExtras` is
// whatever ad hoc dependencies core features already get (cachedPhotoUrl,
// isStaffOrPrivileged, ...) -- offered uniformly here so a module can
// destructure the same names a core feature file would.
function buildModuleCtx(moduleId, { db, state, legacyExtras = {} }) {
  return {
    db,
    moduleId,
    ...legacyExtras,
    migrate: (migrations) => migrate(db, moduleId, migrations),
    schedule: (jobId, cronExpr, fn, opts) => schedule(moduleId, state, jobId, cronExpr, fn, opts),
    isEnabled: () => !!(state.modules.get(moduleId) || {}).enabled,
    getConfig: () => (state.modules.get(moduleId) || {}).config || {},
    requireStaff,
    enabledGuard: enabledGuard(moduleId, state),
    registerDogEnricher: (fn) => { state.enrichers.push({ moduleId, fn }); }
  };
}

// Mounted for every discovered module regardless of enabled state -- serving
// an inert static file is harmless; only *injecting* a <script> tag for it
// (assetTagsHtml/staffPanelHtml below) is gated on enabled.
function mountModuleStatics(app, modules) {
  for (const m of modules) {
    const publicDir = path.join(m.dir, 'public');
    if (fs.existsSync(publicDir)) app.use(`/modules/${m.id}`, express.static(publicDir));
  }
}

// <script>/<link> tags for every enabled module's `slot` assets (manifest
// clientAssets.index / .staff / .playgroup, each a list of filenames under
// its public/ dir). Computed fresh on every call -- deliberately not cached
// at startup -- so a toggle changes what gets injected on the very next page
// load, matching the no-restart-needed design everywhere else here.
function assetTagsHtml(modules, state, version, slot) {
  let html = '';
  for (const m of modules) {
    if (!(state.modules.get(m.id) || {}).enabled) continue;
    const files = (m.manifest.clientAssets && m.manifest.clientAssets[slot]) || [];
    for (const file of files) {
      const url = `/modules/${m.id}/${file}?v=${version}`;
      html += file.endsWith('.css') ? `<link rel="stylesheet" href="${url}" />\n` : `<script src="${url}"></script>\n`;
    }
  }
  return html;
}

// A module's staff-panel HTML fragment (manifest.clientAssets.staffPanel =
// { html, js: [...], css: [...] }), wrapped with its own asset tags, for
// the Settings tab's <!-- MODULE_STAFF_PANELS --> marker. The fragment text
// itself is cached per module (it's a static file on disk, read once), but
// which modules' panels appear is still recomputed per call from live
// enabled state, same reasoning as assetTagsHtml.
const panelFragmentCache = new Map();
function staffPanelHtml(modules, state, version) {
  let html = '';
  for (const m of modules) {
    if (!(state.modules.get(m.id) || {}).enabled) continue;
    const panel = m.manifest.clientAssets && m.manifest.clientAssets.staffPanel;
    if (!panel) continue;
    if (!panelFragmentCache.has(m.id)) {
      const fragment = fs.readFileSync(path.join(m.dir, 'public', panel.html), 'utf8');
      const css = (panel.css || []).map((f) => `<link rel="stylesheet" href="/modules/${m.id}/${f}?v=${version}" />`).join('\n');
      const js = (panel.js || []).map((f) => `<script src="/modules/${m.id}/${f}?v=${version}"></script>`).join('\n');
      panelFragmentCache.set(m.id, `<div class="module-panel" data-module-id="${m.id}">\n${fragment}\n</div>\n${css}\n${js}`);
    }
    html += panelFragmentCache.get(m.id);
  }
  return html;
}

// Merges every enabled module's registerDogEnricher() result into one
// object for GET /api/dogs/:id -- the exact precedent is already there:
// `dog.playgroupCounts = playgroupApi.counts(id)`. One module's failure
// (a bug, a bad query) never breaks the dog payload for everyone else.
function runDogEnrichers(dogId, state) {
  const out = {};
  for (const { moduleId, fn } of state.enrichers) {
    if (!(state.modules.get(moduleId) || {}).enabled) continue;
    try { Object.assign(out, fn(dogId) || {}); } catch (err) { console.error(`[modules:${moduleId}] dog enricher failed:`, err); }
  }
  return out;
}

// GET /api/modules, PUT /api/modules/:id -- the Settings tab's backend.
function registerModuleAdminRoutes(app, modules, state, db) {
  const shape = (m) => {
    const s = state.modules.get(m.id) || { enabled: false, config: {} };
    return {
      id: m.id, name: m.manifest.name, description: m.manifest.description, version: m.manifest.version,
      enabled: s.enabled, config: s.config, configSchema: m.manifest.configSchema || []
    };
  };
  app.get('/api/modules', requireStaff, (req, res) => {
    res.json({ modules: modules.map(shape) });
  });
  app.put('/api/modules/:id', requireStaff, asyncRoute(async (req, res) => {
    const m = modules.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'No such module.' });
    const current = state.modules.get(m.id);
    const body = req.body || {};
    let config = current.config;
    if (body.config && typeof body.config === 'object') {
      const validKeys = new Set((m.manifest.configSchema || []).map((f) => f.key));
      for (const k of Object.keys(body.config)) {
        if (!validKeys.has(k)) return res.status(400).json({ error: `Unknown config key: ${k}` });
      }
      let merged = { ...current.config, ...body.config };
      if (m.resolveConfig) {
        try { merged = await m.resolveConfig(merged); }
        catch (err) { return res.status(400).json({ error: err.message || 'Invalid configuration.' }); }
      }
      config = merged;
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : current.enabled;
    db.prepare('UPDATE modules SET enabled = ?, config = ? WHERE id = ?').run(enabled ? 1 : 0, JSON.stringify(config), m.id);
    state.modules.set(m.id, { enabled, config });
    res.json({ module: shape(m) });
  }));
}

module.exports = {
  discoverModules, loadModuleState, buildModuleCtx, mountModuleStatics,
  assetTagsHtml, staffPanelHtml, runDogEnrichers, registerModuleAdminRoutes,
  requireStaff
};
