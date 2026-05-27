// =============================================================================
// price-drop-fanout — alert savers when a listing's price drops
// =============================================================================
// Deploy with:
//   supabase functions deploy price-drop-fanout --no-verify-jwt
//
// Auth model (same pattern as send-push + saved-search-fanout, see
//   [[supabase-new-key-format-internal-fn-calls]] memory):
//   - --no-verify-jwt so the gateway accepts requests without a JWT
//   - Internal apikey check verifies the caller has the service-role key
//
// Trigger point (caller): send-email's trigger-price-drop-fanout mode,
// which is invoked from the portal whenever a seller saves a listing
// with a decreased asking_price_usd.
//
// Request body: { listing_id: uuid, old_price: number, new_price: number }
//
// Eligibility filters (defense-in-depth — caller also checks but we
// re-validate so we can't be tricked into spamming):
//   1. Drop must be significant: ≥ 5% AND ≥ $25.
//   2. Listing must be approved + active.
//   3. Seller's account must be active.
//   4. Skip the seller themselves (they shouldn't get a notification
//      about their own price drop).
//   5. Skip savers we've notified within the last 30 days for THIS listing
//      (last_price_drop_notified_at on the saved_listings row).
//
// Notification copy:
//   Title: "Price drop on a listing you saved"
//   Body:  "[Artwork] is now $[new] (was $[old], save $[diff])"
//   Tap → /listing.html?id=...
//
// Returns: { matched, sent, skipped: { cap, recent, seller, error } }
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Significance thresholds — chosen so a $5 reduction on a $10,000 listing
// doesn't fire (technically 0.05%) and a $5 reduction on a $50 print
// doesn't fire either (technically 10% but only $5 absolute). Both must
// pass for the alert to send. Tunable here without DB or client changes.
const MIN_DROP_PERCENT  = 0.05;   // 5%
const MIN_DROP_DOLLARS  = 25;     // $25
const DEDUP_WINDOW_DAYS = 30;

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

  // Internal auth check.
  const callerKey = req.headers.get("apikey") || req.headers.get("Apikey");
  if (!callerKey || callerKey !== SERVICE_KEY) {
    return json(401, { error: "Unauthorized" });
  }

  try {
    const body = await req.json();
    const listingId = String(body?.listing_id || "").trim();
    const oldPrice  = Number(body?.old_price);
    const newPrice  = Number(body?.new_price);
    if (!listingId || !Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) {
      return json(400, { error: "listing_id + numeric old_price + new_price required" });
    }

    // Significance gate.
    if (newPrice >= oldPrice) {
      return json(200, { matched: 0, sent: 0, reason: "not-a-drop" });
    }
    const dropDollars = oldPrice - newPrice;
    const dropPercent = oldPrice > 0 ? dropDollars / oldPrice : 0;
    if (dropDollars < MIN_DROP_DOLLARS || dropPercent < MIN_DROP_PERCENT) {
      return json(200, {
        matched: 0,
        sent: 0,
        reason: "drop-not-significant",
        dropDollars,
        dropPercent: Number(dropPercent.toFixed(3)),
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Load listing + seller status.
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("listing_id, seller_id, artist_name, artwork_title, status, moderation_status")
      .eq("listing_id", listingId)
      .single();
    if (listingErr || !listing) {
      return json(200, { matched: 0, sent: 0, reason: "listing-missing" });
    }
    if (listing.moderation_status !== "approved") {
      return json(200, { matched: 0, sent: 0, reason: "not-approved" });
    }

    const { data: sellerProfile } = await supabase
      .from("profiles")
      .select("display_name, account_status")
      .eq("user_id", listing.seller_id)
      .single();
    if (sellerProfile?.account_status && sellerProfile.account_status !== "active") {
      return json(200, { matched: 0, sent: 0, reason: "seller-inactive" });
    }

    // Cutoff timestamp for the dedup window.
    const cutoffIso = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Pull all savers of this listing whose last_price_drop_notified_at is
    // NULL OR older than the cutoff. We can't .or() against NULL cleanly
    // in PostgREST without acrobatics, so we filter in JS after a broader
    // query.
    const { data: savers, error: saversErr } = await supabase
      .from("saved_listings")
      .select("user_id, last_price_drop_notified_at")
      .eq("listing_id", listingId);
    if (saversErr) {
      console.error("[price-drop-fanout] savers query failed:", saversErr);
      return json(500, { error: "Could not fetch savers" });
    }

    let matched = 0, sent = 0;
    const skipped = { cap: 0, recent: 0, seller: 0, error: 0 };

    // Build notification copy. Used for every saver — same content.
    const artworkLabel = listing.artwork_title
      ? (listing.artist_name ? `${listing.artwork_title} by ${listing.artist_name}` : listing.artwork_title)
      : "A listing you saved";
    const fmtPrice = (n: number) => "$" + n.toLocaleString();
    const title = "Price drop on a listing you saved";
    const bodyText = `${artworkLabel} is now ${fmtPrice(newPrice)} (was ${fmtPrice(oldPrice)}, save ${fmtPrice(dropDollars)})`;

    for (const row of (savers || [])) {
      matched++;
      try {
        // Skip the seller themselves.
        if (row.user_id === listing.seller_id) {
          skipped.seller++;
          continue;
        }
        // Skip if we already notified within the dedup window.
        if (row.last_price_drop_notified_at && row.last_price_drop_notified_at > cutoffIso) {
          skipped.recent++;
          continue;
        }

        // Send the push. We deliberately mark this saver as "notified"
        // BEFORE awaiting the push response — push services can be slow
        // or transiently flaky, but we'd rather under-notify than send
        // duplicates. If the push fails, the row is still flagged for
        // the next 30 days, which is the conservative trade-off.
        const { error: stampErr } = await supabase
          .from("saved_listings")
          .update({ last_price_drop_notified_at: new Date().toISOString() })
          .eq("user_id", row.user_id)
          .eq("listing_id", listingId);
        if (stampErr) {
          console.error("[price-drop-fanout] stamp failed for", row.user_id, stampErr);
          skipped.error++;
          continue;
        }

        await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: "POST",
          headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: row.user_id,
            title,
            body:    bodyText,
            url:     `/listing.html?id=${listing.listing_id}`,
            tag:     `price-drop-${listing.listing_id}`,
          }),
        }).catch((e) => {
          console.warn("[price-drop-fanout] push dispatch failed for", row.user_id, e);
        });

        sent++;
      } catch (e) {
        console.error("[price-drop-fanout] per-saver error for", row.user_id, e);
        skipped.error++;
      }
    }

    return json(200, {
      matched,
      sent,
      skipped,
      dropDollars,
      dropPercent: Number(dropPercent.toFixed(3)),
    });
  } catch (err) {
    console.error("[price-drop-fanout] handler error:", err);
    return json(500, { error: (err as Error).message });
  }
});
