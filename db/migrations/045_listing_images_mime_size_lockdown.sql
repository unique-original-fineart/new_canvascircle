-- =============================================================================
-- 045_listing_images_mime_size_lockdown.sql
-- =============================================================================
-- Server-side MIME + size validation on the `listing-images` storage bucket.
--
-- Threat model: the existing upload path lets the client choose the
-- Content-Type header it sends to Supabase Storage. Without bucket-level
-- restrictions, a malicious client can bypass compressImage() and upload
-- arbitrary content — most importantly SVG-with-embedded-JavaScript, which
-- would execute XSS when rendered, or oversized binaries that drain
-- Supabase Storage quota.
--
-- Defense: tell Supabase Storage to refuse uploads outside the allowed MIME
-- list and over a sane size cap. This is enforced at the storage REST API
-- level, server-side, regardless of what the client claims.
--
-- Allowed MIMEs aligned with what compressImage() actually produces today:
--   image/jpeg   — primary output
--   image/png    — iOS PWA fallback when canvas.toBlob silently drops WebP
--                  (see [[image-upload-pipeline]] for the WebKit quirk)
--   image/webp   — preferred output when supported
--
-- EXPLICITLY NOT ALLOWED:
--   image/svg+xml — can carry inline <script>, executes on render
--   image/gif     — not used; deny by default
--   application/* — never an image
--   anything else — closed by default
--
-- File size limit: 5 MB. compressImage targets ~200-400KB compressed; 5MB
-- is generous headroom for the occasional uncompressed iPhone HEIC that
-- gets pushed through. Anything larger is almost certainly abuse.
--
-- Defense-in-depth: even if a determined attacker sends SVG bytes with a
-- forged Content-Type: image/jpeg header, Supabase Storage will store the
-- file with content-type image/jpeg, and Cloudflare's X-Content-Type-Options:
-- nosniff (set in /_headers as of cc-v162) prevents the browser from
-- sniffing and re-interpreting as SVG. So the script never executes when
-- rendered in an <img> tag downstream.
--
-- Note on the verification-videos bucket: not touched here. That bucket is
-- already private + admin-RLS-only (see migration 020), so SVG smuggling
-- isn't a concern there — no path renders the bytes as HTML/SVG.
-- =============================================================================

update storage.buckets
set
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'],
  file_size_limit    = 5242880  -- 5 MB
where id = 'listing-images';

-- Sanity check: confirm the row exists. If this returns 0 rows, the bucket
-- was never created via the dashboard and this migration is a no-op. (The
-- bucket was created via Supabase dashboard before migration files were
-- consistently authored, hence no `create bucket` step here.)
do $$
declare
  v_allowed text[];
  v_limit   bigint;
begin
  select allowed_mime_types, file_size_limit
    into v_allowed, v_limit
    from storage.buckets
    where id = 'listing-images';
  if v_allowed is null then
    raise exception 'listing-images bucket not found or update failed';
  end if;
  raise notice 'listing-images allowed_mime_types = %, file_size_limit = %', v_allowed, v_limit;
end $$;

-- =============================================================================
-- End of migration 045.
-- =============================================================================
