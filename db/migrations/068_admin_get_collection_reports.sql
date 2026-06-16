-- =============================================================================
-- 068_admin_get_collection_reports.sql
-- =============================================================================
-- Admin-only RPC that returns open collection_item_reports joined with
-- the underlying collection_items + owner profile + reporter profile.
--
-- Why an RPC instead of a PostgREST embedded select:
--   The collection_items table revokes SELECT from authenticated /
--   anon / public (see 057_collections.sql lines 100-101). All client
--   access goes through SECURITY DEFINER RPCs by design (the
--   "no-direct-table-access" posture protects private collection
--   data even if an RLS policy is misconfigured). So even an admin
--   client doing PostgREST `select(collection_items(...))` gets
--   nothing back from the join.
--
-- This RPC bypasses that restriction explicitly for admins via the
-- existing public.is_admin() check, returning flat rows the admin
-- queue UI can render without needing additional fetches.
--
-- Returned rows also include is_public so the admin can see at a
-- glance whether the reported piece is currently public (visitor-
-- reportable) or has been flipped private since the report landed.
-- =============================================================================

create or replace function public.admin_get_collection_reports()
returns table (
  id                  bigint,
  collection_item_id  uuid,
  reason              text,
  created_at          timestamptz,
  reporter_id         uuid,
  reporter_name       text,
  reporter_handle     text,
  item_artist_name    text,
  item_artwork_title  text,
  item_image_path     text,
  item_is_public      boolean,
  item_public_story   text,
  owner_id            uuid,
  owner_name          text,
  owner_handle        text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  return query
  select
    cir.id,
    cir.collection_item_id,
    cir.reason,
    cir.created_at,
    cir.reporter_id,
    rp.display_name as reporter_name,
    rp.handle       as reporter_handle,
    ci.artist_name,
    ci.artwork_title,
    ci.image_path,
    ci.is_public,
    ci.public_story,
    ci.owner_id,
    op.display_name as owner_name,
    op.handle       as owner_handle
  from public.collection_item_reports cir
  left join public.collection_items ci on ci.id = cir.collection_item_id
  left join public.profiles op on op.user_id = ci.owner_id
  left join public.profiles rp on rp.user_id = cir.reporter_id
  where cir.status = 'open'
  order by cir.created_at desc;
end;
$$;

revoke all on function public.admin_get_collection_reports() from public, anon;
grant execute on function public.admin_get_collection_reports() to authenticated;

comment on function public.admin_get_collection_reports() is
  'Admin-only fetch of open Collection piece reports with joined collection_items + owner/reporter profiles. See 068_admin_get_collection_reports.sql.';
