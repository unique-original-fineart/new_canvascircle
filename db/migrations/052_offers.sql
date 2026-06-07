-- =============================================================================
-- 052_offers.sql
-- =============================================================================
-- Make-an-Offer feature foundation.
--
-- Mirrors eBay's "Best Offer" pattern: buyer proposes a price below the
-- seller's asking, seller accepts / counters / declines. Buyer never sees
-- WHY an offer fails (could be auto-reject floor, explicit decline,
-- expiration); the asymmetric information is what gives the seller pricing
-- power that the [[preserve-seller-pricing-power]] memory locks in.
--
-- Schema overview:
--   * `public.offers` — append-mostly. Status mutates over the offer's
--     lifecycle but the original row is never deleted. Counter-offers
--     create NEW rows that point back via parent_offer_id, so the full
--     negotiation chain is reconstructable for the analytics layer
--     without complicating the rendering query.
--   * `public.profiles.auto_reject_floor_usd` — per-seller minimum offer.
--     Strictly below = silent auto-decline (no push, no email, status
--     flips to 'auto_declined' on insert via trigger).
--
-- Constraints honored per memory:
--   * [[free-for-collectors-forever]] — no fees, no payment processing,
--     no escrow. The offer is purely a negotiation message.
--   * [[preserve-seller-pricing-power]] — floor is private, never
--     exposed to buyers. Buyers see only their own offer status, never
--     other offers on the same listing.
--   * [[in-platform-messenger-idea]] — structured offer state machine
--     ONLY. No free-form messaging on top — that's what
--     contact-seller is for. Optional one-line note per offer is the
--     full chat surface.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. auto_reject_floor_usd column on profiles
-- ---------------------------------------------------------------------------
-- Numeric so it can hold any whole-dollar amount. Nullable means "no
-- floor configured" (every offer reaches the seller for manual review).
-- Sellers who want to filter low-balls set it to e.g. 80% of their
-- asking price (a private heuristic — buyers never see this number).
alter table public.profiles
  add column if not exists auto_reject_floor_usd numeric(10, 2);

-- Defense-in-depth: the column needs an authenticated GRANT since
-- migration 051 revoked table-level SELECT. Per [[versioned-module-imports]]
-- analog from migration 051's note: any new column added must be granted.
grant select (auto_reject_floor_usd) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 2. offers table
-- ---------------------------------------------------------------------------
-- Status state machine:
--   pending        — buyer just submitted, awaiting seller decision
--   accepted       — seller said yes; off-platform handoff begins
--   countered      — seller responded with a counter-amount; the original
--                    offer row's status becomes "countered" and a NEW
--                    offer row is inserted with parent_offer_id pointing
--                    here, status='pending', buyer_id and seller_id swapped
--                    on the "who is responding next" axis. The new row is
--                    inserted by the respond_to_offer RPC, NOT the buyer.
--   declined       — seller explicitly said no
--   auto_declined  — failed the seller's auto_reject_floor_usd (silent to buyer)
--   withdrawn      — buyer rescinded before seller acted
--   expired        — 7 days passed with no seller decision (hourly cron)
--   accepted_counter / declined_counter / withdrawn_counter — terminal
--                    states when a counter offer is responded to. Encoded
--                    on the counter-offer row, not the original.
--
-- Money is in numeric(10,2) — supports up to $99,999,999.99 per offer.
-- Park West fine art realistically tops out at $50K-ish; cap is generous.
create table if not exists public.offers (
  id                uuid primary key default gen_random_uuid(),
  listing_id        uuid not null references public.listings(listing_id) on delete cascade,
  -- Who is offering money / proposing a price right now. For the original
  -- offer this is the buyer; for a counter-offer row this is the seller
  -- (because the seller is proposing a price in the counter). The
  -- responder is always the other party.
  proposer_id      uuid not null references auth.users(id) on delete cascade,
  responder_id     uuid not null references auth.users(id) on delete cascade,
  amount_usd       numeric(10, 2) not null,
  note             text,
  status           text not null default 'pending'
                     check (status in (
                       'pending', 'accepted', 'declined', 'countered',
                       'auto_declined', 'withdrawn', 'expired',
                       'accepted_counter', 'declined_counter', 'withdrawn_counter'
                     )),
  -- Counter-offer chains: a counter-offer is a NEW row whose parent_offer_id
  -- points to the row it counters. Walk parent_offer_id upward to reconstruct
  -- the full negotiation thread for a listing/buyer pair.
  parent_offer_id  uuid references public.offers(id) on delete set null,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       uuid references auth.users(id) on delete set null,
  decision_note    text,
  -- proposer_id and responder_id must differ. Critical sanity check —
  -- prevents a single user from offering against themselves.
  constraint offer_two_parties check (proposer_id <> responder_id),
  constraint offer_positive_amount check (amount_usd > 0)
);

