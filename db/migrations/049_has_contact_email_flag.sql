-- =============================================================================
-- 049_has_contact_email_flag.sql
-- =============================================================================
-- Add a derived boolean column `has_contact_email` to profiles so the
-- listing + seller pages can show/hide the "Email Seller" button WITHOUT
-- needing to SELECT the actual contact_email value.
--
-- Threat model: any signed-in user can run an arbitrary SELECT against
-- the catalog and grab the raw `profiles.contact_email` field for every
-- seller. Park West collectors are high-value targets for spam/phishing
-- and the existing public pages (listing.html, seller.html) ship the
-- raw email in the JSON payload to the client. A scraper signed into
-- any account can harvest every seller email in minutes.
--
-- This migration is part of the cc-v172 anti-scraping fix:
--   1. Add has_contact_email as a STORED generated column. Cheap to
--      compute, indexed automatically since it's not nullable in the
--      derivation, no behavioral change yet.
--   2. Update listing.html + seller.html to SELECT has_contact_email
--      instead of contact_email. Done in same deploy.
--   3. (Later session, defense-in-depth) REVOKE column-level SELECT on
--      contact_email from authenticated, with SECURITY DEFINER helpers
--      for the owner-self-read and admin paths. Deferred because it
--      requires refactoring 6+ places in portal/index.html that admin
--      queries today depend on. Out of scope for this session — the
--      scraping vector is on the PUBLIC pages, which this migration +
--      the listing.html/seller.html changes already close.
--
-- The column is GENERATED ALWAYS so it stays in sync with contact_email
-- automatically; no trigger needed. STORED means it's materialized in
-- the row (vs computed at query time), so SELECTs are free.
-- =============================================================================

alter table public.profiles
  add column if not exists has_contact_email boolean
  generated always as (
    contact_email is not null and trim(contact_email) <> ''
  ) stored;

-- Sanity check: count current rows where the flag computes true vs false,
-- just so the run output makes the rollout visible.
do $$
declare
  v_true int;
  v_false int;
begin
  select count(*) filter (where has_contact_email),
         count(*) filter (where not has_contact_email)
    into v_true, v_false
    from public.profiles;
  raise notice 'profiles.has_contact_email: % true / % false', v_true, v_false;
end $$;

-- =============================================================================
-- End of migration 049.
-- =============================================================================
