-- =============================================================================
-- 039_open_to_trade.sql
-- =============================================================================
-- Adds "Open to Trade" optionality on sale listings. Sellers can flag a sale
-- listing as open to trade offers and (optionally) describe what they'd be
-- interested in trading for.
--
-- Why a flag on sale listings instead of a third listing_type:
--   Trades are inherently two-sided matching, which has terrible liquidity
--   density in a thin market. A dedicated tab would likely look empty. By
--   piggybacking on sale listings, the existing discovery surface carries
--   trade-curious buyers in front of every "open to trade" listing
--   automatically. If the flag gains real adoption, we can promote it later.
--
-- Why two columns instead of one:
--   open_to_trade is the cheap server-side filter (used in WHERE clauses
--   for the catalog filter chip + saved-search fanout). trade_looking_for
--   is buyer-facing free text that only renders on the detail view; we
--   don't want to scan a TEXT column to filter the catalog list view.
--
-- Why the gate is sale-only:
--   ISO listings are buyer requests — they don't have a piece to trade.
--   The CHECK constraint enforces both new columns are inert on ISO rows.
--
-- Schema changes:
--   1. open_to_trade BOOL NOT NULL DEFAULT false.
--   2. trade_looking_for TEXT (nullable, free-text, no length cap at DB
--      level — UI will impose a soft limit).
--   3. CHECK constraint: both columns can only be meaningful when
--      listing_type='sale'. ISO rows must have open_to_trade=false and
--      trade_looking_for IS NULL.
--   4. Partial index on open_to_trade=true for the catalog filter query.
-- =============================================================================

-- (1) Flag column. DEFAULT false so existing rows backfill correctly.
alter table public.listings
  add column if not exists open_to_trade boolean not null default false;

-- (2) Free-text "what I'm looking for" field.
alter table public.listings
  add column if not exists trade_looking_for text null;

-- (3) Sale-only constraint. Drop-and-readd so re-runs are safe.
alter table public.listings
  drop constraint if exists listings_trade_sale_only;
alter table public.listings
  add constraint listings_trade_sale_only
  check (
    listing_type = 'sale'
    or (open_to_trade = false and trade_looking_for is null)
  );

-- (4) Partial index for the catalog "Open to Trade" filter. Only indexes
--     rows where the flag is true, keeping the index small.
create index if not exists listings_open_to_trade_idx
  on public.listings (created_at desc)
  where open_to_trade = true
    and moderation_status = 'approved'
    and status in ('available','pending');

comment on column public.listings.open_to_trade is
  'Sale listings only: seller has marked this piece as open to trade offers in addition to or instead of an outright sale. ISO listings are constrained to false.';

comment on column public.listings.trade_looking_for is
  'Sale listings only: free-text description of what the seller is hunting for in a trade (e.g. "Mr. Brainwash Madonna giclée, or any signed Banksy print"). Renders only on the listing detail view, not on the catalog card.';
