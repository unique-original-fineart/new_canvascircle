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

import { supabase, currentProfile } from "./supabase.js";

// ---- Inject pill styling once per page ------------------------------------
if (!document.getElementById("nav-auth-styles")) {
  const style = document.createElement("style");
  style.id = "nav-auth-styles";
  style.textContent = `
    .cc-auth-link.is-signed-in {
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
    .cc-auth-link.is-signed-in::after {
      content: "↗";
      font-size: 12px;
      opacity: .85;
      transform: translateY(-1px);
    }
    .cc-auth-link.is-signed-in:hover,
    .cc-auth-link.is-signed-in:focus-visible {
      filter: brightness(.94);
      color: #fff !important;
      transform: translateY(-1px);
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
  `;
  document.head.appendChild(style);
}

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
      } else {
        for (const link of links) {
          link.textContent = link.dataset.origText || "Log In";
          link.title = "";
          link.classList.remove("is-signed-in");
        }
      }
    } catch (e) {
      console.warn("[nav-auth] couldn't read session:", e);
    }
  }

  await update();
  supabase.auth.onAuthStateChange((_event, _session) => { update(); });
})();
