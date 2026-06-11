-- =============================================================================
-- 060_collection_item_visibility.sql
-- =============================================================================
-- Per-item visibility toggle on Collection items. Some collectors want
-- to share PART of their Collection publicly while keeping certain
-- pieces private (sentimental, controversial, valuable enough that they
-- don't want to broadcast ownership, etc.). Before this migration the
-- visibility was all-or-nothing at the Collection level.
--
-- Design:
--   * New collection_items.is_public boolean, default TRUE. Default
--     preserves backward compatibility — existing rows stay public.
--   * Owner sees ALL their items in their portal regardless of is_public.
--     The flag only governs the PUBLIC seller-page display.
--   * get_public_collection now filters by is_public = TRUE in addition
--     to the existing collection_is_public + is_trusted profile gates.
--   * insert_collection_item + update_collection_item accept the flag.
--   * ISO matching is INTENTIONALLY unchanged. The match logic queries
--     collection_items regardless of is_public — matching is about
--     ownership, not display. A private piece still counts toward the
--     "N collectors own this" community count on ISO listings AND its
--     owner still gets the "you have this piece" push. The privacy
--     boundary is purely about the public Collection PAGE display.
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — unchanged, this migration
--     doesn't touch any price data.
--   * [[anonymous-privacy-ui-only]] — owner identity continues to never
--     leak in ISO matching, regardless of is_public.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Column
-- ---------------------------------------------------------------------------
alter table public.collection_items
  add column if not exists is_public boolean not null default true;

-- ---------------------------------------------------------------------------
-- 2. get_public_collection — add is_public filter
-- ---------------------------------------------------------------------------
-- DROP-then-CREATE because the return shape doesn't change but we want
-- to be explicit about the function-body update. Could use OR REPLACE
-- if the signature is stable; using DROP-then-CREATE here as a pattern.
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
    and ci.is_public = true   -- per-item gate added in migration 060
  order by ci.created_at desc;
$$;

revoke all on function public.get_public_collection(uuid) from public;
grant execute on function public.get_public_collection(uuid) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 3. get_my_collection — return is_public so the portal can render the
--    per-item toggle state + Private badge on cards.
-- ---------------------------------------------------------------------------
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
    is_public, created_at, updated_at
  from public.collection_items
  where owner_id = auth.uid()
  order by created_at desc;
$$;

revoke all on function public.get_my_collection() from public, anon;
grant execute on function public.get_my_collection() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. insert_collection_item — accept p_is_public, defaulting to true
-- ---------------------------------------------------------------------------
-- Same RPC, signature extended with a trailing p_is_public param. Default
-- TRUE matches the column default + means existing client code that
-- doesn't pass the param continues to work unchanged.
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
  p_is_public           boolean default true
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
    source_listing_id, is_public
  ) values (
    v_caller, trim(p_artist_name), trim(p_artwork_title), trim(p_medium),
    p_artwork_category, p_image_path, p_height_in, p_width_in, p_depth_in,
    nullif(trim(coalesce(p_framed_size, '')), ''), p_coa_included,
    v_clean_story,
    nullif(trim(coalesce(p_private_notes, '')), ''),
    p_appraised_value_usd, p_paid_value_usd,
    p_source_listing_id,
    coalesce(p_is_public, true)
  )
  returning id into v_new_id;
  return v_new_id;
end $$;

revoke all on function public.insert_collection_item(text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, uuid, boolean) from public, anon;
grant execute on function public.insert_collection_item(text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. update_collection_item — accept p_is_public
-- ---------------------------------------------------------------------------
-- Null = don't change, true/false = set explicitly. For boolean fields
-- a null sentinel is cleaner than a separate _clear flag.
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
  p_is_public                 boolean default null
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
    is_public           = coalesce(p_is_public, is_public),
    updated_at = now()
  where id = p_item_id;
end $$;

revoke all on function public.update_collection_item(uuid, text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon;
grant execute on function public.update_collection_item(uuid, text, text, text, text, text, numeric, numeric, numeric, text, text, text, text, numeric, numeric, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to authenticated;

-- =============================================================================
-- End of migration 060.
-- =============================================================================
