// =============================================================================
// push-notifications.js — PWA Web Push opt-in/opt-out helpers.
// =============================================================================
// Exports four things:
//
//   1. getPushStatus()        — returns "unsupported" | "denied" | "granted-subscribed"
//                                | "granted-unsubscribed" | "default"
//   2. subscribePush()        — requests permission (if needed), subscribes via
//                                PushManager, persists endpoint+keys to Supabase.
//                                Returns the PushSubscription on success.
//   3. unsubscribePush()      — unsubscribes the current browser+user pair and
//                                deletes the row from push_subscriptions.
//   4. pushSupported()        — boolean: is the API available in this context?
//
// VAPID_PUBLIC_KEY is the public half of the VAPID keypair Guy generates with
// `npx web-push generate-vapid-keys`. Public keys are safe to embed in client
// code — they only identify the application server, they don't authenticate it.
// The PRIVATE key lives in Supabase secrets and is used only by the send-push
// edge function to sign push requests.
//
// On iOS, getPushStatus() can return "unsupported" even on a recent Safari if
// the page is being viewed in a regular browser tab. iOS requires the PWA to be
// installed (added to home screen) before PushManager becomes available. The
// banner UI on the Inquiries tab uses this to show "install the app first"
// guidance instead of an Enable button.
// =============================================================================

import { supabase } from "/lib/supabase.js?v=4";

// REPLACE THIS WITH YOUR GENERATED PUBLIC KEY.
// Run `npx web-push generate-vapid-keys` once, then paste the public key here.
// The private key goes into Supabase secrets as VAPID_PRIVATE_KEY.
//
// If you regenerate the keypair later, all existing push_subscriptions will be
// invalidated — clients will need to resubscribe. Don't rotate casually.
export const VAPID_PUBLIC_KEY = "BE-tJnM_23CWA_qsewZ_S6UaLlUoLPT9XDbekuje7v6P84FP0wzGejTvS2x3VI5K7QFipP2Bv0isKszTokEc27c";

// ----- Helpers ---------------------------------------------------------------
function urlBase64ToUint8Array(base64String) {
  // Browser PushManager wants the VAPID public key as a Uint8Array, but
  // VAPID keys are typically provided as URL-safe base64. Standard helper.
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/**
 * Returns one of:
 *   "unsupported"         — browser doesn't support web push at all
 *   "denied"              — user has blocked the permission
 *   "granted-subscribed"  — permission granted AND we have an active subscription
 *   "granted-unsubscribed"— permission granted but no subscription (rare; user re-subscribed elsewhere)
 *   "default"             — user hasn't been asked yet (or has dismissed without choosing)
 */
export async function getPushStatus() {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "default";

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? "granted-subscribed" : "granted-unsubscribed";
  } catch (e) {
    console.warn("[push] getSubscription failed:", e);
    return "default";
  }
}

/**
 * Request permission (if not already granted), subscribe via PushManager,
 * and persist the endpoint + keys to Supabase. Throws on any failure with
 * a user-readable message.
 *
 * Heavily logged + timeout-guarded because iOS PWA push subscribe has a
 * history of mid-flow hangs (the browser-side subscribe succeeds, then the
 * subsequent fetch silently never completes because the PWA context goes
 * stale right after the permission prompt closes). The timeout + visible
 * error reporting in the banner lets users see what failed.
 */
