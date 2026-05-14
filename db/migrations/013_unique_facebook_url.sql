-- =============================================================================
-- 013_unique_facebook_url.sql
-- =============================================================================
-- Enforce one-account-per-Facebook-profile. Different surface forms of the
-- same Facebook URL (http vs https, www vs m, trailing slashes, tracking
-- params) all normalize to the same canonical key. The unique index runs on
-- the normalized form so users can't bypass it by varying the URL shape.
--
-- Email uniqueness is already enforced upstream by Supabase Auth on
-- auth.users.email, which the handle_new_user trigger mirrors into
-- profiles.contact_email — no extra work needed there.
-- =============================================================================

-- 1. Normalization function — IMMUTABLE so it can back an index.
create or replace function public.normalize_fb_url(raw text)
returns text
language sql
immutable
as $$
  select case
    when raw is null then null
    when length(btrim(raw)) = 0 then null
    else
      -- Strip protocol, common subdomain prefixes, trailing slashes, common
      -- tracking params, and lowercase the whole thing. Keep `profile.php?id=`
      -- and similar identity-bearing query strings intact.
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                lower(btrim(raw)),
                '^https?://', ''                       -- drop scheme
              ),
              '^(www\.|m\.|mbasic\.|touch\.|l\.)', ''  -- drop common subdomains
            ),
            '[?&](fbclid|ref|mibextid|_rdr|_rdc|locale|sk)=[^&#]*', ''  -- strip tracking params
          ),
          '[?&]$', ''                                  -- clean a dangling ? or &
        ),
        '/+$', ''                                      -- drop trailing slashes
      )
  end
$$;

-- 2. Unique partial index — only enforced on rows that actually have a URL.
-- Profiles with NULL facebook_profile_url stay unconstrained.
create unique index if not exists profiles_facebook_url_normalized_unique
  on public.profiles (public.normalize_fb_url(facebook_profile_url))
  where facebook_profile_url is not null;

-- 3. Sanity check that no existing duplicates would block the index. If this
-- raises, you'll need to resolve collisions in the data first. This is a
-- diagnostic SELECT, not an enforced check — it's only here to flag problems
-- during the migration run.
do $$
declare
  collision_count int;
begin
  select count(*) into collision_count
  from (
    select public.normalize_fb_url(facebook_profile_url) as key
    from public.profiles
    where facebook_profile_url is not null
    group by 1
    having count(*) > 1
  ) c;
  if collision_count > 0 then
    raise warning 'Migration 013: % Facebook URL collisions exist. Index will fail. Resolve duplicates first.', collision_count;
  end if;
end $$;