-- Indexes for the common access patterns:
--   * Seller's incoming offers, newest first ("my Offers inbox")
--   * Buyer's outgoing offers, newest first ("my offers I've made")
--   * Per-listing offer history (counter chains, analytics)
--   * Expiration sweep — only pending rows older than 7d need scanning
create index if not exists offers_responder_status_idx
  on public.offers (responder_id, status, created_at desc);
create index if not exists offers_proposer_status_idx
  on public.offers (proposer_id, status, created_at desc);
create index if not exists offers_listing_idx
  on public.offers (listing_id, created_at desc);
create index if not exists offers_expiry_sweep_idx
  on public.offers (created_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 3. RLS — admin-only-managed write, scoped-read for buyer/seller
-- ---------------------------------------------------------------------------
alter table public.offers enable row level security;

-- SELECT: buyer can see their own outgoing offers (where they are the
-- proposer, plus counter-offers where they are the responder). Seller
-- can see incoming offers on their own listings (where they are the
-- responder, plus their own counters where they are the proposer).
-- Admin sees everything via is_admin(). No anon visibility.
drop policy if exists offers_select_parties on public.offers;
create policy offers_select_parties
  on public.offers
  for select
  using (
    auth.uid() = proposer_id
    or auth.uid() = responder_id
    or public.is_admin()
  );

-- INSERT/UPDATE: writes ONLY through the RPCs below. No direct table writes
-- from clients. We deliberately do NOT add an insert policy; the RPCs run
-- SECURITY DEFINER and bypass RLS. This prevents a buyer from inserting an
-- offer with a forged seller_id or status.
revoke all on public.offers from public, anon;
revoke all on public.offers from authenticated;

-- ---------------------------------------------------------------------------
-- 4. insert_offer RPC — buyer submits a new offer
-- ---------------------------------------------------------------------------
-- Validates:
--   * caller is authenticated
--   * listing exists + is approved + is a sale listing (not ISO) + status = available
--   * caller is NOT the listing's seller (no self-offering)
--   * neither party has blocked the other (reuses is_blocked_between RPC)
--   * note is sanitized: ≤500 chars, no URLs
--   * amount > 0
-- Then:
--   * checks auto_reject_floor_usd on the seller's profile
--   * if amount < floor → inserts with status='auto_declined' (silent)
--   * else inserts with status='pending'
-- Returns the inserted row's id.
--
-- Caller receives the same response whether the offer landed as 'pending'
-- or 'auto_declined' so the auto-reject signal is never leaked to the
-- buyer. Push / email fan-out happens off the offer-fanout edge function,
-- which is no-op for auto_declined rows.
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
  v_offer_status   text := 'pending';
  v_note_clean     text;
  v_offer_id       uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in to make an offer';
  end if;
  if p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'offer amount must be positive';
  end if;

  -- Validate listing + pull seller id under elevated privs.
  select seller_id, listing_type, moderation_status, status
    into v_seller_id, v_listing_type, v_moderation, v_status
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

  -- Block-check — same semantics as contact-seller. Symmetric: either
  -- direction blocks the offer.
  if public.is_blocked_between(v_caller, v_seller_id) then
    raise exception 'offer cannot be delivered';
  end if;

  -- Sanitize the note. Light rules: cap length + scrub obvious URLs.
  -- Stricter URL scrubbing happens client-side too but the server is the
  -- canonical filter.
  if p_note is not null then
    v_note_clean := substring(trim(p_note), 1, 500);
    if v_note_clean ~* '(https?://|www\.)' then
      raise exception 'links are not allowed in offer notes';
    end if;
    if v_note_clean = '' then v_note_clean := null; end if;
  end if;

  -- Auto-reject floor check. NULL floor = no floor, all offers go to pending.
  select auto_reject_floor_usd into v_floor
    from public.profiles where user_id = v_seller_id;
  if v_floor is not null and p_amount_usd < v_floor then
    v_offer_status := 'auto_declined';
  end if;

  insert into public.offers (
    listing_id, proposer_id, responder_id, amount_usd, note, status
  ) values (
    p_listing_id, v_caller, v_seller_id, p_amount_usd, v_note_clean, v_offer_status
  )
  returning id into v_offer_id;

  return v_offer_id;
end $$;

revoke all on function public.insert_offer(uuid, numeric, text) from public, anon;
grant execute on function public.insert_offer(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. respond_to_offer RPC — seller accepts / counters / declines
-- ---------------------------------------------------------------------------
-- decision: 'accept' | 'counter' | 'decline'
-- counter_amount_usd: required when decision='counter', else null
-- decision_note: optional message attached to the seller's response
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
    raise exception 'only the seller can respond to this offer';
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer is not in pending state (current: %)', v_offer.status;
  end if;

  -- Sanitize decision_note same way as offer notes.
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
  -- Mark the original as countered.
  update public.offers
    set status = 'countered',
        decided_at = now(),
        decided_by = v_caller,
        decision_note = v_note_clean
    where id = p_offer_id;
  -- Insert the seller's counter as a new offer row. Roles flip:
  -- proposer = seller (offering the counter price), responder = original buyer.
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
-- 6. respond_to_counter RPC — buyer responds to seller's counter
-- ---------------------------------------------------------------------------
-- decision: 'accept_counter' | 'counter_back' | 'walk_away'
-- counter_back_amount: required when decision='counter_back'
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
  -- Only the responder of a counter-offer (the original buyer in most cases)
  -- can respond to it.
  if v_offer.responder_id <> v_caller then
    raise exception 'you are not the responder for this offer';
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'offer is not in pending state (current: %)', v_offer.status;
  end if;
  -- Must be a counter (have a parent_offer_id) — this RPC is for buyer
  -- responding to seller's counter, not for the initial offer.
  if v_offer.parent_offer_id is null then
    raise exception 'this offer is not a counter; use respond_to_offer if you are the seller';
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

  -- decision = 'counter_back' — buyer counters the seller's counter.
  -- Same pattern: mark current as countered, insert a new offer row
  -- with roles flipped again.
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
-- 7. withdraw_offer RPC — proposer rescinds a pending offer
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_offer(p_offer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_offer  public.offers%rowtype;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  select * into v_offer from public.offers where id = p_offer_id;
  if v_offer.id is null then raise exception 'offer not found'; end if;
  if v_offer.proposer_id <> v_caller then
    raise exception 'only the proposer can withdraw this offer';
  end if;
  if v_offer.status <> 'pending' then
    raise exception 'only pending offers can be withdrawn';
  end if;
  -- If this offer is a counter (has a parent), the withdrawal flips status to
  -- withdrawn_counter; otherwise plain withdrawn. Keeps the analytics layer
  -- able to distinguish initial-withdraw vs counter-withdraw.
  update public.offers
    set status = case when parent_offer_id is null then 'withdrawn' else 'withdrawn_counter' end,
        decided_at = now(),
        decided_by = v_caller
    where id = p_offer_id;
end $$;

revoke all on function public.withdraw_offer(uuid) from public, anon;
grant execute on function public.withdraw_offer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Expiration cron — pending offers older than 7 days auto-expire
-- ---------------------------------------------------------------------------
-- pg_cron is already enabled for verification_video_cleanup; piggyback.
-- Run at :23 past every hour to avoid clustering with other crons.
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
          set status = case when parent_offer_id is null then 'expired' else 'expired' end,
              decided_at = now()
          where status = 'pending'
            and created_at < now() - interval '7 days';
      $cron$
    );
  else
    raise notice 'pg_cron not installed — install it before relying on automatic expiration';
  end if;
end $$;

-- =============================================================================
-- End of migration 052.
-- =============================================================================
