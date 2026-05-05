-- =============================================================================
-- Migration 001 — artwork_category + framed_size
-- =============================================================================
-- Apply ONCE to the live database (Supabase SQL editor > New query > paste > Run).
-- Idempotent: safe to re-run.
--
-- What this does:
--   1. Replaces the listings.artwork_category check constraint to match the
--      legacy values: 'Unique/Original', 'Limited Edition', 'Other'.
--      (The original schema mistakenly used medium-based categories like
--      'Painting' / 'Drawing'. Production data uses edition status.)
--   2. Adds listings.framed_size text — the legacy form collects this and the
--      detail page should display it.
-- =============================================================================

-- 1) Drop the old check constraint if present.
do $$
declare
  cn text;
begin
  for cn in
    select conname
      from pg_constraint
     where conrelid = 'public.listings'::regclass
       and contype  = 'c'
       and pg_get_constraintdef(oid) ilike '%artwork_category%'
  loop
    execute format('alter table public.listings drop constraint %I', cn);
  end loop;
end $$;

-- 2) Wipe the four test-seed listings — their categories (Painting / Sculpture
--    / Print / Drawing) won't satisfy the new constraint, and they were going
--    to be deleted by the import script anyway.
delete from public.listings
 where listing_id in (
   '11111111-1111-1111-1111-111111111111',
   '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333',
   '44444444-4444-4444-4444-444444444444'
 );

-- 3) Anything else that doesn't fit the new check (defensive — should be
--    a no-op for a fresh DB; keeps re-runs sane).
update public.listings
   set artwork_category = 'Other'
 where artwork_category not in ('Unique/Original', 'Limited Edition', 'Other');

-- 4) Add the new check constraint with the legacy values.
alter table public.listings
  add constraint listings_artwork_category_check
  check (artwork_category in ('Unique/Original', 'Limited Edition', 'Other'));

-- 5) Add framed_size column (no default — legacy data may have nulls).
alter table public.listings
  add column if not exists framed_size text;
