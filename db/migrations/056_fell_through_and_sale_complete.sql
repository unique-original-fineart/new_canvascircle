-- =============================================================================
-- 056_fell_through_and_sale_complete.sql
-- =============================================================================
-- Two new seller-side affordances for accepted offers:
--
--   1. mark_offer_fell_through — buyer ghosted after acceptance OR the
--      off-platform deal didn't close for any other reason. Seller voids
--      the acceptance:
--        * Offer flips to status='fell_through'
--        * Listing flips back to 'available'
--        * OTHER offers that were auto-declined when this one accepted
--          (status='declined_listing_unavailable', declined_by_offer_id
--          pointing at this offer) get REACTIVATED back to 'pending' so
--          those buyers can resume negotiation.
--        * Countdown on the revived offers starts fresh via last_revived_at
--          (otherwise a 6-day-old offer would revive with 1 day left).
--      Returns the array of revived offer IDs so the frontend can pass
--      them to offer-fanout for the "your offer is back in play" push.
--
--   2. mark_offer_sale_complete — happy path. Off-platform deal closed.
--      Seller flips listing.status to 'sold'. No state change on the
--      offer itself (stays 'accepted' / 'accepted_counter'); the listing
--      status is the canonical "did the transaction close" indicator.
--
-- Plus a new last_revived_at column so countdowns on revived offers reset
-- to a fresh 7-day window instead of inheriting whatever time was left on
-- the original creation.
--
-- Why seller-only for both: per design discussion 2026-06-07. Buyer
-- ghosting is the failure case sellers actually need to recover from;
-- seller ghosting is rare (sellers control inventory). If we ever need
-- a buyer-side void path, add a separate RPC.
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — revived buyers don't see WHY
--     the sale fell through, just that it did. No leak of the ghoster's
--     identity or amount in the push (other than what they already saw
--     when they got the original "sold to another buyer" push).
--   * [[free-for-collectors-forever]] — still no transaction layer.
--     Marking sale complete is metadata only. Marking fell-through is
--     metadata only. No money flows through the platform.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema extensions
-- ---------------------------------------------------------------------------

alter table public.offers drop constraint if exists offers_status_check;
alter table public.offers add constraint offers_status_check check (status in (
  'pending', 'accepted', 'declined', 'countered',
  'auto_declined', 'withdrawn', 'expired',
  'accepted_counter', 'declined_counter', 'withdrawn_counter',
  'declined_listing_unavailable',
  'fell_through'
));

-- last_revived_at: set when an offer is reactivated from
-- declined_listing_unavailable back to pending via the fell-through path.
-- Countdown rendering uses GREATEST(created_at, last_revived_at) as the
-- anchor so revived offers get a fresh 7-day window. Also used by the
-- pg_cron expiration job below.
alter table public.offers
  add column if not exists last_revived_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Update expiration cron — count from last_revived_at when set
