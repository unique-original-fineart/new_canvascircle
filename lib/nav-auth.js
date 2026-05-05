// =============================================================================
// nav-auth.js — Decorate the nav with the signed-in user's name.
// =============================================================================
// Drop this onto any page with the standard <nav> by including:
//
//   <a href="/portal/" id="nav-portal">Sell</a>
//   ...
//   <script type="module" src="/lib/nav-auth.js"></script>
//
// When the visitor is signed in, we replace the "Sell" link's text with
// "Hi, {display_name}". The link still points at /portal/ so the user can
// jump to their dashboard. When signed out, the link stays as the original
// label so casual visitors get the right call to action.
//
// This is intentionally lightweight — the actual auth gating happens inside
// /portal/ via Row-Level Security. We're only updating presentation here.
// =============================================================================

import { supabase, currentProfile } from "./supabase.js";

(async function decorateNav() {
  const link = document.getElementById("nav-portal");
  if (!link) return;

  // Listen for auth state changes too — so if the user signs in/out in
  // another tab, the nav updates reactively without a refresh.
  async function update() {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        const profile = await currentProfile();
        const name = profile?.display_name || session.user.email?.split("@")[0] || "you";
        link.textContent = "Hi, " + name;
        link.title = "Open your portal";
      } else {
        // Restore original text if we previously decorated and then signed out.
        if (link.dataset.origText) link.textContent = link.dataset.origText;
      }
    } catch (e) {
      // Network or storage issue — leave the link as-is.
      console.warn("[nav-auth] couldn't read session:", e);
    }
  }

  // Stash the original label so we can restore on sign-out.
  link.dataset.origText = link.textContent;

  await update();
  supabase.auth.onAuthStateChange((_event, _session) => { update(); });
})();
