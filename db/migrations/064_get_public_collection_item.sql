-- =============================================================================
-- 064_get_public_collection_item.sql
-- =============================================================================
-- New public RPC for fetching ONE collection_item's public data, plus
-- the owner's display_name + handle so the per-piece share card on
-- social media (iMessage, Facebook, Instagram, etc.) can render a
-- compelling "Britto, Spirit of Adventure — From Guy Scuderi's
-- Collection on CanvasCircle" preview.
--
-- Used by:
--   * The Cloudflare Pages Function (functions/seller.js +
--     seller.html.js) to build the OG meta tags when ?piece=<id> is
--     present in the URL.
--   * The seller.html JS to validate that a deep-linked piece is
--     publicly viewable before opening its detail modal automatically.
--
-- Gates: enforces the same is_public + collection_is_public +
-- is_trusted + account_status='active' chain as get_public_collection.
-- Returns zero rows if any gate fails, so a private/suspended/
-- unconfigured piece falls back to the seller-level OG card cleanly.
--
-- Scope: COLLECTION_ITEMS ONLY. in_collection listings are not exposed
-- through this RPC for v1 — they're still visible in the public
-- Collection grid (via get_public_collection's UNION), but they don't
-- get their own shareable per-piece OG URL. They lack acquired_year and
-- public_story so the OG card would be sparse anyway, and the
-- listing's old description field could carry sales-context language
-- we don't want surfacing in a "look what's in my Collection" share.
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — no monetary fields exposed.
--   * [[anonymous-privacy-ui-only]] — owner identity (display_name,
--     handle) is already public on the seller page; surfacing it here
--     for the OG card preserves the same boundary, no new disclosure.
-- =============================================================================

create or replace function public.get_public_collection_item(
  p_item_id uuid
) returns table (
  id                 uuid,
  artist_name        text,
  artwork_title      text,
  medium             text,
  artwork_category   text,
  image_path         text,
  height_in          numeric,
  width_in           numeric,
  depth_in           numeric,
  framed_size        text,
  coa_included       text,
  public_story       text,
  acquired_year      integer,
  acquired_month     integer,
  via_canvascircle   boolean,
  owner_user_id      uuid,
  owner_display_name text,
  owner_handle       text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ci.id, ci.artist_name, ci.artwork_title, ci.medium, ci.artwork_category,
    ci.image_path, ci.height_in, ci.width_in, ci.depth_in, ci.framed_size,
    ci.coa_included, ci.public_story, ci.acquired_year, ci.acquired_month,
    (ci.source_listing_id is not null) as via_canvascircle,
    p.user_id      as owner_user_id,
    p.display_name as owner_display_name,
    p.handle       as owner_handle
  from public.collection_items ci
  join public.profiles p on p.user_id = ci.owner_id
  where ci.id = p_item_id
    and ci.is_public = true
    and p.collection_is_public = true
    and p.is_trusted = true
    and p.account_status = 'active';
$$;

revoke all on function public.get_public_collection_item(uuid) from public;
grant execute on function public.get_public_collection_item(uuid) to authenticated, anon;

-- =============================================================================
-- End of migration 064.
-- =============================================================================
