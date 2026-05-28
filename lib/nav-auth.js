// =============================================================================
// nav-auth.js — Decorate every .cc-auth-link with the signed-in state.
// =============================================================================
// Drop this onto any page with one or more auth-aware links:
//
//   <a href="/portal/" class="cc-auth-link">Log In</a>
//   ...
//   <script type="module" src="/lib/nav-auth.js"></script>
//
// Behavior:
//   - Signed out → link shows its original text (e.g. "Log In").
//   - Signed in  → link reads "My Account", styled as a gold pill, with the
//     full display name as the title attribute.
//   - Updates reactively across tabs via Supabase auth state events.
//
// The same hook works for buyers and sellers — both share the /portal/ path.
// =============================================================================

import { supabase, currentProfile } from "./supabase.js?v=2";

// =============================================================================
// Service Worker registration
// =============================================================================
// Registers /sw.js (at the site root, scope '/') on every page that loads
// nav-auth.js — i.e. every page on the site. Without this, the PWA has no
// active SW for pages outside /assets/, which means:
//   - No offline / cache-first behavior (cold-start hangs on bad networks)
//   - PushManager.subscribe() can never resolve (push notifications fail
//     silently — this was the bug that surfaced 2026-05-26)
//   - Android Chrome won't show the "install app" prompt
//
// Note on path: the SW MUST be served from the site root (or have a custom
// Service-Worker-Allowed header) for its scope to cover /, /portal/,
// /listing.html, etc. A SW at /assets/sw.js has default scope /assets/,
// which can't control those pages.
//
// Registration is fire-and-forget. Failure is non-fatal — the page works
// without the SW, just less well. Only registers over HTTPS or localhost,
// since browsers refuse SW registration on plain http (this is a feature,
// not a bug — SWs can intercept all network traffic and need to be served
// over a secure origin to prevent MITM).
if ("serviceWorker" in navigator &&
    (window.isSecureContext || window.location.hostname === "localhost")) {
  // Defer until after first paint so we don't compete with critical-path
  // resources. The SW caching is a "make repeat visits faster" feature,
  // not a "block first visit" feature.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then((reg) => {
        // No-op — registration success means the SW is installing or
        // already active. The SW handles its own activate flow.
        if (reg && typeof reg.update === "function") {
          // Best-effort: prompt the browser to check for an updated SW
          // on every page load so v## cache version bumps roll out fast.
          reg.update().catch(() => {});
        }
      })
      .catch((err) => {
        console.warn("[sw] register failed (non-fatal):", err);
      });
  });
}

