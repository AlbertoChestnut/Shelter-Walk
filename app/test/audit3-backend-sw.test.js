// Audit 3 (backend, service worker): the QR scanner library is kept at
// install (Scan works offline without ever being opened online), and an
// "End walk" tap is kept with a one-off nonce, so the app only acts on an
// /?endWalk link the worker itself opened (a crafted link does nothing) and
// the tap time never comes from the URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ORIGIN = 'https://shelter.example';
const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url);

function fakeCaches() {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        put: async (req, res) => { entries.set(keyOf(req), res); },
        match: async (req) => { const r = entries.get(keyOf(req)); return r ? r.clone() : undefined; },
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
        delete: async (req) => entries.delete(keyOf(req)),
        addAll: async () => {}
      });
    }
    return stores.get(name);
  };
  return { stores, open, keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n), match: async () => undefined };
}

function loadWorker({ windows = [] } = {}) {
  const handlers = {};
  const caches = fakeCaches();
  const opened = [];
  const posted = [];
  const fetched = [];
  const self = {
    location: { origin: ORIGIN },
    crypto: webcrypto,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    registration: { showNotification: async () => {} }
  };
  const clients = {
    matchAll: async () => windows.map((url) => ({ url, postMessage: (m) => posted.push(m), focus: async () => {} })),
    openWindow: async (url) => { opened.push(url); }
  };
  const context = vm.createContext({
    self, caches, clients, URL, Request, Response, Headers, Promise, console, btoa, String, Math, Uint8Array, Array, JSON, Date,
    fetch: async (url, opts) => {
      fetched.push(String(url));
      return Object.defineProperty(new Response('/* lib */', { status: 200 }), 'type', { value: 'basic' });
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8'), context);
  return { handlers, caches, opened, posted, fetched };
}

test('install keeps the QR scanner library', async () => {
  const w = loadWorker();
  let done;
  w.handlers.install({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(w.fetched.includes('/js/html5-qrcode.min.js'));
  const kept = await (await w.caches.open('shelter-walk-v10')).match('/js/html5-qrcode.min.js');
  assert.ok(kept, 'kept for offline Scan');
});

test('"End walk" with the app closed opens it with a nonce kept by the worker, not a time in the URL', async () => {
  const w = loadWorker();
  let done;
  w.handlers.notificationclick({ action: 'end', notification: { close() {}, data: { walkId: 42 } }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(w.opened.length, 1);
  const url = new URL(w.opened[0], ORIGIN);
  assert.equal(url.searchParams.get('endWalk'), '42');
  assert.equal(url.searchParams.get('at'), null, 'no tap time in the link');
  const nonce = url.searchParams.get('nonce');
  assert.match(nonce, /^[0-9a-f]{32}$/);
  const kept = await (await w.caches.open('shelter-walk-end-taps')).match('/__end-tap/42');
  const tap = await kept.json();
  assert.equal(tap.nonce, nonce, 'the app checks the link against this');
  assert.equal(tap.walkId, '42');
  assert.ok(Math.abs(Date.parse(tap.at) - Date.now()) < 5000, 'the tap time is kept here');
});

test('the end-tap store survives a worker update', async () => {
  const w = loadWorker();
  await (await w.caches.open('shelter-walk-end-taps')).put('/__end-tap/1', new Response('{}'));
  let done;
  w.handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.ok(w.caches.stores.has('shelter-walk-end-taps'));
});

test('with the app open, the tap still goes straight to it as a message', async () => {
  const w = loadWorker({ windows: [`${ORIGIN}/`] });
  let done;
  w.handlers.notificationclick({ action: 'end', notification: { close() {}, data: { walkId: 7 } }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(w.opened.length, 0);
  assert.equal(w.posted[0].type, 'end-walk');
  assert.equal(String(w.posted[0].walkId), '7');
});