-- ---------------------------------------------------------------------------
-- Without this update, a revived offer would expire 7 days after its
-- ORIGINAL creation (often immediately). With this, the 7 days start
-- ticking from the revival.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
      from cron.job where jobname = 'offers-expire-pending';
    perform cron.schedule(
      'offers-expire-pending',
      '23 * * * *',
      $cron$
        update public.offers
          set status = 'expired',
              decided_at = now()
          where status = 'pending'
            and greatest(created_at, coalesce(last_revived_at, created_at)) < now() - interval '7 days';
      $cron$
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. mark_offer_fell_through RPC
-- ---------------------------------------------------------------------------
-- Verifies caller is the listing's seller (which is the responder of an
-- 'accepted' offer, or the proposer of an 'accepted_counter' offer that
-- they originated). Voids the acceptance, revives the auto-declined
-- offers from the same race, flips listing back to available.
--
-- Returns the array of revived offer IDs so the frontend can fan out
-- "your offer is back in play" pushes via offer-fanout mode='fell_through'.
create or replace function public.mark_offer_fell_through(
  p_offer_id uuid
) returns uuid[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller        uuid := auth.uid();
  v_offer         public.offers%rowtype;
  v_listing_seller uuid;
  v_revived       uuid[];
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;

  select * into v_offer from public.offers where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'offer not found';
  end if;
  if v_offer.status not in ('accepted', 'accepted_counter') then
    raise exception 'only accepted offers can be marked as fell-through (current: %)', v_offer.status;
  end if;

  -- Caller must be the listing's seller. The seller is the listing's
  -- seller_id column; the offer's proposer/responder roles flip across
  -- counters, so we look up the canonical seller from the listing.
  select seller_id into v_listing_seller from public.listings where listing_id = v_offer.listing_id;
  if v_listing_seller is null then
    raise exception 'listing not found';
  end if;
  if v_listing_seller <> v_caller then
    raise exception 'only the listing seller can mark an offer as fell-through';
  end if;

  -- 1. Revive race losers. UPDATE...RETURNING lets us capture the array
  --    of reactivated IDs in one statement. Clear declined_by_offer_id +
  --    decided_at so the rows look pristine again; stamp last_revived_at
  --    so the countdown timer resets to a fresh 7-day window.
  with revived as (
    update public.offers
      set status = 'pending',
          decided_at = null,
          declined_by_offer_id = null,
          last_revived_at = now()
      where declined_by_offer_id = p_offer_id
        and status = 'declined_listing_unavailable'
      returning id
  )
  select array_agg(id) into v_revived from revived;

  -- 2. Void the accepted offer itself.
  update public.offers
    set status = 'fell_through',
        decided_at = now(),
        decided_by = v_caller
    where id = p_offer_id;

  -- 3. Flip listing back to available. Only if currently 'pending'
  --    (Pending Sale) — don't clobber if seller already manually moved
  --    it to 'sold' or 'delisted' for some reason.
  update public.listings
    set status = 'available'
    where listing_id = v_offer.listing_id
      and status = 'pending';

  return coalesce(v_revived, array[]::uuid[]);
end $$;

revoke all on function public.mark_offer_fell_through(uuid) from public, anon;
grant execute on function public.mark_offer_fell_through(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. mark_offer_sale_complete RPC
-- ---------------------------------------------------------------------------
-- Seller confirms the off-platform deal closed. Listing flips to 'sold'.
-- Offer status stays as 'accepted' / 'accepted_counter' — the listing
-- status carries the canonical "the transaction closed" signal.
create or replace function public.mark_offer_sale_complete(
  p_offer_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller         uuid := auth.uid();
  v_offer          public.offers%rowtype;
  v_listing_seller uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;

  select * into v_offer from public.offers where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'offer not found';
  end if;
  if v_offer.status not in ('accepted', 'accepted_counter') then
    raise exception 'only accepted offers can be marked as sale complete (current: %)', v_offer.status;
  end if;

  select seller_id into v_listing_seller from public.listings where listing_id = v_offer.listing_id;
  if v_listing_seller is null then
    raise exception 'listing not found';
  end if;
  if v_listing_seller <> v_caller then
    raise exception 'only the listing seller can mark a sale as complete';
  end if;

  -- Flip listing to sold. Allow from 'pending' (the post-accept state)
  -- OR 'available' (in case seller manually flipped it back at some point).
  -- Don't update if already 'sold' or 'delisted' so we don't churn timestamps.
  update public.listings
    set status = 'sold'
    where listing_id = v_offer.listing_id
      and status in ('pending', 'available');
end $$;

revoke all on function public.mark_offer_sale_complete(uuid) from public, anon;
grant execute on function public.mark_offer_sale_complete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Update get_offer_threads_for_user to include last_revived_at
-- ---------------------------------------------------------------------------
-- Countdown rendering needs this column. Adding it to the return table
-- so the frontend can use GREATEST(created_at, last_revived_at) as the
-- anchor for "expires in N" calculations.
--
-- DROP-then-CREATE because Postgres won't let CREATE OR REPLACE change a
-- function's return table shape (we're adding last_revived_at to the
-- returned columns). The DROP is safe — the function is recreated
-- immediately after with the same signature + permissions, no client-
-- visible gap.
drop function if exists public.get_offer_threads_for_user(uuid);
create function public.get_offer_threads_for_user(
  p_user_id uuid default null
) returns table (
  id                       uuid,
  listing_id               uuid,
  proposer_id              uuid,
  responder_id             uuid,
  amount_usd               numeric,
  note                     text,
  status                   text,
  parent_offer_id          uuid,
  declined_by_offer_id     uuid,
  created_at               timestamptz,
  last_revived_at          timestamptz,
  decided_at               timestamptz,
  decision_note            text,
  direction                text,
  artist_name              text,
  artwork_title            text,
  listing_seller_id        uuid,
  listing_status           text,
  other_party_id           uuid,
  other_party_display_name text,
  other_party_handle       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with target as (
    select coalesce(p_user_id, auth.uid()) as uid
  ),
  base as (
    select o.*,
      case when o.responder_id = (select uid from target) then 'incoming' else 'outgoing' end as direction,
      case when o.responder_id = (select uid from target) then o.proposer_id else o.responder_id end as other_id
    from public.offers o, target
    where (o.proposer_id = target.uid or o.responder_id = target.uid)
      and o.status <> 'auto_declined'
  )
  select
    b.id, b.listing_id, b.proposer_id, b.responder_id,
    b.amount_usd, b.note, b.status, b.parent_offer_id, b.declined_by_offer_id,
    b.created_at, b.last_revived_at, b.decided_at, b.decision_note,
    b.direction,
    l.artist_name, l.artwork_title, l.seller_id, l.status as listing_status,
    b.other_id,
    p.display_name, p.handle
  from base b
  left join public.listings l on l.listing_id = b.listing_id
  left join public.profiles p on p.user_id = b.other_id
  order by b.created_at desc
  limit 200;
$$;

revoke all on function public.get_offer_threads_for_user(uuid) from public, anon;
grant execute on function public.get_offer_threads_for_user(uuid) to authenticated;

-- =============================================================================
-- End of migration 056.
-- =============================================================================
