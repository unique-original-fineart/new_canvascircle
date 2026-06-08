// =============================================================================
// offer-fanout — CanvasCircle Make-an-Offer notification fan-out
// =============================================================================
// Deploy:
//   supabase functions deploy offer-fanout
//
// Auto-injected by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Called by the listing.html offer modal + the portal Offers tab. Routes
// to one of four modes:
//
//   mode='create' (default) — fired after an offer or counter is INSERTED
//     * Caller MUST be the offer's proposer (forge defense)
//     * Push to responder ("you have a new offer / counter to decide")
//     * For initial offers (not counters): saver-nudge fan-out to anyone
//       who saved this listing
//     * Silent for auto_declined (legacy — current insert_offer RAISEs
//       instead of inserting auto_declined, but legacy rows still exist)
//
//   mode='decision' — fired after respond_to_offer/respond_to_counter
//     * Caller MUST be the offer's responder
//     * Push to proposer with the decision (accepted / declined / counter
//       — counters route via 'create' on the new counter row, not here)
//     * On accept/accept_counter: race-to-accept fan-out — find all
//       offers with declined_by_offer_id = this offer's id and push
//       "another buyer accepted, this listing is no longer available"
//       to each loser's proposer (the displaced buyer)
//
//   mode='fell_through' — fired after mark_offer_fell_through RPC
//     * Caller MUST be the listing's seller (mirrors the RPC's auth check)
//     * Push the ghoster (proposer of the now-fell_through offer)
//     * Push each revived buyer ("your offer is back in play") — IDs
//       come from `revived_offer_ids` in the body, returned by the RPC.
//
//   mode='sale_complete' — fired after mark_offer_sale_complete RPC
//     * Caller MUST be the listing's seller
//     * Push the buyer ("seller marked the sale complete, thanks!")
//
// Request body:
//   { offer_id: uuid, mode?: 'create' | 'decision' | 'fell_through' | 'sale_complete',
//     revived_offer_ids?: uuid[] }
//
// Response: { sent: number, saver_nudges?: number, race_losers?: number, revived?: number }
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

