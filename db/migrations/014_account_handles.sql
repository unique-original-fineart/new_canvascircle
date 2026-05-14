-- =============================================================================
-- 014_account_handles.sql
-- =============================================================================
-- Adds a unique @handle per account. Display name can still collide (two
-- users can both be "John Smith"), but the handle disambiguates them — much
-- like Twitter/Bluesky/Reddit, where display name is the human label and the
-- handle is the technical identifier.
--
-- Format: 3-20 chars, must start with a letter, then letters/digits/
-- underscores only. Stored as-typed (preserves the user's preferred casing)
-- but uniqueness is enforced case-insensitively, so "JaneSmith" and
-- "janesmith" collide.
--
-- Handles are locked once set — they are the technical identifier that
-- buyers and admins will use to refer to a specific account. The seller
-- portal will not expose any "change my handle" UI; admins can change via
-- SQL only if absolutely necessary.
--
-- Step order matters: the column has to exist before any function or index
-- can reference it. SQL-language functions resolve column references at
-- CREATE time, so creating is_handle_available before adding the column
-- would fail with "column handle does not exist". Same for the index.
-- =============================================================================

-- 1. Format validator. Pure function — no column references — so it can
-- be defined any time.
create or replace function public.is_valid_handle(h text)
returns boolean
language sql
immutable
as $$
  select h is not null
     and length(h) between 3 and 20
     and h ~ '^[A-Za-z][A-Za-z0-9_]{2,19}$'
$$;

-- 2. Add the handle column. Nullable for backward compatibility — any rows
-- predating this migration stay valid until they're back-filled; new signups
-- via the updated trigger always carry a value.
alter table public.profiles
  add column if not exists handle text
    check (handle is null or public.is_valid_handle(handle));

-- 3. Unique partial index on lower(handle). NULL handles are excluded so
-- pre-migration rows don't all collide with each other.
create unique index if not exists profiles_handle_lower_unique
  on public.profiles (lower(handle))
  where handle is not null;

-- 4. Availability check — returns true if the (case-insensitive) handle is
-- free to claim, false if taken. SECURITY DEFINER so the anonymous signup
-- form can probe without a session; it's read-only and reveals nothing
-- sensitive (only whether a handle exists, which a signup error message
-- would expose anyway).
--
-- Must be defined AFTER the column exists so the column reference resolves.
create or replace function public.is_handle_available(h text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_valid_handle(h)
     and not exists (
       select 1 from public.profiles
       where lower(handle) = lower(h)
     )
$$;
grant execute on function public.is_handle_available(text) to anon, authenticated;

-- 5. Teach handle_new_user() to read the handle from raw_user_meta_data and
-- store it on the new profiles row. Preserves all prior behavior
-- (display_name fallback to email prefix, contact_email mirror,
-- tos_accepted_at, tos_version).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    user_id, display_name, contact_email, handle, tos_accepted_at, tos_version
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email,
    nullif(new.raw_user_meta_data->>'handle', ''),
    nullif(new.raw_user_meta_data->>'tos_accepted_at', '')::timestamptz,
    nullif(new.raw_user_meta_data->>'tos_version', '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
