-- =============================================================================
-- 016_anon_column_privacy.sql
-- =============================================================================
-- Hardens public.profiles against bot-scraping by signed-out (anon) callers.
--
-- The problem we're solving:
--   The Supabase anon API key is publicly embedded in /lib/supabase.js (this is
--   how Supabase is designed to be used). Until now, anon could SELECT every
--   column on profiles directly via PostgREST — including contact_email and
--   facebook_profile_url. The web app's UI hides those fields from anon
--   viewers, but the data was still in raw API responses, harvestable by any
--   bot with no signup required.
--
-- After this migration:
--   - Anon can only SELECT a small set of intentionally-public columns
--     (user_id, display_name, handle, account_status, created_at).
--   - Anon trying to select contact_email, facebook_profile_url, location,
--     pending_display_name, tos_*, etc. gets 403 from PostgREST.
--   - Authenticated users keep full SELECT — they still see seller contact
--     info on listing pages and seller pages once signed in.
--
-- This closes the easy-mode scraper (anon API enumeration). It does NOT
-- close the hard-mode scraper (sign up first, then scrape) — that's a
-- separate residual risk we handle via admin moderation.
--
-- DEPLOYMENT ORDER:
--   1. First, deploy the client-side change that makes listing.html and
--      seller.html request only safe profile columns when the viewer is
--      anonymous.
--   2. THEN run this migration in the Supabase SQL editor.
--   If you run this migration before the JS ships, anon page loads will
--   start returning 403 because their queries still request sensitive
--   columns.
-- =============================================================================

-- Strip anon's blanket SELECT on profiles. Existing UPDATE/DELETE grants (if
-- any) are left intact — those are controlled by RLS policies, not GRANTs.
revoke select on public.profiles from anon;

-- Re-grant SELECT only on the columns deemed safe for anonymous viewers.
-- Conservative list — any column not enumerated here is unreadable by anon
-- and will return 403 from PostgREST. New columns added later are not
-- automatically anon-readable, which is the right default for a privacy
-- posture.
--
-- Safe columns:
--   user_id        — needed for joins (listings.seller_id -> profiles.user_id)
--   display_name   — public per privacy policy
--   handle         — public per privacy policy (the @handle disambiguator)
--   account_status — needed for catalog query to hide suspended/banned sellers
--   created_at     — joined date on /seller pages (public)
--
-- Explicitly NOT granted (and thus inaccessible to anon):
--   contact_email, facebook_profile_url, location, pending_display_name,
--   pending_display_name_at, tos_accepted_at, tos_version, is_admin,
--   is_trusted, status_changed_at
grant select (
  user_id,
  display_name,
  handle,
  account_status,
  created_at
) on public.profiles to anon;

-- Authenticated retains full SELECT. (Re-granting is defensive — the prior
-- revoke targeted anon only, but stating the authenticated grant explicitly
-- makes the intent clear and survives any future revoke-all cleanups.)
grant select on public.profiles to authenticated;
