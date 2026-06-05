-- =============================================================================
-- 050_revoke_contact_email_column.sql
-- =============================================================================
-- Phase 2 of the email-anti-scraping lockdown (Phase 1 was migration 049 +
-- cc-v172). This migration closes the remaining hole: even though our HTML
-- pages no longer SELECT contact_email, the Supabase PostgREST endpoint is
-- still open to any authenticated client running a direct query like:
--
--   GET /rest/v1/profiles?select=contact_email,user_id
--
-- RLS controls which ROWS get returned but not which COLUMNS. By default
-- the `authenticated` role has SELECT on every column of every table in
-- the public schema. So a determined scraper could grab any signed-in
-- user's token and harvest every email in seconds, totally bypassing
-- the page-level refactor.
--
-- The fix is column-level: REVOKE SELECT on the contact_email column
-- from the authenticated + anon roles. After this migration, any
-- attempt to include contact_email in a SELECT (via PostgREST or via
-- a SQL query running as authenticated) returns a permission-denied
-- error. Edge functions running with the service_role bypass this
-- since their role grants are unaffected.
--
-- Legitimate access paths that still need email data:
--   * The OWNER reading their own contact_email (e.g., portal Profile
--     tab "your email is X" display, listing.html's Reply-To attribution)
--   * Admins viewing emails in moderation queues
--
-- These get SECURITY DEFINER helper RPCs that bypass the REVOKE by
-- running as the function owner (postgres). The functions internally
-- gate access: owner-self-read RPC checks auth.uid() = user_id; admin
-- RPC checks public.is_admin().
--
-- After this lands, the client-side refactor (lib/supabase.js helpers +
-- portal/index.html call-site updates) is what makes everything keep
-- working. The migration alone would just break the Profile tab and
-- admin views, so coordinate deploy: migration AFTER the code is live.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. REVOKE column-level SELECT on contact_email
-- ---------------------------------------------------------------------------
-- This is the structural fix. Anything else is window dressing.
revoke select (contact_email) on public.profiles from authenticated;
revoke select (contact_email) on public.profiles from anon;

-- ---------------------------------------------------------------------------
-- 2. get_my_contact_email — owner-self-read helper
-- ---------------------------------------------------------------------------
-- Returns the calling user's own contact_email. Runs as SECURITY DEFINER
-- so it sees through the column revoke. The body checks auth.uid() is
-- set, then selects the email for that exact row, returning null if no
-- profile row exists yet (shouldn't happen in normal flow but defensive).
create or replace function public.get_my_contact_email()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
begin
  if auth.uid() is null then
    return null;
  end if;
  select contact_email into v_email
    from public.profiles
    where user_id = auth.uid()
    limit 1;
  return v_email;
end $$;

-- Anon doesn't have a uid so the RPC is meaningless to them, but we
-- restrict execution anyway since there's no scenario where anon needs it.
revoke all on function public.get_my_contact_email() from public;
revoke all on function public.get_my_contact_email() from anon;
grant execute on function public.get_my_contact_email() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_get_contact_emails — batch admin lookup helper
-- ---------------------------------------------------------------------------
-- Returns a table of (user_id, contact_email) rows for the requested
-- user_ids. Only admins (per public.is_admin()) can call. Used by
-- admin moderation queues (verification panel, reported listings,
-- pending listings, etc.) which need to display seller/reporter emails.
-- Batch shape (uuid[] input → table output) so the admin UI can fetch
-- a whole page's worth of emails in one round-trip instead of one
-- RPC per row.
create or replace function public.admin_get_contact_emails(p_user_ids uuid[])
returns table (user_id uuid, contact_email text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'admin_get_contact_emails requires admin privileges';
  end if;
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return;
  end if;
  return query
    select p.user_id, p.contact_email
      from public.profiles p
      where p.user_id = any(p_user_ids);
end $$;

revoke all on function public.admin_get_contact_emails(uuid[]) from public;
revoke all on function public.admin_get_contact_emails(uuid[]) from anon;
grant execute on function public.admin_get_contact_emails(uuid[]) to authenticated;

-- =============================================================================
-- End of migration 050.
-- =============================================================================
