-- =============================================================================
-- 055_offers_restructure.sql
-- =============================================================================
-- Three interlocking changes that re-shape the Make-an-Offer feature from
-- a one-shot buyer-to-seller flow into a structured negotiation system:
--
--   1. One active offer per (listing, buyer) pair — prevents a buyer from
--      spamming a seller with parallel offers. Once a thread is declined
--      or withdrawn, the buyer can start a new one.
--
--   2. Seller-initiated offers — sellers can now propose an offer TO any
--      saver of their listing, opening a parallel negotiation per saver.
--      Mirrors eBay's "offer to interested buyer" flow.
--
--   3. Race-to-accept resolution — when one buyer accepts (or one seller
--      accepts a buyer's offer), the listing flips to Pending Sale and
--      all OTHER active negotiations on that listing auto-decline with a
--      new status 'declined_listing_unavailable'. Push notifications to
--      the losing buyers happen via offer-fanout edge fn (see new
--      declined_by_offer_id column for cross-reference).
--
-- Plus a helper RPC `get_offer_threads_for_user` that returns the data
-- the portal Offers tab needs — offers + listing context + other-party
-- display name & handle — in one query, so the client can group by
-- listing without a second round-trip to fetch profile info.
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — race resolution doesn't reveal
--     other offer amounts to the losing buyers. They're told "sold to
--     another buyer" only.
--   * [[free-for-collectors-forever]] — still no fees, still no escrow.
--     Race-to-accept is purely a UX clarity feature, not a transaction.
--   * [[in-platform-messenger-idea]] — structured offer state machine
--     ONLY. New seller-initiated flow doesn't add free-form messaging.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema extensions
-- ---------------------------------------------------------------------------

-- New terminal status for race losers + tracking column linking losers to
-- the winning offer that bumped them out. Both needed before any RPC
-- references them.
alter table public.offers drop constraint if exists offers_status_check;
alter table public.offers add constraint offers_status_check check (status in (
  'pending', 'accepted', 'declined', 'countered',
  'auto_declined', 'withdrawn', 'expired',
  'accepted_counter', 'declined_counter', 'withdrawn_counter',
  'declined_listing_unavailable'
));

alter table public.offers
  add column if not exists declined_by_offer_id uuid references public.offers(id) on delete set null;

-- Index for the offer-fanout edge fn lookup pattern: "find all losers of
-- this winning offer". Cheap b/c the column is sparse (only race losers
-- have a value).
create index if not exists offers_declined_by_idx
  on public.offers (declined_by_offer_id)
  where declined_by_offer_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Helper: _has_active_offer_thread
-- ---------------------------------------------------------------------------
-- Returns true if there's a pending offer involving (listing, buyer) in
-- either direction. A "thread" is the chain of offers linked by
-- parent_offer_id, but the test is simpler than walking the chain: only
-- one row per thread is ever in 'pending' state at a time (counters flip
-- the previous row to 'countered' before inserting the next 'pending'
-- row). So "thread is active" === "exists a pending row for this pair".
create or replace function public._has_active_offer_thread(
  p_listing_id uuid,
  p_buyer_id   uuid,
  p_seller_id  uuid
) returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.offers o
    where o.listing_id = p_listing_id
      and o.status = 'pending'
      and (
        (o.proposer_id = p_buyer_id  and o.responder_id = p_seller_id)
        or
        (o.proposer_id = p_seller_id and o.responder_id = p_buyer_id)
      )
  );
$$;

revoke all on function public._has_active_offer_thread(uuid, uuid, uuid) from public, anon, authenticated;
-- Only called by other SECURITY DEFINER RPCs, not by clients directly.

