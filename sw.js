// Canvas Circle service worker.
//
// IMPORTANT: This file lives at the SITE ROOT, not /assets/. A SW's default
// scope is the directory it's served from — a SW at /assets/sw.js can only
// control pages under /assets/, which means /portal/, /listing.html, etc.
// would never get a controlling SW. That broke push notifications (
// navigator.serviceWorker.ready hung forever for pages outside /assets/) and
// was silently disabling the caching layer for every other page on the site.
// The old /assets/sw.js still exists as a self-unregistering stub so any
// stale registrations from before this move get cleaned up.
//
// Goals:
//   - Make the catalog installable as a PWA (Chrome requires a fetch handler).
//   - Keep the catalog up to date when the user is online (network-first for HTML).
//   - Show *something* if the user is offline and has visited before (cache fallback).
//   - Cache static assets aggressively (icons, images) so repeat opens are snappy.
//   - Receive Web Push notifications and deep-link click-throughs.
//
// Bump CACHE_VERSION whenever you ship a breaking change to the cached shell so
// older clients drop the stale cache on activation.

const CACHE_VERSION = 'cc-v224-moderation-admin-queue-and-public-filter';
const HTML_NETWORK_TIMEOUT_MS = 2500;

// Cross-origin hostnames whose responses we cache aggressively. As of
// cc-v170 the only cross-origin script we load is Cloudflare Turnstile's
// challenge widget (challenges.cloudflare.com); the JS libraries that
// were previously imported from esm.sh + cdn.jsdelivr.net are now
// self-hosted under /vendor/ for supply-chain safety. See lib/supabase.js
// header for the rationale.
const CROSS_ORIGIN_CACHE_HOSTS = new Set([
  'challenges.cloudflare.com',
]);
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
  // /lib/* JS modules. These were previously lazy-cached on first request,
  // which meant every SW bump forced users to pay N sequential round-trips
  // for them on the next page load before any of their code could run.
  // Pre-caching costs ~50KB at install time but eliminates that waterfall.
  // URLs must match the exact import strings used by HTML / other modules
  // — including the ?v=N cache-bust query string (see [[versioned-module-imports]]).
  '/lib/supabase.js?v=5',
  '/lib/config.js',
  '/lib/saves.js',
  '/lib/welcome-banner.js',
  '/lib/push-notifications.js',
  '/lib/return-trail.js',
  '/lib/auth-prompt.js',
  '/lib/install-prompt.js',
  '/lib/nav-auth.js?v=13',
  '/lib/video-compression.js',
  // Self-hosted third-party libs (as of cc-v170). See lib/supabase.js
  // header comment for the supply-chain rationale. ?v=1 cache-bust
  // string must match the importers in lib/supabase.js + portal/index.html.
  '/vendor/supabase-js-v2.esm.js?v=1',
  '/vendor/chart-4.4.0.umd.min.js?v=1',
  '/vendor/sortable-1.15.2.min.js?v=1',
  '/vendor/jszip-3.10.1.min.js?v=1',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
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
  const isSameOrigin       = (url.origin === self.location.origin);
  const isCrossOriginCDN   = CROSS_ORIGIN_CACHE_HOSTS.has(url.hostname);

  if (isCrossOriginCDN) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
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

  if (!isSameOrigin) return;

  const accept = req.headers.get('accept') || '';
  const isHtml = req.mode === 'navigate' || accept.includes('text/html');

  if (isHtml) {
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

// =============================================================================
// Web Push handlers — receive notifications + handle click-throughs.
// =============================================================================
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'CanvasCircle', body: event.data.text() };
    }
  }
  const title = payload.title || 'CanvasCircle';
  const options = {
    body:  payload.body  || '',
    icon:  payload.icon  || '/assets/icons/icon-192.png',
    badge: payload.badge || '/assets/icons/icon-192.png',
    tag:   payload.tag   || undefined,
    data:  { url: payload.url || '/' },
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  const absoluteTarget = new URL(targetUrl, self.location.origin).href;

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    for (const client of allClients) {
      try {
        const clientUrl = new URL(client.url);
        const targetUrlObj = new URL(absoluteTarget);
        if (clientUrl.pathname === targetUrlObj.pathname && 'focus' in client) {
          await client.focus();
          try { client.postMessage({ type: 'cc-notification-clicked', url: absoluteTarget }); } catch {}
          return;
        }
      } catch {}
    }
    if (allClients.length > 0 && 'navigate' in allClients[0]) {
      try {
        await allClients[0].navigate(absoluteTarget);
        await allClients[0].focus();
        return;
      } catch {}
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(absoluteTarget);
    }
  })());
});
