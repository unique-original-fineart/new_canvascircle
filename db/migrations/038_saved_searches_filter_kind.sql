-- =============================================================================
-- 038_saved_searches_filter_kind.sql
-- =============================================================================
-- Extends the follow system to support arbitrary catalog filter combos as
-- saved searches. Buyers can pin any combination of category + price range +
-- verification + trust-member + seller filter + text search, and get a push
-- notification when a newly-approved listing matches.
--
-- Three kinds of saved_searches now coexist:
--   kind='artist'  → match by artist_name (existing; case-insensitive)
--   kind='seller'  → match by seller_id    (existing)
--   kind='filter'  → match by JSONB criteria in filter_json (NEW)
--
-- Why on the same table (not a new one):
--   The fanout edge function already iterates saved_searches when a new
--   listing is approved. Adding a third kind to the same table means one
--   more code path in the fanout, not a parallel system. Notifications
--   audit (saved_search_notifications) reuses the same dedup logic — a
--   user who follows the artist AND has a filter that matches the same
--   listing only gets pinged once, same as the existing artist+seller
--   dedup case.
--
-- Schema changes:
--   1. New nullable column: filter_json (JSONB) — required for kind='filter'.
--   2. New nullable column: display_name (TEXT)  — optional user label.
--   3. Extend kind CHECK to allow 'filter'.
--   4. Make value nullable (filter rows have no single 'value').
--   5. Drop the old (user_id, kind, value) unique constraint; replace
--      with a partial unique index that only applies to artist/seller.
--      kind='filter' has no dedup — users may save multiple filter combos.
--   6. CHECK constraint enforcing filter_json/value mutual exclusivity per
--      kind (filter_json present iff kind='filter'; value present iff not).
-- =============================================================================

-- (1) Add the new columns
alter table public.saved_searches
  add column if not exists filter_json jsonb null;

alter table public.saved_searches
  add column if not exists display_name text null;

-- (3) Allow 'filter' kind. Drop-and-readd the CHECK so re-runs are safe.
alter table public.saved_searches
  drop constraint if exists saved_searches_kind_check;
alter table public.saved_searches
  add constraint saved_searches_kind_check
  check (kind in ('artist', 'seller', 'filter'));

-- (4) Make 'value' nullable. Existing artist/seller rows still have it;
--     new filter rows leave it NULL.
alter table public.saved_searches
  alter column value drop not null;

-- (5) Replace the old combined-unique constraint with a partial unique
--     index. Without this, two kind='filter' rows for the same user
--     would collide on (user_id, kind, NULL) — Postgres treats NULLs as
--     distinct so it actually wouldn't, BUT we also want artist/seller
--     dedup to keep working unchanged.
alter table public.saved_searches
  drop constraint if exists saved_searches_user_kind_value_unique;

drop index if exists saved_searches_user_kind_value_unique_idx;
create unique index if not exists saved_searches_user_kind_value_unique_idx
  on public.saved_searches (user_id, kind, value)
  where kind in ('artist', 'seller');

-- (6) Consistency: filter_json present iff kind='filter'; value present iff not.
alter table public.saved_searches
  drop constraint if exists saved_searches_filter_json_consistency;
alter table public.saved_searches
  add constraint saved_searches_filter_json_consistency
  check (
    (kind = 'filter' and filter_json is not null and value is null)
    or
    (kind in ('artist', 'seller') and filter_json is null and value is not null)
  );

comment on column public.saved_searches.filter_json is
  'For kind=filter saved searches: JSON snapshot of the catalog filter combo. Keys (all optional except listing_type): listing_type ("sale"|"iso", required), q (free-text), cat ("Unique/Original"|"Limited Edition"), seller_id (uuid), trust_member ("established"|"non-established"), trust_verify ("verified"|"unverified"), min_price (number), max_price (number). The fanout function evaluates each new approved listing against these criteria.';

comment on column public.saved_searches.display_name is
  'Optional user-editable label for the saved search. NULL = UI generates a label from filter_json criteria.';
