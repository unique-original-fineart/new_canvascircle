-- =============================================================================
-- 069_admin_collection_audit.sql
-- =============================================================================
-- Admin-only RPCs for auditing the entire collection_items population
-- (including private items / private profiles) and force-deleting
-- problematic pieces.
--
-- Why this exists (Layer 1 of the prohibited-content moderation
-- strategy, see [[private-collection-content-moderation]]):
--   Non-Established members can post collection_items freely without
--   admin approval — those pieces never reach a public page, but they
--   ARE stored in our Supabase Storage bucket under our account. A
--   bad actor could use this as cheap image hosting for prohibited
--   content. Without admin visibility into PRIVATE items, the only
--   moderation path is reports against PUBLIC items, which misses the
--   threat.
--
--   These RPCs give the solo admin a way to spot-check private content
--   and act on it. Per-item deletion is destructive but recoverable
--   via the nightly R2 backup (see r2-backup-system memory), so the
--   audit trail of "admin removed this piece" is the R2 mirror.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. admin_get_all_collection_items
-- ---------------------------------------------------------------------------
-- Returns EVERY collection_items row, joined with the owner's profile.
-- Ignores is_public + collection_is_public + is_trusted gates that
-- ordinarily limit visibility. Admin-only via the is_admin() check.
--
-- Returned columns mirror what the admin queue needs: enough to render
-- a thumb + artist/title + owner + visibility + reported-status. We
-- also include public_story so the admin can read the seller-authored
-- text (a common vector for prohibited language).
create or replace function public.admin_get_all_collection_items(
  p_limit  integer default 200,
  p_offset integer default 0,
  p_search text    default null  -- ILIKE on artist OR title OR owner name
) returns table (
  id                  uuid,
  owner_id            uuid,
  owner_name          text,
  owner_handle        text,
  owner_account_status text,
  owner_is_trusted    boolean,
  owner_collection_is_public boolean,
  artist_name         text,
  artwork_title       text,
  medium              text,
  artwork_category    text,
  image_path          text,
  is_public           boolean,
  public_story        text,
  created_at          timestamptz,
  open_report_count   integer
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
    ci.id,
    ci.owner_id,
    p.display_name             as owner_name,
    p.handle                   as owner_handle,
    p.account_status           as owner_account_status,
    p.is_trusted               as owner_is_trusted,
    p.collection_is_public     as owner_collection_is_public,
    ci.artist_name,
    ci.artwork_title,
    ci.medium,
    ci.artwork_category,
    ci.image_path,
    ci.is_public,
    ci.public_story,
    ci.created_at,
    coalesce(
      (select count(*)::integer
         from public.collection_item_reports cir
         where cir.collection_item_id = ci.id and cir.status = 'open'),
      0
    ) as open_report_count
  from public.collection_items ci
  left join public.profiles p on p.user_id = ci.owner_id
  where p_search is null
     or ci.artist_name   ilike '%' || p_search || '%'
     or ci.artwork_title ilike '%' || p_search || '%'
     or p.display_name   ilike '%' || p_search || '%'
     or p.handle         ilike '%' || p_search || '%'
  order by ci.created_at desc
  limit  greatest(1, least(p_limit, 500))
  offset greatest(0, p_offset);
end;
$$;

revoke all on function public.admin_get_all_collection_items(integer, integer, text) from public, anon;
grant execute on function public.admin_get_all_collection_items(integer, integer, text) to authenticated;

comment on function public.admin_get_all_collection_items(integer, integer, text) is
  'Admin audit: lists ALL collection_items regardless of public/private gates. Paginated, optional ILIKE search on artist/title/owner. See 069_admin_collection_audit.sql.';

-- ---------------------------------------------------------------------------
-- 2. admin_delete_collection_item
-- ---------------------------------------------------------------------------
-- Admin force-delete a Collection piece. The owner's normal
-- delete_collection_item RPC (see 057) only lets the owner delete
-- their own pieces. This one lets the admin delete anyone's piece.
--
-- Resolves any open reports tied to this piece in the same transaction
-- so the admin queue stays clean. The reason text the admin enters is
-- written to those reports as resolution_note so other admins (or
-- future-self) can see what happened.
--
-- The storage object is NOT removed here — that requires a Supabase
-- Storage API call from the client. The JS caller of this RPC should
-- follow the RPC with a `supabase.storage.from('collection-images').remove([path])`.
-- If the storage cleanup fails, the DB row is still gone (the bigger
-- safety win) and the orphaned image is just dead bytes until cleaned
-- up manually. The nightly R2 backup mirror retains a copy regardless.
create or replace function public.admin_delete_collection_item(
  p_item_id uuid,
  p_reason  text
) returns table (
  image_path text  -- echoed back so the caller can remove the storage object
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_path text;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason required';
  end if;

  -- Resolve open reports against this piece in the same transaction.
  update public.collection_item_reports
     set status          = 'resolved',
         resolved_by     = auth.uid(),
         resolved_at     = now(),
         resolution_note = 'piece removed by admin: ' || trim(p_reason)
   where collection_item_id = p_item_id and status = 'open';

  -- Grab the image path before deleting so the caller can clean up storage.
  select ci.image_path into v_path from public.collection_items ci where ci.id = p_item_id;
  if v_path is null then
    return;  -- idempotent: item already gone
  end if;

  delete from public.collection_items where id = p_item_id;

  return query select v_path;
end;
$$;

revoke all on function public.admin_delete_collection_item(uuid, text) from public, anon;
grant execute on function public.admin_delete_collection_item(uuid, text) to authenticated;

comment on function public.admin_delete_collection_item(uuid, text) is
  'Admin force-delete a Collection piece + auto-resolve any open reports. Returns image_path so caller can remove the storage object. See 069_admin_collection_audit.sql.';
