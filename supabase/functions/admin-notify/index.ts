// =============================================================================
// admin-notify — Push notification to the admin when something needs review
// =============================================================================
// Deploy with:
//   supabase functions deploy admin-notify
//
// (Default JWT verification — the gateway authenticates the calling user's
// session token; we don't need --no-verify-jwt because this function is
// triggered by signed-in sellers from the portal, not by other edge functions.)
//
// Required Supabase secrets:
//   ADMIN_USER_ID         — the auth.users.id of the admin to notify. Set
//                            once via Supabase Dashboard → Project Settings →
//                            Edge Functions → Secrets, OR via:
//                            supabase secrets set ADMIN_USER_ID=<uuid>
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//
// When called:
//   1. Validates the caller is signed in (the gateway already did this).
//   2. Loads the listing for context (artist, title, price, seller name).
//   3. Constructs notification copy based on the `kind` field.
//   4. Calls send-push internally with the admin's user_id.
//
// Trigger points (callers, all in portal/index.html):
//   - kind='listing'     → after a new sale/ISO listing is submitted
//                          with moderation_status='pending', OR after a
//                          non-Established seller's edit re-queues the
//                          listing into the moderation queue.
//   - kind='verification' → after a verification video is uploaded
//                          (any seller, since the admin reviews each video).
//
// Push tag uses a stable key like `admin-<kind>-<listing_id>` so re-fires
// for the same listing replace the prior notification instead of stacking.
//
// Request body:
//   { kind: 'listing' | 'verification', listing_id: string }
//
// Response: { sent: boolean, reason?: string }
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ADMIN_USER_ID = Deno.env.get("ADMIN_USER_ID") ?? "";

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

  if (!ADMIN_USER_ID) {
    console.error("[admin-notify] ADMIN_USER_ID secret not set");
    return json(200, { sent: false, reason: "admin-not-configured" });
  }

  try {
    const body = await req.json();
    const kind = String(body?.kind || "");
    const listingId = String(body?.listing_id || "").trim();
    if (!listingId)                                 return json(400, { error: "listing_id required" });
    if (kind !== "listing" && kind !== "verification") return json(400, { error: "kind must be 'listing' or 'verification'" });

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // Load listing for the notification body. Service-role bypasses RLS so
    // we get the canonical row regardless of moderation/visibility state.
    const { data: listing, error: listingErr } = await supabase
      .from("listings")
      .select("listing_id, seller_id, artist_name, artwork_title, listing_type, asking_price_usd, budget_min_usd, budget_max_usd, moderation_status")
      .eq("listing_id", listingId)
      .single();
    if (listingErr || !listing) {
      console.warn("[admin-notify] listing not found:", listingId, listingErr);
      return json(200, { sent: false, reason: "listing-missing" });
    }

    // Don't bother notifying about admin's OWN listings (when admin is
    // testing the portal as a seller).
    if (String(listing.seller_id) === ADMIN_USER_ID) {
      return json(200, { sent: false, reason: "admin-is-seller" });
    }

    // Seller name for context.
    const { data: sellerProfile } = await supabase
      .from("profiles")
      .select("display_name, handle")
      .eq("user_id", listing.seller_id)
      .single();
    const sellerName = sellerProfile?.display_name
      || (sellerProfile?.handle ? `@${sellerProfile.handle}` : "Unknown seller");

    // Construct copy.
    const isIso = listing.listing_type === "iso";
    const artist = listing.artist_name || (isIso ? "Any artist" : "Unknown artist");
    const title  = listing.artwork_title || (isIso ? "(no specific title)" : "Untitled");
    const priceStr = isIso
      ? (listing.budget_max_usd != null
          ? `Up to $${Number(listing.budget_max_usd).toLocaleString()}`
          : "Open budget")
      : (listing.asking_price_usd != null
          ? `$${Number(listing.asking_price_usd).toLocaleString()}`
          : "Price on request");

    let pushTitle: string;
    let pushBody:  string;
    if (kind === "listing") {
      pushTitle = isIso ? "New ISO request pending review" : "New listing pending review";
      pushBody  = `${artist} — ${title} — ${priceStr} — by ${sellerName}`;
    } else {
      // kind === 'verification'
      pushTitle = "New verification video pending";
      pushBody  = `${artist} — ${title} — by ${sellerName}`;
    }

    // Push tag: stable per (kind, listing_id) so resubmissions replace
    // the prior notification rather than stacking. Admin only ever sees
    // the most recent state for each listing.
    const tag = `admin-${kind}-${listing.listing_id}`;

    // Fire the push via send-push. send-push is deployed --no-verify-jwt
    // with an internal apikey check; we pass SERVICE_KEY in the apikey
    // header (see [[supabase-new-key-format-internal-fn-calls]] in memory).
    try {
      const pushRes = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: ADMIN_USER_ID,
          title:   pushTitle,
          body:    pushBody,
          url:     `/portal/?tab=admin`,
          tag,
        }),
      });
      if (!pushRes.ok) {
        const t = await pushRes.text().catch(() => "");
        console.warn("[admin-notify] send-push returned non-OK:", pushRes.status, t);
      }
    } catch (e) {
      console.warn("[admin-notify] send-push dispatch failed:", e);
    }

    return json(200, { sent: true });
  } catch (err) {
    console.error("[admin-notify] handler error:", err);
    return json(500, { error: (err as Error).message });
  }
});
