-- =============================================================================
-- 026_search_established_members.sql
-- =============================================================================
-- Search helper for the reference-request autocomplete in the seller portal.
-- Returns up to N Established Member profiles whose display_name or handle
-- contains the query string (case-insensitive). Filters out:
--   - The caller themselves (you can't reference yourself)
--   - Non-Established users (only is_trusted = true can be a target)
--   - Suspended/banned accounts
--   - Users the caller already has an active (pending or accepted) reference
--     relationship with — so the dropdown never offers a target you can't
--     legally request anyway.
--
-- Result is ordered with exact matches first (exact handle, then exact
-- display name), then prefix matches, then substring matches; alphabetical
-- by display_name as final tiebreaker. Limit capped at 25 server-side to
-- protect against runaway clients.
-- =============================================================================

create or replace function public.search_established_members(
  p_query text,
  p_limit int default 10
)
returns table(
  user_id      uuid,
  display_name text,
  handle       text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_q      text := btrim(coalesce(p_query, ''));
  v_limit  int  := least(coalesce(p_limit, 10), 25);
begin
  if v_caller is null then
    raise exception 'Must be signed in to search members.';
  end if;
  if length(v_q) < 2 then
    return;  -- Too-short queries return zero rows
  end if;

  return query
  select p.user_id, p.display_name, p.handle
    from public.profiles p
   where p.is_trusted = true
     and p.account_status = 'active'
     and p.user_id <> v_caller
     and (
       lower(coalesce(p.display_name, '')) like '%' || lower(v_q) || '%'
       or lower(coalesce(p.handle, ''))    like '%' || lower(v_q) || '%'
     )
     and not exists (
       select 1
         from public.seller_references r
        where r.seller_user_id   = v_caller
          and r.reference_user_id = p.user_id
          and r.status in ('pending', 'accepted')
     )
   order by
     case
       when lower(p.handle)       = lower(v_q)             then 0
       when lower(p.display_name) = lower(v_q)             then 1
       when lower(p.handle)       like lower(v_q) || '%'   then 2
       when lower(p.display_name) like lower(v_q) || '%'   then 3
       else 4
     end,
     p.display_name
   limit v_limit;
end;
$$;

revoke all on function public.search_established_members(text, int) from public;
revoke all on function public.search_established_members(text, int) from anon;
grant execute on function public.search_established_members(text, int) to authenticated;
