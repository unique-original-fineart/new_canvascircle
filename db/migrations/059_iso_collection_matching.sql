-- =============================================================================
-- 059_iso_collection_matching.sql
-- =============================================================================
-- Collections Chunk C — ISO matching.
--
-- When a buyer posts an ISO listing ("In Search Of: Britto 'Spirit of
-- Adventure'"), we want to surface that to Established collectors who
-- have a matching piece in their Collection. Three RPCs power this:
--
--   1. find_iso_collection_matches — INTERNAL. Returns the array of
--      user_ids the iso-match-fanout edge fn should push to. Locked
--      down to service_role + the ISO lister themselves (for testing).
--      Excludes the ISO lister so they don't get notified about their
--      own search.
--
--   2. get_iso_match_count — PUBLIC. Returns an aggregate count for
--      the "N collectors in the community own this piece" line on the
--      ISO listing detail page. Identities never leak. Anyone (including
--      anon) can call.
--
--   3. viewer_has_collection_match — AUTHENTICATED. Returns a boolean
--      indicating whether the calling user's own Collection contains a
--      matching piece. Used to show the "You have this piece" banner to
--      the collector when they're viewing the ISO listing.
--
-- Match logic (shared by all three):
--   * iso.artist_name (if set): case-insensitive SUBSTRING match against
--     collection_items.artist_name — catches "Britto" matching "Romero
--     Britto" both ways. Park West artist names are recognizable enough
--     that false positives are rare in practice.
--   * iso.artwork_title (if set): case-insensitive EXACT match against
--     collection_items.artwork_title — stricter than artist matching
--     because titles are specific identifiers.
--   * AT LEAST ONE of artist_name or artwork_title must be present on
--     the ISO listing (the insert flow enforces this), otherwise the
--     match would be unbounded.
--   * Owner must be Established (is_trusted=true) AND active. Non-
--     Established collectors don't receive ISO match pushes for now —
--     they probably aren't ready to sell, and we want the buyer-seller
--     warm intro to land with people who have proven track records.
--   * Exclude the ISO lister themselves.
--
-- Constraints honored:
--   * [[preserve-seller-pricing-power]] — no price data is in scope;
--     ISO matching is purely artist+title.
--   * [[anonymous-privacy-ui-only]] — identities never leak to the ISO
--     lister or any third party; only an aggregate count.
--   * [[collectors-only-policy]] — matching includes all Established
--     collectors regardless of whether they've ever listed a piece.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. _match_iso_to_collection — INTERNAL match predicate (helper)
-- ---------------------------------------------------------------------------
-- Returns true if a collection_items row would be a match for the given
-- ISO listing's artist/title. Extracted as a function so all three RPCs
-- below share the exact same matching semantics; if we ever loosen or
-- tighten the algorithm, it only changes here.
create or replace function public._match_iso_to_collection(
  p_iso_artist text,
  p_iso_title  text,
  p_ci_artist  text,
  p_ci_title   text
) returns boolean
language sql
immutable
as $$
  select
    case
      when coalesce(trim(p_iso_artist), '') = '' and coalesce(trim(p_iso_title), '') = '' then false
      else
        (coalesce(trim(p_iso_artist), '') = ''
          or p_ci_artist ilike '%' || trim(p_iso_artist) || '%')
        and
        (coalesce(trim(p_iso_title), '') = ''
          or lower(trim(p_ci_title)) = lower(trim(p_iso_title)))
    end;
$$;

revoke all on function public._match_iso_to_collection(text, text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. find_iso_collection_matches — INTERNAL (for edge fn fanout)
-- ---------------------------------------------------------------------------
-- Returns the array of distinct user_ids that match this ISO listing.
-- Filters to (a) Established + active accounts, (b) excludes the ISO
-- lister themselves. Only called by iso-match-fanout edge fn (service-
-- role) and by the ISO lister for inline testing.
create or replace function public.find_iso_collection_matches(
  p_iso_listing_id uuid
) returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller      uuid := auth.uid();
  v_iso         public.listings%rowtype;
  v_matches     uuid[];
begin
  select * into v_iso from public.listings where listing_id = p_iso_listing_id;
  if v_iso.listing_id is null or v_iso.listing_type <> 'iso' then
    return array[]::uuid[];
  end if;
  -- Gate: only the ISO lister or service-role (auth.uid() is null when
  -- called via service-role JWT) can read identity-level matches.
  -- service_role bypass: auth.uid() returns null for service_role.
  if v_caller is not null and v_caller <> v_iso.seller_id and not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select coalesce(array_agg(distinct ci.owner_id), array[]::uuid[])
    into v_matches
    from public.collection_items ci
    join public.profiles p on p.user_id = ci.owner_id
    where p.is_trusted = true
      and p.account_status = 'active'
      and ci.owner_id <> v_iso.seller_id
      and public._match_iso_to_collection(
        v_iso.artist_name, v_iso.artwork_title,
        ci.artist_name,    ci.artwork_title
      );
  return v_matches;
end $$;

revoke all on function public.find_iso_collection_matches(uuid) from public, anon;
grant execute on function public.find_iso_collection_matches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. get_iso_match_count — PUBLIC (aggregate count for ISO listing page)
-- ---------------------------------------------------------------------------
-- Returns the number of distinct Established collectors whose Collection
-- contains a matching piece. Used for the "N collectors in the community
-- own this piece" line on the listing detail page. NEVER returns
-- identities — only the count. Safe to call from any role including anon.
create or replace function public.get_iso_match_count(
  p_iso_listing_id uuid
) returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_iso     public.listings%rowtype;
  v_count   integer;
begin
  select * into v_iso from public.listings where listing_id = p_iso_listing_id;
  if v_iso.listing_id is null or v_iso.listing_type <> 'iso' then
    return 0;
  end if;
  select count(distinct ci.owner_id)
    into v_count
    from public.collection_items ci
    join public.profiles p on p.user_id = ci.owner_id
    where p.is_trusted = true
      and p.account_status = 'active'
      and ci.owner_id <> v_iso.seller_id
      and public._match_iso_to_collection(
        v_iso.artist_name, v_iso.artwork_title,
        ci.artist_name,    ci.artwork_title
      );
  return coalesce(v_count, 0);
end $$;

revoke all on function public.get_iso_match_count(uuid) from public;
grant execute on function public.get_iso_match_count(uuid) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 4. viewer_has_collection_match — AUTHENTICATED (collector self-check)
-- ---------------------------------------------------------------------------
-- Returns true if the calling user has at least one Collection item that
-- matches this ISO listing. Used to show the "You have this piece in
-- your Collection" banner to the matched collector. Does NOT require
-- is_trusted (we want collectors at any tier to see they're matched —
-- the trust gate only governs the push notification fanout, which is
-- a discoverability concern, not a privacy concern).
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
  -- The ISO lister never has a "you have this piece" match against
  -- their own listing (they're the one looking, not selling).
  if v_iso.seller_id = v_caller then return false; end if;

  select exists (
    select 1 from public.collection_items ci
    where ci.owner_id = v_caller
      and public._match_iso_to_collection(
        v_iso.artist_name, v_iso.artwork_title,
        ci.artist_name,    ci.artwork_title
      )
  ) into v_hit;
  return coalesce(v_hit, false);
end $$;

revoke all on function public.viewer_has_collection_match(uuid) from public, anon;
grant execute on function public.viewer_has_collection_match(uuid) to authenticated;

-- =============================================================================
-- End of migration 059.
-- =============================================================================
