-- =============================================================================
-- 051_revoke_authenticated_table_select_grant_columns.sql
-- =============================================================================
-- Fix for the gap discovered after deploying migration 050: the column-level
-- REVOKE on contact_email didn't actually block authenticated users from
-- reading it via direct PostgREST. The reason is migration 016 (line 68)
-- explicitly GRANTed table-level SELECT to the authenticated role. Per
-- Postgres semantics, a table-level grant trumps column-level REVOKEs —
-- if you have SELECT on the table, you have SELECT on every column.
--
-- The fix mirrors what migration 016 already did for anon: REVOKE the
-- table-level grant, then GRANT column-level SELECT on every column
-- EXCEPT contact_email. After this, attempting to read contact_email
-- via a direct REST query returns 403 / permission denied, while every
-- other field continues to work.
--
-- MAINTENANCE NOTE: whenever a new column is added to public.profiles in
-- a future migration, you MUST also add it to the GRANT statement below
-- (or in that migration). Forgetting is non-fatal but breaks features
-- that read the new column — symptom: PostgREST returns 403 on that
-- column for authenticated callers. Pattern:
--
--   alter table public.profiles add column foo text;
--   grant select (foo) on public.profiles to authenticated;
--
-- Column-level grants are intentional friction — better than the
-- alternative of having every new column quietly accessible to anyone
-- with a Supabase auth token.
-- =============================================================================

-- Strip table-level SELECT (added defensively at the end of migration 016).
revoke select on public.profiles from authenticated;

-- Re-grant SELECT one column at a time. Same enumerated list pattern that
-- migration 016 uses for anon. EVERY column on profiles EXCEPT contact_email
-- is listed here.
--
-- Owners read their own contact_email via the get_my_contact_email()
-- SECURITY DEFINER RPC (migration 050). Admins read other users' emails
-- via admin_get_contact_emails(uuid[]) (also migration 050). Edge
-- functions running with the service_role bypass these column grants
-- entirely since service_role is not subject to RLS or column-level
-- access controls.
grant select (
  user_id,
  display_name,
  handle,
  has_contact_email,
  facebook_profile_url,
  location,
  shipping_zip,
  about_text,
  pending_about_text,
  pending_about_at,
  pending_display_name,
  pending_display_name_at,
  preferred_contact,
  is_admin,
  is_trusted,
  is_trusted_locked,
  account_status,
  status_changed_at,
  created_at,
  last_inquiry_seen_at,
  post_presets,
  post_drafts,
  collage_banner_settings,
  tos_accepted_at,
  tos_version
) on public.profiles to authenticated;

-- Verification block: print the post-migration grant state so the run
-- output makes the lockdown visible at a glance.
do $$
declare
  v_authenticated_can_select_email boolean;
begin
  select exists (
    select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'profiles'
        and column_name = 'contact_email'
        and grantee = 'authenticated'
        and privilege_type = 'SELECT'
  ) into v_authenticated_can_select_email;

  if v_authenticated_can_select_email then
    raise warning 'authenticated STILL has SELECT on contact_email — something else re-granted it';
  else
    raise notice 'authenticated correctly does NOT have SELECT on contact_email';
  end if;
end $$;

-- =============================================================================
-- End of migration 051.
-- =============================================================================
