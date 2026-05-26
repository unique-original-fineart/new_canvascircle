// =============================================================================
// send-email — CanvasCircle transactional email edge function
// =============================================================================
// Deploy:
//   supabase functions deploy send-email
//
// Required secrets (Supabase > Project Settings > Edge Functions > Secrets):
//   RESEND_API_KEY        — your Resend API key (re_xxx)
//   RESEND_FROM_EMAIL     — e.g. "CanvasCircle <no-reply@canvascircle.art>"
//                            (must be a verified domain on Resend; for quick
//                             testing use "onboarding@resend.dev")
//   ADMIN_EMAIL           — where seller "Contact admin" emails go
//
// Auto-injected by Supabase (no need to set):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
//
// Modes (POST body { mode: ... }):
//   1. "broadcast"        — admin only. Body { audience, subject, text }
//                            audience: "all" | "sellers" | "buyers"
//   2. "direct-to-seller" — admin only. Body { sellerUserId, subject, text }
//   3. "contact-admin"    — any signed-in user. Body { subject, text }
//   4. "welcome"          — any signed-in user, sent to themselves.
//                            Body {} — function builds template from profile.
//   5. "contact-seller"   — any signed-in user. Body { listing_id, subject, text }
//                            Routes buyer → seller through Resend with Reply-To
//                            set to the buyer's contact email, so the seller's
//                            reply goes back to the buyer (not to no-reply@).
//                            Rate-limited to RATE_LIMIT_PER_HOUR sends per
//                            sender per hour via the contact_messages table.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY    = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "onboarding@resend.dev";
const ADMIN_EMAIL       = Deno.env.get("ADMIN_EMAIL") ?? "admin@canvascircle.art";
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Max buyer→seller contact-form sends from one sender per rolling hour.
// 5 is generous enough that a legitimate buyer pinging multiple sellers
// won't hit it, but cheap enough that a compromised account or naive
// scraper gets shut down fast. Bump if real users start complaining.
const CONTACT_SELLER_RATE_LIMIT_PER_HOUR = 5;

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

