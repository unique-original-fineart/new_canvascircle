-- =============================================================================
-- CanvasCircle.art — Database Schema
-- =============================================================================
-- Run this in the Supabase SQL editor (Project > SQL > New query > paste > Run).
-- Idempotent where reasonable; safe to re-run after edits.
--
-- What this creates:
--   1. Tables: profiles, listings, listing_images, saved_listings,
--              moderation_events, email_log
--   2. Indexes on common query paths
--   3. Triggers: auto-update updated_at, auto-create profile on signup,
--                track previous_price when price changes
--   4. Row-Level Security (RLS) policies for every table
--   5. Storage bucket: listing-images (public read, authenticated write)
--
-- Architecture notes:
--   - profiles extends auth.users (1:1 by user_id)
--   - listings.seller_id → profiles.user_id
--   - All "who is admin" checks read from profiles.is_admin
--   - The public catalog reads listings WHERE status IN ('available','pending')
--     AND moderation_status = 'approved'
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
create extension if not exists "pgcrypto";  -- gen_random_uuid()


-- -----------------------------------------------------------------------------
-- Helper: updated_at trigger function
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- =============================================================================
-- TABLE: profiles
-- =============================================================================
-- One row per authenticated user. Created automatically by a trigger on
-- auth.users so we never have an auth user without a profile.
-- =============================================================================
create table if not exists public.profiles (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  display_name         text,
  facebook_profile_url text,
  location             text,
  post_header          text default '',
  post_footer          text default '',
  is_trusted           boolean not null default false,
  is_admin             boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists profiles_is_admin_idx   on public.profiles (is_admin)   where is_admin   = true;
create index if not exists profiles_is_trusted_idx on public.profiles (is_trusted) where is_trusted = true;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();


-- Auto-create a profile row when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =============================================================================
-- TABLE: listings
-- =============================================================================
-- One row per artwork listing. Replaces the row-per-submission Google Sheet.
-- =============================================================================
create table if not exists public.listings (
  listing_id              uuid primary key default gen_random_uuid(),
  seller_id               uuid not null references public.profiles(user_id) on delete cascade,

  -- Artwork identity
  artist_name             text not null,
  artwork_title           text not null,
  artwork_category        text not null check (artwork_category in (
                            'Unique/Original', 'Limited Edition', 'Other')),
  medium                  text,
  year_created            text,                 -- text, since "c. 1970" etc. is allowed

  -- Dimensions (inches)
  height_in               numeric,
  width_in                numeric,
  depth_in                numeric,              -- optional, for sculpture / 3D
  framed_size             text,                 -- e.g. "24.5 x 24.5" — free text from legacy form

  -- Condition / provenance / story
  condition_notes         text,
  provenance              text,
  description             text,

  -- Money
  asking_price_usd        numeric not null check (asking_price_usd >= 0),
  previous_price_usd      numeric,
  price_updated_at        timestamptz,

  -- Logistics
  shipping_offered        text not null check (shipping_offered in ('Yes','No')),
  coa_included            text not null check (coa_included in ('Yes','No')),

  -- Status / moderation
  status                  text not null default 'pending_review' check (status in (
                            'pending_review','available','pending','sold',
                            'delisted','not_renewed','rejected')),
  moderation_status       text not null default 'pending' check (moderation_status in (
                            'pending','approved','rejected')),
  moderation_notes        text,

  -- Seller signal to buyers
  seller_mood             text check (seller_mood in (
                            'Open to Offers','Price Firm',
                            'Motivated to Sell','Testing the Market')),

  -- Renewal lifecycle (60-day window)
  last_renewed_at         timestamptz not null default now(),
  renewal_warning_sent_at timestamptz,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists listings_seller_id_idx          on public.listings (seller_id);
create index if not exists listings_status_idx             on public.listings (status);
create index if not exists listings_moderation_status_idx  on public.listings (moderation_status);
create index if not exists listings_created_at_idx         on public.listings (created_at desc);
create index if not exists listings_public_visible_idx     on public.listings (created_at desc)
  where moderation_status = 'approved' and status in ('available','pending');

drop trigger if exists listings_set_updated_at on public.listings;
create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();


-- Track price changes: if asking_price_usd changes, snapshot the old value
-- into previous_price_usd and stamp price_updated_at.
create or replace function public.track_price_change()
returns trigger
language plpgsql
as $$
begin
  if new.asking_price_usd is distinct from old.asking_price_usd then
    new.previous_price_usd = old.asking_price_usd;
    new.price_updated_at   = now();
  end if;
  return new;
end;
$$;

drop trigger if exists listings_track_price_change on public.listings;
create trigger listings_track_price_change
  before update on public.listings
  for each row execute function public.track_price_change();


-- =============================================================================
-- TABLE: listing_images
-- =============================================================================
-- One row per image attached to a listing. Storage path points into the
-- "listing-images" Supabase Storage bucket. position controls display order.
-- =============================================================================
create table if not exists public.listing_images (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null references public.listings(listing_id) on delete cascade,
  storage_path text not null,        -- e.g. "{listing_id}/0.jpg"
  position     int  not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists listing_images_listing_id_idx
  on public.listing_images (listing_id, position);


-- =============================================================================
-- TABLE: saved_listings
-- =============================================================================
-- A user's "hearted" listings. Replaces the localStorage-only saved list.
-- =============================================================================
create table if not exists public.saved_listings (
  user_id    uuid not null references auth.users(id)        on delete cascade,
  listing_id uuid not null references public.listings(listing_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, listing_id)
);

create index if not exists saved_listings_listing_id_idx on public.saved_listings (listing_id);


-- =============================================================================
-- TABLE: moderation_events
-- =============================================================================
-- Audit trail for admin actions on listings.
-- =============================================================================
create table if not exists public.moderation_events (
  id         uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(listing_id) on delete cascade,
  admin_id   uuid references public.profiles(user_id) on delete set null,
  action     text not null check (action in (
               'approved','rejected','status_changed',
               'renewal_extended','seller_token_rotated','note')),
  details    jsonb,                  -- e.g. {"from":"pending","to":"available"}
  notes      text,
  created_at timestamptz not null default now()
);

create index if not exists moderation_events_listing_id_idx on public.moderation_events (listing_id, created_at desc);
create index if not exists moderation_events_admin_id_idx   on public.moderation_events (admin_id, created_at desc);


-- =============================================================================
-- TABLE: email_log
-- =============================================================================
-- Record of every transactional email sent (via edge function + Resend).
-- =============================================================================
create table if not exists public.email_log (
  id          uuid primary key default gen_random_uuid(),
  to_email    text not null,
  subject     text not null,
  body        text,
  kind        text,                  -- welcome | renewal_warning | status_change | manual | ...
  listing_id  uuid references public.listings(listing_id) on delete set null,
  sent_by     uuid references public.profiles(user_id)    on delete set null,
  sent_at     timestamptz not null default now()
);

create index if not exists email_log_to_email_idx   on public.email_log (to_email, sent_at desc);
create index if not exists email_log_listing_id_idx on public.email_log (listing_id, sent_at desc);


-- =============================================================================
-- ROW-LEVEL SECURITY
-- =============================================================================
-- Enable RLS on every table. Then add explicit policies. Anything not allowed
-- by a policy is denied — the service_role key bypasses RLS for admin tasks.
-- =============================================================================

alter table public.profiles          enable row level security;
alter table public.listings          enable row level security;
alter table public.listing_images    enable row level security;
alter table public.saved_listings    enable row level security;
alter table public.moderation_events enable row level security;
alter table public.email_log         enable row level security;


-- Helper: is the current user an admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select is_admin from public.profiles where user_id = auth.uid()),
    false
  );
$$;


-- ---- profiles ----
drop policy if exists profiles_select_public  on public.profiles;
drop policy if exists profiles_update_self    on public.profiles;
drop policy if exists profiles_update_admin   on public.profiles;

-- Anyone (incl. anonymous catalog visitors) can read a basic profile so
-- listing cards can show seller display_name / location.
create policy profiles_select_public
  on public.profiles for select
  using (true);

-- A user can update their own profile (but cannot grant themselves admin —
-- enforced at column level via a separate check below).
create policy profiles_update_self
  on public.profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy profiles_update_admin
  on public.profiles for update
  using (public.is_admin())
  with check (public.is_admin());


-- ---- listings ----
drop policy if exists listings_select_public on public.listings;
drop policy if exists listings_select_owner  on public.listings;
drop policy if exists listings_select_admin  on public.listings;
drop policy if exists listings_insert_owner  on public.listings;
drop policy if exists listings_update_owner  on public.listings;
drop policy if exists listings_update_admin  on public.listings;
drop policy if exists listings_delete_owner  on public.listings;
drop policy if exists listings_delete_admin  on public.listings;

-- Public visibility: approved + active.
create policy listings_select_public
  on public.listings for select
  using (moderation_status = 'approved' and status in ('available','pending','sold'));

-- A seller always sees their own listings (any status).
create policy listings_select_owner
  on public.listings for select
  using (seller_id = auth.uid());

-- Admins see everything.
create policy listings_select_admin
  on public.listings for select
  using (public.is_admin());

-- A seller may create listings under their own seller_id.
create policy listings_insert_owner
  on public.listings for insert
  with check (seller_id = auth.uid());

-- A seller may update their own listing — but cannot self-approve.
-- (moderation_status is enforced via column-level trigger below.)
create policy listings_update_owner
  on public.listings for update
  using (seller_id = auth.uid())
  with check (seller_id = auth.uid());

create policy listings_update_admin
  on public.listings for update
  using (public.is_admin())
  with check (public.is_admin());

create policy listings_delete_owner
  on public.listings for delete
  using (seller_id = auth.uid());

create policy listings_delete_admin
  on public.listings for delete
  using (public.is_admin());


-- Prevent sellers from changing moderation_status on their own listings.
create or replace function public.guard_moderation_status()
returns trigger
language plpgsql
as $$
begin
  if new.moderation_status is distinct from old.moderation_status
     and not public.is_admin() then
    raise exception 'Only admins can change moderation_status';
  end if;
  return new;
end;
$$;

drop trigger if exists listings_guard_moderation_status on public.listings;
create trigger listings_guard_moderation_status
  before update on public.listings
  for each row execute function public.guard_moderation_status();


-- ---- listing_images ----
drop policy if exists listing_images_select_public on public.listing_images;
drop policy if exists listing_images_select_owner  on public.listing_images;
drop policy if exists listing_images_select_admin  on public.listing_images;
drop policy if exists listing_images_write_owner   on public.listing_images;
drop policy if exists listing_images_write_admin   on public.listing_images;

create policy listing_images_select_public
  on public.listing_images for select
  using (exists (
    select 1 from public.listings l
    where l.listing_id = listing_images.listing_id
      and l.moderation_status = 'approved'
      and l.status in ('available','pending','sold')
  ));

create policy listing_images_select_owner
  on public.listing_images for select
  using (exists (
    select 1 from public.listings l
    where l.listing_id = listing_images.listing_id
      and l.seller_id  = auth.uid()
  ));

create policy listing_images_select_admin
  on public.listing_images for select
  using (public.is_admin());

create policy listing_images_write_owner
  on public.listing_images for all
  using (exists (
    select 1 from public.listings l
    where l.listing_id = listing_images.listing_id
      and l.seller_id  = auth.uid()
  ))
  with check (exists (
    select 1 from public.listings l
    where l.listing_id = listing_images.listing_id
      and l.seller_id  = auth.uid()
  ));

create policy listing_images_write_admin
  on public.listing_images for all
  using (public.is_admin())
  with check (public.is_admin());


-- ---- saved_listings ----
drop policy if exists saved_listings_select_self on public.saved_listings;
drop policy if exists saved_listings_write_self  on public.saved_listings;

create policy saved_listings_select_self
  on public.saved_listings for select
  using (user_id = auth.uid());

create policy saved_listings_write_self
  on public.saved_listings for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ---- moderation_events ----
drop policy if exists moderation_events_admin on public.moderation_events;

create policy moderation_events_admin
  on public.moderation_events for all
  using (public.is_admin())
  with check (public.is_admin());


-- ---- email_log ----
drop policy if exists email_log_admin on public.email_log;

create policy email_log_admin
  on public.email_log for all
  using (public.is_admin())
  with check (public.is_admin());


-- =============================================================================
-- STORAGE BUCKET: listing-images
-- =============================================================================
-- Run this once in the SQL editor. Public read so the catalog can <img src=…>
-- straight from the bucket. Authenticated users can write under their own
-- listing folder; admins can write anywhere.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('listing-images', 'listing-images', true)
on conflict (id) do nothing;

-- Public read is granted by bucket.public = true. The policies below cover
-- INSERT/UPDATE/DELETE.

drop policy if exists listing_images_storage_insert_owner on storage.objects;
drop policy if exists listing_images_storage_update_owner on storage.objects;
drop policy if exists listing_images_storage_delete_owner on storage.objects;
drop policy if exists listing_images_storage_admin        on storage.objects;

-- Path convention: "{listing_id}/{anything}". A seller can write only into
-- folders for listings they own.
create policy listing_images_storage_insert_owner
  on storage.objects for insert
  with check (
    bucket_id = 'listing-images'
    and exists (
      select 1 from public.listings l
      where l.listing_id::text = split_part(storage.objects.name, '/', 1)
        and l.seller_id = auth.uid()
    )
  );

create policy listing_images_storage_update_owner
  on storage.objects for update
  using (
    bucket_id = 'listing-images'
    and exists (
      select 1 from public.listings l
      where l.listing_id::text = split_part(storage.objects.name, '/', 1)
        and l.seller_id = auth.uid()
    )
  );

create policy listing_images_storage_delete_owner
  on storage.objects for delete
  using (
    bucket_id = 'listing-images'
    and exists (
      select 1 from public.listings l
      where l.listing_id::text = split_part(storage.objects.name, '/', 1)
        and l.seller_id = auth.uid()
    )
  );

create policy listing_images_storage_admin
  on storage.objects for all
  using (bucket_id = 'listing-images' and public.is_admin())
  with check (bucket_id = 'listing-images' and public.is_admin());


-- =============================================================================
-- DONE.
-- After running this, set yourself as admin with:
--   update public.profiles set is_admin = true where user_id =
--     (select id from auth.users where email = 'gjscuderi@gmail.com');
-- =============================================================================
