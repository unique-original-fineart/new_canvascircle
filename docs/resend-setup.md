# Resend setup

Step-by-step to wire up transactional email for CanvasCircle (broadcasts,
contact-admin, direct-to-seller, signup welcome).

## 1. Create a Resend account
- Go to <https://resend.com> and sign up.
- Free tier: 100 emails/day, 3,000/month, 1 verified domain. Plenty for now.

## 2. Pick a sending identity
You have two options:

**A) Quick start (no DNS needed)** — use Resend's onboarding domain.
   - Sender address: `onboarding@resend.dev`
   - You can send right away, but emails come from `resend.dev`, not your domain.

**B) Production setup (recommended)** — verify `canvascircle.art`.
   - In Resend, click **Domains → Add domain → canvascircle.art**.
   - Resend gives you 4 DNS records (TXT, MX, SPF, DKIM).
   - Add them to your DNS provider (likely Cloudflare, since the site is on Pages).
     - Cloudflare → DNS → Add record. Make sure "Proxy status" is set to **DNS only** (gray cloud) for the MX/TXT records.
   - Back in Resend, click **Verify**. Takes a few minutes.
   - Once verified, your sender becomes e.g. `CanvasCircle <no-reply@canvascircle.art>`.

Skip step B for now if you want to ship fast — you can verify the domain later
without changing any code.

## 3. Generate an API key
- Resend → **API Keys → Create API Key**.
- Name it "CanvasCircle production".
- Permission: **Sending access** (read-only options aren't needed).
- Copy the key (`re_xxxxxxxx...`). You won't see it again.

## 4. Add secrets to Supabase
Open **Supabase → Project Settings → Edge Functions → Secrets** and add:

| Name | Value |
|---|---|
| `RESEND_API_KEY` | the key from step 3 |
| `RESEND_FROM_EMAIL` | `onboarding@resend.dev` (option A) <br>OR `CanvasCircle <no-reply@canvascircle.art>` (option B) |
| `ADMIN_EMAIL` | `gjscuderi@gmail.com` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected — don't add them manually.

## 5. Install the Supabase CLI
If you haven't already:

```bash
brew install supabase/tap/supabase   # mac
# or visit https://supabase.com/docs/guides/cli/getting-started
```

Then link your project:

```bash
cd ~/Documents/CanvasCircle_2
supabase login                         # opens browser, auth once
supabase link --project-ref xwieomjsqwcswoadrvkv
```

## 6. Deploy the edge function

```bash
supabase functions deploy send-email --no-verify-jwt=false
```

(The `--no-verify-jwt=false` is the default; spelled out for clarity. JWT
verification is what lets the function read the caller's session.)

You should see: **Deployed Function send-email**.

## 7. Smoke test from the browser
With the front-end already wired up, sign in to `/portal/`, open the Admin tab,
go to the new Broadcast section, send a test message to "All admins" (just you).
Check your inbox — should arrive in a few seconds.

If nothing arrives:
- Check Resend → **Logs** (left sidebar) — see if the email was sent / bounced.
- Check Supabase → **Edge Functions → send-email → Logs** — see if the call hit
  the function and what it returned.
- 99% of failures are: missing `RESEND_API_KEY` secret, or sender domain not
  verified (option B before completing DNS verification).

## 8. (Optional) Schedule the welcome email differently
The welcome email currently fires from the front-end after a successful signup.
That's fine but if the user closes the tab before it sends, they don't get it.
For more reliability, configure a **Supabase Auth Hook** to call this function
on the `auth.user.created` event instead. See:
<https://supabase.com/docs/guides/auth/auth-hooks>

Not necessary for v1.

## Quick reference — function modes

The `send-email` function accepts a JSON body:

```jsonc
// Admin broadcast to all active sellers
{ "mode": "broadcast", "audience": "sellers", "subject": "...", "text": "..." }

// Admin emails one seller
{ "mode": "direct-to-seller", "sellerUserId": "uuid", "subject": "...", "text": "..." }

// Seller emails the admin
{ "mode": "contact-admin", "subject": "...", "text": "..." }

// Welcome email to the calling user
{ "mode": "welcome" }
```

Auth header required for all modes. Admin-only modes return 403 if the caller's
profile doesn't have `is_admin = true`.
