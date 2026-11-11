// Security pass 3, the in-process half (see audit-security3.test.js for the
// server half): the service worker never keeps personal answers (#3), the
// youtube module only fetches YouTube (#11), the scraper only takes numeric
// animal ids (#13), the database overwrites deleted data (#13), and the
// Guide's links can't point off-site with "//" or "/\" (#13).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { isolateEnv } = require('./_helpers');

isolateEnv('sw-sec3-inproc-');
const db = require('../src/db');
const { runScrape, IMAGES_DIR } = require('../src/scraper');
const { resolveChannelId } = require('../modules/youtube-channel/resolveChannel');

// Stubbed network: the fake shelter for the scraper, a counter for YouTube.
let listing = [];
let ytFetches = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://pets.wake.gov')) {
    if (u.endsWith('/api/animals/adopt/') && opts.method === 'POST') return json({ data: JSON.parse(opts.body).species === 'Dog' ? listing : [] });
    if (u.includes('/api/animals/adopted')) return json({ data: [] });
    if (/\/api\/photos\//.test(u)) return json({ large: ['/img/x.jpg'] });
    if (/\/img\/x\.jpg/.test(u)) return new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (/\/api\/animals\/adopt\//.test(u)) return json({ primaryBreed: 'Mix', location: 'Kennel', summary: 'Nice', tags: [], sex: 'Male', age: '3 Years' });
    return new Response('{}', { status: 404 });
  }
  if (/youtube\.com|youtu\.be/.test(u)) {
    ytFetches.push(u);
    return new Response('<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">', { status: 200 });
  }
  ytFetches.push(u);
  return realFetch(url, opts);
};

test('#13 the database overwrites deleted rows (secure_delete)', () => {
  assert.equal(db.pragma('secure_delete', { simple: true }), 1);
});

test('#13 the scraper skips any animal id that is not plain digits', async () => {
  listing = [
    { shelterBuddyId: 4321, name: 'Good', sex: 'Male', age: '3 Years', dateInShelter: '2026-08-01T00:00:00' },
    { shelterBuddyId: '../../evil', name: 'Bad', sex: 'Male', age: '3 Years', dateInShelter: '2026-08-01T00:00:00' },
    { shelterBuddyId: '12/34', name: 'Slash', sex: 'Male', age: '3 Years', dateInShelter: '2026-08-01T00:00:00' }
  ];
  await runScrape();
  const names = db.prepare('SELECT name FROM dogs ORDER BY name').all().map((r) => r.name);
  assert.deepEqual(names, ['Good']);
  const files = fs.existsSync(IMAGES_DIR) ? fs.readdirSync(IMAGES_DIR) : [];
  assert.ok(files.every((f) => /^\d+\.jpg(\.lastmod)?$/.test(f)), files.join(','));
  assert.ok(!fs.existsSync(path.join(IMAGES_DIR, '..', '..', 'evil.jpg')));
});

test('#11 the youtube module fetches only YouTube', async () => {
  for (const bad of ['http://169.254.169.254/latest/meta-data/', 'https://evil.example/@x', 'http://www.youtube.com/@x',
    'https://www.youtube.com:8443/@x', 'https://user@www.youtube.com/@x', 'https://youtube.com.evil.example/@x', 'file:///etc/passwd',
    'gopher://youtube.com/', 'not a url at all', 'c/SomeName', 'https://evil.example/youtube.com/channel/UCabcdefghijklmnopqrstuv']) {
    ytFetches = [];
    await assert.rejects(() => resolveChannelId(bad), /YouTube channel link/, bad);
    assert.deepEqual(ytFetches, [], `no fetch for ${bad}`);
  }
  for (const good of ['https://www.youtube.com/@wcac', 'https://youtube.com/@wcac', 'https://m.youtube.com/@wcac', 'youtube.com/@wcac', 'https://youtu.be/abc123', '@wcac']) {
    ytFetches = [];
    assert.equal(await resolveChannelId(good), 'UCabcdefghijklmnopqrstuv', good);
    assert.equal(ytFetches.length, 1, good);
    assert.match(new URL(ytFetches[0]).hostname, /^(www\.|m\.)?youtube\.com$|^youtu\.be$/);
  }
  assert.equal(await resolveChannelId('https://www.youtube.com/channel/UCzzzzzzzzzzzzzzzzzzzzzz'), 'UCzzzzzzzzzzzzzzzzzzzzzz');
});

test('#13 the Guide\'s links: a site path yes, "//host" and "/\\host" no', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = /function safeUrl\(url, allowContact\) \{[\s\S]*?\n {2}\}/.exec(src);
  assert.ok(fn, 'safeUrl found');
  const safeUrl = vm.runInNewContext(`(${fn[0]})`);
  assert.equal(safeUrl('/wiki-images/a.png'), true);
  assert.equal(safeUrl('https://example.org/x'), true);
  assert.equal(safeUrl('//evil.example/x'), false);
  assert.equal(safeUrl('/\\evil.example/x'), false);
  assert.equal(safeUrl('javascript:alert(1)'), false);
  assert.equal(safeUrl('mailto:a@b.c', true), true);
});

