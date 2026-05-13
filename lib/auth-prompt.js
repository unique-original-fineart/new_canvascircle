// =============================================================================
// auth-prompt.js — Tiny modal nudging unsigned visitors to sign in.
// =============================================================================
// Usage from any page:
//
//   import { showAuthPrompt } from "/lib/auth-prompt.js";
//   if (!signedIn) showAuthPrompt({ message: "Sign up to save listings." });
//
// The modal injects its own styles + DOM on first call. Shows a sign-in
// button + create-account button (both link to /portal/) and a Cancel.
// =============================================================================

let injected = false;

function inject() {
  if (injected) return;
  injected = true;

  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <style>
      #cc-auth-prompt {
        position: fixed; inset: 0;
        background: rgba(20,16,12,.65);
        display: none;
        align-items: center; justify-content: center;
        z-index: 1000; padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      #cc-auth-prompt.open { display: flex; }
      #cc-auth-prompt .ap-card {
        background: #fff;
        border-radius: 14px;
        padding: 24px 26px 20px;
        max-width: 420px; width: 100%;
        box-shadow: 0 12px 36px rgba(0,0,0,.18);
      }
      #cc-auth-prompt h3 {
        margin: 0 0 8px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 22px; font-weight: 600; color: #1a1a1a;
      }
      #cc-auth-prompt p {
        margin: 0 0 18px;
        color: #6b6b6b; font-size: 14px; line-height: 1.5;
      }
      #cc-auth-prompt .ap-actions {
        display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
      }
      #cc-auth-prompt a, #cc-auth-prompt button {
        padding: 9px 14px;
        border-radius: 8px;
        border: 1px solid #b8860b;
        font-size: 14px; font-weight: 600;
        cursor: pointer; text-decoration: none;
        font-family: inherit;
      }
      #cc-auth-prompt a.primary   { background: #b8860b; color: #fff; }
      #cc-auth-prompt a.secondary { background: #fff; color: #1a1a1a; border-color: #e8e4dc; }
      #cc-auth-prompt button.cancel {
        background: none; color: #6b6b6b; border-color: #e8e4dc;
        margin-left: auto;
      }
      #cc-auth-prompt button.cancel:hover { color: #1a1a1a; border-color: #ccc; }
    </style>
    <div id="cc-auth-prompt" role="dialog" aria-modal="true">
      <div class="ap-card">
        <h3 id="cc-auth-prompt-title">Create a free account</h3>
        <p id="cc-auth-prompt-msg">Sign up to save listings. Same account also lets you sell pieces from your collection or post In Search Of requests — no commitment.</p>
        <div class="ap-actions">
          <a class="primary" id="cc-auth-prompt-signin" href="/portal/">Sign in</a>
          <a class="secondary" id="cc-auth-prompt-signup" href="/portal/">Create account</a>
          <button class="cancel" id="cc-auth-prompt-cancel" type="button">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const overlay = document.getElementById("cc-auth-prompt");
  const cancel  = document.getElementById("cc-auth-prompt-cancel");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
  cancel.addEventListener("click", () => overlay.classList.remove("open"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.classList.remove("open");
  });
}

export function showAuthPrompt(opts = {}) {
  inject();
  const overlay = document.getElementById("cc-auth-prompt");
  if (opts.message) document.getElementById("cc-auth-prompt-msg").textContent = opts.message;
  if (opts.title)   document.getElementById("cc-auth-prompt-title").textContent = opts.title;
  overlay.classList.add("open");
}