// ---- Inject pill styling once per page ------------------------------------
if (!document.getElementById("nav-auth-styles")) {
  const style = document.createElement("style");
  style.id = "nav-auth-styles";
  style.textContent = `
    /* Unread-inquiries badge — small gradient pill appended to the
       My Account link on EVERY page (not just /portal/). The portal
       writes the count to localStorage on dashboard load + after the
       seller acknowledges the panel; this file reads it on signed-in
       page loads so the seller sees the signal anywhere on the site. */
    .cc-auth-link .cc-auth-badge {
      display: inline-flex; align-items: center; justify-content: center;
      margin-left: 6px;
      min-width: 18px; height: 18px;
      padding: 0 6px;
      border-radius: 999px;
      background: linear-gradient(135deg, #FF6A1A 0%, #E91E63 35%, #8B1FC4 65%, #2D7FFF 100%);
      color: #FFFFFF;
      font-size: 11px; font-weight: 700;
      line-height: 1;
    }
    /* Footer auth-link variants don't get the badge — too easy to lose
       in cramped footer text. The header link is the canonical surface. */
    footer .cc-auth-link .cc-auth-badge,
    .footer .cc-auth-link .cc-auth-badge { display: none; }

    /* Signed-in "My Account" link — styled identically to the other nav
       links (Catalog, Guidelines, About). No pill, no ↗ arrow. The arrow
       was fighting the active-page indicator over the ::after pseudo
       and producing a stray 3px gradient sliver inside the text. Without
       it, ::after is owned cleanly by the active-page rule. */
    .cc-auth-link.is-signed-in {
      display: inline-flex;
      align-items: center;
      background: transparent;
      color: var(--fg, #E5E7EB);
      padding: 0;
      border-radius: 0;
      font-weight: inherit;
      box-shadow: none;
      transition: color .15s ease;
    }
    .cc-auth-link.is-signed-in:hover,
    .cc-auth-link.is-signed-in:focus-visible {
      color: var(--accent, #2D7FFF);
    }
    /* Footer-style auth links (inline in footer text) shouldn't get the gold
       pill — they keep the inherited footer styling but show the same label
       so the user sees "My Account" wherever the link lives. */
    footer .cc-auth-link.is-signed-in,
    .footer .cc-auth-link.is-signed-in {
      background: transparent;
      color: inherit !important;
      box-shadow: none;
      padding: 0;
      border-radius: 0;
      font-weight: inherit;
    }
    footer .cc-auth-link.is-signed-in::after,
    .footer .cc-auth-link.is-signed-in::after { content: ""; }

    /* ---- Mobile hamburger menu ---- */
    .nav-toggle {
      display: none;
      background: none; border: 1px solid var(--card-line, #e8e4dc);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      color: var(--fg, #1a1a1a);
    }
    @media (max-width: 640px) {
      header nav, header.site nav { display: none; }
      header nav.is-open, header.site nav.is-open {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 4px;
        position: absolute;
        top: 100%; right: 12px; left: auto;
        min-width: 180px;
        /* Dark-mode panel — surface-1 matches the header surface so the
           popover reads as part of the header, not a foreign overlay. */
        background: var(--surface-1, #1A2459);
        border: 1px solid var(--border, #2D3D85);
        border-radius: 10px;
        padding: 8px;
        box-shadow: 0 8px 22px rgba(0,0,0,.45);
        z-index: 100;
      }
      header nav.is-open a {
        margin-left: 0 !important;
        padding: 9px 10px;
        border-radius: 6px;
        color: var(--fg, #E5E7EB);
      }
      header nav.is-open a:hover { background: var(--surface-2, #243170); }
      /* My Account link: the base rule sets display:inline-flex AND
         padding:0 / border-radius:0 (stripped pill styling). Inside the
         hamburger menu we need it to behave EXACTLY like the other rows:
         stretch full row width, share the 9px/10px padding so its tap
         target matches the others, and use the same 6px corner radius so
         the surface-2 active/hover background fills consistently. Without
         these overrides the My Account row sits at zero padding (visibly
         shorter than peers) and the active-state gradient bar at left:0
         lands directly on the "M" instead of at the row's left edge. */
      header nav.is-open .cc-auth-link.is-signed-in,
      header.site nav.is-open .cc-auth-link.is-signed-in {
        display: flex;
        width: 100%;
        justify-content: flex-start;
        padding: 9px 10px;
        border-radius: 6px;
      }
      .nav-toggle { display: inline-flex; align-items: center; justify-content: center; }
      header, header.site { position: relative; }
    }

    /* ---- Active-page indicator in top nav ----
       JS below adds .cc-nav-current to the link whose href matches the
       current page. A 2px gradient line under the link signals "you are
       here" and gives the brand gradient one more meaningful surface. */
    header nav a.cc-nav-current,
    header.site nav a.cc-nav-current {
      position: relative;
      color: var(--fg, #E5E7EB);
    }
    header nav a.cc-nav-current::after,
    header.site nav a.cc-nav-current::after {
      content: "";
      position: absolute;
      left: 0; right: 0; bottom: -6px;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(135deg, #FF6A1A 0%, #E91E63 35%, #8B1FC4 65%, #2D7FFF 100%);
    }
    /* Inside the mobile hamburger menu, the active link is highlighted with
       a left-edge gradient bar instead of an underline — fits the vertical
       list layout better. */
    @media (max-width: 640px) {
      header nav.is-open a.cc-nav-current,
      header.site nav.is-open a.cc-nav-current {
        background: var(--surface-2, #243170);
      }
      header nav.is-open a.cc-nav-current::after,
      header.site nav.is-open a.cc-nav-current::after {
        left: 0; right: auto; top: 0; bottom: 0;
        width: 3px; height: auto;
        border-radius: 0;
      }
    }
  `;
  document.head.appendChild(style);
}

// ---- Mark the link to the current page with .cc-nav-current ---------------
(function markCurrentNavLink() {
  // Cloudflare Pages serves /guidelines.html at the clean URL /guidelines,
  // so the current URL's pathname is /guidelines but the <a href> is still
  // /guidelines.html. Strip both /index.html (catalog root) AND any
  // trailing .html so the comparison works regardless of which side has
  // the extension.
  const normalize = p =>
    p.replace(/\/index\.html$/, "/")
     .replace(/\.html$/, "")
     .replace(/\/$/, "") || "/";
  const current = normalize(window.location.pathname);
  const links = document.querySelectorAll("header nav a, header.site nav a");
  links.forEach((link) => {
    const href = link.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) return;
    let linkPath;
    try {
      linkPath = normalize(new URL(href, window.location.origin).pathname);
    } catch { return; }
    if (linkPath === current) {
      link.classList.add("cc-nav-current");
    }
  });
})();

// ---- Inject hamburger toggle button on mobile ------------------------------
(function setupHamburger() {
  const nav = document.querySelector("header nav, header.site nav");
  const header = document.querySelector("header, header.site");
  if (!nav || !header) return;
  if (header.querySelector(".nav-toggle")) return; // already injected
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-toggle";
  btn.setAttribute("aria-label", "Menu");
  btn.setAttribute("aria-expanded", "false");
  btn.textContent = "☰";
  btn.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "✕" : "☰";
  });
  // Close menu on outside click
  document.addEventListener("click", (e) => {
    if (!nav.classList.contains("is-open")) return;
    if (header.contains(e.target)) return;
    nav.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "☰";
  });
  // Close menu when a link inside is clicked
  nav.addEventListener("click", (e) => {
    if (e.target.tagName === "A") {
      nav.classList.remove("is-open");
      btn.setAttribute("aria-expanded", "false");
      btn.textContent = "☰";
    }
  });
  header.appendChild(btn);
})();

