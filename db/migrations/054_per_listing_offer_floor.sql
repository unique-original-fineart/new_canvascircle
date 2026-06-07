-- =============================================================================
-- 054_per_listing_offer_floor.sql
-- =============================================================================
-- Move the auto-reject floor from per-seller (profiles.auto_reject_floor_usd)
-- to per-listing (listings.auto_reject_floor_usd). Also change the auto-reject
-- behavior from silent to transparent: buyers now see a clear error message
-- when their offer is below the floor, so they can re-offer with a higher
-- amount instead of waiting for a response that never comes.
--
-- Why per-listing: a seller's Britto print at $400 and Wyland canvas at $8K
-- need wildly different floors. One blanket per-seller floor can't capture
-- that. eBay's Best Offer feature uses per-listing floors for the same
-- reason. Per-seller is too crude for an art platform with diverse inventory.
--
-- Why transparent: silent auto-decline burns buyer time (they wait for a
-- response that never comes) and wastes a future offer opportunity (a
-- nudge that says "try higher" gives the buyer a path to a real bid).
-- The asymmetric-info benefit of [[preserve-seller-pricing-power]] is
-- preserved by NOT revealing the exact floor amount — just "your offer is
-- below the seller's minimum." Buyer knows to bid higher; doesn't know
-- how much higher.
--
-- Migration plan:
--   1. Add listings.auto_reject_floor_usd (nullable numeric).
--   2. GRANT SELECT on that column to authenticated.
--      We don't fully lock it down with REVOKE-then-GRANT-other-columns
--      because listings has dozens of fields. Realistic exposure: a
--      determined attacker could pull the column via direct PostgREST.
--      UX-level (which is what 99% of buyers experience): the offer
--      modal never shows the floor, only the "below minimum" error.
--   3. Update insert_offer RPC: read from listings, raise exception with
--      a clear buyer-facing message instead of inserting auto_declined.
--   4. Leave profiles.auto_reject_floor_usd in place (dormant) so any
--      historical references in code/queries continue to work. Can be
--      dropped in a later cleanup migration if desired.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add the per-listing floor column
-- ---------------------------------------------------------------------------
alter table public.listings
  add column if not exists auto_reject_floor_usd numeric(10, 2);

-- Listings already grant SELECT to anon + authenticated for the catalog
-- to work. New columns inherit table-level grants automatically. The
-- floor amount IS technically visible to a determined attacker via
-- direct PostgREST queries; UX-level the offer modal never shows it
-- and the catalog/listing-page queries don't select it.

-- ---------------------------------------------------------------------------
-- 2. Update insert_offer RPC: per-listing floor + transparent rejection
-- ---------------------------------------------------------------------------
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

  -- Pull seller + listing context + per-listing floor.
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

  -- Block-check, same semantics as contact-seller.
  if public.is_blocked_between(v_caller, v_seller_id) then
    raise exception 'offer cannot be delivered';
  end if;

  -- Sanitize note: cap length + scrub URLs.
  if p_note is not null then
    v_note_clean := substring(trim(p_note), 1, 500);
    if v_note_clean ~* '(https?://|www\.)' then
      raise exception 'links are not allowed in offer notes';
    end if;
    if v_note_clean = '' then v_note_clean := null; end if;
  end if;

  -- Auto-reject floor check. NULL floor = no floor configured for this
  -- listing, all offers go through to pending. If a floor is set and the
  -- offer is below it, raise a clear buyer-facing exception. The error
  -- message deliberately does NOT include the floor amount — only that
  -- the offer was below the seller's minimum. This preserves the
  -- asymmetric-info property of [[preserve-seller-pricing-power]] while
  -- giving the buyer enough information to re-bid sensibly.
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

-- =============================================================================
-- End of migration 054.
-- =============================================================================
