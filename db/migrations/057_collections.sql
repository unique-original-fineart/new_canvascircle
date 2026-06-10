-- =============================================================================
-- 057_collections.sql
-- =============================================================================
-- Collections feature, Chunk A — foundation.
--
-- A Collection is a personal catalog of pieces a user owns. Distinct from
-- Listings: Collection items are "what I own and want to show off",
-- Listings are "what I'm trying to sell." A piece can be in a Collection
-- without ever having been listed (most cases), and a piece that gets
-- listed-and-sold can be added to the buyer's Collection via the Chunk B
-- "add this to your Collection" prompt.
--
-- Privacy model (locked 2026-06-08 with Guy):
--   * Items have PUBLIC fields (artist, title, medium, category, image,
--     size, frame size, COA, public story) and PRIVATE fields (private
--     notes, appraised value, paid value).
--   * A user's Collection is PRIVATE BY DEFAULT. The user can flip it to
--     public ONLY if they are Established (is_trusted). If admin later
--     un-Establishes them, the read-time check in get_public_collection
--     hides the Collection again automatically — the boolean stays set
--     but the effective visibility flips off.
--   * Private fields are never returned to any caller other than the
--     owner. Enforced at the column-grant layer (private columns have
--     no GRANT) AND at the RPC layer (get_public_collection explicitly
--     omits them).
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — appraised value and what-you-
--     paid are NEVER public, even on a public Collection. Per-piece price
--     data leaking to public viewers would undermine sellers' pricing
--     position when those pieces later list.
--   * [[free-for-collectors-forever]] — Collections are free, no fees,
--     no premium tier gating.
--   * [[collectors-only-policy]] — no artists posting their own work
--     into a "Collection." The piece must be one they own as a collector.
--     (Enforcement is policy + admin-review, not technical — same as the
--     existing listing gate.)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles columns — per-user Collection visibility + About blurb
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists collection_is_public boolean not null default false;
alter table public.profiles
  add column if not exists collection_about_text text;

-- Grant SELECT on the new columns to authenticated + anon so the public
-- seller page can render them. (Per migration 051's column-grant pattern:
-- new columns added to profiles need explicit grants.)
grant select (collection_is_public, collection_about_text) on public.profiles to authenticated;
grant select (collection_is_public, collection_about_text) on public.profiles to anon;

