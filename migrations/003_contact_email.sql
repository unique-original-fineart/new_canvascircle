-- =============================================================================
-- Migration 003 — profiles.contact_email + new-user trigger update
-- =============================================================================
-- Apply ONCE in the Supabase SQL editor.
--
-- Purpose: expose a per-seller contact email so the listing detail page can
-- render an "Email Seller" mailto: link without buyers having to copy-paste.
--
-- Behavior:
--   - Adds profiles.contact_email (text, nullable). Sellers may clear it later
--     if they don't want their email exposed via the catalog.
--   - Backfills it from auth.users.email for existing rows.
--   - Updates handle_new_user() so new signups get their email pre-populated.
-- =============================================================================

alter table public.profiles
  add column if not exists contact_email text;

update public.profiles p
   set contact_email = u.email
  from auth.users u
 where p.user_id = u.id
   and p.contact_email is null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name, contact_email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;
