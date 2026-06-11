-- =============================================================================
-- 062_get_my_collection_includes_in_collection_listings.sql
-- =============================================================================
-- Bug-fix-as-migration: after migration 061 added the listings.status =
-- 'in_collection' state, those listings correctly showed on the PUBLIC
-- Collection tab (because get_public_collection was updated to UNION
-- both sources). But the OWNER's portal Collection tab still only saw
-- native collection_items — get_my_collection wasn't updated in 061.
--
-- This migration drops + recreates get_my_collection to UNION the two
-- sources with the same source_type column convention. Native items
-- continue to expose ALL fields (including private ones); listing rows
-- expose nulls for private fields (listings don't have private_notes,
-- appraised_value_usd, paid_value_usd). The portal-side renderer
-- branches on source_type to pick the image bucket and to route edits.
-- =============================================================================

drop function if exists public.get_my_collection();
create function public.get_my_collection()
returns table (
  id                  uuid,
  artist_name         text,
  artwork_title       text,
  medium              text,
  artwork_category    text,
  image_path          text,
  height_in           numeric,
  width_in            numeric,
  depth_in            numeric,
  framed_size         text,
  coa_included        text,
  public_story        text,
  private_notes       text,
  appraised_value_usd numeric,
  paid_value_usd      numeric,
  source_listing_id   uuid,
  is_public           boolean,
  created_at          timestamptz,
  updated_at          timestamptz,
  source_type         text  -- 'collection_item' or 'listing'
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Native collection_items (full field set, all owner-private data exposed).
  select
    id, artist_name, artwork_title, medium, artwork_category, image_path,
    height_in, width_in, depth_in, framed_size, coa_included, public_story,
    private_notes, appraised_value_usd, paid_value_usd, source_listing_id,
    is_public, created_at, updated_at,
    'collection_item'::text as source_type
  from public.collection_items
  where owner_id = auth.uid()

  union all

  -- Listings currently held in_collection. Private collection-item fields
  -- aren't applicable here (listings don't carry private_notes, appraised
  -- value, paid value, etc.) so they come back null. is_public is forced
  -- to true since listings don't have a per-item visibility toggle yet —
  -- a listing in 'in_collection' state IS shared on the public Collection
  -- if the seller's overall Collection is public.
  select
    l.listing_id as id,
    l.artist_name,
    l.artwork_title,
    l.medium,
    l.artwork_category,
    (
      select li.storage_path from public.listing_images li
      where li.listing_id = l.listing_id
      order by li.position asc
      limit 1
    ) as image_path,
    l.height_in,
    l.width_in,
    l.depth_in,
    l.framed_size,
    l.coa_included,
    null::text       as public_story,
    null::text       as private_notes,
    null::numeric    as appraised_value_usd,
    null::numeric    as paid_value_usd,
    null::uuid       as source_listing_id,
    true             as is_public,
    l.created_at,
    l.updated_at,
    'listing'::text  as source_type
  from public.listings l
  where l.seller_id = auth.uid()
    and l.status = 'in_collection'
  order by created_at desc;
$$;

revoke all on function public.get_my_collection() from public, anon;
grant execute on function public.get_my_collection() to authenticated;

-- =============================================================================
-- End of migration 062.
-- =============================================================================
