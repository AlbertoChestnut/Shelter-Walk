// Audit 3, volunteer app (ui): the server pieces and a few client rules
// checked from the source (the browser side is in smoke/audit3-ui.js).
//  - One default activity per species: defaultActivityCat next to the dogs'
//    defaultActivity (settings, /api/me, the export), and a cat-only
//    volunteer's old default carried over when the column is added.
//  - Every /api answer carries X-Server-Now (the app's timers run on it).
//  - Guide: a too-large picture says "max 6 MB"; a multi-part emoji icon is
//    kept whole.
//  - The eligibility status rows and the top banners pass 4.5:1 contrast,
//    in both themes; the Not eligible wording; shares never "100%" next to
//    other slices; the walker-chat button clears the tab bar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { startServer, tempDirs } = require('./_helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_JS = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
const STYLE = fs.readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8');
const CHAT_CSS = fs.readFileSync(path.join(__dirname, '..', 'modules', 'walker-chat', 'public', 'chat.css'), 'utf8');

let server; let base;
const USER = 'audit3.ui@example.com';
const STAFF = 'audit3.ui.staff@example.com';
const call = async (url, { method = 'GET', body, email = USER, headers = {} } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'x-auth-email': email, ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
  });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
};

test.before(async () => {
  server = await startServer({ prefix: 'sw-audit3-ui-' });
  base = server.base;
});
test.after(async () => { if (server) { await server.stop(); fs.rmSync(server.dir, { recursive: true, force: true }); } });

