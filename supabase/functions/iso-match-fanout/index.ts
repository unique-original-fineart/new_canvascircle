// =============================================================================
// iso-match-fanout — CanvasCircle Collections ↔ ISO match push fan-out
// =============================================================================
// Deploy:
//   supabase functions deploy iso-match-fanout
//
// Auto-injected by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Called by the portal after an ISO listing is inserted (auto-approved
// for Established sellers) or after an admin approves a pending ISO
// listing. The function:
//   1. Loads the ISO listing.
//   2. Self-gates: skip if listing_type != 'iso', moderation_status !=
//      'approved', or status != 'available'. So callers can fire-and-
//      forget — calls against non-live listings just no-op.
//   3. Calls find_iso_collection_matches RPC to get the array of
//      Established collectors whose Collections contain a matching
//      piece. Excludes the ISO lister themselves.
//   4. Sends one push notification per matched collector with a deep
//      link to the ISO listing. The collector decides whether to reach
//      out via the existing contact-seller flow.
//
// Auth: ISO lister, admin, or service-role can call. Identity-level
// matches are NEVER returned to the caller — only the count.
//
// Request body:
//   { iso_listing_id: uuid }
//
// Response: { matched_count, sent }
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

async function sendPush(
  user_id: string,
  title: string,
  body: string,
  url: string,
  tag: string,
): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, title, body, url, tag }),
    });
    if (!r.ok) console.warn("[iso-match-fanout] push non-200:", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("[iso-match-fanout] push dispatch failed:", e);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    // Two clients: userClient for caller-identity validation, adminClient
    // for service-role queries (matching RPC + push dispatch).
    const userClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json(401, { error: "Invalid session" });

    const body = await req.json();
    const iso_listing_id: string | undefined = body?.iso_listing_id;
    if (!iso_listing_id) return json(400, { error: "iso_listing_id required" });

    // Load the listing. Use adminClient so RLS doesn't bite — we trust
    // the auth check below.
    const { data: listing, error: listErr } = await adminClient
      .from("listings")
      .select("listing_id, listing_type, seller_id, artist_name, artwork_title, status, moderation_status")
      .eq("listing_id", iso_listing_id)
      .single();
    if (listErr || !listing) {
      console.error("[iso-match-fanout] listing lookup failed:", listErr);
      return json(404, { error: "Listing not found" });
    }

    // Self-gates so callers don't need to pre-check state.
    if (listing.listing_type !== "iso") {
      return json(200, { matched_count: 0, sent: 0, reason: "not an ISO listing" });
    }
    if (listing.moderation_status !== "approved" || listing.status !== "available") {
      return json(200, { matched_count: 0, sent: 0, reason: "ISO not live yet" });
    }

    // Auth: only the ISO lister or an admin can trigger the fanout.
    // Look up the caller's admin flag via profiles.is_admin.
    const isLister = listing.seller_id === user.id;
    let isAdmin = false;
    if (!isLister) {
      const { data: callerProfile } = await adminClient
        .from("profiles")
        .select("is_admin")
        .eq("user_id", user.id)
        .single();
      isAdmin = !!callerProfile?.is_admin;
    }
    if (!isLister && !isAdmin) {
      return json(403, { error: "Only the ISO lister or an admin can dispatch this fanout" });
    }

    // Find matching collector user_ids. The RPC enforces is_trusted +
    // active + excludes the ISO lister.
    const { data: matches, error: matchErr } = await adminClient
      .rpc("find_iso_collection_matches", { p_iso_listing_id: iso_listing_id });
    if (matchErr) {
      console.error("[iso-match-fanout] match RPC failed:", matchErr);
      return json(500, { error: matchErr.message || "match failed" });
    }
    const recipients: string[] = Array.isArray(matches) ? matches : [];

    // Build the push body. Title shows the artist when known so the
    // collector immediately recognizes the relevance.
    const artistLabel = listing.artist_name ? ` by ${listing.artist_name}` : "";
    const titleLabel  = listing.artwork_title ? ` "${listing.artwork_title}"` : "";
    const pushTitle = "A buyer is looking for a piece you own";
    const pushBody  = `Someone posted an In Search Of for${titleLabel}${artistLabel}. You have a match in your Collection — tap to see their post.`;
    const pushUrl   = `/listing.html?id=${iso_listing_id}`;
    const tagBase   = `iso-match-${iso_listing_id}`;

    let sent = 0;
    for (const uid of recipients) {
      if (await sendPush(uid, pushTitle, pushBody, pushUrl, tagBase)) sent++;
    }

    return json(200, { matched_count: recipients.length, sent });
  } catch (err) {
    console.error("[iso-match-fanout] crashed:", err);
    return json(500, { error: (err as Error).message || "Internal error" });
  }
});
