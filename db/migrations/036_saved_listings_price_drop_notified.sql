-- =============================================================================
-- 036_saved_listings_price_drop_notified.sql
-- =============================================================================
-- Tracks the per-user, per-listing dedup window for price-drop push alerts.
-- When a seller drops the price on a listing, the price-drop-fanout edge
-- function alerts everyone who saved that listing — but only if we haven't
-- already notified them about a drop on this same listing in the last 30
-- days. Without that window, a seller toggling the price up and down would
-- spam their savers.
--
-- NULL means "never notified" — the first eligible drop will fire and
-- stamp this column with now(). Subsequent drops within 30 days are
-- silently skipped; drops after 30 days fire again and restamp.
-- =============================================================================

alter table public.saved_listings
  add column if not exists last_price_drop_notified_at timestamptz;

-- Lookup index — the fanout function filters savers by listing_id and
-- checks this column for each. Index on (listing_id, last_price_drop_notified_at)
-- makes that batch lookup cheap even with many savers.
create index if not exists saved_listings_listing_drop_notified_idx
  on public.saved_listings (listing_id, last_price_drop_notified_at);
