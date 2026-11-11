// Service worker: Web Push delivery + basic offline resilience. Shelter wifi
// is often spotty, so the app should still show the last-known data (with
// the page's own "Offline" banner) instead of going blank on a dropped
// connection.
// v10: personal API answers are no longer kept (mayKeepApiCopy), and the
// version bump drops any that v9 stored.
const CACHE_NAME = 'shelter-walk-v10';
// Versioned css/js (?v=, a hash of the public files that changes whenever
// one of them does; see ASSET_VERSION in server.js) and photos each get their own cache, so old versions can be
// dropped and photos capped without touching the rest.
const ASSET_CACHE = 'shelter-walk-assets-v1';
const PHOTO_CACHE = 'shelter-walk-photos-v1';
// An "End walk" tapped on a notification while the app was closed: the tap
// is kept here with a one-off nonce, and the app is opened at
// /?endWalk=<id>&nonce=<nonce>. The app ends the walk only when the nonce
// matches what's kept, so a crafted /?endWalk link can't end anyone's walk
// (audit 3). The tap time comes from here, never from the URL.
const END_TAP_CACHE = 'shelter-walk-end-taps';
const KEEP_CACHES = [CACHE_NAME, ASSET_CACHE, PHOTO_CACHE, END_TAP_CACHE];
// Cap on cached API responses -- URLs with per-request timestamps in them
// (walks/for-day) would otherwise pile up forever.
const MAX_API_ENTRIES = 150;
// Cap on cached photos (dog photos, silhouettes, Guide images): enough for
// everyone at the shelter plus a good share of the alumni.
const MAX_PHOTO_ENTRIES = 400;
// Only truly static, unversioned assets are pre-cached here -- app.js/
// style.css are served with a cache-busting ?v= query string that changes
// whenever their content does (see ASSET_VERSION in server.js), so pre-caching a bare
// URL for them would just cache the wrong version. The fetch handler below
// caches whatever versioned URL actually gets requested instead.
const STATIC_ASSETS = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png'];

// The app page itself, kept at install: the first visit after an update goes
// through the old worker, and this one then drops the old cache, so without
// it a reload offline would have no page at all until the next online visit.
// Every app navigation falls back to it offline (see navigationKey).
const APP_SHELL = '/app';
function cacheAppShell(cache) {
  // redirect:'manual': a signed-out fetch is the login gate's redirect, which
  // must never be kept as the app page.
  return fetch(APP_SHELL, { redirect: 'manual', credentials: 'same-origin' })
    .then((res) => (res.ok && res.type === 'basic' && !res.redirected ? cache.put(APP_SHELL, res) : null))
    .catch(() => {});
}

