-- =============================================================================
-- 037_saved_searches_category_filter.sql
-- =============================================================================
-- Adds an optional category narrowing to the follow feature. Users who
-- follow an artist can now choose to receive notifications only for that
-- artist's Unique/Original pieces, only Limited Editions, or all (the
-- existing default).
--
-- Schema:
--   category_filter NULL          → notify for ALL of this artist's listings
--                                   (existing behavior; all existing rows
--                                   land here on first column add).
--   category_filter = 'Unique/Original'  → notify only for Unique listings
--   category_filter = 'Limited Edition'  → notify only for Limited listings
--
-- The CHECK constraint mirrors the listings.artwork_category enum values
-- (see initial schema). If a new category is ever added to listings, this
-- constraint needs to be widened alongside it.
--
-- Why on saved_searches (not a separate table):
--   The filter is a 1:1 narrowing of an existing follow, not a new
--   relationship. Keeping it as an optional column means existing follows
--   continue to work unchanged (NULL = no narrowing, same as before) and
--   the fanout query stays a single SELECT.
--
-- Applies only to kind='artist' in the current UI (sellers' public pages
-- show their full catalog, so a category-narrowed seller-follow would
-- conflict with the page the user'd visit). The column is permitted on
-- any row at the schema level — future extension to sellers is one UI
-- change away with no DB migration needed.
-- =============================================================================

alter table public.saved_searches
  add column if not exists category_filter text null;

-- Drop the constraint first if a previous migration already added it
-- with different values — defensive when re-running.
alter table public.saved_searches
  drop constraint if exists saved_searches_category_filter_check;

alter table public.saved_searches
  add constraint saved_searches_category_filter_check
  check (category_filter is null
         or category_filter in ('Unique/Original', 'Limited Edition'));

comment on column public.saved_searches.category_filter is
  'Optional category narrowing for follow notifications. NULL = follow all categories. Must match listings.artwork_category values when set.';
