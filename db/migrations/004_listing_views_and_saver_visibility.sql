-- =============================================================================
-- Migration 004 — listing views tracking + saver visibility for sellers
-- =============================================================================
-- Apply ONCE in the Supabase SQL editor. Idempotent.
--
-- What this does:
--   1. Adds listing_views — one row per detail-page view. Tracks viewer
--      (when signed in; null for anonymous browsers) and timestamp.
--   2. Adds listings.view_count integer with a trigger that increments on
--      every listing_views insert (mirrors the save_count pattern).
--   3. Adds RLS so:
--        - Anyone (anon + authed) can INSERT a view.
--        - Only the listing's seller (and admins) can SELECT view rows.
--   4. Adds an extra RLS policy on saved_listings so a listing's seller can
--      see who has hearted their own listings (for the seller dashboard
--      "Saved by" reveal). Buyers' saved sets remain private otherwise.
-- =============================================================================

-- ---- listing_views table ----
create table if not exists public.listing_views (
  id              bigint generated always as identity primary key,
  listing_id      uuid not null references public.listings(listing_id) on delete cascade,
  viewer_user_id  uuid references auth.users(id) on delete set null,
  viewed_at       timestamptz not null default now()
);

create index if not exists listing_views_listing_idx on public.listing_views (listing_id, viewed_at desc);
create index if not exists listing_views_viewer_idx  on public.listing_views (viewer_user_id);

-- ---- view_count column on listings ----
alter table public.listings
  add column if not exists view_count integer not null default 0;

create or replace function public.bump_view_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.listings
     set view_count = view_count + 1
   where listing_id = NEW.listing_id;
  return NEW;
end;
$$;

drop trigger if exists listing_views_bump_count on public.listing_views;
create trigger listing_views_bump_count
  after insert on public.listing_views
  for each row execute function public.bump_view_count();

-- Backfill counter (no rows exist yet, but defensive).
update public.listings l
   set view_count = coalesce((
     select count(*) from public.listing_views v where v.listing_id = l.listing_id
   ), 0);

-- ---- RLS for listing_views ----
alter table public.listing_views enable row level security;

drop policy if exists listing_views_insert_anyone on public.listing_views;
create policy listing_views_insert_anyone
  on public.listing_views for insert
  with check (true);

drop policy if exists listing_views_select_seller on public.listing_views;
create policy listing_views_select_seller
  on public.listing_views for select
  using (
    exists (
      select 1 from public.listings l
      where l.listing_id = listing_views.listing_id
        and l.seller_id  = auth.uid()
    )
  );

drop policy if exists listing_views_select_admin on public.listing_views;
create policy listing_views_select_admin
  on public.listing_views for select
  using (public.is_admin());

-- ---- saved_listings: let sellers see who saved their own listings ----
drop policy if exists saved_listings_select_seller on public.saved_listings;
create policy saved_listings_select_seller
  on public.saved_listings for select
  using (
    exists (
      select 1 from public.listings l
      where l.listing_id = saved_listings.listing_id
        and l.seller_id  = auth.uid()
    )
  );
