# CanvasCircle.art — v2

A rebuild of CanvasCircle as a single self-hosted site. Replaces the old
Google Forms + Sheets + Apps Script + GitHub Pages pipeline with:

- **Supabase** — Postgres database, auth, file storage, edge functions
- **Cloudflare Pages** — static hosting at `canvascircle.art`
- **Vanilla HTML + ES modules** — no build step, no framework

The previous implementation lives untouched in `_legacy/` for reference.

## Folder layout

```
CanvasCircle_2/
├── index.html              # Public catalog landing (loads from Supabase)
├── about.html              # (todo) static About page
├── listing.html            # (todo) single-listing detail page
│
├── portal/                 # Authenticated seller area
│   └── index.html          # (todo) sign in, edit listings, sales-post builder
│
├── admin/                  # Admin-only area
│   └── index.html          # (todo) moderation, trusted sellers, broadcast email
│
├── lib/
│   ├── config.js           # Public Supabase URL + anon key, site origin
│   └── supabase.js         # Shared Supabase client + helpers
│
├── db/
│   └── schema.sql          # The full Postgres schema — run once in Supabase
│
├── assets/                 # Logos, favicon, OG image, manifest, sw.js
│
├── _legacy/                # Old Apps Script / GitHub Pages pipeline (read-only)
│
├── MIGRATION.md            # Plan for cutting over from the legacy pipeline
└── README.md               # (this file)
```

## First-time setup

1. **Create the Supabase project** (already done — `xwieomjsqwcswoadrvkv`).
2. **Run the schema:** open Supabase → SQL → New query → paste
   `db/schema.sql` → Run. This creates every table, index, RLS policy, and
   the `listing-images` storage bucket.
3. **Make yourself admin:** in the SQL editor, run
   ```sql
   update public.profiles set is_admin = true
   where user_id = (select id from auth.users where email = 'gjscuderi@gmail.com');
   ```
   (You'll need to sign up via the portal first so the `auth.users` row
   exists.)
4. **Fill in `lib/config.js`:** paste your Supabase **anon** key into
   `SUPABASE_ANON_KEY`. The anon key is safe to commit; the **service\_role**
   key is not — keep it only in your password manager and Supabase edge
   function secrets.
5. **Push to GitHub** (`unique-original-fineart/new_canvascircle`). Cloudflare
   Pages auto-deploys on push.

## Local development

There's no build step. Open the project with any static file server, e.g.:

```bash
# from inside CanvasCircle_2/
python3 -m http.server 8080
# then open http://localhost:8080
```

ES module imports (`import { supabase } from "/lib/supabase.js"`) require a
real HTTP server — opening files via `file://` will break the imports.

## Auth model (RLS-driven)

All access control lives in `db/schema.sql` as Row-Level Security policies.
Plain English summary:

- **Anonymous visitors** can read approved + active listings and their
  images. They can't read anything else.
- **Signed-in sellers** can read/write their own listings and images,
  read/write their own profile, read/write their own saved listings.
  They cannot self-approve (a trigger blocks any change to
  `moderation_status` from a non-admin).
- **Admins** (`profiles.is_admin = true`) can do anything.

The browser only ever uses the **anon key**. RLS does the gating
server-side.

## Where things moved (legacy → v2)

| Legacy                                          | v2                                              |
|-------------------------------------------------|-------------------------------------------------|
| Google Form submission                          | `portal/` listing form                          |
| Google Sheet rows                               | `listings` table (Postgres)                     |
| Google Drive image folder                       | `listing-images` Supabase Storage bucket        |
| `processArtworkSubmissions.gs` Apps Script      | RLS policies + edge functions (as needed)       |
| `seller_portal.html` (HtmlService)              | `portal/index.html` (auth-gated SPA-style page) |
| `admin_portal.html` (HtmlService)               | `admin/index.html`                              |
| `generate_catalog.py` + GitHub Pages rebuild    | `index.html` queries Supabase directly          |
| Email via `MailApp`                             | Resend via Supabase edge function               |
| Daily renewal trigger (`dailyRenewalCheck`)     | `pg_cron` scheduled SQL or scheduled edge fn    |

## What's not here yet

Phase 0 (this commit) is **scaffolding only**. The portal, admin pages,
and listing detail page are placeholders. See `MIGRATION.md` for the
phased plan.
