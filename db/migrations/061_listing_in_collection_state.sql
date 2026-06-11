-- =============================================================================
-- 061_listing_in_collection_state.sql
-- =============================================================================
-- "Round-trip" between For Sale and Collection. Listings can now flip
-- between status='available' and status='in_collection' freely:
--   * 'available' / 'pending' / 'sold' / 'not_renewed' — public catalog
--   * 'in_collection' — hidden from public catalog AND For Sale tab, but
--     surfaced on the public Collection tab alongside native collection_items
--
-- Why this design: a listing is a piece of physical artwork the seller
-- owns. Verification proof (the ownership video) is bound to the listing
-- row. Round-tripping via a status flag preserves the verification,
-- image, dimensions — everything — without recreating the listing.
-- The auto-revoke triggers on the 4 sensitive fields (artist, title,
-- medium, category) still fire as designed; status changes don't
-- touch those fields so verification persists across flips.
--
-- ISO matching is extended to include in_collection listings, since
-- the owner still owns the piece. Native collection_items + in_collection
-- listings both count as "I own this" signal for matching.
--
-- The public Collection tab on a seller page now renders BOTH sources
-- (collection_items where is_public=true, in_collection listings) in
-- one unified grid. A new source_type column on the returned shape
-- tells the frontend which storage bucket to pull the image from
-- (collection-images vs listing-images).
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — in_collection listings' price
--     data is NOT exposed on the public Collection tab. Card renders
--     like a Collection card (artist + title + category only).
--   * [[ownership-verification]] — 4-field auto-revoke triggers unchanged.
--     Flipping a verified listing to in_collection and back keeps the
--     verification intact as long as the seller doesn't edit those fields.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Allow 'in_collection' as a listings.status value
-- ---------------------------------------------------------------------------
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check check (
  status in (
    'pending_review',
    'available',
    'pending',
    'sold',
    'delisted',
    'not_renewed',
    'rejected',
    'in_collection'
  )
);