test('one default activity per species: dogs and cats are saved apart', async () => {
  const me = (await call('/api/me')).json;
  assert.equal(me.defaultActivity, 'walk');
  assert.equal(me.defaultActivityCat, null, 'no cat default yet (the app falls back to cuddle)');
  let r = await call(`/api/users/${me.id}/settings`, { method: 'PUT', body: { defaultActivityCat: 'matchmaking' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.defaultActivityCat, 'matchmaking');
  assert.equal(r.json.defaultActivity, 'walk', "the dogs' default is untouched");
  r = await call(`/api/users/${me.id}/settings`, { method: 'PUT', body: { defaultActivity: 'cuddle' } });
  assert.equal(r.json.defaultActivityCat, 'matchmaking', "and setting the dogs' leaves the cats' alone");
  // A cat can't be walked: refused, nothing saved.
  r = await call(`/api/users/${me.id}/settings`, { method: 'PUT', body: { defaultActivityCat: 'walk', defaultActivity: 'walk' } });
  assert.equal(r.status, 400);
  const after = (await call('/api/me')).json;
  assert.equal(after.defaultActivity, 'cuddle');
  assert.equal(after.defaultActivityCat, 'matchmaking');
  const exported = (await call('/api/me/export')).json;
  assert.equal(JSON.stringify(exported).includes('"defaultActivityCat":"matchmaking"'), true, 'the export has it');
});

test("adding the column carries a cat-only volunteer's default over", async () => {
  const t = tempDirs('sw-audit3-ui-mig-');
  const db = new Database(t.dbFile);
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    default_activity TEXT NOT NULL DEFAULT 'walk', species_pref TEXT NOT NULL DEFAULT 'dog')`);
  const add = db.prepare('INSERT INTO users (name, created_at, default_activity, species_pref) VALUES (?, ?, ?, ?)');
  add.run('Cat person', '2026-01-01', 'matchmaking', 'cat');
  add.run('Both person', '2026-01-01', 'cuddle', 'both');
  add.run('Dog person', '2026-01-01', 'walk', 'dog');
  db.close();
  const s = await startServer({ dbFile: t.dbFile, dir: t.dir });
  try {
    const rows = new Database(t.dbFile, { readonly: true }).prepare('SELECT name, default_activity_cat AS cat FROM users ORDER BY id').all();
    assert.deepEqual(rows.map((r) => r.cat), ['matchmaking', null, null]);
  } finally {
    await s.stop();
    fs.rmSync(t.dir, { recursive: true, force: true });
  }
});

test('every /api answer says the server time (X-Server-Now)', async () => {
  const before = Date.now();
  const { headers } = await call('/api/me');
  const now = Number(headers.get('x-server-now'));
  assert.ok(Number.isFinite(now) && Math.abs(now - before) < 60000, `X-Server-Now ${headers.get('x-server-now')}`);
  assert.match(APP_JS, /X-Server-Now/, 'and the app reads it');
  assert.match(APP_JS, /const now = serverNow\(\);/, 'the walk timer runs on it');
});

test('Guide: a too-large picture says the limit; a multi-part emoji icon stays whole', async () => {
  // Staff can edit the Guide.
  const staffHeaders = { 'x-auth-staff': '1' };
  const big = Buffer.alloc(6 * 1024 * 1024 + 10, 0xff);
  const up = await call('/api/wiki/images', { method: 'POST', body: big, email: STAFF, headers: { ...staffHeaders, 'content-type': 'image/jpeg' } });
  assert.equal(up.status, 413);
  assert.match(up.json.error, /too large \(max 6 MB\)/);
  for (const icon of ['🧑‍🦯', '🏳️‍🌈', '👍🏽', '🐕‍🦺']) {
    const made = await call('/api/wiki', { method: 'POST', body: { title: `Icon ${icon}`, icon, body: 'x' }, email: STAFF, headers: staffHeaders });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const list = (await call('/api/wiki', { email: STAFF, headers: staffHeaders })).json.sections;
    assert.equal(list.find((s) => s.id === made.json.id).icon, icon, `${icon} kept whole`);
  }
  assert.doesNotMatch(APP_JS, /id="guideIcon" maxlength="4"/, 'the icon box takes a multi-part emoji');
});

// ---- From the source ----
function contrast(a, b) {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const hex6 = (h) => (h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h);
function ruleColors(selector) {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(STYLE);
  assert.ok(m, `style.css has ${selector}`);
  const bg = /background:\s*(#[0-9a-f]{3,6})\b/i.exec(m[1]);
  const fg = /(?:^|;|\s)color:\s*(#[0-9a-f]{3,6})\b/i.exec(m[1]);
  assert.ok(bg && fg, `${selector} sets a solid background and color`);
  return [hex6(fg[1]), hex6(bg[1])];
}

test('eligibility rows and the top banners: 4.5:1 or better, light and dark', () => {
  for (const sel of ['.elig-block', '.elig-caution', '.elig-hard', 'html[data-theme="dark"] .elig-block', 'html[data-theme="dark"] .elig-caution']) {
    const [fg, bg] = ruleColors(sel);
    assert.ok(contrast(fg, bg) >= 4.5, `${sel}: ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}:1`);
  }
  const banner = /\.new-build-banner, \.offline-banner \{([^}]*)\}/.exec(STYLE);
  assert.ok(banner, 'one rule for both banners');
  const bg = /background:\s*(#[0-9a-f]{6})/i.exec(banner[1])[1];
  const fg = /color:\s*(#[0-9a-f]{6})/i.exec(banner[1])[1];
  assert.ok(contrast(fg, bg) >= 4.5, `banner ${fg} on ${bg}`);
  assert.match(STYLE, /\.new-build-banner \.btn \{[^}]*width: auto;[^}]*min-height: 44px/, 'Reload: auto width, 44px tall');
  assert.match(APP_JS, /A new version is ready\. Reload when you\\'re done\./);
  // No more white circle behind the 🚫 on the old pill.
  assert.doesNotMatch(STYLE, /\.badge\.blocked \.badge-icon \{[^}]*background: #fff/);
});

test('wording: In foster is a caution, not "Not eligible"; sentence case; stickers; one clock style', () => {
  const fn = /function eligibilityStatusHtml[\s\S]*?\n {2}\}/.exec(APP_JS)[0];
  assert.match(fn, /in_foster'\) return row\('caution'/, 'foster gets the caution row');
  assert.match(APP_JS, /why = 'Experienced volunteers only \(EVO\)'/);
  assert.doesNotMatch(APP_JS, /Experienced Volunteers Only/);
  assert.doesNotMatch(APP_JS, /Behavior markers|No behavior markers|'s markers|Save markers/);
  assert.match(APP_JS, /Stickers with a lock are there/);
  assert.doesNotMatch(APP_JS, /By engagement type/);
  assert.doesNotMatch(APP_JS, /No matching dogs\./);
  assert.doesNotMatch(APP_JS, /'🐶 New'/);
  assert.doesNotMatch(APP_JS, /'Not Playgroup eligible'/);
  assert.doesNotMatch(APP_JS, /No \$\{searchHiddenNote \? 'shown '/);
  assert.doesNotMatch(APP_JS.replace(/^\s*\/\/.*$/gm, ''), /\d PM\b/, 'no "4-7 PM" next to "4–7 pm"');
  // fmtClock gives "6:09 pm", like the ranges.
  const src = /const pad2 = [^\n]*\n/.exec(APP_JS)[0] + /function fmtClock\(iso\) \{[\s\S]*?\n {2}\}/.exec(APP_JS)[0];
  const ctx = { shelterParts: () => ({ hh: 18, mm: 9 }) };
  vm.runInNewContext(src + '\nthis.out = fmtClock("x");', ctx);
  assert.equal(ctx.out, '6:09 pm');
});

test('a share next to other slices is never "100%"; one day lists "1 dog"', () => {
  const src = /const pctLabel = \(n, total\) => \{[\s\S]*?\n {2}\};/.exec(APP_JS)[0];
  const ctx = {};
  vm.runInNewContext(src + '\nthis.f = pctLabel;', ctx);
  assert.equal(ctx.f(996, 1000), '>99%');
  assert.equal(ctx.f(5, 5), '100%');
  assert.equal(ctx.f(1, 1000), '<1%');
  assert.equal(ctx.f(1, 2), '50%');
  assert.match(APP_JS, /\(\$\{d\.dogs\} \$\{nounFor\(statsSpeciesKeys\(\), d\.dogs !== 1\)\}\)/);
});

test("Together's averages follow the server's per-row flag, not the rounded lengths", () => {
  const src = /const rowSeconds = [^\n]*\n/.exec(APP_JS)[0] + /const rowEnded = [^\n]*\n/.exec(APP_JS)[0] + /function avgPick\(walks\) \{[\s\S]*?\n {2}\}/.exec(APP_JS)[0];
  const ctx = { SHARED_CONFIG: { minAvgSeconds: 60 } };
  vm.runInNewContext(src + '\nthis.f = avgPick;', ctx);
  // Others' 90-second walk arrives as 0 (5-minute rounding) but was averaged.
  const rows = [
    { slot: 0, order: 1, activity: 'walk', durationSeconds: 0, averaged: true },
    { slot: 0, order: 2, activity: 'walk', durationSeconds: 1200, averaged: true },
    { slot: 1, order: 3, activity: 'walk', durationSeconds: 0, averaged: false },
    { slot: 1, order: 4, activity: 'cuddle', durationSeconds: 600, averaged: false }
  ];
  const pick = ctx.f(rows);
  assert.equal(pick.rows.length, 2, 'both averaged walks count, the 0-length one too');
  assert.equal(pick.skipped, 1, 'only the real mis-scan is "under a minute"');
  assert.equal(pick.activity, 'walk');
  // Your own history (no flag) keeps the minute rule.
  const mine = ctx.f([{ ended_at: 'x', duration_seconds: 30, activity: 'walk' }, { ended_at: 'x', duration_seconds: 900, activity: 'walk' }]);
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.skipped, 1);
});

test('the walker-chat button sits above the tab bar', () => {
  const m = /\.wc-toggle \{[\s\S]*?bottom: calc\((\d+)px/.exec(CHAT_CSS);
  assert.ok(m && Number(m[1]) >= 64, 'bottom clears the ~58px tab bar');
});
