-- =============================================================================
-- Migration 002 — listings.save_count + auto-maintained via triggers
-- =============================================================================
-- Apply ONCE to the live database. Idempotent: safe to re-run.
--
-- What this does:
--   1. Adds listings.save_count integer (default 0) — denormalized count of
--      how many users have hearted this listing. Anonymous visitors can read
--      this column (it sits on the public-readable listings row), even though
--      the underlying saved_listings rows are private (per RLS).
--   2. Trigger functions on saved_listings (INSERT / DELETE) keep the counter
--      in sync. SECURITY DEFINER lets the trigger bypass RLS so any signed-in
--      user's save can update the count on a listing they don't own.
--   3. Backfills counts from any existing saved_listings rows (likely zero).
-- =============================================================================

alter table public.listings
  add column if not exists save_count integer not null default 0;

create or replace function public.bump_save_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (TG_OP = 'INSERT') then
    update public.listings
       set save_count = save_count + 1
     where listing_id = NEW.listing_id;
    return NEW;
  elsif (TG_OP = 'DELETE') then
    update public.listings
       set save_count = greatest(0, save_count - 1)
     where listing_id = OLD.listing_id;
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists saved_listings_bump_count_ins on public.saved_listings;
create trigger saved_listings_bump_count_ins
  after insert on public.saved_listings
  for each row execute function public.bump_save_count();

drop trigger if exists saved_listings_bump_count_del on public.saved_listings;
create trigger saved_listings_bump_count_del
  after delete on public.saved_listings
  for each row execute function public.bump_save_count();

-- Backfill — recompute every listing's save_count from the source of truth.
update public.listings l
   set save_count = coalesce((
     select count(*) from public.saved_listings s where s.listing_id = l.listing_id
   ), 0);
