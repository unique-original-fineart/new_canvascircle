-- =============================================================================
-- 058_collection_buyer_prompt.sql
-- =============================================================================
-- Collections Chunk B — buyer-side "add this to my Collection" prompt.
--
-- When a seller marks an offer as Sale Completed (migration 056's
-- mark_offer_sale_complete), the listing flips to status='sold' and the
-- buyer gets a thank-you push. But the buyer has no in-product nudge to
-- log the piece in their Collection — they'd have to manually copy the
-- artist, title, medium, etc. into the Collection form.
--
-- This migration adds the state needed to surface a one-tap banner on
-- the buyer's portal dashboard:
--   "You bought 'X' by Y. Add it to your Collection?"
-- Banner stays visible until the buyer either:
--   (a) adds the piece (a collection_items row exists with owner=buyer +
--       source_listing_id=listing). Detected by JOIN, no flag needed.
--   (b) dismisses the prompt explicitly. Tracked by the new
--       buyer_dismissed_collection_prompt_at column on offers.
--
-- Why on offers and not on listings: a listing has ONE seller but
-- potentially multiple buyers across its history (offer accepted, fell
-- through, re-accepted with a different buyer). The "buyer dismissed"
-- state is per-(offer, buyer) pair, which is the offer row itself.
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — the prompt and its
--     pre-filled modal don't expose any price the seller charged or
--     other private data. Listing fields used (artist, title, medium,
--     category, image_path) are already public.
--   * [[free-for-collectors-forever]] — no fees, no escrow. Pure UX.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. buyer_dismissed_collection_prompt_at column
-- ---------------------------------------------------------------------------
alter table public.offers
  add column if not exists buyer_dismissed_collection_prompt_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. get_pending_collection_prompts RPC
-- ---------------------------------------------------------------------------
-- Returns the offers the caller (as buyer) hasn't yet acted on:
--   - status in ('accepted', 'accepted_counter')   (the buyer "won")
--   - listing.status = 'sold'                       (sale completed)
--   - buyer_dismissed_collection_prompt_at IS NULL  (not dismissed)
--   - AND no collection_items row exists with owner_id=caller +
--     source_listing_id = offer.listing_id          (not yet added)
--
-- "Caller as buyer" is whichever role the caller played in the thread:
--   - Initial offer flow: caller is proposer (buyer→seller)
--   - Seller-initiated offer flow: caller is responder (seller→buyer)
-- The listing's seller_id pins the seller; the OTHER party is the buyer.
--
-- Returned fields are the pre-fill data for the Collection modal: just
-- the listing-level publics (artist, title, medium, category, image_path).
create or replace function public.get_pending_collection_prompts()
returns table (
  offer_id            uuid,
  listing_id          uuid,
  artist_name         text,
  artwork_title       text,
  medium              text,
  artwork_category    text,
  image_path          text,
  height_in           numeric,
  width_in            numeric,
  depth_in            numeric,
  framed_size         text,
  coa_included        text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    o.id as offer_id,
    l.listing_id,
    l.artist_name,
    l.artwork_title,
    l.medium,
    l.artwork_category,
    -- Listing's first image. The buyer's modal will preload this from the
    -- listing-images bucket and re-upload it into collection-images on save.
    (
      select li.storage_path
      from public.listing_images li
      where li.listing_id = l.listing_id
      order by li.position asc
      limit 1
    ) as image_path,
    l.height_in,
    l.width_in,
    l.depth_in,
    l.framed_size,
    l.coa_included
  from public.offers o
  join public.listings l on l.listing_id = o.listing_id
  where o.status in ('accepted', 'accepted_counter')
    and l.status = 'sold'
    and o.buyer_dismissed_collection_prompt_at is null
    -- Caller must be the BUYER of this thread (the non-seller party).
    and (
      (l.seller_id = o.responder_id and o.proposer_id  = auth.uid())  -- buyer proposed
      or
      (l.seller_id = o.proposer_id  and o.responder_id = auth.uid())  -- seller proposed, buyer accepted
    )
    -- Skip if the buyer already added it to their Collection.
    and not exists (
      select 1 from public.collection_items ci
      where ci.owner_id = auth.uid()
        and ci.source_listing_id = l.listing_id
    )
  order by o.decided_at desc nulls last
  limit 20;
$$;

revoke all on function public.get_pending_collection_prompts() from public, anon;
grant execute on function public.get_pending_collection_prompts() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. dismiss_collection_prompt RPC
-- ---------------------------------------------------------------------------
-- Marks the prompt as dismissed by stamping buyer_dismissed_collection_prompt_at.
-- Caller must be the buyer of the offer (the non-seller participant).
-- Idempotent — re-dismissing just updates the timestamp.
create or replace function public.dismiss_collection_prompt(
  p_offer_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller     uuid := auth.uid();
  v_seller_id  uuid;
  v_proposer   uuid;
  v_responder  uuid;
  v_listing_id uuid;
  v_buyer_id   uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  select listing_id, proposer_id, responder_id
    into v_listing_id, v_proposer, v_responder
    from public.offers where id = p_offer_id;
  if v_listing_id is null then
    raise exception 'offer not found';
  end if;
  select seller_id into v_seller_id from public.listings where listing_id = v_listing_id;
  -- The buyer is whoever is NOT the seller.
  v_buyer_id := case when v_proposer = v_seller_id then v_responder else v_proposer end;
  if v_buyer_id <> v_caller then
    raise exception 'only the buyer can dismiss this prompt';
  end if;
  update public.offers
    set buyer_dismissed_collection_prompt_at = now()
    where id = p_offer_id;
end $$;

revoke all on function public.dismiss_collection_prompt(uuid) from public, anon;
grant execute on function public.dismiss_collection_prompt(uuid) to authenticated;

-- =============================================================================
-- End of migration 058.
-- =============================================================================
