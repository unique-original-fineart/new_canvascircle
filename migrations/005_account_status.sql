-- =============================================================================
-- Migration 005 — account_status (active / suspended / banned)
-- =============================================================================
-- Apply ONCE in the Supabase SQL editor. Idempotent.
--
-- Behavior:
--   - 'active'    → normal account, listings show in the public catalog
--   - 'suspended' → admin pauses the account; listings hidden from public
--                    catalog but kept in the seller's portal (read-only via UI)
--   - 'banned'    → permanent; admin also deletes all of their listings.
--                    Their listings can never come back.
--
-- The public catalog SELECT policy is updated to exclude listings whose seller
-- is not active. Owner + admin SELECTs are unaffected — sellers still see
-- their own listings in their portal even while suspended.
-- =============================================================================

alter table public.profiles
  add column if not exists account_status text not null default 'active'
    check (account_status in ('active', 'suspended', 'banned'));

alter table public.profiles
  add column if not exists status_changed_at timestamptz,
  add column if not exists status_note text;

create index if not exists profiles_account_status_idx
  on public.profiles (account_status)
  where account_status <> 'active';

-- ---- Update the public listings SELECT policy ----
drop policy if exists listings_select_public on public.listings;
create policy listings_select_public
  on public.listings for select
  using (
    moderation_status = 'approved'
    and status in ('available','pending','sold')
    and exists (
      select 1 from public.profiles p
      where p.user_id = listings.seller_id
        and (p.account_status is null or p.account_status = 'active')
    )
  );
