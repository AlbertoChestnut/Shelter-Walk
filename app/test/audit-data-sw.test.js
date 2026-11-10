// The service worker's caching rules (public/sw.js), run in a vm with fake
// caches and fetch: cached API data when the network fails (marked stale),
// versioned assets keep only their newest copy, photos are capped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ORIGIN = 'https://shelter.example';
const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);

function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        put: async (req, res) => { entries.delete(keyOf(req)); entries.set(keyOf(req), res); },
        match: async (req) => { const r = entries.get(keyOf(req)); return r ? r.clone() : undefined; },
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        delete: async (req) => entries.delete(keyOf(req)),
        addAll: async () => {}
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req, opts = {}) => {
      const names = opts.cacheName ? [opts.cacheName] : [...stores.keys()];
      for (const n of names) { if (stores.has(n)) { const r = await stores.get(n).match(req); if (r) return r; } }
      return undefined;
    }
  };
}

function loadWorker() {
  const handlers = {};
  const caches = fakeCaches();
  const env = { online: true, fetch: null };
  const self = {
    location: { origin: ORIGIN },
    navigator: { get onLine() { return env.online; } },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    registration: {}
  };
  const context = vm.createContext({
    self, caches, URL, Request, Response, Headers, Promise, console, btoa, String, Math, Uint8Array,
    fetch: (...args) => env.fetch(...args)
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), context);
  const dispatchFetch = (url, mode = 'cors') => {
    let responded = null;
    const href = new URL(url, ORIGIN).href;
    const request = mode === 'navigate' ? { method: 'GET', url: href, mode } : new Request(href);
    handlers.fetch({ request, respondWith: (p) => { responded = Promise.resolve(p); } });
    return responded;
  };
  return { handlers, caches, env, dispatchFetch };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('API data: a network failure serves the saved copy (marked stale); an expired sign-in does not', async () => {
  const w = loadWorker();
  w.env.fetch = async () => new Response('{"dogs":[1]}', { status: 200, headers: { 'content-type': 'application/json' } });
  await w.dispatchFetch('/api/dogs');
  await settle();
  // Connected but the request fails (spotty shelter wifi): the saved copy, marked stale.
  w.env.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const res = await w.dispatchFetch('/api/dogs');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-SW-Stale'), '1');
  assert.deepEqual(await res.json(), { dogs: [1] });
  // Nothing saved yet: a 503 explaining it, not a hang.
  assert.equal((await w.dispatchFetch('/api/stats')).status, 503);
  // The login gate redirecting (expired sign-in): a 401 the app turns into
  // its sign-in prompt, never the old data. The request asks for manual redirects.
  let seen;
  w.env.fetch = async (req) => { seen = req; return Response.error ? Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' }) : null; };
  const expired = await w.dispatchFetch('/api/dogs');
  assert.equal(seen.redirect, 'manual');
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).sessionExpired, true);
});

test('versioned assets keep only their newest copy, in their own cache', async () => {
  const w = loadWorker();
  w.env.fetch = async (req) => new Response(`body of ${keyOf(req)}`, { status: 200 });
  await w.dispatchFetch('/js/app.js?v=1');
  await settle();
  await w.dispatchFetch('/js/app.js?v=2');
  await w.dispatchFetch('/css/style.css?v=2');
  await settle();
  const assets = [...w.caches.stores.get('shelter-walk-assets-v1').entries.keys()];
  assert.deepEqual(assets.sort(), [`${ORIGIN}/css/style.css?v=2`, `${ORIGIN}/js/app.js?v=2`]);
});

test('photos are capped, and an older cache version is dropped on activate', async () => {
  const w = loadWorker();
  await w.caches.open('shelter-walk-v7');
  w.env.fetch = async () => new Response('jpg', { status: 200, headers: { 'content-type': 'image/jpeg' } });
  for (let i = 0; i < 405; i += 1) {
    await w.dispatchFetch(`/cached-images/${i}.jpg?v=1`);
    await new Promise((r) => setTimeout(r, 1));
  }
  await settle();
  const photos = [...w.caches.stores.get('shelter-walk-photos-v1').entries.keys()];
  assert.equal(photos.length, 400);
  assert.ok(!photos.includes(`${ORIGIN}/cached-images/0.jpg?v=1`), 'oldest dropped first');

  let done;
  w.handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(w.caches.stores.has('shelter-walk-v7'), false);
  assert.equal(w.caches.stores.has('shelter-walk-photos-v1'), true);
});
