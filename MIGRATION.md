# Migration plan — Apps Script pipeline → Supabase + Cloudflare Pages

The legacy site keeps running until v2 is fully ready. We cut over once,
in a known-quiet window, after rehearsing the data import on a staging
project. There is no dual-write phase — the old system is read-only from
the moment we start the import.

## Phase 0 — Scaffold (this commit)

- Folder layout in `CanvasCircle_2/`.
- `db/schema.sql` — full Postgres schema with RLS, run once in Supabase.
- `lib/supabase.js` + `lib/config.js` — shared client.
- `index.html` — minimal public catalog reading live from Supabase.
- `README.md`, `.gitignore`, this file.

**Done when:** schema runs cleanly in Supabase; the empty catalog renders
the "catalog is empty" state at `new-canvascircle.pages.dev`.

## Phase 1 — Public catalog parity

Bring the new public catalog up to feature parity with the live site at
`canvascircle.art`. Still no auth required for visitors.

- `index.html` — full filter toolbar (search, category, status, price
  range), grid sort, empty state, footer.
- `listing.html` — single-listing detail page (replaces the modal in the
  old catalog), with all fields, image gallery, "Listed N days ago",
  seller mood, Message-on-Facebook link, Email Seller link.
- `about.html`, `guidelines.html` — static, copied from `_legacy/` and
  re-skinned.
- Save-listing (heart) — for anonymous visitors store in `localStorage`,
  for signed-in users store in `saved_listings` table (via Phase 2 auth).
- OG tags + favicon + manifest, identical to legacy.

**Done when:** a stranger landing on `new-canvascircle.pages.dev` cannot
tell it apart from `canvascircle.art` aside from the URL.

## Phase 2 — Seller portal

Replace `seller_portal.html` (Apps Script HtmlService).

- Sign up + sign in (email + password, magic link as backup).
- Profile editor — display name, location, Facebook profile URL,
  per-seller post header / footer text.
- Listing form — same fields as the Google Form, with image upload going
  straight into the `listing-images` bucket. Server-side image
  compression (Supabase edge function or just rely on `<img>` resizing)
  matched to the legacy 1200px-wide thumbnail.
- Listing dashboard — edit existing listings (status, price, mood, etc.).
  Validation rules from legacy: Yes/No required for shipping + COA, price
  numeric only.
- Sales-post builder — port the canvas-collage code from
  `_legacy/seller_portal.html`. The logic is unchanged; only the data
  source changes (read from `listings` table instead of `google.script.run`).
- Renewal — banner if any listing is within 7 days of its 60-day window;
  "Renew all" button updates `last_renewed_at = now()` on every listing
  for that seller.

**Done when:** Guy + 1 trusted seller can sign up, submit, edit, build a
post, and renew, all without ever touching the legacy Apps Script.

## Phase 3 — Admin portal

Replace `admin_portal.html` (Apps Script HtmlService).

- Moderation queue — pending listings, approve / reject with notes.
- Trusted sellers panel — toggle `profiles.is_trusted`.
- Filter toolbar (search, seller, artist, status) — same as legacy.
- Update Catalog button — no-op in v2 (the catalog is live, no rebuild).
  Replace with a "Refresh stats" or "Re-run renewal check now" button.
- Expiring soon panel — listings within 7 days of renewal cutoff;
  Extend renewal action.
- Broadcast email — Supabase edge function calling Resend, logged to
  `email_log` table.
- Rotate seller link — N/A (v2 uses real auth, no per-seller magic links).

**Done when:** Guy can do every admin task on the new site.

## Phase 4 — Data import

Run once, in a quiet window, after Phases 1–3 are tested on staging.

1. **Freeze the legacy.** Disable the Google Form. Add a banner to the
   live site pointing at `canvascircle.art` (the new version).
2. **Export the sheet.** Download the responses sheet as CSV.
3. **Run the import script** (`scripts/import_legacy.mjs`, written
   during Phase 4):
   - For each unique seller email in the CSV, create an `auth.users` row
     via Supabase Admin API and a corresponding `profiles` row carrying
     over display_name, location, Facebook URL, post header/footer.
     Send each seller a password-reset email.
   - For each row in the CSV, create a `listings` row with all fields
     mapped one-to-one. Preserve `created_at`, `last_renewed_at`,
     `previous_price_usd`, etc.
   - For each `image_file` value, download from the legacy Drive folder
     and re-upload into `listing-images/{listing_id}/0-{filename}`.
     Insert a `listing_images` row. (The legacy
     `lh3.googleusercontent.com` URLs work for download — no auth
     needed.)
4. **Smoke-test.** Visit the new site as anon, as a freshly-signed-in
   seller, and as an admin. Compare counts: rows in `listings` ==
   approved rows in CSV.
5. **Switch DNS.** Point `canvascircle.art` from GitHub Pages to the
   Cloudflare Pages project. TTL ≤ 5 min beforehand.
6. **Send seller welcome email.** "We've moved — here's your password
   reset link." Sent via Resend through the new admin broadcast tool.

**Done when:** `canvascircle.art` resolves to Cloudflare Pages and every
legacy seller has reset their password.

## Phase 5 — Sunset legacy

After two weeks of stable operation:

- Disable Apps Script time-based triggers (`dailyRenewalCheck`,
  `triggerCatalogRebuild_`).
- Archive the GitHub Pages repo (`unique-original-fineart/art_catalog`)
  — set to read-only, leave the README pointing at the new repo.
- Revoke the GitHub PAT used by the Apps Script.
- Move `_legacy/` out of the v2 repo into a separate
  `canvascircle-legacy-archive` repo so we stop shipping it on every
  push.

## Things that intentionally don't carry over

- **Per-seller magic-link tokens.** v2 uses real auth — no more sending
  long URL tokens. If a seller can't sign in, they reset their password.
- **`generate_catalog.py`.** The catalog is a live Supabase query; no
  static rebuild step. Saves the GitHub Action delay too.
- **`repository_dispatch` rebuild webhook.** Not needed.
- **`listing_id = max + 1`.** v2 uses `gen_random_uuid()` — no collisions
  even with concurrent inserts.
- **`seller_token` column.** Replaced by `auth.users.id`.

## Open questions to resolve before Phase 4

- How do we want to handle `pending_review` legacy rows that were never
  approved? Import as `pending_review` and re-moderate, or skip?
  Probably **import them** so the seller's history is intact.
- Renewal clock — do we reset `last_renewed_at` to import-day for
  everyone (60-day fresh window) or preserve the legacy timestamp
  (some listings would expire immediately)? Probably **preserve**, then
  manually extend any that legitimately deserve more time.
