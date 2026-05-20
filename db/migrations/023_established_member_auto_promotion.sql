-- =============================================================================
-- 023_established_member_auto_promotion.sql
-- =============================================================================
-- Adds automatic promotion to Established Member status (profiles.is_trusted)
-- when a user meets both criteria:
--
--   * ≥4 active sale listings with verification_status = 'verified'
--   * ≥3 currently-accepted Sales References (where the user is the seller
--     being vouched for — `seller_references.seller_user_id`)
--
-- Behavior:
--   - Auto-promote only. The trigger never sets is_trusted = false.
--   - Admin override via a new `is_trusted_locked` boolean: once true, the
--     trigger leaves that profile alone. The admin "Trusted" toggle in the
--     portal will set this lock whenever it's used, so any manual decision
--     by the admin sticks.
--   - Already-trusted users are no-ops (the function short-circuits) so
--     repeated trigger fires never cost a useless UPDATE.
--
-- Backfill at the bottom:
--   1. Every currently-trusted profile gets `is_trusted_locked = true` —
--      treats every existing manual decision as locked, preserving Guy's
--      existing state exactly.
--   2. Untouched profiles that already meet the 4+3 criteria get
--      auto-promoted. Their lock stays false so future admin demotes
--      will set the lock and stick.
--
-- The 4+3 thresholds live in three places — guidelines.html (seller-
-- facing), terms.html (binding), and the constants here. Keep all three
-- in sync if you ever change them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Lock column on profiles
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_trusted_locked boolean not null default false;

comment on column public.profiles.is_trusted_locked is
  'true means the admin has explicitly set this profile''s is_trusted value, and the auto-promotion trigger must not touch it. Set automatically whenever the admin clicks the Trusted toggle. Admin can clear via a "Reset to auto" action to let the trigger take over again.';

-- ---------------------------------------------------------------------------
-- 2. Core recompute function — auto-promotes if criteria are met, never demotes
-- ---------------------------------------------------------------------------
create or replace function public.recompute_user_trusted(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked          boolean;
  v_already_trusted boolean;
  v_verified_count  int;
  v_reference_count int;
begin
  if p_user_id is null then return; end if;

  select is_trusted_locked, is_trusted
    into v_locked, v_already_trusted
  from public.profiles
  where user_id = p_user_id;

  -- Either of these short-circuits the function.
  if v_locked is true       then return; end if;   -- admin owns this profile's state
  if v_already_trusted is true then return; end if;  -- already promoted, no-op

  -- Count active verified sale listings owned by this user.
  -- ISO listings are excluded — they can't be ownership-verified.
  select count(*) into v_verified_count
  from public.listings
  where seller_id = p_user_id
    and listing_type = 'sale'
    and verification_status = 'verified';

  -- Count accepted references where this user is the one being vouched for.
  select count(*) into v_reference_count
  from public.seller_references
  where seller_user_id = p_user_id
    and status = 'accepted';

  -- The 4+3 threshold. Tune here if you ever change the policy; remember
  -- to update guidelines.html + terms.html too.
  if v_verified_count >= 4 and v_reference_count >= 3 then
    update public.profiles
       set is_trusted = true
     where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.recompute_user_trusted(uuid) from public;
revoke all on function public.recompute_user_trusted(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Trigger on listings.verification_status changes
-- ---------------------------------------------------------------------------
-- The sync_listing_verification_status() trigger from migration 020 already
-- keeps listings.verification_status in sync with the raw listing_verifications
-- rows. Watching the denormalized column on listings is therefore enough —
-- any meaningful change to a user's verified count flows through here.
-- ---------------------------------------------------------------------------
create or replace function public.trg_recompute_trusted_on_listing_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.verification_status is distinct from new.verification_status
     and new.seller_id is not null then
    perform public.recompute_user_trusted(new.seller_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_recompute_trusted_on_listing_status on public.listings;
create trigger trg_recompute_trusted_on_listing_status
  after update of verification_status on public.listings
  for each row execute function public.trg_recompute_trusted_on_listing_status();

-- ---------------------------------------------------------------------------
-- 4. Trigger on seller_references changes
-- ---------------------------------------------------------------------------
-- Fires for the SELLER (the user being vouched for) on insert / update /
-- delete. We don't care about the reference user's status because being
-- a reference for someone doesn't change YOUR own promotion criteria.
-- ---------------------------------------------------------------------------
create or replace function public.trg_recompute_trusted_on_reference()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller_id uuid;
begin
  v_seller_id := coalesce(new.seller_user_id, old.seller_user_id);
  if v_seller_id is not null then
    perform public.recompute_user_trusted(v_seller_id);
  end if;
  return null;
end;
$$;

drop trigger if exists trg_recompute_trusted_on_reference_changes on public.seller_references;
create trigger trg_recompute_trusted_on_reference_changes
  after insert or update or delete on public.seller_references
  for each row execute function public.trg_recompute_trusted_on_reference();

-- ---------------------------------------------------------------------------
-- 5. Backfill
-- ---------------------------------------------------------------------------
-- 5a. Lock every currently-Established profile so the trigger never
--     touches their state.
update public.profiles
   set is_trusted_locked = true
 where is_trusted = true;

-- 5b. Auto-promote any non-locked, non-trusted profile that already meets
--     the 4+3 criteria right now. Anyone promoted here keeps lock=false so
--     a later admin demote will set the lock and stick.
update public.profiles p
   set is_trusted = true
 where p.is_trusted = false
   and p.is_trusted_locked = false
   and (
     select count(*) from public.listings l
      where l.seller_id = p.user_id
        and l.listing_type = 'sale'
        and l.verification_status = 'verified'
   ) >= 4
   and (
     select count(*) from public.seller_references r
      where r.seller_user_id = p.user_id
        and r.status = 'accepted'
   ) >= 3;

-- =============================================================================
-- End of migration 023. Requires migrations 019 (seller_references) and 020
-- (listing_verifications + verification_status state machine).
-- =============================================================================