// The QR scanner library: loaded only when a scan opens (app.js
// loadScannerLib), at this fixed URL, so it's kept at install too -- Scan
// then works offline even if it was never opened online (audit 3).
const SCANNER_LIB = '/js/html5-qrcode.min.js';
function cacheScannerLib(cache) {
  return fetch(SCANNER_LIB, { redirect: 'manual', credentials: 'same-origin' })
    .then((res) => (res.ok && res.type === 'basic' && !res.redirected ? cache.put(SCANNER_LIB, res) : null))
    .catch(() => {});
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all([cache.addAll(STATIC_ASSETS).catch(() => {}), cacheScannerLib(cache), cacheAppShell(cache)]))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API data: network-first, falling back to the last successful response
  // when the network fails (offline, or shelter wifi that's connected but not
  // really working), marked with X-SW-Stale: 1 so the page says so. An
  // expired sign-in is told apart: the login gate answers with a redirect,
  // which redirect:'manual' sees as an opaqueredirect instead of a network
  // error, and that becomes the same 401 the server sends for an expired
  // session (app.js then offers to sign in again) rather than old data.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(new Request(req, { redirect: 'manual' }))
        .then((res) => {
          if (res.type === 'opaqueredirect') {
            return new Response(
              JSON.stringify({ error: 'Your sign-in has expired. Reload the page to sign in again.', sessionExpired: true }),
              { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
          }
          if (res.ok && mayKeepApiCopy(url, res)) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).then(trimApiCache);
          }
          return res;
        })
        .catch(() => (neverStale(url) ? Promise.resolve(null) : caches.match(req, { cacheName: CACHE_NAME })).then((cached) => (cached ? markStale(cached) : new Response(
          JSON.stringify({ error: "Couldn't reach the server, and this hasn't been loaded before. Check your connection and try again." }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        ))))
    );
    return;
  }

  // The HTML shell itself (/ and /scan) must NOT be cache-first: it's the
  // one unversioned file, and it's what points at the versioned css/js URLs
  // below (?v=... from ASSET_VERSION in server.js). Cache-first here would
  // mean a redeploy never reaches anyone who'd already loaded the app once
  // -- they'd keep getting the old shell, forever pointing at the old
  // asset URLs, with no way to notice. Network-first (falling back to the
  // cached shell only when actually offline) fixes that while still
  // satisfying the offline-resilience goal.
  // Kept by path, not by full URL: notification taps open /?endWalk=…&at=…,
  // /?open=updates and the like, each a one-off URL that would otherwise pile
  // up as its own copy and never be found again offline. Offline, a page
  // that was never kept falls back to the app page (APP_SHELL).
  if (req.mode === 'navigate') {
    const pathKey = navigationKey(url);
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(pathKey, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(pathKey, { cacheName: CACHE_NAME })
          .then((hit) => hit || (isAppPage(url) ? caches.match(APP_SHELL, { cacheName: CACHE_NAME }) : undefined))
          .then((hit) => hit || caches.match(req, { ignoreSearch: true })))
    );
    return;
  }

  // Assets whose URL changes when their content does (?v= css/js, cached
  // dog photos, content-hashed wiki uploads): cache-first is safe -- a cached
  // copy is by definition still the right one.
  // Each URL path keeps only its newest ?v= copy, and photos are capped.
  const photo = /^\/(cached-images|wiki-images|dog-silhouettes)\//.test(url.pathname);
  const immutable = photo || url.searchParams.has('v');
  if (immutable) {
    const cacheName = photo ? PHOTO_CACHE : ASSET_CACHE;
    event.respondWith(
      caches.match(req, { cacheName }).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(cacheName)
              .then((cache) => dropOtherVersions(cache, url).then(() => cache.put(req, copy)))
              .then(() => (photo ? trimCache(PHOTO_CACHE, MAX_PHOTO_ENTRIES) : null))
              .catch(() => {});
          }
          return res;
        });
      })
    );
    return;
  }

  // Everything else (icons, manifest, the Guide's sticker images) lives at a
  // fixed URL and can change on a redeploy: serve the cached copy instantly
  // but refresh it in the background, so an update shows up on the next visit
  // instead of never.
  event.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
      if (cached) { refresh.catch(() => {}); return cached; }
      return refresh;
    })
  );
});

// A page's cache key: its path on this origin, without the query string.
function navigationKey(url) {
  return `${url.origin}${url.pathname}`;
}
// Pages that are the volunteer app (server.js sendIndex): /, /app, /scan.
function isAppPage(url) {
  return ['/', '/app', '/scan'].includes(url.pathname.replace(/\/+$/, '') || '/');
}

// Personal answers are never kept for offline use: the server marks them
// no-store (or private), and the data export is never kept whatever it says.
// On a shared shelter phone the next volunteer must not be shown them.
function mayKeepApiCopy(url, res) {
  if (url.pathname.replace(/\/+$/, '') === '/api/me/export') return false;
  if (neverStale(url)) return false;
  const cc = (res.headers.get('Cache-Control') || '').toLowerCase();
  return !/\b(no-store|private)\b/.test(cc);
}

// Whether a walk is under way is never answered from a saved copy, whatever
// its headers say: an old "no walk" (or an old walk) would be wrong in a way
// that matters. Offline, the app shows the walk from its own copy instead
// (app.js, "This device's copy of the walk").
function neverStale(url) {
  return /^\/api\/walks(\/|$)/.test(url.pathname);
}

function trimApiCache() {
  return caches.open(CACHE_NAME).then((cache) => cache.keys().then((keys) => {
    const api = keys.filter((k) => new URL(k.url).pathname.startsWith('/api/'));
    // keys() is insertion-ordered, so the front of the list is the oldest.
    return Promise.all(api.slice(0, Math.max(0, api.length - MAX_API_ENTRIES)).map((k) => cache.delete(k)));
  }));
}

function trimCache(cacheName, max) {
  return caches.open(cacheName).then((cache) => cache.keys().then((keys) => (
    Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)))
  )));
}

// A new ?v= of the same file (app.js after a deploy, a dog's replaced
// photo) makes every older copy dead weight.
function dropOtherVersions(cache, url) {
  return cache.keys().then((keys) => Promise.all(keys
    .filter((k) => { const u = new URL(k.url); return u.pathname === url.pathname && u.search !== url.search; })
    .map((k) => cache.delete(k))));
}

// A cached API response served while offline, marked so the page can say
// the data may be out of date.
function markStale(res) {
  const headers = new Headers(res.headers);
  headers.set('X-SW-Stale', '1');
  return res.blob().then((body) => new Response(body, { status: res.status, statusText: res.statusText, headers }));
}

