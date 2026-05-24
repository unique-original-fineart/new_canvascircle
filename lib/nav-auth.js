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
      header nav.is-open .cc-auth-link.is-signed-in {
        align-self: flex-start;
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
