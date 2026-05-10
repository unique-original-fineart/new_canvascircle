-- =============================================================================
-- 007_tos_acceptance.sql
-- =============================================================================
-- Track Terms of Use acceptance per user.
--   - Adds tos_accepted_at (timestamptz) and tos_version (text) to profiles.
--   - Updates handle_new_user() so signups carry their acceptance into the row.
-- The signup form now requires a checkbox; the client passes the timestamp +
-- version through supabase.auth.signUp({ options: { data: { ... } } }), which
-- arrives here in raw_user_meta_data.
-- =============================================================================

alter table public.profiles
  add column if not exists tos_accepted_at timestamptz,
  add column if not exists tos_version     text;

-- Recreate handle_new_user() to also persist tos_accepted_at + tos_version
-- when present on the signup metadata. Backwards compatible: if the metadata
-- keys are missing (old client, server-side admin invite), the columns stay
-- null and nothing breaks.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    user_id, display_name, contact_email, tos_accepted_at, tos_version
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email,
    nullif(new.raw_user_meta_data->>'tos_accepted_at', '')::timestamptz,
    nullif(new.raw_user_meta_data->>'tos_version', '')
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