// A dog photo for a notification, as a data: URL. Photos are behind the
// sign-in, and the browser may load notification images without the
// session cookie, so the worker fetches it itself (same origin, with the
// cookie) and hands over the bytes. Anything unexpected: no photo.
async function notificationImage(url) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) return null;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${type.split(';')[0]};base64,${btoa(binary)}`;
  } catch (err) {
    return null;
  }
}

async function showPush(data) {
  const title = data.title || 'Shelter Walk';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    // The small icon in the notification bar: Android draws only its shape,
    // so it's a white paw on transparent (the app icon showed as a square).
    badge: '/icons/badge-96.png',
    data: { url: data.url || '/', walkId: data.walkId || null, dogName: data.dogName || null, page: data.page || null }
  };
  // Buttons (walk alerts: +10 min / End walk). Android shows them; iPhone
  // ignores them and a tap just opens the app, which can do the same things.
  if (Array.isArray(data.actions) && data.actions.length) {
    options.actions = data.actions.slice(0, 2).map((a) => ({ action: a.action, title: a.title }));
  }
  // e.g. an adoption: the dog's photo as the big picture and the small icon.
  if (data.image && data.image.startsWith('/')) {
    const photo = await notificationImage(data.image);
    if (photo) {
      options.image = photo;
      options.icon = photo;
    }
  }
  // Notifications sharing a tag replace each other instead of stacking --
  // all walk notices use one, so only the latest walk's is ever showing.
  // renotify still buzzes for the replacement (a new walk should alert).
  if (data.tag) {
    options.tag = data.tag;
    options.renotify = true;
  }
  return self.registration.showNotification(title, options);
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (err) { /* no payload / not JSON */ }
  event.waitUntil(showPush(data));
});

// Bring the app forward if it's already open (telling it what to do), or
// open it at `url` (which says the same thing in its query string).
async function openApp(url, message) {
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (open) {
    if (message) open.postMessage(message);
    // Allowed from a notification tap; refused (harmlessly) anywhere else.
    try { await open.focus(); } catch (err) { /* not from a user tap */ }
    return open;
  }
  return clients.openWindow(url);
}

// Keeps an End tap for the app to pick up (END_TAP_CACHE); resolves to its
// nonce, or null if it couldn't be kept.
function stashEndTap(walkId, at) {
  const bytes = new Uint8Array(16);
  self.crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const body = JSON.stringify({ walkId: String(walkId), at, nonce });
  return caches.open(END_TAP_CACHE)
    .then((cache) => cache.put(`/__end-tap/${encodeURIComponent(walkId)}`, new Response(body, { headers: { 'Content-Type': 'application/json' } })))
    .then(() => nonce, () => null);
}

// The shelter's clock (like the app's), not the phone's time zone.
// "6:09 pm", the app's clock style.
const clockLabel = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }).replace(/\s?([AP])M$/, (m, h) => ` ${h.toLowerCase()}m`);

// "+10 min" on a walk alert: extend the walk without opening the app, then
// replace the alert with the new stop time (or say why it couldn't).
async function extendFromNotification(data) {
  const name = data.dogName || 'Your walk';
  let res;
  try {
    res = await fetch(`/api/walks/${data.walkId}/extend`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    // Offline, or an expired sign-in redirecting to the login site: the app
    // can sort either out.
    return openApp('/');
  }
  let body = {};
  try { body = await res.json(); } catch (err) { return openApp('/'); }
  if (res.ok) {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((c) => c.postMessage({ type: 'walk-extended', walkId: data.walkId, stopsAt: body.stopsAt }));
    return self.registration.showNotification(`${name}: added ${body.addedMinutes} minutes`, {
      body: `Now stops automatically at ${clockLabel(body.shownStopsAt || body.stopsAt)}.`,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: 'walk',
      silent: true,
      data: { url: '/', walkId: data.walkId, dogName: data.dogName },
      actions: [{ action: 'extend', title: '+10 min' }, { action: 'end', title: 'End walk' }]
    });
  }
  return self.registration.showNotification(`${name}: couldn't add time`, {
    body: body.error || 'Open the app to check on this walk.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: 'walk',
    data: { url: '/' }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  if (event.action === 'extend' && data.walkId) {
    event.waitUntil(extendFromNotification(data));
  } else if (event.action === 'end' && data.walkId) {
    // The walk ended when the button was tapped, not when the app finishes opening.
    const at = new Date().toISOString();
    event.waitUntil(stashEndTap(data.walkId, at).then((nonce) => openApp(`/?endWalk=${encodeURIComponent(data.walkId)}&nonce=${encodeURIComponent(nonce || '')}`,
      { type: 'end-walk', walkId: data.walkId, at })));
  } else if (data.page === 'feedback') {
    event.waitUntil(openApp(url, { type: 'open-feedback' }));
  } else if (data.page === 'updates') {
    event.waitUntil(openApp(url, { type: 'open-updates' }));
  } else {
    event.waitUntil(openApp(url));
  }
});
