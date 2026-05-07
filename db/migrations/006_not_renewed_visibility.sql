-- =============================================================================
-- Migration 006 — not_renewed listings stay visible + auto-expiry job
-- =============================================================================
-- Apply ONCE in the Supabase SQL editor. Idempotent.
--
-- Behavior:
--   - Listings whose seller stops renewing (last_renewed_at older than 60 days)
--     flip from status='available' to status='not_renewed'.
--   - not_renewed listings stay visible in the public catalog (filtered to
--     their own dropdown option) so buyers can still find them — but the
--     listing detail page warns them that availability is unknown.
--   - Sellers can "Renew" any not_renewed listing from their dashboard to
--     reset last_renewed_at and restore status='available'.
--
-- Optional pg_cron schedule (commented out; enable manually if you want
-- automated daily expiry).
-- =============================================================================

-- ---- Update the public-readable filter to include not_renewed ----
drop policy if exists listings_select_public on public.listings;
create policy listings_select_public
  on public.listings for select
  using (
    moderation_status = 'approved'
    and status in ('available','pending','sold','not_renewed')
    and exists (
      select 1 from public.profiles p
      where p.user_id = listings.seller_id
        and (p.account_status is null or p.account_status = 'active')
    )
  );

-- ---- pg_cron daily expiry (OPTIONAL) ----
-- Setup: Supabase Dashboard > Database > Extensions > enable "pg_cron".
-- Then uncomment and run the block below. This schedules a job that runs
-- every day at 2am UTC and expires any available listing whose
-- last_renewed_at is older than 60 days.
--
-- Without pg_cron, the same effect is achieved by clicking
-- "Run expiration check now" in the Admin > Expiring soon panel.
--
-- create extension if not exists pg_cron;
--
-- select cron.schedule(
--   'cc-expire-listings',
--   '0 2 * * *',
--   $$
--     update public.listings
--        set status = 'not_renewed'
--      where status = 'available'
--        and last_renewed_at < now() - interval '60 days';
--   $$
-- );
