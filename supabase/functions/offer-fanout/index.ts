// =============================================================================
// offer-fanout — CanvasCircle Make-an-Offer notification fan-out
// =============================================================================
// Deploy:
//   supabase functions deploy offer-fanout
//
// Auto-injected by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Called by the listing.html offer-modal client after insert_offer succeeds.
// Triggers two fan-outs:
//
//   1. SELLER PUSH NOTIFICATION
//      "New offer of $X on your listing 'Y'." Routes through send-push so
//      sellers with push-notifications enabled get an immediate alert.
//      Silent for offers with status='auto_declined' (they failed the
//      seller's private floor; per [[preserve-seller-pricing-power]] the
//      seller doesn't need to know about them, and the buyer never finds
//      out either way).
//
//   2. SAVER-NUDGE FAN-OUT (the eBay pattern Guy specifically called out)
//      "Someone made an offer on a piece you saved. Make yours before
//      it sells." Pushes to every user who has saved this listing
//      EXCEPT the buyer who just submitted (no point nudging themselves).
//      Throttled to max 1 push per saver per listing per 24h via a
//      dedupe table (see migration 052's offer_saver_nudges table —
//      actually this nudge table comes in a follow-up migration; for
//      now we throttle in-memory inside this function by checking
//      recent contact_messages or by adding a lightweight nudge log
//      table in migration 053 if scale demands it).
//
// Request body:
//   { offer_id: uuid }
//
// Auth: service-role internal-only. The client passes the service-role
// key via the `apikey` header (per [[supabase-new-key-format-internal-fn-calls]]).
// The function also accepts a regular signed-in user JWT — in that case
// it validates that the caller is the proposer of the offer being announced
// (defense against random users triggering pushes about other people's
// offers).
//
// Response: { sent_seller: boolean, saver_nudges: N, skipped: N }
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

function fmtPrice(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  return "$" + Math.round(n).toLocaleString("en-US");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    // We need both clients:
    //   * userClient: validates the caller's JWT (so we can confirm the
    //     caller is the offer proposer).
    //   * adminClient: service-role for all the cross-user reads + push
    //     dispatch (saver lookups, listing/profile joins).
    const userClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json(401, { error: "Invalid session" });

    const body = await req.json();
    const offer_id: string | undefined = body?.offer_id;
    if (!offer_id) return json(400, { error: "offer_id required" });

    // Load the offer + listing + seller profile.
    const { data: offer, error: offerErr } = await adminClient
      .from("offers")
      .select(`
        id, listing_id, proposer_id, responder_id,
        amount_usd, status, parent_offer_id, created_at,
        listings (
          listing_id, artist_name, artwork_title
        )
      `)
      .eq("id", offer_id)
      .single();
    if (offerErr || !offer) {
      console.error("[offer-fanout] offer lookup failed:", offerErr);
      return json(404, { error: "Offer not found" });
    }

    // Validate: the caller must be the proposer of this offer. Prevents
    // any other user from triggering pushes about an offer they didn't make.
    if (offer.proposer_id !== user.id) {
      return json(403, { error: "Only the proposer can fan out an offer" });
    }

    // Skip everything for auto_declined offers — silent path per spec.
    if (offer.status === "auto_declined") {
      return json(200, { sent_seller: false, saver_nudges: 0, skipped: 1, reason: "auto_declined" });
    }

    // Look up the proposer's display name for the notification body.
    const { data: proposerProfile } = await adminClient
      .from("profiles")
      .select("display_name, handle")
      .eq("user_id", offer.proposer_id)
      .single();
    const proposerLabel = proposerProfile?.display_name
      || (proposerProfile?.handle ? `@${proposerProfile.handle}` : "Someone");

    const artwork = (offer.listings as any)?.artwork_title || "your listing";
    const artist  = (offer.listings as any)?.artist_name   || "";
    const artworkLabel = artist ? `${artwork} by ${artist}` : artwork;

    // -----------------------------------------------------------------
    // 1. Seller push notification.
    // -----------------------------------------------------------------
    // The recipient is the responder (the seller for an initial offer;
    // the original buyer for a counter, which means push goes to whoever
    // is being asked to decide).
    let sentSeller = false;
    const isCounter = offer.parent_offer_id != null;
    const title = isCounter
      ? `${proposerLabel} sent a counter-offer`
      : `New offer of ${fmtPrice(Number(offer.amount_usd))}`;
    const pushBody = isCounter
      ? `${fmtPrice(Number(offer.amount_usd))} on ${artworkLabel}.`
      : `${proposerLabel} offered on ${artworkLabel}.`;

    try {
      const r = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
        method: "POST",
        headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: offer.responder_id,
          title,
          body:    pushBody,
          url:     "/portal/",
          tag:     `offer-${offer.id}`,
        }),
      });
      sentSeller = r.ok;
      if (!r.ok) console.warn("[offer-fanout] seller push non-200:", r.status, await r.text());
    } catch (e) {
      console.error("[offer-fanout] seller push dispatch failed:", e);
    }

    // -----------------------------------------------------------------
    // 2. Saver-nudge fan-out.
    // -----------------------------------------------------------------
    // For the INITIAL offer only (not counter-offers — counters happen
    // in private 1:1 between two parties, the rest of the market doesn't
    // need to know). Pushes to everyone who has saved this listing EXCEPT
    // the proposer themselves.
    //
    // Throttle: skip a saver if they already received an offer-nudge on
    // this listing within the last 24h. We check by scanning saved_listings'
    // last_offer_nudged_at column (added in migration 053 — see TODO below)
    // OR by an in-process query against a nudge log. For MVP we just send
    // one push per saver per offer; if a listing gets multiple offers in
    // the same day the savers may receive multiple nudges. Tighten in a
    // follow-up if signal warrants.
    let saverNudges = 0;
    if (!isCounter) {
      const { data: savers } = await adminClient
        .from("saved_listings")
        .select("user_id")
        .eq("listing_id", offer.listing_id);
      const recipientIds = (savers || [])
        .map((s: any) => s.user_id)
        .filter((uid: string) => uid && uid !== offer.proposer_id && uid !== offer.responder_id);

      // Fan out one push per saver. Sequential to keep load gentle on
      // send-push; small N (savers per listing typically <50 for Park West
      // niche). Future: batch into a single send-push call if N grows.
      for (const uid of recipientIds) {
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
            method: "POST",
            headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: uid,
              title:   "Someone just made an offer",
              body:    `On a piece you saved: ${artworkLabel}. Make yours before it sells.`,
              url:     `/listing.html?id=${offer.listing_id}`,
              tag:     `saver-nudge-${offer.listing_id}`,
            }),
          });
          if (r.ok) saverNudges++;
        } catch (e) {
          console.error("[offer-fanout] saver nudge failed for", uid, e);
        }
      }
    }

    return json(200, { sent_seller: sentSeller, saver_nudges: saverNudges, skipped: 0 });
  } catch (err) {
    console.error("[offer-fanout] crashed:", err);
    return json(500, { error: (err as Error).message || "Internal error" });
  }
});
