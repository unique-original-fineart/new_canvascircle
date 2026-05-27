// =============================================================================
// install-prompt.js — Promote installing CanvasCircle as a PWA.
// =============================================================================
// What this does:
//   1. Captures the browser's `beforeinstallprompt` event on Android Chrome
//      (and Edge, Brave, Samsung Internet, etc.) so we can fire a native
//      one-tap install when the user clicks our "Install" button.
//   2. Exports mountInstallBanner({ container, copy }) — drops a small
//      dismissible banner into the given container, hidden if the user is
//      already running the installed PWA (display-mode: standalone) OR has
//      previously dismissed the banner OR is on a desktop browser. The
//      banner opens a modal with platform-specific install instructions.
//   3. Exports openInstallModal() — opens the same modal from anywhere
//      (used by the About page CTA, and could be wired to a help link).
//
// iOS-specific note: Safari does NOT fire beforeinstallprompt and does NOT
// expose any programmatic install API. The only path is the user manually
// using the Share → Add to Home Screen sheet. So for iOS we show written
// instructions; we cannot trigger the install for them.
//
// In-app browsers (Instagram, Facebook, TikTok webviews) cannot install
// PWAs at all. We detect them by sniffing the UA and show a banner that
// says "Open this in your real browser first" instead of normal steps.
//
// CSS for the banner and modal is injected once per page when the module
// initializes so we don't depend on the host page's stylesheet.
// =============================================================================

// ---- Deferred install prompt (Android Chrome and friends) -----------------
let __deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  // Stop Chrome from showing its own mini-infobar; we want to control the
  // install timing ourselves so we can attach it to a clear, branded UI.
  e.preventDefault();
  __deferredPrompt = e;
  // If our modal is already mounted, swap its Android body in case it
  // was rendered before the event fired.
  const $modal = document.getElementById("cc-install-modal");
  if ($modal && !$modal.hidden) renderAndroidBody();
});

// When the install completes, drop the deferred prompt and close the modal.
window.addEventListener("appinstalled", () => {
  __deferredPrompt = null;
  try { localStorage.setItem("cc_app_installed", "1"); } catch {}
  closeInstallModal();
});

// ---- Platform detection ----------------------------------------------------
function isStandalone() {
  // iOS Safari uses a custom property; everyone else uses a CSS media query.
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}
function isIOS() {
  const ua = navigator.userAgent || "";
  // iPadOS 13+ identifies as Mac; check touch-points to distinguish.
  return /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  // Common in-app webviews where PWA install isn't available.
  return /FBAN|FBAV|Instagram|TikTok|Line|Pinterest|Snapchat|Twitter/i.test(ua);
}
function isMobile() {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
}

// ---- One-time CSS injection ------------------------------------------------
function injectStyles() {
  if (document.getElementById("cc-install-styles")) return;
  const s = document.createElement("style");
  s.id = "cc-install-styles";
  s.textContent = `
    .cc-install-banner {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px;
      margin: 0 auto 16px;
      max-width: 720px;
      background: var(--accent-softer, rgba(45,127,255,0.10));
      border: 1px solid var(--accent-soft, rgba(45,127,255,0.30));
      border-radius: 10px;
      font-size: 13px; line-height: 1.4;
      color: var(--fg, #E5E7EB);
    }
    .cc-install-banner__msg { flex: 1; min-width: 0; }
    .cc-install-banner__msg strong { color: var(--fg, #E5E7EB); }
    .cc-install-banner__cta {
      display: inline-block;
      padding: 5px 11px;
      border-radius: 999px;
      background: var(--brand-gradient, linear-gradient(135deg,#FF6A1A,#E91E63,#8B1FC4,#2D7FFF));
      color: #FFFFFF;
      font-weight: 700;
      font-size: 12px;
      border: none; cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
    }
    .cc-install-banner__dismiss {
      background: none; border: none; padding: 0 4px;
      color: var(--muted, #9AA3BA); cursor: pointer;
      font-size: 16px; line-height: 1;
      font-family: inherit;
    }
    .cc-install-banner__dismiss:hover { color: var(--fg, #E5E7EB); }

    /* Modal */
    .cc-install-overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, .55);
      display: none; align-items: center; justify-content: center;
      z-index: 1500;
      padding: 16px;
    }
    .cc-install-overlay.is-open { display: flex; }
    .cc-install-dialog {
      width: 100%; max-width: 460px;
      background: var(--surface-1, #1A2459);
      border: 1px solid var(--card-line, #2D3D85);
      border-radius: 14px;
      padding: 20px 22px 22px;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    .cc-install-dialog h2 {
      margin: 0 0 4px; font-size: 18px;
      color: var(--fg, #E5E7EB);
    }
    .cc-install-dialog .cc-install-lede {
      margin: 0 0 14px; font-size: 13px; line-height: 1.5;
      color: var(--muted, #9AA3BA);
    }
    .cc-install-tabs {
      display: flex; gap: 4px;
      border-bottom: 1px solid var(--card-line, #2D3D85);
      margin-bottom: 14px;
    }
    .cc-install-tab {
      flex: 1;
      background: none; border: none;
      padding: 9px 8px 11px;
      margin-bottom: -1px;
      font-size: 13px; font-weight: 600;
      color: var(--muted, #9AA3BA);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-family: inherit;
    }
    .cc-install-tab.is-active {
      color: var(--fg, #E5E7EB);
      border-bottom-color: transparent;
      border-image: var(--brand-gradient, linear-gradient(135deg,#FF6A1A,#E91E63,#8B1FC4,#2D7FFF)) 1;
    }
    .cc-install-body { font-size: 14px; line-height: 1.55; color: var(--fg, #E5E7EB); }
    .cc-install-body ol { padding-left: 22px; margin: 8px 0; }
    .cc-install-body li { margin: 6px 0; }
    .cc-install-body code {
      background: var(--surface-2, #243170);
      padding: 1px 6px; border-radius: 4px;
      font-size: 12px;
    }
    .cc-install-warn {
      margin-top: 12px; padding: 9px 11px;
      background: var(--surface-3, #2D3D85);
      border: 1px solid var(--card-line, #2D3D85);
      border-radius: 8px;
      font-size: 12px; line-height: 1.5;
      color: var(--muted, #9AA3BA);
    }
    .cc-install-actions {
      display: flex; gap: 8px; justify-content: flex-end;
      margin-top: 16px;
    }
    .cc-install-actions button {
      padding: 8px 14px; border-radius: 8px;
      font-size: 14px; font-weight: 600; cursor: pointer;
      font-family: inherit;
    }
    .cc-install-actions .cc-install-cancel {
      background: transparent;
      border: 1px solid var(--card-line, #2D3D85);
      color: var(--fg, #E5E7EB);
    }
    .cc-install-actions .cc-install-android-btn {
      background: var(--brand-gradient, linear-gradient(135deg,#FF6A1A,#E91E63,#8B1FC4,#2D7FFF));
      border: none;
      color: #FFFFFF;
    }
    .cc-install-actions .cc-install-android-btn[disabled] { opacity: .55; cursor: wait; }
  `;
  document.head.appendChild(s);
}

