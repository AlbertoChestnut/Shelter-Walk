// Service worker: Web Push delivery + basic offline resilience. Shelter wifi
// is often spotty, so the app should still show the last-known data (with
// the page's own "Offline" banner) instead of going blank on a dropped
// connection.
const CACHE_NAME = 'shelter-walk-v3';
// Cap on cached API responses -- URLs with per-request timestamps in them
// (walks/for-day) would otherwise pile up forever.
const MAX_API_ENTRIES = 150;
// Only truly static, unversioned assets are pre-cached here -- app.js/
// style.css are served with a cache-busting ?v= query string that changes
// on every deploy (see ASSET_VERSION in server.js), so pre-caching a bare
// URL for them would just cache the wrong version. The fetch handler below
// caches whatever versioned URL actually gets requested instead.
const STATIC_ASSETS = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API data: network-first, falling back to the last successful response
  // when offline (so the Available list etc. show stale-but-usable data
  // rather than an error).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).then(trimApiCache);
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || new Response(
          JSON.stringify({ error: "You're offline and this hasn't been loaded before." }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )))
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
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Assets whose URL changes when their content does (?v= css/js, cached
  // dog photos, content-hashed wiki uploads): cache-first is safe -- a cached
  // copy is by definition still the right one.
  const immutable = url.search.includes('v=') || url.pathname.startsWith('/cached-images/') || url.pathname.startsWith('/wiki-images/');
  if (immutable) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
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

function trimApiCache() {
  return caches.open(CACHE_NAME).then((cache) => cache.keys().then((keys) => {
    const api = keys.filter((k) => new URL(k.url).pathname.startsWith('/api/'));
    // keys() is insertion-ordered, so the front of the list is the oldest.
    return Promise.all(api.slice(0, Math.max(0, api.length - MAX_API_ENTRIES)).map((k) => cache.delete(k)));
  }));
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (err) { /* no payload / not JSON */ }
  const title = data.title || 'Shelter Walk';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(url));
});