// Wrap plaintext into a minimal HTML body. Newlines → <br>.
function htmlEscape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]!));
}
function wrapHtml(text: string): string {
  const safe = htmlEscape(text).replace(/\n/g, "<br>");
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px;">
${safe}
<hr style="border:none;border-top:1px solid #e8e4dc;margin:24px 0 16px"/>
<p style="font-size:12px;color:#6b6b6b;margin:0;">CanvasCircle &middot; <a href="https://canvascircle.art" style="color:#b8860b">canvascircle.art</a></p>
</body></html>`;
}

async function sendOne(to: string, subject: string, html: string, replyTo?: string) {
  const body: Record<string, unknown> = {
    from: RESEND_FROM_EMAIL,
    to,
    subject,
    html,
  };
  if (replyTo) body.reply_to = replyTo;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Resend ${r.status}: ${errText}`);
  }
  return await r.json();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  try {
    if (!RESEND_API_KEY) return json(500, { error: "Server is missing RESEND_API_KEY" });

    // Auth — every mode requires a signed-in user.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Missing Authorization header" });

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json(401, { error: "Invalid session" });

    // Caller's profile (for is_admin checks + display name).
    const { data: callerProfile } = await supabase
      .from("profiles")
      .select("user_id, display_name, contact_email, is_admin")
      .eq("user_id", user.id)
      .single();

    const body = await req.json();
    const mode = String(body?.mode || "");

    // ------------------------------------------------------------------
    if (mode === "broadcast") {
      if (!callerProfile?.is_admin) return json(403, { error: "Admin only" });
      const { audience, subject, text } = body;
      if (!subject || !text) return json(400, { error: "subject + text required" });

      // Resolve recipient emails.
      let recipients: { email: string; name: string }[] = [];

      if (audience === "all") {
        const { data } = await supabase
          .from("profiles")
          .select("contact_email, display_name")
          .not("contact_email", "is", null)
          .eq("account_status", "active");
        recipients = (data || [])
          .filter((p) => p.contact_email)
          .map((p) => ({ email: p.contact_email!, name: p.display_name || "" }));
      } else if (audience === "sellers") {
        // Sellers = profiles that have at least one listing. Fetch all then filter.
        const { data: sellerIds } = await supabase
          .from("listings")
          .select("seller_id");
        const ids = [...new Set((sellerIds || []).map((l) => l.seller_id))];
        if (ids.length) {
          const { data } = await supabase
            .from("profiles")
            .select("contact_email, display_name")
            .in("user_id", ids)
            .eq("account_status", "active")
            .not("contact_email", "is", null);
          recipients = (data || [])
            .filter((p) => p.contact_email)
            .map((p) => ({ email: p.contact_email!, name: p.display_name || "" }));
        }
      } else if (audience === "buyers") {
        // Buyers = active users with NO listings.
        const { data: sellerIds } = await supabase.from("listings").select("seller_id");
        const ids = [...new Set((sellerIds || []).map((l) => l.seller_id))];
        let q = supabase
          .from("profiles")
          .select("contact_email, display_name, user_id")
          .eq("account_status", "active")
          .not("contact_email", "is", null);
        if (ids.length) q = q.not("user_id", "in", `(${ids.map((i) => `"${i}"`).join(",")})`);
        const { data } = await q;
        recipients = (data || [])
          .filter((p) => p.contact_email)
          .map((p) => ({ email: p.contact_email!, name: p.display_name || "" }));
      } else {
        return json(400, { error: "Unknown audience" });
      }

      let okCount = 0;
      let errors: string[] = [];
      for (const r of recipients) {
        try {
          const greet = r.name ? `Hi ${r.name.split(/\s+/)[0]},\n\n` : "";
          await sendOne(r.email, subject, wrapHtml(greet + text), ADMIN_EMAIL);
          okCount++;
        } catch (e) {
          errors.push(`${r.email}: ${(e as Error).message}`);
        }
      }
      return json(200, {
        sent: okCount,
        attempted: recipients.length,
        errors: errors.slice(0, 10),
      });
    }

    // ------------------------------------------------------------------
    if (mode === "direct-to-seller") {
      if (!callerProfile?.is_admin) return json(403, { error: "Admin only" });
      const { sellerUserId, subject, text } = body;
      if (!sellerUserId || !subject || !text) return json(400, { error: "sellerUserId + subject + text required" });
      const { data: target } = await supabase
        .from("profiles")
        .select("contact_email, display_name")
        .eq("user_id", sellerUserId)
        .single();
      if (!target?.contact_email) return json(400, { error: "Seller has no contact email on file" });
      const greet = target.display_name ? `Hi ${target.display_name.split(/\s+/)[0]},\n\n` : "";
      await sendOne(target.contact_email, subject, wrapHtml(greet + text), ADMIN_EMAIL);
      return json(200, { sent: 1 });
    }

    // ------------------------------------------------------------------
    if (mode === "contact-admin") {
      const { subject, text } = body;
      if (!subject || !text) return json(400, { error: "subject + text required" });
      const callerName = callerProfile?.display_name || user.email;
      const callerMail = callerProfile?.contact_email || user.email;
      const fullSubject = `[CanvasCircle] ${subject} — from ${callerName}`;
      const fullBody = `From: ${callerName} <${callerMail}>\n\n${text}`;
      await sendOne(ADMIN_EMAIL, fullSubject, wrapHtml(fullBody), callerMail || undefined);
      return json(200, { sent: 1 });
    }

    // ------------------------------------------------------------------
    // contact-seller: signed-in buyer reaches out to a seller about a listing.
    // Replaces the old mailto: launcher. We send via Resend with Reply-To set
    // to the buyer's contact email so the seller's reply lands in the buyer's
    // inbox directly (Resend's From is no-reply@canvascircle.art).
    //
    // Rate limit: count rows in contact_messages where sender_id = caller
    // AND sent_at > now() - 1 hour. If that count >= the cap, reject.
    //
    // Inserts into contact_messages BEFORE calling Resend so that:
    //   (a) the row counts toward the next request's rate limit even if the
    //       Resend call later fails (conservatively assume the email might
    //       have been delivered — better to over-throttle than spam).
    //   (b) failed sends still leave an audit trail for debugging.
    if (mode === "contact-seller") {
      const { listing_id, subject, text } = body;
      if (!listing_id || !subject || !text) {
        return json(400, { error: "listing_id + subject + text required" });
      }
      const trimmedSubject = String(subject).trim().slice(0, 200);
      const trimmedText    = String(text).trim().slice(0, 5000);
      if (!trimmedSubject || !trimmedText) {
        return json(400, { error: "Subject and message cannot be empty." });
      }

      // Buyer must have a contact email on file — that's where the seller's
      // reply goes via Reply-To. Without it, the form gives the seller no
      // way to respond.
      const buyerMail = callerProfile?.contact_email || user.email;
      if (!buyerMail) {
        return json(400, { error: "Your account has no contact email on file. Add one in your profile before messaging sellers." });
      }
      const buyerName = callerProfile?.display_name || (user.email ? user.email.split("@")[0] : "A buyer");

      // Look up the listing → seller. Use service role here because the
      // anon-side listing select can be filtered by visibility policies.
      // We want the canonical row regardless of those filters.
      const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);
      const { data: listing, error: listingErr } = await adminClient
        .from("listings")
        .select("listing_id, seller_id, artwork_title, artist_name, listing_type, status, moderation_status")
        .eq("listing_id", listing_id)
        .single();
      if (listingErr || !listing) {
        return json(404, { error: "Listing not found" });
      }
      if (listing.seller_id === user.id) {
        return json(400, { error: "You can't message yourself." });
      }
      if (listing.moderation_status && listing.moderation_status !== "approved") {
        return json(400, { error: "This listing is not currently open for inquiries." });
      }

      const { data: seller, error: sellerErr } = await adminClient
        .from("profiles")
        .select("user_id, display_name, contact_email, account_status")
        .eq("user_id", listing.seller_id)
        .single();
      if (sellerErr || !seller?.contact_email) {
        return json(400, { error: "Seller has no contact email on file." });
      }
      if (seller.account_status && seller.account_status !== "active") {
        return json(400, { error: "This seller's account is no longer active." });
      }

      // Rate-limit check.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: recentCount, error: countErr } = await adminClient
        .from("contact_messages")
        .select("id", { count: "exact", head: true })
        .eq("sender_id", user.id)
        .gte("sent_at", oneHourAgo);
      if (countErr) {
        console.error("[contact-seller] rate-limit query failed:", countErr);
        // Fail open here — a broken counter shouldn't block legit users —
        // but log loudly so we notice if it persists.
      } else if ((recentCount ?? 0) >= CONTACT_SELLER_RATE_LIMIT_PER_HOUR) {
        return json(429, {
          error: `You've sent ${recentCount} messages in the last hour. Please wait a bit before sending more — this limit protects sellers from spam.`,
        });
      }

      // Insert the audit row. We use the user-scoped client (with the
      // Authorization header from the request) so the RLS insert policy
      // (sender_id = auth.uid()) approves it.
      const { error: insertErr } = await supabase
        .from("contact_messages")
        .insert({
          sender_id:    user.id,
          recipient_id: seller.user_id,
          listing_id:   listing.listing_id,
          subject:      trimmedSubject,
          body:         trimmedText,
          reply_to:     buyerMail,
        });
      if (insertErr) {
        console.error("[contact-seller] insert failed:", insertErr);
        return json(500, { error: "Could not record your message. Please try again." });
      }

      // Build the email. Lead with attribution + listing context, then the
      // buyer's message verbatim. The seller's reply goes back to the
      // buyer via Reply-To.
      const isIso = listing.listing_type === "iso";
      const listingLabel = listing.artwork_title
        ? (listing.artist_name ? `${listing.artwork_title} by ${listing.artist_name}` : listing.artwork_title)
        : (isIso ? "your In Search Of listing" : "your listing");
      const sellerFirst = (seller.display_name || "").split(/\s+/)[0] || "there";
      const fullSubject = `[CanvasCircle] ${trimmedSubject}`;
      const fullBody =
        `Hi ${sellerFirst},\n\n` +
        `${buyerName} sent you a message about ${listingLabel} via CanvasCircle:\n\n` +
        `------------------------------\n` +
        `${trimmedText}\n` +
        `------------------------------\n\n` +
        `Reply to this email and your response will go directly to ${buyerName} at ${buyerMail}.\n\n` +
        `View the listing: https://canvascircle.art/listing.html?id=${listing.listing_id}`;

      try {
        await sendOne(seller.contact_email, fullSubject, wrapHtml(fullBody), buyerMail);
      } catch (sendErr) {
        // Audit row already written. Surface the failure to the caller so
        // they can retry — but the rate-limit counter has already moved.
        console.error("[contact-seller] Resend send failed:", sendErr);
        return json(502, { error: "Email service is having trouble. Please try again in a minute." });
      }

      return json(200, { sent: 1 });
    }

    // ------------------------------------------------------------------
    if (mode === "welcome") {
      const name = callerProfile?.display_name || user.email?.split("@")[0] || "there";
      const subject = "Welcome to CanvasCircle";
      const text =
`Hi ${name.split(/\s+/)[0]},

Welcome to CanvasCircle — a modern art listing platform built for collectors.

Here's what you can do with your account:

• Save listings you love by clicking the heart on any artwork.
• Sell pieces from your own collection — head to the seller portal, fill in your profile (Facebook URL required), and click "+ Add new listing."
• Post an "In Search Of" request for a piece you're hoping to acquire.
• Build a Facebook sales post for your listings in one click.

Before you reach out to a seller, take a minute to read our buying tips:
https://canvascircle.art/guidelines.html

Questions? Contact the admin Guy Scuderi at ${ADMIN_EMAIL}.

— The CanvasCircle team`;
      await sendOne(user.email!, subject, wrapHtml(text), ADMIN_EMAIL);
      return json(200, { sent: 1 });
    }

    return json(400, { error: "Unknown mode" });
  } catch (err) {
    console.error("[send-email] error:", err);
    return json(500, { error: (err as Error).message });
  }
});