-- ---------------------------------------------------------------------------
-- 2. collection_items table
-- ---------------------------------------------------------------------------
-- Public fields: rendered on the public Collection page when the owner
-- has flipped collection_is_public=true AND is_trusted=true.
-- Private fields: never returned to any caller other than the owner.
create table if not exists public.collection_items (
  id                  uuid primary key default gen_random_uuid(),
  owner_id            uuid not null references auth.users(id) on delete cascade,
  -- Public fields ----------------------------------------------------
  artist_name         text not null,
  artwork_title       text not null,
  medium              text not null,
  artwork_category    text not null check (artwork_category in ('Unique/Original', 'Limited Edition')),
  image_path          text not null,
  height_in           numeric,
  width_in            numeric,
  depth_in            numeric,
  framed_size         text,
  coa_included        text check (coa_included in ('Yes', 'No')),
  public_story        text,   -- max 500 chars, scrubbed (see insert/update RPCs)
  -- Private fields (owner-only, NEVER public) ------------------------
  private_notes       text,
  appraised_value_usd numeric(10, 2),
  paid_value_usd      numeric(10, 2),
  -- Provenance to a listing if this piece was bought through CC ------
  source_listing_id   uuid references public.listings(listing_id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists collection_items_owner_idx
  on public.collection_items (owner_id, created_at desc);
-- Match-time lookup for ISO listings (Chunk C). Lowercased artist for
-- case-insensitive fuzzy matching against ISO listings.artist_name.
create index if not exists collection_items_artist_lower_idx
  on public.collection_items (lower(artist_name));

-- ---------------------------------------------------------------------------
-- 3. Grants — table is locked down; reads happen via SECURITY DEFINER RPCs
-- ---------------------------------------------------------------------------
-- Lock the table fully at the role level. All read/write happens through
-- the RPCs below, which enforce the privacy boundary explicitly. This
-- guarantees no client can do `select * from collection_items` and pull
-- private columns even if RLS policies are misconfigured.
alter table public.collection_items enable row level security;
revoke all on public.collection_items from public, anon;
revoke all on public.collection_items from authenticated;

-- A policy that allows the owner SELECT-only via RLS is intentionally
-- NOT added — we don't want any direct table reads. The RPCs use
-- SECURITY DEFINER which bypasses RLS, so they don't need a policy
-- either. Writes also go through RPCs.

-- ---------------------------------------------------------------------------
-- 4. Helper: sanitize_public_story
-- ---------------------------------------------------------------------------
-- Public Story field has tight content rules to prevent it from being
-- used to advertise sales or leak prices in ways that undermine the
-- seller-pricing-power invariant. Cap length, scrub URLs / dollar
-- amounts / "for sale" / "DM me" patterns.
create or replace function public._sanitize_public_story(p_text text)
returns text
language plpgsql
immutable
as $$
declare
  v_clean text;
begin
  if p_text is null then return null; end if;
  v_clean := substring(trim(p_text), 1, 500);
  if v_clean = '' then return null; end if;
  if v_clean ~* '(https?://|www\.)' then
    raise exception 'links are not allowed in the public story';
  end if;
  -- Block dollar-amount patterns. We do NOT block all digits because
  -- "year 2018" or "edition 47/200" are fine. We block $X formats.
  if v_clean ~* '\$\s*\d' then
    raise exception 'dollar amounts are not allowed in the public story (the price stays private to you)';
  end if;
  if v_clean ~* '(for sale|taking offers|dm me|message me|inbox me|hit me up|venmo|paypal|cashapp|zelle)' then
    raise exception 'sale solicitations are not allowed in the public story';
  end if;
  -- Phone-number-ish blocks (loose heuristic: 7+ consecutive digits with
  -- optional separators). Catches "(908) 555-1234" and "9085551234".
  if v_clean ~ '\d[\d\s\-\(\)\.]{6,}\d' then
    raise exception 'phone numbers are not allowed in the public story';
  end if;
  return v_clean;
end $$;

revoke all on function public._sanitize_public_story(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. insert_collection_item RPC
-- ---------------------------------------------------------------------------
-- Caller is the owner. Validates required fields + optional field
-- formats. Returns the new item's id.
create or replace function public.insert_collection_item(
  p_artist_name         text,
  p_artwork_title       text,
  p_medium              text,
  p_artwork_category    text,
  p_image_path          text,
  p_height_in           numeric default null,
  p_width_in            numeric default null,
  p_depth_in            numeric default null,
  p_framed_size         text    default null,
  p_coa_included        text    default null,
  p_public_story        text    default null,
  p_private_notes       text    default null,
  p_appraised_value_usd numeric default null,
  p_paid_value_usd      numeric default null,
  p_source_listing_id   uuid    default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller    uuid := auth.uid();
  v_clean_story text;
  v_new_id    uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  if length(trim(coalesce(p_artist_name, ''))) = 0 then
    raise exception 'artist name is required';
  end if;
  if length(trim(coalesce(p_artwork_title, ''))) = 0 then
    raise exception 'artwork title is required';
  end if;
  if length(trim(coalesce(p_medium, ''))) = 0 then
    raise exception 'medium is required';
  end if;
  if p_artwork_category not in ('Unique/Original', 'Limited Edition') then
    raise exception 'artwork category must be Unique/Original or Limited Edition';
  end if;
  if length(trim(coalesce(p_image_path, ''))) = 0 then
    raise exception 'image is required';
  end if;
  if p_coa_included is not null and p_coa_included not in ('Yes', 'No') then
    raise exception 'COA included must be Yes, No, or blank';
  end if;
  if p_appraised_value_usd is not null and p_appraised_value_usd < 0 then
    raise exception 'appraised value cannot be negative';
  end if;
  if p_paid_value_usd is not null and p_paid_value_usd < 0 then
    raise exception 'paid value cannot be negative';
  end if;

  v_clean_story := public._sanitize_public_story(p_public_story);

  insert into public.collection_items (
    owner_id, artist_name, artwork_title, medium, artwork_category,
    image_path, height_in, width_in, depth_in, framed_size, coa_included,
    public_story, private_notes, appraised_value_usd, paid_value_usd,
    source_listing_id
  ) values (
    v_caller, trim(p_artist_name), trim(p_artwork_title), trim(p_medium),
    p_artwork_category, p_image_path, p_height_in, p_width_in, p_depth_in,
    nullif(trim(coalesce(p_framed_size, '')), ''), p_coa_included,
    v_clean_story,
    nullif(trim(coalesce(p_private_notes, '')), ''),
    p_appraised_value_usd, p_paid_value_usd,
    p_source_listing_id
  )
  returning id into v_new_id;
  return v_new_id;
end $$;

revoke all on function public.insert_collection_item(text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, uuid) from public, anon;
grant execute on function public.insert_collection_item(text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. update_collection_item RPC
-- ---------------------------------------------------------------------------
-- All updatable fields are nullable params; only non-null params are
-- applied. This lets the client send partial updates (e.g. "just change
-- the appraised value") without round-tripping the whole row.
--
-- Image path is updated via a separate flow (delete old + upload new +
-- update path) handled client-side in the portal — keeps this RPC focused
-- on text/numeric updates.
create or replace function public.update_collection_item(
  p_item_id             uuid,
  p_artist_name         text default null,
  p_artwork_title       text default null,
  p_medium              text default null,
  p_artwork_category    text default null,
  p_image_path          text default null,
  p_height_in           numeric default null,
  p_width_in            numeric default null,
  p_depth_in            numeric default null,
  p_framed_size         text default null,
  p_coa_included        text default null,
  p_public_story        text default null,
  p_private_notes       text default null,
  p_appraised_value_usd numeric default null,
  p_paid_value_usd      numeric default null,
  -- Sentinel value: pass true on the corresponding _clear_* flags to
  -- explicitly NULL OUT a field (vs leaving it unchanged via null param).
  p_clear_framed_size         boolean default false,
  p_clear_coa                 boolean default false,
  p_clear_public_story        boolean default false,
  p_clear_private_notes       boolean default false,
  p_clear_appraised_value     boolean default false,
  p_clear_paid_value          boolean default false,
  p_clear_dimensions          boolean default false
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_owner  uuid;
  v_clean_story text;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  select owner_id into v_owner from public.collection_items where id = p_item_id;
  if v_owner is null then
    raise exception 'collection item not found';
  end if;
  if v_owner <> v_caller then
    raise exception 'only the owner can edit this item';
  end if;

  if p_artwork_category is not null and p_artwork_category not in ('Unique/Original', 'Limited Edition') then
    raise exception 'artwork category must be Unique/Original or Limited Edition';
  end if;
  if p_coa_included is not null and p_coa_included not in ('Yes', 'No') then
    raise exception 'COA included must be Yes, No, or blank';
  end if;

  if p_public_story is not null then
    v_clean_story := public._sanitize_public_story(p_public_story);
  end if;

  update public.collection_items set
    artist_name         = coalesce(nullif(trim(p_artist_name), ''), artist_name),
    artwork_title       = coalesce(nullif(trim(p_artwork_title), ''), artwork_title),
    medium              = coalesce(nullif(trim(p_medium), ''), medium),
    artwork_category    = coalesce(p_artwork_category, artwork_category),
    image_path          = coalesce(nullif(trim(p_image_path), ''), image_path),
    height_in           = case when p_clear_dimensions then null else coalesce(p_height_in, height_in) end,
    width_in            = case when p_clear_dimensions then null else coalesce(p_width_in,  width_in)  end,
    depth_in            = case when p_clear_dimensions then null else coalesce(p_depth_in,  depth_in)  end,
    framed_size         = case when p_clear_framed_size  then null else coalesce(nullif(trim(coalesce(p_framed_size, '')), ''), framed_size) end,
    coa_included        = case when p_clear_coa          then null else coalesce(p_coa_included, coa_included) end,
    public_story        = case when p_clear_public_story then null else coalesce(v_clean_story, public_story) end,
    private_notes       = case when p_clear_private_notes then null else coalesce(nullif(trim(coalesce(p_private_notes, '')), ''), private_notes) end,
    appraised_value_usd = case when p_clear_appraised_value then null else coalesce(p_appraised_value_usd, appraised_value_usd) end,
    paid_value_usd      = case when p_clear_paid_value      then null else coalesce(p_paid_value_usd,      paid_value_usd)      end,
    updated_at = now()
  where id = p_item_id;
end $$;

revoke all on function public.update_collection_item(uuid, text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_collection_item(uuid, text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. delete_collection_item RPC
-- ---------------------------------------------------------------------------
-- Note: storage object deletion happens client-side (portal calls
-- storage.from('collection-images').remove(path) before/after this RPC).
-- This RPC just removes the DB row.
create or replace function public.delete_collection_item(
  p_item_id uuid
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_owner  uuid;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  select owner_id into v_owner from public.collection_items where id = p_item_id;
  if v_owner is null then
    return;  -- already gone, idempotent
  end if;
  if v_owner <> v_caller then
    raise exception 'only the owner can delete this item';
  end if;
  delete from public.collection_items where id = p_item_id;
end $$;

revoke all on function public.delete_collection_item(uuid) from public, anon;
grant execute on function public.delete_collection_item(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. set_collection_visibility RPC
-- ---------------------------------------------------------------------------
-- Toggle public/private for the caller's Collection. Going public requires
-- the caller to be Established (is_trusted=true) — this gate is the
-- scammer-prevention layer for the whole feature. Un-Establishing later
-- doesn't auto-flip the boolean back, but read-time enforcement in
-- get_public_collection re-checks is_trusted on every load, so the
-- effective visibility flips off automatically if admin un-Establishes.
create or replace function public.set_collection_visibility(
  p_is_public boolean
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller    uuid := auth.uid();
  v_trusted   boolean;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  select is_trusted into v_trusted from public.profiles where user_id = v_caller;
  if p_is_public = true and coalesce(v_trusted, false) = false then
    raise exception 'only Established Members can make their Collection public';
  end if;
  update public.profiles
    set collection_is_public = p_is_public
    where user_id = v_caller;
end $$;

revoke all on function public.set_collection_visibility(boolean) from public, anon;
grant execute on function public.set_collection_visibility(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. set_collection_about RPC
-- ---------------------------------------------------------------------------
-- Caller sets / updates their public Collection's About blurb. Same
-- scrub rules as public_story (no links, no sale solicitations, no
-- dollar amounts, no phone numbers). Length cap 1000 chars (longer than
-- per-item story because it's the whole-Collection intro).
create or replace function public.set_collection_about(
  p_text text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_clean  text;
begin
  if v_caller is null then
    raise exception 'must be signed in';
  end if;
  if p_text is null or length(trim(p_text)) = 0 then
    update public.profiles set collection_about_text = null where user_id = v_caller;
    return;
  end if;
  v_clean := substring(trim(p_text), 1, 1000);
  if v_clean ~* '(https?://|www\.)' then
    raise exception 'links are not allowed in the Collection About';
  end if;
  if v_clean ~* '\$\s*\d' then
    raise exception 'dollar amounts are not allowed in the Collection About';
  end if;
  if v_clean ~* '(for sale|taking offers|dm me|message me|inbox me|hit me up|venmo|paypal|cashapp|zelle)' then
    raise exception 'sale solicitations are not allowed in the Collection About';
  end if;
  if v_clean ~ '\d[\d\s\-\(\)\.]{6,}\d' then
    raise exception 'phone numbers are not allowed in the Collection About';
  end if;
  update public.profiles set collection_about_text = v_clean where user_id = v_caller;
end $$;

revoke all on function public.set_collection_about(text) from public, anon;
grant execute on function public.set_collection_about(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. get_my_collection RPC
-- ---------------------------------------------------------------------------
-- Owner's view of their own Collection. Returns ALL fields including
-- private ones (notes, appraised value, paid value).
create or replace function public.get_my_collection()
returns table (
  id                  uuid,
  artist_name         text,
  artwork_title       text,
  medium              text,
  artwork_category    text,
  image_path          text,
  height_in           numeric,
  width_in            numeric,
  depth_in            numeric,
  framed_size         text,
  coa_included        text,
  public_story        text,
  private_notes       text,
  appraised_value_usd numeric,
  paid_value_usd      numeric,
  source_listing_id   uuid,
  created_at          timestamptz,
  updated_at          timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    id, artist_name, artwork_title, medium, artwork_category, image_path,
    height_in, width_in, depth_in, framed_size, coa_included, public_story,
    private_notes, appraised_value_usd, paid_value_usd, source_listing_id,
    created_at, updated_at
  from public.collection_items
  where owner_id = auth.uid()
  order by created_at desc;
$$;

revoke all on function public.get_my_collection() from public, anon;
grant execute on function public.get_my_collection() to authenticated;

-- ---------------------------------------------------------------------------
-- 11. get_public_collection RPC (used by Chunk B; defined now for completeness)
-- ---------------------------------------------------------------------------
-- Public viewer's read of someone else's Collection. Returns ONLY public
-- fields. Returns empty if (a) the owner doesn't have collection_is_public=true
-- OR (b) the owner is no longer is_trusted. Both checks happen at read
-- time so admin un-Establishing immediately hides public Collections.
create or replace function public.get_public_collection(
  p_owner_id uuid
) returns table (
  id                  uuid,
  artist_name         text,
  artwork_title       text,
  medium              text,
  artwork_category    text,
  image_path          text,
  height_in           numeric,
  width_in            numeric,
  depth_in            numeric,
  framed_size         text,
  coa_included        text,
  public_story        text,
  created_at          timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ci.id, ci.artist_name, ci.artwork_title, ci.medium, ci.artwork_category,
    ci.image_path, ci.height_in, ci.width_in, ci.depth_in, ci.framed_size,
    ci.coa_included, ci.public_story, ci.created_at
  from public.collection_items ci
  join public.profiles p on p.user_id = ci.owner_id
  where ci.owner_id = p_owner_id
    and p.collection_is_public = true
    and p.is_trusted = true
  order by ci.created_at desc;
$$;

revoke all on function public.get_public_collection(uuid) from public;
grant execute on function public.get_public_collection(uuid) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 12. Storage bucket: collection-images
-- ---------------------------------------------------------------------------
-- Public bucket so collection images can be served via direct CDN URL.
-- Privacy is enforced at the application layer (the public Collection
-- page only renders images for items in a public+established collection).
-- A determined scraper guessing UUID paths is not a realistic threat for
-- art photos.
insert into storage.buckets (id, name, public)
values ('collection-images', 'collection-images', true)
on conflict (id) do nothing;

-- Storage policies: owners can manage their own folder; everyone can read.
-- Folder structure is {owner_id}/{item_id}/{filename}.
drop policy if exists "collection_images_owner_insert" on storage.objects;
create policy "collection_images_owner_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'collection-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "collection_images_owner_update" on storage.objects;
create policy "collection_images_owner_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'collection-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "collection_images_owner_delete" on storage.objects;
create policy "collection_images_owner_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'collection-images'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "collection_images_public_read" on storage.objects;
create policy "collection_images_public_read"
  on storage.objects for select
  to public
  using (bucket_id = 'collection-images');

-- =============================================================================
-- End of migration 057.
-- =============================================================================