// ---- Modal markup + render ------------------------------------------------
function ensureModal() {
  if (document.getElementById("cc-install-modal")) return;
  injectStyles();
  const overlay = document.createElement("div");
  overlay.id = "cc-install-modal";
  overlay.className = "cc-install-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="cc-install-dialog">
      <h2>Install CanvasCircle for push notifications</h2>
      <p class="cc-install-lede">Pin CanvasCircle to your home screen and you'll get push notifications for new buyer inquiries, follow updates from artists &amp; sellers you follow, and price drops on listings you've saved. It also runs full screen with no browser bars and keeps you signed in.</p>
      <div class="cc-install-tabs" role="tablist">
        <button type="button" class="cc-install-tab" data-cc-tab="ios">iPhone</button>
        <button type="button" class="cc-install-tab" data-cc-tab="android">Android</button>
      </div>
      <div class="cc-install-body" id="cc-install-body"></div>
      <div class="cc-install-actions">
        <button type="button" class="cc-install-cancel">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Tab wiring.
  overlay.querySelectorAll("[data-cc-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      overlay.querySelectorAll("[data-cc-tab]").forEach(b => b.classList.toggle("is-active", b === btn));
      if (btn.dataset.ccTab === "ios") renderIosBody(); else renderAndroidBody();
    });
  });
  // Click backdrop / cancel button to close.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeInstallModal(); });
  overlay.querySelector(".cc-install-cancel").addEventListener("click", closeInstallModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeInstallModal();
  });
}

function renderIosBody() {
  ensureModal();
  const $body = document.getElementById("cc-install-body");
  const inAppWarning = isInAppBrowser()
    ? `<div class="cc-install-warn"><strong>Tip:</strong> You're viewing this inside an in-app browser (like Instagram or Facebook), which can't install apps. Tap the menu → "Open in Safari" first, then come back to this page.</div>`
    : "";
  $body.innerHTML = `
    <ol>
      <li>Make sure you're in <strong>Safari</strong> (not Chrome — Apple only allows Safari to install web apps on iPhone).</li>
      <li>Tap the <strong>Share</strong> button at the bottom of the screen — the square with an arrow pointing up.</li>
      <li>Scroll down in the share sheet and tap <strong>Add to Home Screen</strong>.</li>
      <li>Tap <strong>Add</strong> in the top-right.</li>
    </ol>
    <p style="margin: 10px 0 0; font-size: 13px; color: var(--muted, #9AA3BA);">The CanvasCircle icon will appear on your home screen. Open it from there going forward and it'll behave like a real app.</p>
    ${inAppWarning}
  `;
  // Ensure actions row has only the Close button (no Android install).
  const $actions = document.querySelector(".cc-install-actions");
  $actions.querySelector(".cc-install-android-btn")?.remove();
}