-- ---------------------------------------------------------------------------
-- 2. Unified ISO match owner-id helper
-- ---------------------------------------------------------------------------
-- Returns the set of distinct user_ids that match the ISO listing's
-- artist/title from BOTH collection_items AND in_collection listings.
-- Used as the shared core for find_iso_collection_matches,
-- get_iso_match_count, viewer_has_collection_match (which previously
-- queried collection_items only).
--
-- "Active" Established + active profile gate applies in both branches —
-- the trust-tier eligibility for an ISO push is the same regardless of
-- which source the piece came from.
create or replace function public._iso_matched_owner_ids(
  p_iso_listing_id uuid
) returns table (owner_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with iso as (
    select listing_id, seller_id, artist_name, artwork_title, listing_type
    from public.listings
    where listing_id = p_iso_listing_id
  )
  select distinct owner_id from (
    -- Branch 1: collection_items (native Collection pieces)
    select ci.owner_id
    from public.collection_items ci
    join public.profiles p on p.user_id = ci.owner_id
    join iso on iso.listing_id = p_iso_listing_id
    where iso.listing_type = 'iso'
      and p.is_trusted = true
      and p.account_status = 'active'
      and ci.owner_id <> iso.seller_id
      and public._match_iso_to_collection(
        iso.artist_name, iso.artwork_title,
        ci.artist_name, ci.artwork_title
      )

    union

    -- Branch 2: listings flipped to 'in_collection' state. Same matching
    -- logic, same trust gate; owner_id comes from listings.seller_id.
    select l.seller_id as owner_id
    from public.listings l
    join public.profiles p on p.user_id = l.seller_id
    join iso on iso.listing_id = p_iso_listing_id
    where iso.listing_type = 'iso'
      and l.status = 'in_collection'
      and p.is_trusted = true
      and p.account_status = 'active'
      and l.seller_id <> iso.seller_id
      and public._match_iso_to_collection(
        iso.artist_name, iso.artwork_title,
        l.artist_name, l.artwork_title
      )
  ) merged;
$$;

revoke all on function public._iso_matched_owner_ids(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. find_iso_collection_matches — rewrite to use the unified helper
-- ---------------------------------------------------------------------------
create or replace function public.find_iso_collection_matches(
  p_iso_listing_id uuid
) returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller     uuid := auth.uid();
  v_iso        public.listings%rowtype;
  v_matches    uuid[];
begin
  select * into v_iso from public.listings where listing_id = p_iso_listing_id;
  if v_iso.listing_id is null or v_iso.listing_type <> 'iso' then
    return array[]::uuid[];
  end if;
  if v_caller is not null and v_caller <> v_iso.seller_id and not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select coalesce(array_agg(owner_id), array[]::uuid[])
    into v_matches
    from public._iso_matched_owner_ids(p_iso_listing_id);
  return v_matches;
end $$;

revoke all on function public.find_iso_collection_matches(uuid) from public, anon;
grant execute on function public.find_iso_collection_matches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_iso_match_count — rewrite to use the unified helper
-- ---------------------------------------------------------------------------
create or replace function public.get_iso_match_count(
  p_iso_listing_id uuid
) returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_iso    public.listings%rowtype;
  v_count  integer;
begin
  select * into v_iso from public.listings where listing_id = p_iso_listing_id;
  if v_iso.listing_id is null or v_iso.listing_type <> 'iso' then
    return 0;
  end if;
  select count(*) into v_count from public._iso_matched_owner_ids(p_iso_listing_id);
  return coalesce(v_count, 0);
end $$;

revoke all on function public.get_iso_match_count(uuid) from public;
grant execute on function public.get_iso_match_count(uuid) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 5. viewer_has_collection_match — rewrite to use unified helper
-- ---------------------------------------------------------------------------
-- "Does my Collection contain a matching piece?" now includes BOTH
-- native collection_items AND my own listings flipped to in_collection.
-- The trust-tier gate doesn't apply here — the viewer should see the
-- "you have this piece" banner even if they're not Established (only the
-- PUSH side of matching is gated to Established).
create or replace function public.viewer_has_collection_match(
  p_iso_listing_id uuid
) returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_iso    public.listings%rowtype;
  v_hit    boolean;
begin
  if v_caller is null then return false; end if;
  select * into v_iso from public.listings where listing_id = p_iso_listing_id;
  if v_iso.listing_id is null or v_iso.listing_type <> 'iso' then
    return false;
  end if;
  if v_iso.seller_id = v_caller then return false; end if;

  select (
    exists (
      select 1 from public.collection_items ci
      where ci.owner_id = v_caller
        and public._match_iso_to_collection(
          v_iso.artist_name, v_iso.artwork_title,
          ci.artist_name, ci.artwork_title
        )
    )
    or
    exists (
      select 1 from public.listings l
      where l.seller_id = v_caller
        and l.status = 'in_collection'
        and public._match_iso_to_collection(
          v_iso.artist_name, v_iso.artwork_title,
          l.artist_name, l.artwork_title
        )
    )
  ) into v_hit;
  return coalesce(v_hit, false);
end $$;

revoke all on function public.viewer_has_collection_match(uuid) from public, anon;
grant execute on function public.viewer_has_collection_match(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. get_public_collection — UNION collection_items + in_collection listings
-- ---------------------------------------------------------------------------
-- Adds a source_type column so the frontend knows which storage bucket
-- the image_path lives in ('collection_item' → collection-images,
-- 'listing' → listing-images). All other columns mirror the existing
-- shape so the rendering code can be source-agnostic.
--
-- DROP-then-CREATE because the return shape grows by one column.
drop function if exists public.get_public_collection(uuid);
create function public.get_public_collection(
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
  created_at          timestamptz,
  source_type         text  -- 'collection_item' or 'listing'
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Native collection_items branch.
  select
    ci.id, ci.artist_name, ci.artwork_title, ci.medium, ci.artwork_category,
    ci.image_path, ci.height_in, ci.width_in, ci.depth_in, ci.framed_size,
    ci.coa_included, ci.public_story, ci.created_at,
    'collection_item'::text as source_type
  from public.collection_items ci
  join public.profiles p on p.user_id = ci.owner_id
  where ci.owner_id = p_owner_id
    and p.collection_is_public = true
    and p.is_trusted = true
    and ci.is_public = true

  union all

  -- in_collection listings branch. Image path resolves into the
  -- listing-images bucket on the frontend (via source_type). The first
  -- image (lowest position) is used. public_story is null since
  -- listings don't carry that field; their 'description' field is
  -- sales-context copy and we intentionally don't surface it here.
  select
    l.listing_id as id,
    l.artist_name,
    l.artwork_title,
    l.medium,
    l.artwork_category,
    (
      select li.storage_path from public.listing_images li
      where li.listing_id = l.listing_id
      order by li.position asc
      limit 1
    ) as image_path,
    l.height_in, l.width_in, l.depth_in,
    l.framed_size,
    l.coa_included,
    null::text as public_story,
    l.created_at,
    'listing'::text as source_type
  from public.listings l
  join public.profiles p on p.user_id = l.seller_id
  where l.seller_id = p_owner_id
    and l.status = 'in_collection'
    and p.collection_is_public = true
    and p.is_trusted = true
  order by created_at desc;
$$;

revoke all on function public.get_public_collection(uuid) from public;
grant execute on function public.get_public_collection(uuid) to authenticated, anon;

-- =============================================================================
-- End of migration 061.
-- =============================================================================