export async function subscribePush() {
  console.log("[push] subscribePush start");
  if (!pushSupported()) throw new Error("Notifications aren't supported in this browser.");
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY === "REPLACE_ME_WITH_VAPID_PUBLIC_KEY") {
    throw new Error("Push notifications aren't configured yet. Contact the admin.");
  }

  // 1) Ensure permission. Request modal will appear here if the user
  //    hasn't been asked before. If they've previously denied, this
  //    resolves to "denied" without any prompt — we must direct them
  //    to settings.
  let permission = Notification.permission;
  console.log("[push] initial permission:", permission);
  if (permission === "default") {
    permission = await Notification.requestPermission();
    console.log("[push] permission after prompt:", permission);
  }
  if (permission !== "granted") {
    throw new Error("Notifications were blocked. Re-enable them in your browser settings to use this.");
  }

  // 2) Get the active SW registration. ServiceWorker.ready waits for an
  //    active registration so this won't race the SW install.
  console.log("[push] awaiting serviceWorker.ready");
  const reg = await navigator.serviceWorker.ready;
  console.log("[push] got SW registration, scope:", reg.scope);

  // 3) Reuse any existing subscription (idempotent on user re-tapping the
  //    Enable button); otherwise create a fresh one. The applicationServerKey
  //    must match the public key the server signs with.
  let subscription = await reg.pushManager.getSubscription();
  console.log("[push] existing subscription:", !!subscription);
  if (!subscription) {
    console.log("[push] calling pushManager.subscribe");
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    console.log("[push] subscribe returned, endpoint:", subscription?.endpoint?.slice(0, 60) + "...");
  }

  // 4) Persist to Supabase. The endpoint is unique-constrained so a
  //    re-subscribe from the same browser overwrites the same row rather
  //    than fanning out duplicates. Wrapped in a 12s timeout because
  //    iOS PWAs can occasionally hang the fetch after the permission
  //    prompt closes — better to fail loudly than spin forever.
  const json = subscription.toJSON();
  console.log("[push] subscription.toJSON keys:", Object.keys(json), "has keys obj:", !!json.keys);

  console.log("[push] fetching current user");
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr) {
    console.error("[push] auth.getUser error:", userErr);
    throw new Error("Couldn't verify your sign-in: " + (userErr.message || String(userErr)));
  }
  const userId = userData?.user?.id;
  console.log("[push] userId:", userId);
  if (!userId) throw new Error("You need to be signed in to enable notifications.");

  const row = {
    user_id:      userId,
    endpoint:     json.endpoint,
    p256dh:       json.keys?.p256dh,
    auth_secret:  json.keys?.auth,
    user_agent:   navigator.userAgent.slice(0, 500),
    last_used_at: new Date().toISOString(),
    failure_count: 0,
  };
  console.log("[push] upsert row prepared, calling Supabase");

  // Race the upsert against a timeout. If the upsert hangs (iOS PWA
  // quirk), we still surface a real error to the user instead of a
  // forever-spinner.
  const upsertPromise = supabase
    .from("push_subscriptions")
    .upsert(row, { onConflict: "endpoint" });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Database write timed out after 12 seconds. Try again, and if it keeps failing, share the browser console output with the admin.")), 12000)
  );
  const result = await Promise.race([upsertPromise, timeoutPromise]);
  console.log("[push] upsert returned:", result);

  if (result?.error) {
    console.error("[push] upsert error:", result.error);
    // Roll back the browser-side subscribe so we don't leak a half-state
    // where the browser thinks it's subscribed but the server doesn't
    // know about it.
    try { await subscription.unsubscribe(); } catch {}
    throw new Error("Could not save your subscription: " + (result.error.message || String(result.error)));
  }

  console.log("[push] subscribePush complete");
  return subscription;
}

/**
 * Unsubscribe the current browser+user pair. Removes the row from
 * push_subscriptions AND calls subscription.unsubscribe() so the browser
 * stops accepting pushes from this site for this device.
 */
export async function unsubscribePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const subscription = await reg.pushManager.getSubscription();
  if (!subscription) return;

  // Server-side delete first (so even if the unsubscribe() call fails, we
  // stop sending pushes to a dead endpoint).
  try {
    await supabase
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", subscription.endpoint);
  } catch (e) {
    console.warn("[push] DB delete failed:", e);
  }

  // Then browser-side unsubscribe. Best-effort.
  try { await subscription.unsubscribe(); } catch (e) {
    console.warn("[push] browser unsubscribe failed:", e);
  }
}