(async function decorateAuthLinks() {
  const links = Array.from(document.querySelectorAll(".cc-auth-link"));
  if (!links.length) return;

  // Stash original labels so we can restore on sign-out.
  for (const link of links) {
    if (!link.dataset.origText) link.dataset.origText = link.textContent;
  }

  async function update() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const profile = await currentProfile();
        const display = profile?.display_name || session.user.email?.split("@")[0] || "you";
        for (const link of links) {
          link.textContent = "My Account";
          link.title = "Open your portal — Hi, " + display;
          link.classList.add("is-signed-in");
        }
        // Paint cached badge count immediately so signed-in users see a
        // signal on the first frame, then refresh from the server.
        decorateUnreadBadgeFromCache();
        refreshUnreadBadge(session.user.id);
      } else {
        for (const link of links) {
          link.textContent = link.dataset.origText || "Log In";
          link.title = "";
          link.classList.remove("is-signed-in");
          stripUnreadBadge(link);
        }
        // Wipe the cache too — signed-out clients shouldn't carry stale
        // counts forward into the next session.
        try { localStorage.removeItem("cc_unread_inquiries"); } catch {}
      }
    } catch (e) {
      console.warn("[nav-auth] couldn't read session:", e);
    }
  }

  // ---- Unread-inquiries badge helpers ----
  // The badge counts contact_messages rows where recipient_id = me AND
  // sent_at > profiles.last_inquiry_seen_at. The query is cheap (head:true
  // count + an indexed predicate) but we still cache for 60s in localStorage
  // so navigating between pages doesn't hammer Supabase.

  const UNREAD_CACHE_KEY = "cc_unread_inquiries";
  const UNREAD_CACHE_TTL_MS = 60 * 1000;

  function stripUnreadBadge(link) {
    const ex = link.querySelector(".cc-auth-badge");
    if (ex) ex.remove();
  }

  function paintUnreadBadge(count) {
    for (const link of links) {
      stripUnreadBadge(link);
      if (count > 0 && link.classList.contains("is-signed-in")) {
        const badge = document.createElement("span");
        badge.className = "cc-auth-badge";
        badge.textContent = String(count);
        badge.setAttribute("aria-label", `${count} new ${count === 1 ? "inquiry" : "inquiries"}`);
        link.appendChild(badge);
      }
    }
  }

  function decorateUnreadBadgeFromCache() {
    try {
      const raw = localStorage.getItem(UNREAD_CACHE_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (typeof obj?.n === "number") paintUnreadBadge(obj.n);
    } catch {}
  }

  async function refreshUnreadBadge(userId) {
    // Skip the network round-trip when we have a fresh cache entry.
    try {
      const raw = localStorage.getItem(UNREAD_CACHE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj?.ts && (Date.now() - obj.ts) < UNREAD_CACHE_TTL_MS) {
          // The cache is fresh; the paint already happened. Done.
          return;
        }
      }
    } catch {}

    try {
      // Fetch the user's high-water mark.
      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("last_inquiry_seen_at")
        .eq("user_id", userId)
        .single();
      if (profErr) throw profErr;
      const seenAt = prof?.last_inquiry_seen_at;

      // Count messages newer than that mark. When the column is null
      // (bootstrap case), count everything — every message is unread.
      // Filter out dismissed rows (recipient_hidden_at IS NOT NULL) — once
      // the seller has actively hidden an inquiry it should never count
      // toward the unread badge, even if it was unread when they hid it.
      let query = supabase
        .from("contact_messages")
        .select("id", { count: "exact", head: true })
        .eq("recipient_id", userId)
        .is("recipient_hidden_at", null);
      if (seenAt) query = query.gt("sent_at", seenAt);
      const { count, error } = await query;
      if (error) throw error;

      const n = count || 0;
      paintUnreadBadge(n);
      try {
        if (n > 0) {
          localStorage.setItem(UNREAD_CACHE_KEY, JSON.stringify({ n, ts: Date.now() }));
        } else {
          localStorage.removeItem(UNREAD_CACHE_KEY);
        }
      } catch {}
    } catch (e) {
      // Non-fatal — leave the cached badge in place if the refresh fails.
      console.warn("[nav-auth] unread badge refresh failed:", e);
    }
  }

  // Cross-tab sync: when the portal updates the cache (e.g. after the
  // seller views the panel and the count drops to 0), other tabs hear the
  // 'storage' event and repaint instantly.
  window.addEventListener("storage", (e) => {
    if (e.key !== UNREAD_CACHE_KEY) return;
    if (!e.newValue) {
      paintUnreadBadge(0);
      return;
    }
    try {
      const obj = JSON.parse(e.newValue);
      if (typeof obj?.n === "number") paintUnreadBadge(obj.n);
    } catch {}
  });

  await update();
  supabase.auth.onAuthStateChange((_event, _session) => { update(); });
})();
