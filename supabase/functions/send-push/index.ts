// =============================================================================
// send-push — CanvasCircle Web Push notification edge function
// =============================================================================
// Deploy:
//   supabase functions deploy send-push
//
// Required secrets (Supabase > Project Settings > Edge Functions > Secrets):
//   VAPID_PUBLIC_KEY    — base64url-encoded VAPID public key (also baked
//                          into lib/push-notifications.js on the client)
//   VAPID_PRIVATE_KEY   — base64url-encoded VAPID private key (server only)
//   VAPID_SUBJECT       — contact URI, e.g. "mailto:admin@canvascircle.art"
//
// Auto-injected by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Generate the keypair once with:
//   npx web-push generate-vapid-keys
//
// This function is intended to be called from OTHER edge functions
// (e.g. send-email's contact-seller mode) via supabase.functions.invoke.
// It does its own service-role authentication — no end-user can call it
// directly to spam pushes.
//
// Request body:
//   {
//     user_id:  uuid,          // recipient
//     title:    string,        // notification title (e.g. "New inquiry from Sarah")
//     body:     string,        // notification body (e.g. "About 'Untitled #4'")
//     url:      string,        // path to open on tap (e.g. "/portal/")
//     tag?:     string,        // optional dedupe tag (replaces same-tag notifications)
//     icon?:    string,        // optional icon URL override
//   }
//
// Response: { sent: N, failed: M, pruned: P } — N successful deliveries,
// M failures (transient errors, retried by browser push services), P
// subscriptions deleted because the endpoint returned 410/404.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY  = Deno.env.get("VAPID_PUBLIC_KEY")  ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT     = Deno.env.get("VAPID_SUBJECT")     ?? "mailto:admin@canvascircle.art";
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")      ?? "";
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Configure web-push with our VAPID identity once. Called on cold start.
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } catch (e) {
    console.error("[send-push] VAPID setup failed:", e);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return json(500, { error: "VAPID keys are not configured on the server" });
  }

  try {
    const body = await req.json();
    const { user_id, title, url } = body;
    if (!user_id || !title) {
      return json(400, { error: "user_id and title are required" });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Pull all push_subscriptions rows for this user. A single user can
    // have multiple subscriptions (phone + laptop + tablet) and we
    // attempt to deliver to each.
    const { data: subs, error: subsErr } = await supabase
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_secret")
      .eq("user_id", user_id);
    if (subsErr) {
      console.error("[send-push] subs query failed:", subsErr);
      return json(500, { error: "Could not fetch subscriptions" });
    }
    if (!subs || subs.length === 0) {
      return json(200, { sent: 0, failed: 0, pruned: 0, note: "no subscriptions" });
    }

    // The payload the SW receives. Must match the shape the SW handler
    // in assets/sw.js expects.
    const payload = JSON.stringify({
      title: String(title).slice(0, 200),
      body:  body.body  ? String(body.body).slice(0, 500) : "",
      url:   url       ? String(url) : "/",
      tag:   body.tag  ? String(body.tag).slice(0, 100) : undefined,
      icon:  body.icon ? String(body.icon) : "/assets/icons/icon-192.png",
    });

    let sent = 0, failed = 0, pruned = 0;
    const expiredIds: number[] = [];

    // Send each push in parallel — they're independent and there's no
    // ordering constraint. Each browser push service can be slow (~1-3s
    // tail latency) so parallelism matters when a user has 3+ devices.
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth_secret },
          },
          payload,
          {
            TTL: 60 * 60 * 24, // 24h — drop the push if undelivered after a day
            urgency: "high",
          },
        );
        sent++;
      } catch (err: any) {
        const statusCode = err?.statusCode || err?.status;
        if (statusCode === 410 || statusCode === 404) {
          // Expired/invalid endpoint — the user uninstalled the PWA,
          // cleared site data, or the browser revoked permission.
          // Delete the row so we stop trying.
          expiredIds.push(sub.id);
          pruned++;
        } else {
          console.error("[send-push] send failed:", {
            endpoint: sub.endpoint?.slice(0, 80) + "...",
            statusCode,
            message: err?.message,
          });
          failed++;
          // Bump failure_count so we can prune chronic-failure rows
          // later via a maintenance job.
          await supabase
            .from("push_subscriptions")
            .update({ failure_count: (sub as any).failure_count ?? 0 + 1 })
            .eq("id", sub.id)
            .then(() => {}, () => {});
        }
      }
    }));

    // Bulk-delete expired subscriptions.
    if (expiredIds.length) {
      const { error: delErr } = await supabase
        .from("push_subscriptions")
        .delete()
        .in("id", expiredIds);
      if (delErr) {
        console.error("[send-push] prune delete failed:", delErr);
      }
    }

    // Bump last_used_at on the survivors so we know which subscriptions
    // are still alive (helps debug "I'm not getting notifications" reports).
    if (sent > 0) {
      const aliveIds = subs
        .filter((s) => !expiredIds.includes(s.id))
        .map((s) => s.id);
      if (aliveIds.length) {
        await supabase
          .from("push_subscriptions")
          .update({ last_used_at: new Date().toISOString() })
          .in("id", aliveIds)
          .then(() => {}, () => {});
      }
    }

    return json(200, { sent, failed, pruned });
  } catch (err) {
    console.error("[send-push] handler error:", err);
    return json(500, { error: (err as Error).message });
  }
});