// ---- #3 the service worker never keeps personal answers ----
const ORIGIN = 'https://shelter.example';
function loadWorker() {
  const handlers = {};
  const stores = new Map();
  const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);
  const open = async (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        put: async (req, res) => { entries.set(keyOf(req), res); },
        match: async (req) => { const r = entries.get(keyOf(req)); return r ? r.clone() : undefined; },
        keys: async () => [...entries.keys()].map((u) => new Request(u)),
        delete: async (req) => entries.delete(keyOf(req)),
        addAll: async () => {}
      });
    }
    return stores.get(name);
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
    match: async (req, o = {}) => {
      for (const n of o.cacheName ? [o.cacheName] : [...stores.keys()]) { if (stores.has(n)) { const r = await stores.get(n).match(req); if (r) return r; } }
      return undefined;
    }
  };
  const env = { fetch: null };
  const self = { location: { origin: ORIGIN }, navigator: { onLine: true }, addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting() {}, clients: { claim() {} }, registration: {} };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'),
    vm.createContext({ self, caches, URL, Request, Response, Headers, Promise, console, btoa, String, Math, Uint8Array, fetch: (...a) => env.fetch(...a) }));
  const dispatch = (url) => { let p; handlers.fetch({ request: new Request(new URL(url, ORIGIN).href), respondWith: (x) => { p = Promise.resolve(x); } }); return p; };
  return { env, dispatch, stores };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('#3 the service worker keeps no no-store/private answer and never the data export', async () => {
  const w = loadWorker();
  const reply = (cc) => async () => new Response('{"secret":1}', { status: 200, headers: { 'content-type': 'application/json', ...(cc ? { 'cache-control': cc } : {}) } });
  w.env.fetch = reply('no-store');
  await w.dispatch('/api/me');
  w.env.fetch = reply('private, max-age=60');
  await w.dispatch('/api/dogs/1/qr.svg');
  w.env.fetch = reply(null);
  await w.dispatch('/api/me/export');
  await w.dispatch('/api/dogs');
  await settle();
  const kept = [...[...w.stores.values()].flatMap((s) => [...s.entries.keys()])];
  assert.deepEqual(kept, [`${ORIGIN}/api/dogs`], 'only the shared answer is kept');
  // Offline: a personal answer is not served from an old copy.
  w.env.fetch = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal((await w.dispatch('/api/me')).status, 503);
  assert.equal((await w.dispatch('/api/dogs')).headers.get('X-SW-Stale'), '1');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
  assert.match(src, /const CACHE_NAME = 'shelter-walk-v(\d+)'/);
  assert.ok(Number(/shelter-walk-v(\d+)'/.exec(src)[1]) >= 10, 'cache version bumped');
});

test('#3 the app clears the saved API answers when a different account signs in on the device', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = /function forgetOtherAccountsCache\(userId\) \{[\s\S]*?\n {2}\}/.exec(src);
  const api = /function forgetApiCache\(\) \{[\s\S]*?\n {2}\}/.exec(src);
  assert.ok(fn && api);
  // Round 4: only the /api/ entries of the shelter-walk-vN cache go; the app
  // page, manifest and icons stay (the walk screen must open offline).
  const deleted = [];
  const store = new Map();
  const entries = { 'shelter-walk-v10': ['/api/dogs', '/', '/manifest.json', '/icons/icon-192.png', '/api/updates'] };
  const ctx = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    caches: {
      keys: async () => ['shelter-walk-v10', 'shelter-walk-assets-v1', 'shelter-walk-photos-v1'],
      delete: async (k) => { deleted.push(k); return true; },
      open: async (name) => ({
        keys: async () => (entries[name] || ['/x.png']).map((p) => ({ url: `https://app.test${p}` })),
        delete: async (req) => { deleted.push(`${name} ${new URL(req.url).pathname}`); return true; }
      })
    },
    URL, String, Promise
  };
  ctx.window = ctx;
  const forget = vm.runInNewContext(`${api[0]}\n(${fn[0]})`, ctx);
  forget(1);
  forget(1);
  return settle().then(() => {
    assert.deepEqual(deleted, [], 'first sign-in and the same account: nothing cleared');
    forget(2);
    return settle();
  }).then(() => {
    assert.deepEqual(deleted.sort(), ['shelter-walk-v10 /api/dogs', 'shelter-walk-v10 /api/updates'], 'another account: only the saved API answers go');
    assert.equal(store.get('sw-last-user-id'), '2');
  });
});
