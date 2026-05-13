-- =============================================================================
-- 010_catalog_pagination_indexes.sql
-- =============================================================================
-- The catalog now paginates server-side and supports filtering by status
-- (available / sold / not_renewed) + sorting by created_at or
-- asking_price_usd. Add composite indexes so each filter+sort combination
-- can be served by an index seek instead of a full-table scan as the
-- listings table grows.
-- =============================================================================

-- Existing `listings_public_visible_idx` partial index covers
-- (moderation_status='approved' AND status IN ('available','pending'))
-- ordered by created_at DESC — that's the default Available view.
-- Add a broader composite that covers Sold and Not Renewed views too.
create index if not exists listings_catalog_status_created_idx
  on public.listings (moderation_status, status, created_at desc);

-- Price sort. Same approved+status filter, ordered by price.
create index if not exists listings_catalog_status_price_idx
  on public.listings (moderation_status, status, asking_price_usd);

-- Speeds up the artist_name and artwork_category filter dropdowns.
create index if not exists listings_artist_name_idx
  on public.listings (artist_name)
  where moderation_status = 'approved' and artist_name is not null;

create index if not exists listings_artwork_category_idx
  on public.listings (artwork_category)
  where moderation_status = 'approved';
