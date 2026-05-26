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

// CACHE_VERSION bumped to cc-v4-dark on 2026-05-24 so existing PWA users get
// the new dark theme.css and dark-bg logo SVG instead of the cached light
// versions. The previous cache (cc-v3-logo) is deleted on activate — the very
// next HTML request goes to network, but that's the price of shipping a visual
// re-skin widely.
const CACHE_VERSION = 'cc-v27-engagement-delta';
const HTML_NETWORK_TIMEOUT_MS = 2500;

// Cross-origin hostnames whose responses we cache aggressively. Their URLs
// are version-pinned (e.g. esm.sh/@supabase/supabase-js@2) so the response
// at a given URL never changes meaningfully. Caching them eliminates the
// #1 cold-start hang: when iOS launches the PWA on weak cell signal, the
// supabase-js library import would otherwise block ALL JavaScript on the
// page until that network fetch completed. Cache-first means the second
// (and every subsequent) cold start serves the library instantly.
const CROSS_ORIGIN_CACHE_HOSTS = new Set([
  'esm.sh',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
]);
// Paths must match the actual served URLs. These live under /assets/ on
// Cloudflare Pages, NOT at the root — a previous version of this list had
// them at root and the precache silently 404'd (the .catch in install masks
// the failure, so the file appears precached but isn't).
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/assets/theme.css',
  '/assets/manifest.webmanifest',
  '/assets/favicon.ico',
  '/assets/favicon.svg',
  '/assets/favicon-96x96.png',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/apple-touch-icon.png',
  '/assets/logo.svg',
  '/assets/logo-dark-bg.svg',
  '/assets/logo-on-white.svg',
];

// Pre-cache the supabase-js library as part of install so it's available
// the very next time any page tries to import it — even if the user is
// offline at that moment.
//
// Note `?bundle` — without it, the top-level URL would resolve to a file
// that imports a *cascade* of other esm.sh URLs (gotrue, postgrest,
// realtime, etc.), and our pre-cache would only catch the top of that
// tree. The bundled version inlines all transitive deps into a single
// self-contained file, so caching this one URL gives us the entire
// library offline-ready. This is the actual fix for the persistent
// cold-start hangs on iOS PWA.
const SUPABASE_LIB_URL = 'https://esm.sh/@supabase/supabase-js@2?bundle';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Use {cache: 'reload'} so we don't re-cache the stale shell after a deploy.
      Promise.all([
        ...SHELL_ASSETS.map((url) =>
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        ),
        // Pre-fetch the supabase-js library (cross-origin, CORS) so it lands
        // in the cache before any page tries to import it. Best-effort —
        // never block install if this fails; the fetch handler will cache
        // it on demand once the network is available.
        fetch(SUPABASE_LIB_URL, { mode: 'cors' })
          .then((res) => (res && res.ok ? cache.put(SUPABASE_LIB_URL, res) : null))
          .catch(() => null),
      ])
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
  const isSameOrigin       = (url.origin === self.location.origin);
  const isCrossOriginCDN   = CROSS_ORIGIN_CACHE_HOSTS.has(url.hostname);

  // For cross-origin URLs from our trusted CDN allowlist (esm.sh, etc.):
  // cache-first, indefinitely. The URLs are version-pinned so the responses
  // are effectively immutable. This is THE fix for cold-start hangs caused
  // by the supabase-js library import blocking ALL JavaScript.
  if (isCrossOriginCDN) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          // esm.sh and friends return opaque-like responses depending on CORS
          // headers; only cache `basic` and `cors` types. `opaque` responses
          // can't be inspected for status, so caching them is risky.
          if (res && (res.type === 'basic' || res.type === 'cors') && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        }).catch(() => Response.error());
      })
    );
    return;
  }

  // Everything else cross-origin (Drive thumbnails, Supabase REST, fonts):
  // pass through to the network unmodified.
  if (!isSameOrigin) return;

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