async function sendPush(
  adminClient: any,
  user_id: string,
  title: string,
  body: string,
  url: string,
  tag: string
): Promise<boolean> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
      method: "POST",
      headers: { "apikey": SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, title, body, url, tag }),
    });
    if (!r.ok) console.warn("[offer-fanout] push non-200:", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("[offer-fanout] push dispatch failed:", e);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const userClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json(401, { error: "Invalid session" });

    const body = await req.json();
    const offer_id: string | undefined = body?.offer_id;
    const mode: string = body?.mode || "create";
    const revivedIds: string[] = Array.isArray(body?.revived_offer_ids) ? body.revived_offer_ids : [];
    if (!offer_id) return json(400, { error: "offer_id required" });

    // Load the offer + listing.
    const { data: offer, error: offerErr } = await adminClient
      .from("offers")
      .select(`
        id, listing_id, proposer_id, responder_id,
        amount_usd, status, parent_offer_id, created_at, decided_at,
        listings ( listing_id, artist_name, artwork_title )
      `)
      .eq("id", offer_id)
      .single();
    if (offerErr || !offer) {
      console.error("[offer-fanout] offer lookup failed:", offerErr);
      return json(404, { error: "Offer not found" });
    }

    const artwork = (offer.listings as any)?.artwork_title || "your listing";
    const artist  = (offer.listings as any)?.artist_name   || "";
    const artworkLabel = artist ? `${artwork} by ${artist}` : artwork;

    // Skip everything for legacy auto_declined rows (silent path).
    if (offer.status === "auto_declined") {
      return json(200, { sent: 0, skipped: 1, reason: "auto_declined" });
    }

    // -------------------------------------------------------------------
    // MODE: create — caller is proposer, push goes to responder
    // -------------------------------------------------------------------
    if (mode === "create") {
      if (offer.proposer_id !== user.id) {
        return json(403, { error: "Only the proposer can fan out a new offer" });
      }

      // Get proposer's display name for the push body.
      const { data: proposerProfile } = await adminClient
        .from("profiles")
        .select("display_name, handle")
        .eq("user_id", offer.proposer_id)
        .single();
      const proposerLabel = proposerProfile?.display_name
        || (proposerProfile?.handle ? `@${proposerProfile.handle}` : "Someone");

      const isCounter = offer.parent_offer_id != null;
      const title = isCounter
        ? `${proposerLabel} sent a counter-offer`
        : `New offer of ${fmtPrice(Number(offer.amount_usd))}`;
      const pushBody = isCounter
        ? `${fmtPrice(Number(offer.amount_usd))} on ${artworkLabel}.`
        : `${proposerLabel} offered on ${artworkLabel}.`;

      let sent = 0;
      if (await sendPush(adminClient, offer.responder_id, title, pushBody, "/portal/", `offer-${offer.id}`)) sent++;

      // Saver-nudge: initial offer only, exclude proposer + responder.
      let saverNudges = 0;
      if (!isCounter) {
        const { data: savers } = await adminClient
          .from("saved_listings")
          .select("user_id")
          .eq("listing_id", offer.listing_id);
        const recipients = (savers || [])
          .map((s: any) => s.user_id)
          .filter((uid: string) => uid && uid !== offer.proposer_id && uid !== offer.responder_id);
        for (const uid of recipients) {
          if (await sendPush(
            adminClient, uid,
            "Someone just made an offer",
            `On a piece you saved: ${artworkLabel}. Make yours before it sells.`,
            `/listing.html?id=${offer.listing_id}`,
            `saver-nudge-${offer.listing_id}`
          )) saverNudges++;
        }
      }

      return json(200, { sent, saver_nudges: saverNudges });
    }

    // -------------------------------------------------------------------
    // MODE: decision — caller is responder, push goes to proposer
    // Plus race-to-accept fan-out on accept/accept_counter.
    // -------------------------------------------------------------------
    if (mode === "decision") {
      if (offer.responder_id !== user.id) {
        return json(403, { error: "Only the responder can fan out a decision" });
      }

      let title = "";
      let pushBody = "";
      const amtStr = fmtPrice(Number(offer.amount_usd));
      switch (offer.status) {
        case "accepted":
        case "accepted_counter":
          title = "Your offer was accepted!";
          pushBody = `${amtStr} on ${artworkLabel}. The other party will follow up to complete the sale off-platform.`;
          break;
        case "declined":
        case "declined_counter":
          title = "Your offer was declined";
          pushBody = `${amtStr} on ${artworkLabel}. You can send a new offer if you'd like.`;
          break;
        default:
          // Status doesn't match a decision we push for (e.g. countered —
          // that path goes through mode='create' on the new counter row).
          return json(200, { sent: 0, skipped: 1, reason: `status=${offer.status}` });
      }

      let sent = 0;
      if (await sendPush(adminClient, offer.proposer_id, title, pushBody, "/portal/", `offer-decision-${offer.id}`)) sent++;

      // Race-to-accept fan-out. Only on accept/accept_counter — when the
      // listing closes, every other active negotiation got auto-declined
      // via _finalize_listing_acceptance() with declined_by_offer_id set
      // to this offer's id. Push each loser's proposer.
      let raceLosers = 0;
      if (offer.status === "accepted" || offer.status === "accepted_counter") {
        const { data: losers } = await adminClient
          .from("offers")
          .select("id, proposer_id, responder_id, listing_id")
          .eq("declined_by_offer_id", offer.id);
        // The loser's "buyer" is the one who was NOT the listing's seller.
        // Look up seller_id once.
        const { data: listing } = await adminClient
          .from("listings")
          .select("seller_id")
          .eq("listing_id", offer.listing_id)
          .single();
        const sellerId = listing?.seller_id;
        const seen = new Set<string>();
        for (const lo of (losers || []) as any[]) {
          const buyerId = lo.proposer_id === sellerId ? lo.responder_id : lo.proposer_id;
          if (!buyerId || seen.has(buyerId)) continue;
          seen.add(buyerId);
          if (await sendPush(
            adminClient, buyerId,
            "Listing no longer available",
            `${artworkLabel} just sold to another buyer. Your offer was closed out.`,
            `/listing.html?id=${offer.listing_id}`,
            `race-loser-${offer.listing_id}`
          )) raceLosers++;
        }
      }

      return json(200, { sent, race_losers: raceLosers });
    }

    // -------------------------------------------------------------------
    // MODE: fell_through — caller is the listing's seller, push the
    // ghoster (proposer of the voided offer) + push each revived buyer.
    // -------------------------------------------------------------------
    if (mode === "fell_through") {
      // Caller validation: must be the listing's seller.
      const { data: listing } = await adminClient
        .from("listings")
        .select("seller_id")
        .eq("listing_id", offer.listing_id)
        .single();
      if (!listing || listing.seller_id !== user.id) {
        return json(403, { error: "Only the listing seller can fan out fell-through" });
      }

      // The "ghoster" is the buyer of this thread — the participant who is
      // NOT the seller. They originally proposed (or accepted via counter)
      // and then didn't follow through off-platform.
      const ghosterId = offer.proposer_id === listing.seller_id ? offer.responder_id : offer.proposer_id;

      let sent = 0;
      if (ghosterId) {
        if (await sendPush(
          adminClient, ghosterId,
          "Sale marked as fell through",
          `The seller voided your accepted offer on ${artworkLabel}. The listing is back on the market.`,
          `/listing.html?id=${offer.listing_id}`,
          `offer-fell-through-${offer.id}`
        )) sent++;
      }

      // Revived buyers: each got the "sold to another buyer" push when
      // this offer accepted. Now they get a "back in play" push so they
      // know to come check their portal.
      let revived = 0;
      if (revivedIds.length > 0) {
        const { data: revivedRows } = await adminClient
          .from("offers")
          .select("id, proposer_id, responder_id")
          .in("id", revivedIds);
        const seen = new Set<string>();
        for (const r of (revivedRows || []) as any[]) {
          // Identify each revived offer's buyer (the non-seller participant).
          const buyerId = r.proposer_id === listing.seller_id ? r.responder_id : r.proposer_id;
          if (!buyerId || seen.has(buyerId)) continue;
          seen.add(buyerId);
          if (await sendPush(
            adminClient, buyerId,
            "Your offer is back in play",
            `The sale on ${artworkLabel} fell through. Your offer is open again. Check your portal to act.`,
            `/portal/`,
            `offer-revived-${offer.id}-${r.id}`
          )) revived++;
        }
      }

      return json(200, { sent, revived });
    }

    // -------------------------------------------------------------------
    // MODE: sale_complete — caller is the listing's seller, push the
    // buyer to confirm the off-platform deal closed.
    // -------------------------------------------------------------------
    if (mode === "sale_complete") {
      const { data: listing } = await adminClient
        .from("listings")
        .select("seller_id")
        .eq("listing_id", offer.listing_id)
        .single();
      if (!listing || listing.seller_id !== user.id) {
        return json(403, { error: "Only the listing seller can fan out sale-complete" });
      }

      const buyerId = offer.proposer_id === listing.seller_id ? offer.responder_id : offer.proposer_id;
      let sent = 0;
      if (buyerId) {
        if (await sendPush(
          adminClient, buyerId,
          "Sale marked complete",
          `The seller marked the sale of ${artworkLabel} as complete. Thanks for buying!`,
          `/portal/`,
          `offer-complete-${offer.id}`
        )) sent++;
      }
      return json(200, { sent });
    }

    return json(400, { error: `Unknown mode: ${mode}` });
  } catch (err) {
    console.error("[offer-fanout] crashed:", err);
    return json(500, { error: (err as Error).message || "Internal error" });
  }
});
