-- =============================================================================
-- 008_banned_credentials_and_reject_reason.sql
-- =============================================================================
-- Two related admin/moderation features:
--   (a) banned_credentials denylist  — when an admin bans an account, the
--       email address (always) and Facebook URL (if present) are recorded
--       here so the same email/FB can't be used to create a fresh account
--       or change a profile.
--   (b) listings.moderation_reason   — admin's note explaining why a listing
--       was rejected. Shown to the seller in their listings dashboard so
--       they know what to fix.
-- =============================================================================

-- ----- (a) banned_credentials -----
create table if not exists public.banned_credentials (
  id                bigserial primary key,
  email             text,
  facebook_profile_url text,
  banned_user_id    uuid references auth.users(id) on delete set null,
  banned_at         timestamptz not null default now(),
  reason            text,
  -- Either email or FB must be present (or both); a row with neither is junk.
  constraint banned_credentials_at_least_one
    check (email is not null or facebook_profile_url is not null)
);

-- Case-insensitive uniqueness so different casings of the same email/FB
-- can't slip through. NULLs are allowed (the field is optional).
create unique index if not exists banned_credentials_email_unique
  on public.banned_credentials (lower(email))
  where email is not null;

create unique index if not exists banned_credentials_fb_unique
  on public.banned_credentials (lower(facebook_profile_url))
  where facebook_profile_url is not null;

alter table public.banned_credentials enable row level security;

-- Only admins can read or write the denylist. The signup-check uses a
-- security-definer function (below) so anonymous signups can match against
-- the table without granting select to the public.
drop policy if exists banned_credentials_admin_all on public.banned_credentials;
create policy banned_credentials_admin_all
  on public.banned_credentials
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- Public-callable helper: returns true if the given email OR fb URL is in
-- the denylist. Security definer + locked search_path so unauthenticated
-- callers can check without seeing the contents of the table.
create or replace function public.is_banned_credential(
  p_email text,
  p_facebook_url text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
      from public.banned_credentials
     where (p_email          is not null and lower(email)               = lower(p_email))
        or (p_facebook_url   is not null and lower(facebook_profile_url) = lower(p_facebook_url))
  );
end;
$$;

grant execute on function public.is_banned_credential(text, text) to anon, authenticated;

-- When an admin sets account_status='banned' on a profile, snapshot the
-- email + FB into banned_credentials so the same person can't re-signup
-- under the same identity. Trigger runs as security-definer (function below
-- is owner-rights) so it can insert regardless of RLS.
create or replace function public.snapshot_banned_credentials()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if NEW.account_status = 'banned'
     and (OLD.account_status is distinct from 'banned')
  then
    -- Look up the auth email for this user.
    select u.email into v_email
      from auth.users u
     where u.id = NEW.user_id;

    -- Insert email + fb URL (whichever are present). on conflict do nothing
    -- handles repeat-ban / re-ban scenarios harmlessly.
    if v_email is not null then
      insert into public.banned_credentials (email, banned_user_id, reason)
      values (v_email, NEW.user_id, 'account banned')
      on conflict do nothing;
    end if;

    if NEW.facebook_profile_url is not null then
      insert into public.banned_credentials (facebook_profile_url, banned_user_id, reason)
      values (NEW.facebook_profile_url, NEW.user_id, 'account banned')
      on conflict do nothing;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists profiles_snapshot_banned on public.profiles;
create trigger profiles_snapshot_banned
  after update of account_status on public.profiles
  for each row
  execute function public.snapshot_banned_credentials();

-- ----- (b) listing rejection reason -----
alter table public.listings
  add column if not exists moderation_reason text,
  add column if not exists moderation_reason_at timestamptz;
