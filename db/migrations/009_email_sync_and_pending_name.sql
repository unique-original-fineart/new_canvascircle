-- =============================================================================
-- 009_email_sync_and_pending_name.sql
-- =============================================================================
-- (a) Auto-sync profiles.contact_email from auth.users.email so there's only
--     ONE source of truth for the user's email. Users change their email via
--     the Supabase "Change Email Address" auth flow; this trigger then
--     propagates the new value to profiles.contact_email automatically.
--
-- (b) Add pending_display_name (text) + pending_display_name_at (timestamptz)
--     to profiles. The user requests a name change from their portal; the
--     admin approves/rejects from the Sellers admin panel. On approval the
--     pending value moves into display_name and the pending fields clear.
-- =============================================================================

-- ----- (a) Email sync trigger -----
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Fire only when the email actually changes.
  if NEW.email is distinct from OLD.email then
    update public.profiles
       set contact_email = NEW.email
     where user_id = NEW.id;
  end if;
  return NEW;
end;
$$;

drop trigger if exists on_auth_user_email_change on auth.users;
create trigger on_auth_user_email_change
  after update of email on auth.users
  for each row
  execute function public.handle_user_email_change();

-- Backfill: ensure every existing profiles.contact_email matches the current
-- auth.users.email value (defensive — if anyone had a stale separate value).
update public.profiles p
   set contact_email = u.email
  from auth.users u
 where p.user_id = u.id
   and (p.contact_email is null or p.contact_email is distinct from u.email);

-- ----- (b) Pending display name -----
alter table public.profiles
  add column if not exists pending_display_name    text,
  add column if not exists pending_display_name_at timestamptz;

-- RLS: users can write their own pending_display_name (no extra policy
-- needed — profiles_update_self already covers "user can update own row").
-- Admins use profiles_update_admin to copy pending into display_name.

-- Optional convenience index for admins to find pending requests quickly.
create index if not exists profiles_pending_name_idx
  on public.profiles (pending_display_name_at)
  where pending_display_name is not null;
