// =============================================================================
// saved-search-fanout — alert followers when a matching listing appears
// =============================================================================
// Deploy with:
//   supabase functions deploy saved-search-fanout --no-verify-jwt
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   No additional secrets — this function delegates to send-push + send-email
//   which already have their own VAPID + Resend configuration.
//
// Auth model (same pattern as send-push, see
//   [[supabase-new-key-format-internal-fn-calls]] memory):
//   - Deployed --no-verify-jwt so the gateway accepts requests without a
//     JWT (sb_secret_ keys aren't JWTs).
//   - Internal apikey check at the top of the handler verifies the caller
//     presented the SERVICE_ROLE_KEY in the `apikey` header. Only other
//     edge functions / our own backend code holds that key.
//
// Trigger points (callers):
//   1. Portal new-listing flow when an Established Member auto-approves
//      (status='approved' on insert).
//   2. Portal admin "Approve" action when moderation_status flips to
//      'approved' for a non-Established seller's listing.
//
// Request body: { listing_id: uuid }
//
// Flow:
//   1. Verify caller auth (apikey matches SERVICE_KEY).
//   2. Load the listing — must exist, must be approved, must have an
//      artist_name and seller_id. Skip silently otherwise (caller doesn't
//      need to know about edge cases).
//   3. Query saved_searches matching either the artist (case-insensitive)
//      OR the seller_id. Dedupe by user_id (a user might follow both the
//      artist AND the seller of the same listing — we only notify once).
//   4. For each unique user:
//      a. Skip the seller themselves (don't notify a seller about their own
//         listing they just posted).
//      b. Check the daily cap (max 20 notifications per user per day from
//         this feature).
//      c. Try to INSERT a saved_search_notifications row. UNIQUE on
//         (user_id, listing_id) means if there's already a row, the buyer
//         was already notified about this exact listing — ON CONFLICT
//         DO NOTHING + checking affected-rows tells us whether to send.
//      d. If the insert took: fire push + email.
//   5. Return counts.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DAILY_CAP_PER_USER = 20;

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  // Internal auth check — see send-push for the same pattern. With
  // --no-verify-jwt the gateway lets any caller in, so we re-verify here.
  const callerKey = req.headers.get("apikey") || req.headers.get("Apikey");
  if (!callerKey || callerKey !== SERVICE_KEY) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    const body = await req.json();
    const listingId = String(body?.listing_id || "").trim();
    if (!listingId) return json(400, { error: "listing_id required" });

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Load the listing. Service-role bypasses RLS so we get the canonical
    //    row regardless of visibility policies.
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("listing_id, seller_id, artist_name, artwork_title, listing_type, status, moderation_status, asking_price_usd, budget_min_usd, budget_max_usd")
      .eq("listing_id", listingId)
      .single();
    if (listingErr || !listing) {
      console.warn("[saved-search-fanout] listing not found:", listingId, listingErr);
      return json(200, { matched: 0, sent: 0, skipped: 0, reason: "listing-missing" });
    }
    if (listing.moderation_status && listing.moderation_status !== "approved") {
      return json(200, { matched: 0, sent: 0, skipped: 0, reason: "not-approved" });
    }

    // 2) Look up the seller's display name (used in the notification body).
    const { data: sellerProfile } = await supabase
      .from("profiles")
      .select("display_name, handle, account_status")
      .eq("user_id", listing.seller_id)
      .single();
    if (sellerProfile?.account_status && sellerProfile.account_status !== "active") {
      return json(200, { matched: 0, sent: 0, skipped: 0, reason: "seller-inactive" });
    }
    const sellerName = sellerProfile?.display_name || "A seller";

    // 3) Find every saved_search that matches this listing. Two OR'd patterns:
    //    (a) kind='artist' AND lower(value) = lower(artist_name)
    //    (b) kind='seller' AND value = seller_id::text
    //    We do two queries instead of one .or() because PostgREST .or() with
    //    case-insensitive matching gets awkward.
    const artistName = (listing.artist_name || "").trim();
    const sellerIdStr = String(listing.seller_id);

    let artistFollowers: any[] = [];
    if (artistName) {
      const { data: rows, error: artistErr } = await supabase
        .from("saved_searches")
        .select("id, user_id, value")
        .eq("kind", "artist")
        .ilike("value", artistName);   // ilike with no wildcards = case-insensitive equality
      if (artistErr) {
        console.error("[saved-search-fanout] artist query failed:", artistErr);
      } else {
        artistFollowers = rows || [];
      }
    }

    let sellerFollowers: any[] = [];
    {
      const { data: rows, error: sellerErr } = await supabase
        .from("saved_searches")
        .select("id, user_id")
        .eq("kind", "seller")
        .eq("value", sellerIdStr);
      if (sellerErr) {
        console.error("[saved-search-fanout] seller query failed:", sellerErr);
      } else {
        sellerFollowers = rows || [];
      }
    }

    // Dedupe by user_id. Prefer the artist-follower's saved_search_id when
    // a user has both (arbitrary choice — either is correct in the log).
    const followerMap = new Map<string, { savedSearchId: number }>();
    for (const r of artistFollowers) {
      if (!followerMap.has(r.user_id)) followerMap.set(r.user_id, { savedSearchId: r.id });
    }
    for (const r of sellerFollowers) {
      if (!followerMap.has(r.user_id)) followerMap.set(r.user_id, { savedSearchId: r.id });
    }

    // 4) Skip the seller themselves (they shouldn't be notified about their
    //    own listing even if they happen to follow their own artist).
    followerMap.delete(sellerIdStr);

    let sent = 0, capped = 0, deduped = 0, errored = 0;
    const matched = followerMap.size;

    // 5) Build notification copy.
    const isIso = listing.listing_type === "iso";
    const title = isIso
      ? `New In Search Of from ${sellerName}`
      : (artistName ? `New from ${artistName}` : `New listing from ${sellerName}`);
    const priceStr = isIso
      ? (listing.budget_max_usd != null
          ? `Up to $${Number(listing.budget_max_usd).toLocaleString()}`
          : "Open budget")
      : (listing.asking_price_usd != null
          ? `$${Number(listing.asking_price_usd).toLocaleString()}`
          : "Price on request");
    const bodyText = `${listing.artwork_title || "Untitled"} — ${priceStr} — by ${sellerName}`;

    // Per-day boundary (UTC — simpler than time-zoning per user; cap is
    // approximate, not load-bearing).
    const dayStartIso = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();

    // 6) Fan out. Sequential is fine — these counts are low and we want
    //    each insert's UNIQUE check to settle before the next.
    for (const [userId, { savedSearchId }] of followerMap.entries()) {
      try {
        // Daily cap check.
        const { count: todayCount, error: capErr } = await supabase
          .from("saved_search_notifications")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .gte("sent_at", dayStartIso);
        if (capErr) {
          console.warn("[saved-search-fanout] cap query failed for", userId, capErr);
          // Fail-open: don't drop the notification just because the cap
          // query had a transient error.
        } else if ((todayCount ?? 0) >= DAILY_CAP_PER_USER) {
          capped++;
          continue;
        }

        // Insert audit row (also serves as dedup gate — UNIQUE constraint).
        const { data: inserted, error: insertErr } = await supabase
          .from("saved_search_notifications")
          .insert({
            user_id:         userId,
            saved_search_id: savedSearchId,
            listing_id:      listing.listing_id,
          })
          .select("id")
          .maybeSingle();

        if (insertErr) {
          // 23505 = unique_violation = already notified about this listing.
          if (String(insertErr.code) === "23505" || /duplicate key/i.test(insertErr.message || "")) {
            deduped++;
            continue;
          }
          console.error("[saved-search-fanout] log insert failed for", userId, insertErr);
          errored++;
          continue;
        }
        if (!inserted) {
          // ON CONFLICT silently dropped — treat as deduped.
          deduped++;
          continue;
        }

        // --- Push notification (best-effort, non-blocking) ---
        // Push only — no email path. Per-event email for follow alerts
        // crosses into annoying-territory fast (different ergonomic from
        // "weekly digest"). Push notifications are the right register for
        // this kind of alert: lockscreen for installed-PWA users, silent
        // for everyone else. Non-followers receive nothing either way.
        try {
          await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
            method: "POST",
            headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: userId,
              title,
              body:    bodyText,
              url:     `/listing.html?id=${listing.listing_id}`,
              tag:     `saved-search-${listing.listing_id}`,
            }),
          });
        } catch (e) {
          console.warn("[saved-search-fanout] push dispatch failed for", userId, e);
        }

        sent++;
      } catch (e) {
        console.error("[saved-search-fanout] per-follower error for", userId, e);
        errored++;
      }
    }

    return json(200, { matched, sent, capped, deduped, errored });
  } catch (err) {
    console.error("[saved-search-fanout] handler error:", err);
    return json(500, { error: (err as Error).message });
  }
});
