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

const CACHE_VERSION = 'cc-v49-push-prominence';
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

const SUPABASE_LIB_URL = 'https://esm.sh/@supabase/supabase-js@2?bundle';
const CHARTJS_LIB_URL  = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all([
        ...SHELL_ASSETS.map((url) =>
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        ),
        fetch(SUPABASE_LIB_URL, { mode: 'cors' })
          .then((res) => (res && res.ok ? cache.put(SUPABASE_LIB_URL, res) : null))
          .catch(() => null),
        fetch(CHARTJS_LIB_URL, { mode: 'cors' })
          .then((res) => (res && res.ok ? cache.put(CHARTJS_LIB_URL, res) : null))
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
