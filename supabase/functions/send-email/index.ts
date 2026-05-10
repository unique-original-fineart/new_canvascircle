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
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY    = Deno.env.get("RESEND_API_KEY") ?? "";
const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL") ?? "onboarding@resend.dev";
const ADMIN_EMAIL       = Deno.env.get("ADMIN_EMAIL") ?? "admin@canvascircle.art";
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
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
    if (mode === "welcome") {
      const name = callerProfile?.display_name || user.email?.split("@")[0] || "there";
      const subject = "Welcome to CanvasCircle";
      const text =
`Hi ${name.split(/\s+/)[0]},

Welcome to CanvasCircle — a modern art marketplace for social selling.

Here's what you can do with your account:

• Save listings you love by clicking the heart on any artwork.
• Sell your own art — head to the seller portal, fill in your profile, and click "+ Add new listing."
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
