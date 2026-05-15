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

const CACHE_VERSION = 'cc-v2';
const HTML_NETWORK_TIMEOUT_MS = 2500;
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
    // Network-first with timeout fallback. On a fast connection the network
    // response wins and the user gets fresh HTML. On a slow/flaky connection
    // (common on mobile cell signal), we serve the cached HTML after
    // HTML_NETWORK_TIMEOUT_MS so the page paints immediately — the network
    // fetch keeps running in the background to refresh the cache for next
    // time. If the network ultimately fails AND there's no cache, fall back
    // to the root '/' so the user at least sees the catalog shell.
    event.respondWith((async () => {
      const cached = await caches.match(req);
      const networkPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(() => resolve(null), HTML_NETWORK_TIMEOUT_MS)
        );
        const winner = await Promise.race([networkPromise, timeoutPromise]);
        if (winner) return winner;
        return cached;
      }

      const fresh = await networkPromise;
      if (fresh) return fresh;
      return (await caches.match('/')) || Response.error();
    })());
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
