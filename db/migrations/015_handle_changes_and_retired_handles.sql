-- =============================================================================
-- 015_handle_changes_and_retired_handles.sql
-- =============================================================================
-- Lets users set or change their @handle from the Profile tab. Two things
-- matter for safety:
--
-- 1) Old handles are *permanently retired* once vacated. No one — including
--    the previous owner — can ever claim a retired handle again. This is the
--    sole defense against impersonation: a buyer who saved a listing under
--    @johnsmith last week can't be confused by a new user taking @johnsmith
--    this week.
--
-- 2) The set/change operation is atomic via a SECURITY DEFINER RPC. Without
--    that, a race between availability-check and update could let two users
--    grab the same handle in the same instant.
--
-- This migration also accommodates pre-existing accounts that signed up
-- before migration 014 — their handle is NULL, and change_my_handle() treats
-- the initial set the same as a change (just nothing to retire).
-- =============================================================================

-- 1. The retirement registry. PK on handle (case-stored) plus a partial
-- functional unique index on lower(handle) gives us O(1) case-insensitive
-- lookups for is_handle_available.
create table if not exists public.retired_handles (
  handle           text primary key
                     check (length(handle) between 3 and 20),
  retired_at       timestamptz not null default now(),
  formerly_user_id uuid references auth.users(id) on delete set null
);

create unique index if not exists retired_handles_lower_unique
  on public.retired_handles (lower(handle));

-- RLS: everyone can read (the "is this handle taken" lookup runs anon), no
-- one can write directly — only the change_my_handle RPC writes.
alter table public.retired_handles enable row level security;

drop policy if exists retired_handles_read_all on public.retired_handles;
create policy retired_handles_read_all
  on public.retired_handles for select
  using (true);

-- 2. Update is_handle_available to also exclude retired handles. Replaces
-- the version from migration 014.
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
     and not exists (
       select 1 from public.retired_handles
       where lower(handle) = lower(h)
     )
$$;
grant execute on function public.is_handle_available(text) to anon, authenticated;

-- 3. The atomic set-or-change operation. Locks the caller's profile row,
-- re-checks availability inside the lock, retires the old handle (if any),
-- and updates the new one. Returns the new handle on success; raises a
-- descriptive exception on failure so the UI can show a clean message.
create or replace function public.change_my_handle(new_handle text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid := auth.uid();
  v_old_handle text;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to change your handle.';
  end if;

  if not public.is_valid_handle(new_handle) then
    raise exception 'Handle must be 3-20 characters, start with a letter, and contain only letters, digits, or underscores.';
  end if;

  -- Row-lock the caller's profile so a concurrent change can't slip in.
  select handle into v_old_handle
    from public.profiles
    where user_id = v_user_id
    for update;

  -- No-op if they're "changing" to the same handle. Still validates that
  -- the input is well-formed; just don't churn the retired_handles table.
  if v_old_handle is not null and lower(v_old_handle) = lower(new_handle) then
    return v_old_handle;
  end if;

  -- Case-insensitive collision check against live profiles (excluding self).
  if exists (
    select 1 from public.profiles
    where lower(handle) = lower(new_handle)
      and user_id <> v_user_id
  ) then
    raise exception 'That handle is already taken.';
  end if;

  -- Case-insensitive collision check against retired handles.
  if exists (
    select 1 from public.retired_handles
    where lower(handle) = lower(new_handle)
  ) then
    raise exception 'That handle was previously used and has been permanently retired. Please pick a different one.';
  end if;

  -- If they had an old handle, retire it before flipping to the new one.
  if v_old_handle is not null then
    insert into public.retired_handles (handle, formerly_user_id)
    values (v_old_handle, v_user_id)
    on conflict (handle) do nothing;  -- defensive; PK should make this impossible
  end if;

  update public.profiles
    set handle = new_handle
    where user_id = v_user_id;

  return new_handle;
end;
$$;
grant execute on function public.change_my_handle(text) to authenticated;