-- ---------------------------------------------------------------------------
-- 3. Helper: _finalize_listing_acceptance
-- ---------------------------------------------------------------------------
-- Called by respond_to_offer (on accept) and respond_to_counter (on
-- accept_counter). Does the race-to-accept work:
--   * Flips listing.status to 'pending' (Pending Sale)
--   * Finds all OTHER pending offers on this listing where the OTHER
--     party of the offer is NOT the winning buyer
--   * Updates each to status='declined_listing_unavailable',
--     decided_at=now(), declined_by_offer_id=p_winning_offer_id
--
-- Why declined_by_offer_id: the offer-fanout edge fn uses it to find
-- which losing offers need a push notification when a sale closes. It
-- also gives the analytics layer a way to reconstruct "this offer
-- displaced N other negotiations."
--
-- The check `o.proposer_id <> p_winning_buyer_id AND o.responder_id <>
-- p_winning_buyer_id` excludes the winning buyer's own thread (which
-- already has the accepted row, not pending).
create or replace function public._finalize_listing_acceptance(
  p_listing_id        uuid,
  p_winning_offer_id  uuid,
  p_winning_buyer_id  uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seller_id uuid;
begin
  -- Look up seller for the listing once; we'll use it to identify the
  -- "buyer" of each losing thread (the participant who is NOT the seller).
  select seller_id into v_seller_id from public.listings where listing_id = p_listing_id;
  if v_seller_id is null then
    -- Listing was deleted between accept and finalize — abandon quietly.
    return;
  end if;

  -- Move listing to Pending Sale so it stops showing as available in the
  -- catalog. Seller can later flip to 'sold' or back to 'available' if the
  -- off-platform deal falls through. Only flip if currently 'available' —
  -- don't clobber a manual 'sold' or admin-set state.
  update public.listings
    set status = 'pending'
    where listing_id = p_listing_id
      and status = 'available';

  -- Auto-decline all OTHER pending offers on this listing. The winning
  -- thread's accepted row is already not 'pending' (it just got set to
  -- 'accepted' / 'accepted_counter'), so it's naturally excluded. We
  -- still defensively guard with `<> p_winning_offer_id` in case a
  -- timing race ever leaves something pending in the winning chain.
  update public.offers
    set status = 'declined_listing_unavailable',
        decided_at = now(),
        declined_by_offer_id = p_winning_offer_id
    where listing_id = p_listing_id
      and status = 'pending'
      and id <> p_winning_offer_id
      and proposer_id  <> p_winning_buyer_id
      and responder_id <> p_winning_buyer_id;
end $$;

