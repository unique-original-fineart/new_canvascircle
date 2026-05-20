-- =============================================================================
-- 024_admin_reset_trusted_lock.sql
-- =============================================================================
-- Companion RPC for migration 023's is_trusted_locked column.
--
-- The admin Trusted toggle in the portal now sets is_trusted_locked = true
-- whenever it's clicked, so any manual decision sticks. When the admin wants
-- to release that lock and let the auto-promotion trigger take over again
-- for a given user, they call this RPC.
--
-- Behavior:
--   1. Clears is_trusted_locked for the target user.
--   2. Immediately calls recompute_user_trusted() so the user is evaluated
--      against the 4+3 criteria right away. If they meet it AND are not
--      currently trusted, they get auto-promoted in this same call. If
--      they're already trusted, the recompute is a no-op (the recompute
--      function short-circuits when is_trusted is already true).
--   3. Returns the user's new is_trusted value so the UI can update.
-- =============================================================================

create or replace function public.admin_reset_trusted_lock(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_trusted boolean;
begin
  if not public.is_admin() then
    raise exception 'Only admins can reset the trusted lock.';
  end if;
  if p_user_id is null then
    raise exception 'A user id is required.';
  end if;

  update public.profiles
     set is_trusted_locked = false
   where user_id = p_user_id;

  -- Recompute may auto-promote if the user meets the 4+3 criteria.
  -- No-op if they're already trusted.
  perform public.recompute_user_trusted(p_user_id);

  select is_trusted into v_new_trusted
    from public.profiles
   where user_id = p_user_id;

  return coalesce(v_new_trusted, false);
end;
$$;

revoke all on function public.admin_reset_trusted_lock(uuid) from public;
revoke all on function public.admin_reset_trusted_lock(uuid) from anon;
grant execute on function public.admin_reset_trusted_lock(uuid) to authenticated;
