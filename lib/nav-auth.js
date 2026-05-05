// =============================================================================
// nav-auth.js — Decorate the nav with the signed-in user's name as a pill.
// =============================================================================
// Drop this onto any page with the standard <nav> by including:
//
//   <a href="/portal/" id="nav-portal">Sell</a>
//   ...
//   <script type="module" src="/lib/nav-auth.js"></script>
//
// When signed in, the link becomes a button-styled pill that says
// "Hi, {first name}" and points at /portal/. When signed out it stays as
// the original label (e.g. "Sell") so casual visitors get the right call to
// action. The same component will work for buyers when they have accounts
// — same pill, same /portal/ destination — only what's *inside* the portal
// will differ between sellers and buyers.
//
// This is intentionally lightweight; the actual auth gating happens inside
// /portal/ via Row-Level Security. We're only updating presentation here.
// =============================================================================

import { supabase, currentProfile } from "./supabase.js";

// ---- Inject pill styling once per page ------------------------------------
if (!document.getElementById("nav-auth-styles")) {
  const style = document.createElement("style");
  style.id = "nav-auth-styles";
  style.textContent = `
    nav a.is-signed-in {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--accent, #b8860b);
      color: #fff !important;
      padding: 5px 12px 6px;
      border-radius: 999px;
      font-weight: 600;
      letter-spacing: .1px;
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      transition: filter .15s ease, transform .12s ease;
    }
    nav a.is-signed-in::after {
      content: "↗";
      font-size: 12px;
      opacity: .85;
      transform: translateY(-1px);
    }
    nav a.is-signed-in:hover,
    nav a.is-signed-in:focus-visible {
      filter: brightness(.94);
      color: #fff !important;
      transform: translateY(-1px);
    }
  `;
  document.head.appendChild(style);
}

(async function decorateNav() {
  const link = document.getElementById("nav-portal");
  if (!link) return;

  // Stash the original label so we can restore on sign-out.
  if (!link.dataset.origText) link.dataset.origText = link.textContent;

  function firstName(name) {
    if (!name) return null;
    const trimmed = String(name).trim();
    if (!trimmed) return null;
    return trimmed.split(/\s+/)[0];
  }

  async function update() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const profile = await currentProfile();
        const display = profile?.display_name || session.user.email?.split("@")[0] || "you";
        const first   = firstName(display) || display;
        link.textContent = "Hi, " + first;
        link.title = "Open your portal — " + display;
        link.classList.add("is-signed-in");
      } else {
        link.textContent = link.dataset.origText || "Sign in";
        link.title = "";
        link.classList.remove("is-signed-in");
      }
    } catch (e) {
      console.warn("[nav-auth] couldn't read session:", e);
    }
  }

  await update();
  supabase.auth.onAuthStateChange((_event, _session) => { update(); });
})();