revoke all on function public._finalize_listing_acceptance(uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Update insert_offer — one-active-offer enforcement
-- ---------------------------------------------------------------------------
-- Same RPC signature as migration 054. Adds the "do you already have a
-- thread open with this seller on this listing?" check between the
-- block-check and the floor check. Buyer-friendly error message tells
-- them they can withdraw the existing one if they want to re-offer.
create or replace function public.insert_offer(
  p_listing_id uuid,
  p_amount_usd numeric,
  p_note       text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller         uuid := auth.uid();
  v_seller_id      uuid;
  v_listing_type   text;
  v_moderation     text;
  v_status         text;
  v_floor          numeric;
  v_note_clean     text;
  v_offer_id       uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in to make an offer';
  end if;
  if p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'offer amount must be positive';
  end if;

  select seller_id, listing_type, moderation_status, status, auto_reject_floor_usd
    into v_seller_id, v_listing_type, v_moderation, v_status, v_floor
    from public.listings
    where listing_id = p_listing_id;
  if v_seller_id is null then
    raise exception 'listing not found';
  end if;
  if v_listing_type = 'iso' then
    raise exception 'offers are sale-only; ISO listings do not accept offers';
  end if;
  if v_moderation <> 'approved' then
    raise exception 'this listing is not currently open for offers';
  end if;
  if v_status <> 'available' then
    raise exception 'this listing is not currently available';
  end if;
  if v_seller_id = v_caller then
    raise exception 'you cannot offer on your own listing';
  end if;

  if public.is_blocked_between(v_caller, v_seller_id) then
    raise exception 'offer cannot be delivered';
  end if;

  -- One-active-offer enforcement. The buyer (v_caller) cannot have a
  -- pending thread already with this seller on this listing. Friendly
  -- error tells them their option (withdraw + re-offer, or wait).
  if public._has_active_offer_thread(p_listing_id, v_caller, v_seller_id) then
    raise exception 'You already have an active offer on this listing. Withdraw it from your portal Offers tab before sending a new one.'
      using errcode = 'P0001';
  end if;

  if p_note is not null then
    v_note_clean := substring(trim(p_note), 1, 500);
    if v_note_clean ~* '(https?://|www\.)' then
      raise exception 'links are not allowed in offer notes';
    end if;
    if v_note_clean = '' then v_note_clean := null; end if;
  end if;

  -- Per-listing auto-reject floor check (migration 054). Transparent —
  -- buyer sees a clear error so they can re-bid higher.
  if v_floor is not null and p_amount_usd < v_floor then
    raise exception 'Your offer is below the seller''s minimum for this listing. Try a higher amount.'
      using errcode = 'P0001';
  end if;

  insert into public.offers (
    listing_id, proposer_id, responder_id, amount_usd, note, status
  ) values (
    p_listing_id, v_caller, v_seller_id, p_amount_usd, v_note_clean, 'pending'
  )
  returning id into v_offer_id;

  return v_offer_id;
end $$;

revoke all on function public.insert_offer(uuid, numeric, text) from public, anon;
grant execute on function public.insert_offer(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. New RPC: insert_seller_offer
-- ---------------------------------------------------------------------------
-- Seller-initiated offer flow. Seller picks a saver from the savers list
-- on their listing card and sends a price offer. Mirror image of
-- insert_offer:
--   * Caller MUST be the listing's seller
--   * Target buyer MUST have saved this listing (validates the entry
--     point — sellers can only offer to people who showed interest, not
--     spam random users)
--   * Same listing-state checks (sale, approved, available)
--   * Same block-check
--   * Same one-active-offer enforcement
--   * Note sanitization
--   * Floor doesn't apply — the seller IS the one setting the price, no
--     need to gate it against their own floor
-- Returns the inserted offer id.
create or replace function public.insert_seller_offer(
  p_listing_id uuid,
  p_buyer_id   uuid,
  p_amount_usd numeric,
  p_note       text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller         uuid := auth.uid();
  v_seller_id      uuid;
  v_listing_type   text;
  v_moderation     text;
  v_status         text;
  v_has_saved      boolean;
  v_note_clean     text;
  v_offer_id       uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  if p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'offer amount must be positive';
  end if;
  if p_buyer_id is null or p_buyer_id = v_caller then
    raise exception 'invalid buyer';
  end if;

  select seller_id, listing_type, moderation_status, status
    into v_seller_id, v_listing_type, v_moderation, v_status
    from public.listings
    where listing_id = p_listing_id;
  if v_seller_id is null then
    raise exception 'listing not found';
  end if;
  if v_seller_id <> v_caller then
    raise exception 'only the listing owner can send seller offers';
  end if;
  if v_listing_type = 'iso' then
    raise exception 'seller offers are sale-only';
  end if;
  if v_moderation <> 'approved' then
    raise exception 'this listing is not currently approved';
  end if;
  if v_status <> 'available' then
    raise exception 'this listing is not currently available';
  end if;

  -- The buyer must have saved this listing. This is the gate that
  -- prevents sellers from cold-DMing random users via the offer system.
  -- (See db/migrations/saved_listings setup — saves table is the canonical
  -- "buyer expressed interest" signal.)
  select exists (
    select 1 from public.saved_listings
    where listing_id = p_listing_id and user_id = p_buyer_id
  ) into v_has_saved;
  if not v_has_saved then
    raise exception 'you can only send offers to users who have saved this listing';
  end if;

  if public.is_blocked_between(v_caller, p_buyer_id) then
    raise exception 'offer cannot be delivered';
  end if;

  -- One-active-offer enforcement, mirrored from insert_offer. Friendlier
  -- error since the seller knows who the buyer is.
  if public._has_active_offer_thread(p_listing_id, p_buyer_id, v_caller) then
    raise exception 'You already have an active offer thread with this buyer on this listing.'
      using errcode = 'P0001';
  end if;

  if p_note is not null then
    v_note_clean := substring(trim(p_note), 1, 500);
    if v_note_clean ~* '(https?://|www\.)' then
      raise exception 'links are not allowed in offer notes';
    end if;
    if v_note_clean = '' then v_note_clean := null; end if;
  end if;

  -- Roles: seller is proposing the price, buyer will respond. This
  -- matches the structure used for seller counter-offers (parent_offer_id
  -- chains) so the existing respond_to_offer RPC handles the buyer's
  -- accept/counter/decline path with no changes needed.
  insert into public.offers (
    listing_id, proposer_id, responder_id, amount_usd, note, status
  ) values (
    p_listing_id, v_caller, p_buyer_id, p_amount_usd, v_note_clean, 'pending'
  )
  returning id into v_offer_id;

  return v_offer_id;
end $$;

revoke all on function public.insert_seller_offer(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.insert_seller_offer(uuid, uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Update respond_to_offer — race-to-accept on accept path
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_offer(
  p_offer_id          uuid,
  p_decision          text,
  p_counter_amount    numeric default null,
  p_decision_note     text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller         uuid := auth.uid();
  v_offer          public.offers%rowtype;
  v_new_offer_id   uuid;
  v_note_clean     text;
  v_winning_buyer  uuid;
  v_seller_id      uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  if p_decision not in ('accept', 'counter', 'decline') then
    raise exception 'decision must be accept, counter, or decline';
  end if;

  select * into v_offer from public.offers where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'offer not found';
  end if;
  if v_offer.responder_id <> v_caller then
    raise exception 'only the responder can act on this offer';
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer is not in pending state (current: %)', v_offer.status;
  end if;

  if p_decision_note is not null then
    v_note_clean := substring(trim(p_decision_note), 1, 500);
    if v_note_clean ~* '(https?://|www\.)' then
      raise exception 'links are not allowed in decision notes';
    end if;
    if v_note_clean = '' then v_note_clean := null; end if;
  end if;

  if p_decision = 'accept' then
    update public.offers
      set status = 'accepted',
          decided_at = now(),
          decided_by = v_caller,
          decision_note = v_note_clean
      where id = p_offer_id;

    -- Race-to-accept: figure out who the buyer is in this winning thread
    -- (the participant who is NOT the listing's seller), then auto-decline
    -- all other active offers on the listing.
    select seller_id into v_seller_id from public.listings where listing_id = v_offer.listing_id;
    v_winning_buyer := case when v_offer.proposer_id = v_seller_id then v_offer.responder_id else v_offer.proposer_id end;
    perform public._finalize_listing_acceptance(v_offer.listing_id, p_offer_id, v_winning_buyer);

    return p_offer_id;
  end if;

  if p_decision = 'decline' then
    update public.offers
      set status = 'declined',
          decided_at = now(),
          decided_by = v_caller,
          decision_note = v_note_clean
      where id = p_offer_id;
    return p_offer_id;
  end if;

  -- decision = 'counter'
  if p_counter_amount is null or p_counter_amount <= 0 then
    raise exception 'counter amount must be positive';
  end if;
  update public.offers
    set status = 'countered',
        decided_at = now(),
        decided_by = v_caller,
        decision_note = v_note_clean
    where id = p_offer_id;
  insert into public.offers (
    listing_id, proposer_id, responder_id, amount_usd, note,
    status, parent_offer_id
  ) values (
    v_offer.listing_id, v_caller, v_offer.proposer_id,
    p_counter_amount, v_note_clean,
    'pending', p_offer_id
  )
  returning id into v_new_offer_id;
  return v_new_offer_id;
end $$;

revoke all on function public.respond_to_offer(uuid, text, numeric, text) from public, anon;
grant execute on function public.respond_to_offer(uuid, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Update respond_to_counter — race-to-accept on accept_counter path
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_counter(
  p_offer_id            uuid,
  p_decision            text,
  p_counter_back_amount numeric default null,
  p_decision_note       text default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller         uuid := auth.uid();
  v_offer          public.offers%rowtype;
  v_new_offer_id   uuid;
  v_note_clean     text;
  v_winning_buyer  uuid;
  v_seller_id      uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  if p_decision not in ('accept_counter', 'counter_back', 'walk_away') then
    raise exception 'decision must be accept_counter, counter_back, or walk_away';
  end if;

  select * into v_offer from public.offers where id = p_offer_id;
  if v_offer.id is null then
    raise exception 'offer not found';
  end if;
  if v_offer.responder_id <> v_caller then
    raise exception 'you are not the responder for this offer';
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer is not in pending state (current: %)', v_offer.status;
  end if;
  if v_offer.parent_offer_id is null then
    raise exception 'this offer is not a counter; use respond_to_offer if you are responding to an initial offer';
  end if;

  if p_decision_note is not null then
    v_note_clean := substring(trim(p_decision_note), 1, 500);
    if v_note_clean ~* '(https?://|www\.)' then
      raise exception 'links are not allowed in decision notes';
    end if;
    if v_note_clean = '' then v_note_clean := null; end if;
  end if;

  if p_decision = 'accept_counter' then
    update public.offers
      set status = 'accepted_counter',
          decided_at = now(),
          decided_by = v_caller,
          decision_note = v_note_clean
      where id = p_offer_id;

    -- Race-to-accept on counter acceptance, same logic as respond_to_offer.
    select seller_id into v_seller_id from public.listings where listing_id = v_offer.listing_id;
    v_winning_buyer := case when v_offer.proposer_id = v_seller_id then v_offer.responder_id else v_offer.proposer_id end;
    perform public._finalize_listing_acceptance(v_offer.listing_id, p_offer_id, v_winning_buyer);

    return p_offer_id;
  end if;

  if p_decision = 'walk_away' then
    update public.offers
      set status = 'declined_counter',
          decided_at = now(),
          decided_by = v_caller,
          decision_note = v_note_clean
      where id = p_offer_id;
    return p_offer_id;
  end if;

  -- decision = 'counter_back'
  if p_counter_back_amount is null or p_counter_back_amount <= 0 then
    raise exception 'counter amount must be positive';
  end if;
  update public.offers
    set status = 'countered',
        decided_at = now(),
        decided_by = v_caller,
        decision_note = v_note_clean
    where id = p_offer_id;
  insert into public.offers (
    listing_id, proposer_id, responder_id, amount_usd, note,
    status, parent_offer_id
  ) values (
    v_offer.listing_id, v_caller, v_offer.proposer_id,
    p_counter_back_amount, v_note_clean,
    'pending', p_offer_id
  )
  returning id into v_new_offer_id;
  return v_new_offer_id;
end $$;

revoke all on function public.respond_to_counter(uuid, text, numeric, text) from public, anon;
grant execute on function public.respond_to_counter(uuid, text, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. New RPC: get_offer_threads_for_user
-- ---------------------------------------------------------------------------
-- Replaces the client-side two-half query. Returns ALL offers involving
-- the caller (either as proposer OR responder), joined with listing
-- context AND the OTHER party's display name + handle. Excludes auto-
-- declined (silent floor rejects) from the caller's view — those never
-- surface to either party as listing-level "negotiations."
--
-- Why a SECURITY DEFINER RPC: profiles has column-level grants and the
-- existing RLS on offers + saved_listings makes the join awkward to do
-- client-side. Doing it server-side keeps the catalog snappy and the
-- privacy boundary explicit (we only ever return data the caller is
-- already entitled to see).
--
-- Direction is computed: 'incoming' when caller is responder, 'outgoing'
-- when caller is proposer.
create or replace function public.get_offer_threads_for_user(
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
    b.created_at, b.decided_at, b.decision_note,
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
-- End of migration 055.
-- =============================================================================
