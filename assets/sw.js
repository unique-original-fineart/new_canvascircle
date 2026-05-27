// =============================================================================
// DEPRECATED — moved to /sw.js (site root)
// =============================================================================
// The CanvasCircle service worker used to live here, but a SW at /assets/sw.js
// has a default scope of /assets/, which meant it could never actually control
// the catalog (/), portal (/portal/), listing pages, etc. That broke push
// notifications (navigator.serviceWorker.ready hung forever for any page
// outside /assets/) and silently disabled the entire caching layer for the
// rest of the site.
//
// The real SW now lives at /sw.js (scope: '/'). This file stays here only as
// a self-unregistering stub so existing PWA installs that previously
// registered /assets/sw.js can clean themselves up on next visit.
//
// Once we're confident nobody has the old registration anymore (a few weeks
// post-deploy is conservative), this file can be deleted entirely.
// =============================================================================

self.addEventListener('install', () => {
  // Activate immediately so the unregister fires on the next page load.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      // Drop our own registration. The new SW at /sw.js will take over from
      // the next nav-auth.js register() call.
      await self.registration.unregister();
      // Reload any open clients so they pick up the new SW immediately
      // instead of running uncontrolled for the rest of the session.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clients) {
        try { c.navigate(c.url); } catch {}
      }
    } catch (e) {
      // Best-effort — if anything fails, we just stay registered as a
      // dead-end SW (no fetch handler = no behavior). Harmless.
      console.warn('[sw stub] unregister failed:', e);
    }
  })());
});
