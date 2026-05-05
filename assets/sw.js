// Canvas Circle service worker.
//
// Goals:
//   - Make the catalog installable as a PWA (Chrome requires a fetch handler).
//   - Keep the catalog up to date when the user is online (network-first for HTML).
//   - Show *something* if the user is offline and has visited before (cache fallback).
//   - Cache static assets aggressively (icons, images) so repeat opens are snappy.
//
// Bump CACHE_VERSION whenever you ship a breaking change to the cached shell so
// older clients drop the stale cache on activation.

const CACHE_VERSION = 'cc-v1';
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Use {cache: 'reload'} so we don't re-cache the stale shell after a deploy.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only intercept same-origin requests; let cross-origin (Drive thumbnails, fonts)
  // pass through to the network unmodified.
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get('accept') || '';
  const isHtml = req.mode === 'navigate' || accept.includes('text/html');

  if (isHtml) {
    // Network-first so the catalog is always fresh when online; fall back to
    // the most recently cached copy if the network fails.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('/')))
    );
    return;
  }

  // Cache-first for everything else (icons, images, scripts, CSS).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
