-- =============================================================================
-- 063_collection_acquired_date_and_stats.sql
-- =============================================================================
-- Two related changes:
--
--   1. Add acquired_year + acquired_month columns to collection_items so
--      collectors can record WHEN they got each piece. Year-only is the
--      common case ("I picked this up in 2018"); month is optional for
--      collectors who want granular records ("April 2020, Park West
--      cruise"). Used by:
--        * The detail-modal display ("Acquired April 2018" / "Acquired
--          in 2018")
--        * The collection-stats RPCs below ("Collecting since 2014",
--          "5 pieces this year")
--
--   2. Two new stats RPCs:
--        * get_my_collection_stats() — owner-only view including total
--          appraised value and total paid (both private fields). Used
--          for the private stats card in the portal Collection tab.
--        * get_public_collection_stats(p_owner_id) — publicly callable.
--          Returns aggregate counts only — no price data, no per-item
--          identities. Used for the stats strip above the public
--          Collection grid on seller pages.
--
-- "Acquired through CanvasCircle" semantic: a collection_item with
-- source_listing_id IS NOT NULL was added via the buyer-after-sale
-- prompt (Chunk B). We expose that as a boolean in get_*_collection
-- queries so the frontend can render the "Acquired through CanvasCircle"
-- badge WITHOUT ever exposing the original seller's identity. Per the
-- privacy concern Guy raised: the lineage signal is "platform-level
-- proof of provenance" only, never "previously owned by @handle."
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — public stats expose NO
--     monetary data. Only the owner's stats RPC returns appraised /
--     paid totals.
--   * [[anonymous-privacy-ui-only]] — stats are aggregate; identities
--     of previous owners are NEVER part of any returned shape.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.collection_items
  add column if not exists acquired_year integer
    check (acquired_year is null or (acquired_year >= 1900 and acquired_year <= 2200));
alter table public.collection_items
  add column if not exists acquired_month integer
    check (acquired_month is null or (acquired_month >= 1 and acquired_month <= 12));

-- Light index used by the "earliest year" + "this year" stats queries.
create index if not exists collection_items_acquired_year_idx
  on public.collection_items (owner_id, acquired_year);

-- ---------------------------------------------------------------------------
-- 2. get_my_collection — surface acquired_year, acquired_month, via_cc flag
-- ---------------------------------------------------------------------------
-- via_cc is derived (source_listing_id is not null) so the frontend
-- never needs to dereference the actual listing — and crucially, can't
-- accidentally surface the previous owner's identity.
drop function if exists public.get_my_collection();
create function public.get_my_collection()
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
  is_public           boolean,
  acquired_year       integer,
  acquired_month      integer,
  via_canvascircle    boolean,
  created_at          timestamptz,
  updated_at          timestamptz,
  source_type         text
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
    is_public, acquired_year, acquired_month,
    (source_listing_id is not null) as via_canvascircle,
    created_at, updated_at,
    'collection_item'::text as source_type
  from public.collection_items
  where owner_id = auth.uid()

  union all

  -- in_collection listings — no acquired_* and never via_cc (they were
  -- the user's own listings, not acquired through CC). Null those out.
  select
    l.listing_id as id, l.artist_name, l.artwork_title, l.medium, l.artwork_category,
    (
      select li.storage_path from public.listing_images li
      where li.listing_id = l.listing_id
      order by li.position asc limit 1
    ) as image_path,
    l.height_in, l.width_in, l.depth_in, l.framed_size, l.coa_included,
    null::text as public_story,
    null::text as private_notes,
    null::numeric as appraised_value_usd,
    null::numeric as paid_value_usd,
    null::uuid as source_listing_id,
    true as is_public,
    null::integer as acquired_year,
    null::integer as acquired_month,
    false as via_canvascircle,
    l.created_at, l.updated_at,
    'listing'::text as source_type
  from public.listings l
  where l.seller_id = auth.uid()
    and l.status = 'in_collection'
  order by created_at desc;
$$;

revoke all on function public.get_my_collection() from public, anon;
grant execute on function public.get_my_collection() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. get_public_collection — same shape additions
-- ---------------------------------------------------------------------------
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
  acquired_year       integer,
  acquired_month      integer,
  via_canvascircle    boolean,
  created_at          timestamptz,
  source_type         text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ci.id, ci.artist_name, ci.artwork_title, ci.medium, ci.artwork_category,
    ci.image_path, ci.height_in, ci.width_in, ci.depth_in, ci.framed_size,
    ci.coa_included, ci.public_story,
    ci.acquired_year, ci.acquired_month,
    (ci.source_listing_id is not null) as via_canvascircle,
    ci.created_at,
    'collection_item'::text as source_type
  from public.collection_items ci
  join public.profiles p on p.user_id = ci.owner_id
  where ci.owner_id = p_owner_id
    and p.collection_is_public = true
    and p.is_trusted = true
    and ci.is_public = true

  union all

  select
    l.listing_id as id, l.artist_name, l.artwork_title, l.medium, l.artwork_category,
    (
      select li.storage_path from public.listing_images li
      where li.listing_id = l.listing_id
      order by li.position asc limit 1
    ) as image_path,
    l.height_in, l.width_in, l.depth_in, l.framed_size, l.coa_included,
    null::text as public_story,
    null::integer as acquired_year,
    null::integer as acquired_month,
    false as via_canvascircle,
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

-- ---------------------------------------------------------------------------
-- 4. insert_collection_item — accept acquired_year + acquired_month
-- ---------------------------------------------------------------------------
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
  p_source_listing_id   uuid    default null,
  p_is_public           boolean default true,
  p_acquired_year       integer default null,
  p_acquired_month      integer default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller      uuid := auth.uid();
  v_clean_story text;
  v_new_id      uuid;
begin
  if v_caller is null then raise exception 'must be signed in'; end if;
  if length(trim(coalesce(p_artist_name, ''))) = 0 then raise exception 'artist name is required'; end if;
  if length(trim(coalesce(p_artwork_title, ''))) = 0 then raise exception 'artwork title is required'; end if;
  if length(trim(coalesce(p_medium, ''))) = 0 then raise exception 'medium is required'; end if;
  if p_artwork_category not in ('Unique/Original', 'Limited Edition') then
    raise exception 'artwork category must be Unique/Original or Limited Edition';
  end if;
  if length(trim(coalesce(p_image_path, ''))) = 0 then raise exception 'image is required'; end if;
  if p_coa_included is not null and p_coa_included not in ('Yes', 'No') then
    raise exception 'COA included must be Yes, No, or blank';
  end if;
  if p_appraised_value_usd is not null and p_appraised_value_usd < 0 then raise exception 'appraised value cannot be negative'; end if;
  if p_paid_value_usd is not null and p_paid_value_usd < 0 then raise exception 'paid value cannot be negative'; end if;
  if p_acquired_year is not null and (p_acquired_year < 1900 or p_acquired_year > 2200) then
    raise exception 'acquired year must be between 1900 and 2200';
  end if;
  if p_acquired_month is not null and (p_acquired_month < 1 or p_acquired_month > 12) then
    raise exception 'acquired month must be between 1 and 12';
  end if;

  v_clean_story := public._sanitize_public_story(p_public_story);

  insert into public.collection_items (
    owner_id, artist_name, artwork_title, medium, artwork_category,
    image_path, height_in, width_in, depth_in, framed_size, coa_included,
    public_story, private_notes, appraised_value_usd, paid_value_usd,
    source_listing_id, is_public, acquired_year, acquired_month
  ) values (
    v_caller, trim(p_artist_name), trim(p_artwork_title), trim(p_medium),
    p_artwork_category, p_image_path, p_height_in, p_width_in, p_depth_in,
    nullif(trim(coalesce(p_framed_size, '')), ''), p_coa_included,
    v_clean_story,
    nullif(trim(coalesce(p_private_notes, '')), ''),
    p_appraised_value_usd, p_paid_value_usd,
    p_source_listing_id,
    coalesce(p_is_public, true),
    p_acquired_year, p_acquired_month
  )
  returning id into v_new_id;
  return v_new_id;
end $$;

revoke all on function public.insert_collection_item(text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, uuid, boolean, integer, integer) from public, anon;
grant execute on function public.insert_collection_item(text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, uuid, boolean, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. update_collection_item — accept acquired_year + acquired_month + clears
-- ---------------------------------------------------------------------------
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
  p_clear_framed_size         boolean default false,
  p_clear_coa                 boolean default false,
  p_clear_public_story        boolean default false,
  p_clear_private_notes       boolean default false,
  p_clear_appraised_value     boolean default false,
  p_clear_paid_value          boolean default false,
  p_clear_dimensions          boolean default false,
  p_is_public                 boolean default null,
  p_acquired_year             integer default null,
  p_acquired_month            integer default null,
  p_clear_acquired_date       boolean default false
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
  if v_caller is null then raise exception 'must be signed in'; end if;
  select owner_id into v_owner from public.collection_items where id = p_item_id;
  if v_owner is null then raise exception 'collection item not found'; end if;
  if v_owner <> v_caller then raise exception 'only the owner can edit this item'; end if;

  if p_artwork_category is not null and p_artwork_category not in ('Unique/Original', 'Limited Edition') then
    raise exception 'artwork category must be Unique/Original or Limited Edition';
  end if;
  if p_coa_included is not null and p_coa_included not in ('Yes', 'No') then
    raise exception 'COA included must be Yes, No, or blank';
  end if;
  if p_acquired_year is not null and (p_acquired_year < 1900 or p_acquired_year > 2200) then
    raise exception 'acquired year must be between 1900 and 2200';
  end if;
  if p_acquired_month is not null and (p_acquired_month < 1 or p_acquired_month > 12) then
    raise exception 'acquired month must be between 1 and 12';
  end if;

  if p_public_story is not null then v_clean_story := public._sanitize_public_story(p_public_story); end if;

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
    is_public           = coalesce(p_is_public, is_public),
    acquired_year       = case when p_clear_acquired_date then null else coalesce(p_acquired_year, acquired_year) end,
    acquired_month      = case when p_clear_acquired_date then null else coalesce(p_acquired_month, acquired_month) end,
    updated_at = now()
  where id = p_item_id;
end $$;

revoke all on function public.update_collection_item(uuid, text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, integer, integer, boolean) from public, anon;
grant execute on function public.update_collection_item(uuid, text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean, integer, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. get_my_collection_stats — owner-only stats card
-- ---------------------------------------------------------------------------
-- Includes the private monetary totals (appraised + paid) since this is
-- only ever returned to the owner. Stats are scoped to collection_items
-- only — in_collection listings show in the grid but don't contribute
-- to stats (they don't have acquired_year, and treating their created_at
-- as acquisition date would be misleading).
create or replace function public.get_my_collection_stats()
returns table (
  total_pieces       integer,
  total_artists      integer,
  acquired_via_cc    integer,
  earliest_year      integer,
  added_this_year    integer,
  total_appraised    numeric,
  total_paid         numeric,
  top_artists        jsonb,
  by_category        jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller uuid := auth.uid();
  v_total_pieces  integer;
  v_total_artists integer;
  v_via_cc        integer;
  v_earliest      integer;
  v_this_year     integer;
  v_total_appr    numeric;
  v_total_paid    numeric;
  v_top_artists   jsonb;
  v_by_category   jsonb;
begin
  if v_caller is null then
    return query select 0, 0, 0, null::integer, 0, 0::numeric, 0::numeric,
      '[]'::jsonb, '{}'::jsonb;
    return;
  end if;

  select count(*) into v_total_pieces from public.collection_items where owner_id = v_caller;
  select count(distinct artist_name) into v_total_artists from public.collection_items where owner_id = v_caller;
  select count(*) into v_via_cc from public.collection_items where owner_id = v_caller and source_listing_id is not null;
  select min(acquired_year) into v_earliest from public.collection_items where owner_id = v_caller and acquired_year is not null;
  select count(*) into v_this_year from public.collection_items where owner_id = v_caller and acquired_year = extract(year from now())::int;
  select coalesce(sum(appraised_value_usd), 0) into v_total_appr from public.collection_items where owner_id = v_caller;
  select coalesce(sum(paid_value_usd), 0) into v_total_paid from public.collection_items where owner_id = v_caller;

  -- Top 5 artists by piece count.
  select coalesce(jsonb_agg(t order by t->>'count' desc), '[]'::jsonb) into v_top_artists from (
    select jsonb_build_object('artist_name', artist_name, 'count', count(*)) as t
    from public.collection_items
    where owner_id = v_caller
    group by artist_name
    order by count(*) desc
    limit 5
  ) sub;

  -- By category: { "Unique/Original": N, "Limited Edition": M }
  select coalesce(jsonb_object_agg(artwork_category, c), '{}'::jsonb) into v_by_category from (
    select artwork_category, count(*) as c
    from public.collection_items
    where owner_id = v_caller
    group by artwork_category
  ) sub;

  return query select v_total_pieces, v_total_artists, v_via_cc, v_earliest, v_this_year,
                      v_total_appr, v_total_paid, v_top_artists, v_by_category;
end $$;

revoke all on function public.get_my_collection_stats() from public, anon;
grant execute on function public.get_my_collection_stats() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. get_public_collection_stats — anonymous stats for the public Collection
-- ---------------------------------------------------------------------------
-- NO monetary data. Returns only counts + earliest year + top artists.
-- Respects the same is_public + is_trusted gates as get_public_collection.
-- Counts items currently visible on the public Collection page (per-
-- item is_public = true).
create or replace function public.get_public_collection_stats(
  p_owner_id uuid
) returns table (
  total_pieces    integer,
  total_artists   integer,
  acquired_via_cc integer,
  earliest_year   integer,
  top_artists     jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_open boolean;
  v_total integer;
  v_artists integer;
  v_via_cc integer;
  v_earliest integer;
  v_top jsonb;
begin
  select (p.collection_is_public and p.is_trusted) into v_is_open
    from public.profiles p where p.user_id = p_owner_id;
  if not coalesce(v_is_open, false) then
    return query select 0, 0, 0, null::integer, '[]'::jsonb;
    return;
  end if;

  select count(*) into v_total from public.collection_items
    where owner_id = p_owner_id and is_public = true;
  select count(distinct artist_name) into v_artists from public.collection_items
    where owner_id = p_owner_id and is_public = true;
  select count(*) into v_via_cc from public.collection_items
    where owner_id = p_owner_id and is_public = true and source_listing_id is not null;
  select min(acquired_year) into v_earliest from public.collection_items
    where owner_id = p_owner_id and is_public = true and acquired_year is not null;

  select coalesce(jsonb_agg(t order by t->>'count' desc), '[]'::jsonb) into v_top from (
    select jsonb_build_object('artist_name', artist_name, 'count', count(*)) as t
    from public.collection_items
    where owner_id = p_owner_id and is_public = true
    group by artist_name
    order by count(*) desc
    limit 5
  ) sub;

  return query select v_total, v_artists, v_via_cc, v_earliest, v_top;
end $$;

revoke all on function public.get_public_collection_stats(uuid) from public;
grant execute on function public.get_public_collection_stats(uuid) to authenticated, anon;

-- =============================================================================
-- End of migration 063.
-- =============================================================================