function renderAndroidBody() {
  ensureModal();
  const $body = document.getElementById("cc-install-body");
  const $actions = document.querySelector(".cc-install-actions");

  if (__deferredPrompt) {
    // Native one-tap install path. Insert (or refresh) the Install button.
    $body.innerHTML = `
      <p style="margin: 0 0 8px;">Your browser supports one-tap install:</p>
      <p style="margin: 0; font-size: 13px; color: var(--muted, #9AA3BA);">Tap <strong>Install app</strong> below and confirm. The CanvasCircle icon will appear on your home screen.</p>
    `;
    if (!$actions.querySelector(".cc-install-android-btn")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cc-install-android-btn";
      btn.textContent = "Install app";
      btn.addEventListener("click", async () => {
        if (!__deferredPrompt) return;
        btn.disabled = true;
        btn.textContent = "Installing…";
        try {
          __deferredPrompt.prompt();
          const result = await __deferredPrompt.userChoice;
          __deferredPrompt = null;
          if (result?.outcome === "accepted") {
            closeInstallModal();
          } else {
            btn.disabled = false;
            btn.textContent = "Install app";
          }
        } catch (e) {
          console.warn("[install-prompt] native prompt failed:", e);
          btn.disabled = false;
          btn.textContent = "Install app";
        }
      });
      $actions.insertBefore(btn, $actions.firstChild);
    }
  } else {
    // Written instructions path — used when the browser is past the
    // beforeinstallprompt window (already shown the bottom-sheet hint),
    // or doesn't fire it at all (some Android browsers).
    const inAppWarning = isInAppBrowser()
      ? `<div class="cc-install-warn"><strong>Tip:</strong> You're viewing this inside an in-app browser (like Instagram or Facebook), which can't install apps. Tap the menu → "Open in browser" first, then come back to this page.</div>`
      : "";
    $body.innerHTML = `
      <ol>
        <li>Open this page in <strong>Chrome</strong> (or another Android browser that supports installable web apps — Edge, Brave, Samsung Internet all work).</li>
        <li>Tap the <strong>⋮ menu</strong> in the top-right corner.</li>
        <li>Tap <strong>Install app</strong> (sometimes labeled <strong>Add to Home screen</strong>).</li>
        <li>Confirm the install.</li>
      </ol>
      <p style="margin: 10px 0 0; font-size: 13px; color: var(--muted, #9AA3BA);">The CanvasCircle icon will appear on your home screen. Open it from there going forward and it'll behave like a real app.</p>
      ${inAppWarning}
    `;
    $actions.querySelector(".cc-install-android-btn")?.remove();
  }
}

// ---- Public API ------------------------------------------------------------
export function openInstallModal() {
  ensureModal();
  const overlay = document.getElementById("cc-install-modal");
  // Pick the tab matching the user's platform by default. Falls back to
  // iOS as the more common iPhone-user case in our demographic.
  const tab = isIOS() ? "ios" : "android";
  overlay.querySelectorAll("[data-cc-tab]").forEach(b => b.classList.toggle("is-active", b.dataset.ccTab === tab));
  if (tab === "ios") renderIosBody(); else renderAndroidBody();
  overlay.classList.add("is-open");
}

export function closeInstallModal() {
  const overlay = document.getElementById("cc-install-modal");
  if (overlay) overlay.classList.remove("is-open");
}

/**
 * Mount a small dismissible "Install as an app" banner into the given
 * container. No-op on desktop, on already-installed PWAs, or if the user
 * previously dismissed.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container — where to insert the banner (banner appended)
 * @param {string} [opts.copy] — banner message HTML (default provided)
 */
export function mountInstallBanner({ container, copy } = {}) {
  if (!container) return;
  if (!isMobile()) return;
  if (isStandalone()) return;
  try {
    if (localStorage.getItem("cc_install_banner_dismissed") === "1") return;
    if (localStorage.getItem("cc_app_installed") === "1") return;
  } catch {}

  injectStyles();
  const banner = document.createElement("div");
  banner.className = "cc-install-banner";
  // Default banner copy leads with push notifications now (2026-05-27) —
  // that's the killer feature that gives users a concrete reason to pin
  // CanvasCircle to their home screen. Push only works on iOS once the
  // PWA is installed (Apple's restriction, not ours), so installing is
  // a prerequisite to ever receiving lockscreen alerts for inquiries,
  // follow updates, and price drops. Callers can override `copy` for
  // page-specific framing (e.g. the catalog hero may want a shorter
  // pitch). Old generic "use as an app" copy is preserved in git history.
  banner.innerHTML = `
    <div class="cc-install-banner__msg">${copy || `<strong>🔔 Turn on push notifications</strong> — install CanvasCircle as an app to get a buzz on your lockscreen for inquiries, follow updates, and price drops.`}</div>
    <button type="button" class="cc-install-banner__cta">How?</button>
    <button type="button" class="cc-install-banner__dismiss" aria-label="Dismiss">✕</button>
  `;
  banner.querySelector(".cc-install-banner__cta").addEventListener("click", openInstallModal);
  banner.querySelector(".cc-install-banner__dismiss").addEventListener("click", () => {
    banner.remove();
    try { localStorage.setItem("cc_install_banner_dismissed", "1"); } catch {}
  });
  container.appendChild(banner);
}
