// =============================================================================
// welcome-banner.js — persistent "Continue to where you came from" banner
// =============================================================================
// Companion to /lib/return-trail.js. When a signed-in user has an active
// return-trail breadcrumb (set when they signed up after coming from a
// seller page or listing), this module injects a sticky banner at the top
// of the viewport that persists across every page on the site until the
// user explicitly dismisses it via the × button.
//
// Continue → navigates back to the trail target WITHOUT clearing the trail
// (so the banner keeps appearing on subsequent pages until dismissed).
// × clears the trail and removes the banner permanently.
//
// Usage from any page's module script:
//   import { mountWelcomeBanner } from "/lib/welcome-banner.js";
//   mountWelcomeBanner();
//
// Safe to call before/during page-load DOM construction — the function
// waits for DOMContentLoaded if needed.
// =============================================================================

import { supabase } from "/lib/supabase.js?v=5";
import { readReturnTrail, clearReturnTrail } from "/lib/return-trail.js";

let mounted = false;

export async function mountWelcomeBanner() {
  if (mounted) return;

  // Cheap check first — bail without an auth round-trip if there's no trail.
  const trail = readReturnTrail();
  if (!trail) return;

  // Auth check is timeout-raced so a slow cold-start doesn't block the banner
  // from showing once auth eventually resolves.
  let user = null;
  try {
    user = await Promise.race([
      supabase.auth.getUser().then(r => r.data?.user || null).catch(() => null),
      new Promise(r => setTimeout(() => r(null), 3000)),
    ]);
  } catch (e) {}
  if (!user) return;

  // Wait for the DOM to be ready so document.body exists.
  if (document.readyState === "loading") {
    await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
  }

  mounted = true;
  inject(trail);
}

function inject(trail) {
  const label = (trail.label || "the page you were viewing").trim();
  const safeLabel = escapeHtml(label);
  const safeUrl = trail.url;

  // If the user is already ON the trail's destination page, hide the
  // Continue button — tapping it would just reload the same URL. Keep
  // the banner itself visible with welcome copy + a dismiss control.
  const herePath = location.pathname;
  const therePath = trail.url.split("?")[0].split("#")[0];
  const onDestination = (herePath === therePath);

  const wrap = document.createElement("div");
  wrap.id = "cc-welcome-banner";
  wrap.innerHTML = `
    <style>
      #cc-welcome-banner {
        position: sticky;
        top: 0;
        z-index: 999;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 14px;
        background: #faf6ec;
        border-bottom: 1px solid #ecdfb8;
        color: #5a4400;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        box-shadow: 0 1px 3px rgba(0,0,0,.04);
      }
      #cc-welcome-banner .wb-text { flex: 1; min-width: 0; }
      #cc-welcome-banner .wb-text strong { font-weight: 700; }
      #cc-welcome-banner .wb-label { font-weight: 600; color: #5a4400; }
      #cc-welcome-banner #wb-continue {
        padding: 6px 12px;
        border-radius: 7px;
        border: 1px solid #b8860b;
        background: #b8860b;
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
        text-decoration: none;
        display: inline-block;
      }
      #cc-welcome-banner #wb-continue:hover { background: #9c7209; }
      #cc-welcome-banner #wb-dismiss {
        background: none;
        border: none;
        color: #7a6020;
        font-size: 22px;
        line-height: 1;
        padding: 2px 8px;
        cursor: pointer;
        border-radius: 4px;
        font-family: inherit;
      }
      #cc-welcome-banner #wb-dismiss:hover { background: #f1e6c2; color: #5a4400; }
      @media (max-width: 600px) {
        #cc-welcome-banner { font-size: 12px; padding: 7px 10px; gap: 6px; }
        #cc-welcome-banner #wb-continue { font-size: 12px; padding: 5px 9px; }
      }
    </style>
    <div class="wb-text">
      ${onDestination
        ? `<strong>Welcome to CanvasCircle!</strong> You're now signed in — feel free to message this collector or explore the catalog.`
        : `<strong>Welcome to CanvasCircle!</strong> Continue to <span class="wb-label">${safeLabel}</span>.`}
    </div>
    ${onDestination ? "" : `<button type="button" id="wb-continue">Continue →</button>`}
    <button type="button" id="wb-dismiss" aria-label="Dismiss">×</button>
  `;

  document.body.insertBefore(wrap, document.body.firstChild);

  const $continue = document.getElementById("wb-continue");
  const $dismiss  = document.getElementById("wb-dismiss");

  if ($continue) {
    $continue.addEventListener("click", () => {
      // Deliberately do NOT clear the trail. The banner is meant to stay
      // visible until the user explicitly dismisses it via ×.
      location.assign(safeUrl);
    });
  }
  $dismiss.addEventListener("click", () => {
    clearReturnTrail();
    wrap.remove();
    mounted = false;
  });
}

function escapeHtml(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}
