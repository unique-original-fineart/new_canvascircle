-- =============================================================================
-- 073_auto_reject_explicit_message.sql
-- =============================================================================
-- Updates the insert_offer RPC's auto-reject-floor error message to be
-- explicit that the offer was AUTOMATICALLY DECLINED, not just "below
-- the minimum." Same throw-on-floor-violation behavior as migration 054
-- + 055; only the message text changes.
--
-- Why: buyers were seeing "Your offer is below the seller's minimum for
-- this listing. Try a higher amount." and could reasonably read that as
-- a soft warning ("maybe my offer is being considered"). The new message
-- says explicitly that the offer was AUTOMATICALLY DECLINED and that
-- the seller WAS NOT NOTIFIED, so the buyer knows (a) no human action
-- is coming and (b) re-bidding higher is the only path forward.
--
-- The floor amount itself stays private per [[preserve-seller-pricing-power]].
--
-- This is a MINIMAL PATCH: drop + recreate insert_offer with body
-- exactly mirroring migration 055 except for the one raise-exception
-- string. If 055's body changes for other reasons later, this file
-- should be re-applied (or its single change merged in).
-- =============================================================================

drop function if exists public.insert_offer(uuid, numeric, text);

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

  -- Per-listing auto-reject floor check (migration 054, message updated
  -- in migration 073). Transparent — buyer sees an explicit "automatically
  -- declined" error so they understand (a) the decision was automatic,
  -- (b) the seller was not notified, and (c) re-bidding higher is the
  -- way forward. The floor amount itself stays private.
  if v_floor is not null and p_amount_usd < v_floor then
    raise exception 'Your offer was automatically declined because it''s below the seller''s minimum for this listing. The seller was not notified. Submit a higher amount to try again.'
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

comment on function public.insert_offer(uuid, numeric, text) is
  'Buyer-side offer submission. Validates listing + block-status + floor + note. Auto-reject floor surfaces an explicit "automatically declined" message to the buyer. See 073_auto_reject_explicit_message.sql.';
