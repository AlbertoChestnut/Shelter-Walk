// Audit 2 (backend, service worker): the app page is kept at install (so the
// first reload offline after an update still works), navigations are kept by
// path (so /?endWalk=… and /?open=… notification taps open offline), and an
// app page that was never kept falls back to /app.
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
const page = (body) => new Response(`<html>${body}</html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const offline = async () => { throw new TypeError('Failed to fetch'); };

test('install keeps the app page, but never a signed-out redirect', async () => {
  const w = loadWorker();
  let asked;
  w.env.fetch = async (url, opts) => { asked = { url: String(url), opts }; return Object.defineProperty(page('app'), 'type', { value: 'basic' }); };
  let done;
  w.handlers.install({ waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(asked.url, '/app');
  assert.equal(asked.opts.redirect, 'manual');
  const shell = await w.caches.match('/app', { cacheName: 'shelter-walk-v10' });
  assert.ok(shell, 'the app page is kept');
  // Signed out: the login gate's redirect comes back opaque, and isn't kept.
  const w2 = loadWorker();
  w2.env.fetch = async () => Object.defineProperty(new Response(null, { status: 200 }), 'type', { value: 'opaqueredirect' });
  let done2;
  w2.handlers.install({ waitUntil: (p) => { done2 = p; } });
  await done2;
  assert.equal(await w2.caches.match('/app'), undefined);
});

test('navigations are kept by path; offline, notification links open the kept page', async () => {
  const w = loadWorker();
  w.env.fetch = async () => page('fresh');
  await w.dispatchFetch('/?endWalk=12&at=2026-11-10T15:00:00Z', 'navigate');
  await w.dispatchFetch('/?open=updates', 'navigate');
  await settle();
  const keys = [...w.caches.stores.get('shelter-walk-v10').entries.keys()];
  assert.deepEqual(keys, [`${ORIGIN}/`], 'one copy, under its path');
  w.env.fetch = offline;
  const res = await w.dispatchFetch('/?endWalk=99&at=2026-11-10T16:00:00Z', 'navigate');
  assert.match(await res.text(), /fresh/);
});

test('offline, an app page never kept falls back to /app', async () => {
  const w = loadWorker();
  const store = await w.caches.open('shelter-walk-v10');
  await store.put('/app', page('shell'));
  w.env.fetch = offline;
  for (const url of ['/scan', '/?open=updates', '/']) {
    const res = await w.dispatchFetch(url, 'navigate');
    assert.ok(res, url);
    assert.match(await res.text(), /shell/, url);
  }
  // Not an app page (the staff dashboard): no stand-in.
  assert.equal(await w.dispatchFetch('/staff', 'navigate'), undefined);
});
