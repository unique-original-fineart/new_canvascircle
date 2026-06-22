-- =============================================================================
-- 072_moderation_queue_rpcs.sql
-- =============================================================================
-- Admin-facing RPCs for the pending-image moderation queue (Layer 2 of
-- the prohibited-content moderation strategy; see migration 071) PLUS
-- an updated get_public_collection that excludes pieces whose latest
-- image scan is still pending admin review.
--
-- Three new admin RPCs:
--   * admin_get_pending_moderation: list all pending rows with joined
--     piece + owner data so the admin queue can render rich rows.
--   * admin_approve_moderation: admin says "this is fine, publish"
--     → verdict flips to 'approved', the piece becomes publicly visible
--     again (or stays visible for edit flows).
--   * admin_reject_moderation: admin says "this violates ToS" → the
--     piece is deleted via the existing tombstone path so the owner
--     sees a banner explaining what happened; verdict flips to
--     'rejected'.
--
-- The public-surface filter on get_public_collection is the load-
-- bearing safety net: until admin reviews, the piece is invisible to
-- other users on the public Collection page even if all the
-- public/private flags say it should be visible. Owner sees it
-- normally in their portal — they own it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. admin_get_pending_moderation
-- ---------------------------------------------------------------------------
-- Joins moderation_flags (verdict='pending') with collection_items via
-- either the FK (set on edit-flow uploads) OR storage_path matching
-- (set on new-item uploads where the FK couldn't be populated upfront —
-- see cc-v223 fix). Either way the admin sees the row + the underlying
-- piece + owner profile + Sightengine reason.
create or replace function public.admin_get_pending_moderation()
returns table (
  flag_id            uuid,
  user_id            uuid,
  owner_name         text,
  owner_handle       text,
  owner_account_status text,
  bucket             text,
  storage_path       text,
  reason             text,
  scores             jsonb,
  csam_detected      boolean,
  created_at         timestamptz,
  collection_item_id uuid,
  artist_name        text,
  artwork_title      text,
  is_public          boolean,
  public_story       text
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
    mf.id                       as flag_id,
    mf.user_id,
    p.display_name              as owner_name,
    p.handle                    as owner_handle,
    p.account_status            as owner_account_status,
    mf.bucket,
    mf.storage_path,
    mf.reason,
    mf.scores,
    mf.csam_detected,
    mf.created_at,
    ci.id                       as collection_item_id,
    ci.artist_name,
    ci.artwork_title,
    ci.is_public,
    ci.public_story
  from public.moderation_flags mf
  left join public.profiles p on p.user_id = mf.user_id
  -- Edit-flow uploads have the FK populated → direct join.
  -- New-item-flow uploads have FK=NULL → fall back to storage_path
  -- matching since image_path on collection_items uses the same string.
  left join public.collection_items ci on (
       (mf.collection_item_id is not null and ci.id = mf.collection_item_id)
    or (mf.collection_item_id is null and mf.bucket = 'collection-images' and ci.image_path = mf.storage_path)
  )
  where mf.verdict = 'pending'
  order by mf.csam_detected desc, mf.created_at asc;
end;
$$;

revoke all on function public.admin_get_pending_moderation() from public, anon;
grant execute on function public.admin_get_pending_moderation() to authenticated;

comment on function public.admin_get_pending_moderation() is
  'Admin queue: pending moderation_flags rows joined with their piece + owner. CSAM-flagged rows surface first. See 072_moderation_queue_rpcs.sql.';

-- ---------------------------------------------------------------------------
-- 2. admin_approve_moderation
-- ---------------------------------------------------------------------------
-- Admin reviewed the image and decided it's fine. Flip verdict from
-- 'pending' to 'approved' so the get_public_collection filter stops
-- excluding it. Idempotent — re-approving an already-approved row
-- is a no-op.
create or replace function public.admin_approve_moderation(
  p_flag_id uuid,
  p_note    text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;

  update public.moderation_flags
     set verdict        = 'approved',
         reviewed_by    = auth.uid(),
         reviewed_at    = now(),
         review_note    = p_note
   where id = p_flag_id
     and verdict = 'pending';
end;
$$;

revoke all on function public.admin_approve_moderation(uuid, text) from public, anon;
grant execute on function public.admin_approve_moderation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_reject_moderation
-- ---------------------------------------------------------------------------
-- Admin reviewed the image and decided it violates ToS. Deletes the
-- attached collection_items row (writing the same tombstone the
-- existing admin_delete_collection_item RPC writes, so the owner sees
-- the banner notification on their Collection tab). Flips verdict to
-- 'rejected' on the moderation_flag itself. Returns the storage path
-- so the JS caller can remove the image from Storage.
--
-- Resolution of the underlying item:
--   * If collection_item_id is set on the flag → use that.
--   * If collection_item_id is null → look up the item by storage_path
--     matching the user's image_path.
--   * If no matching item found → just flip the verdict + return path.
--     (Edge case: image uploaded but item insert failed afterward.)
create or replace function public.admin_reject_moderation(
  p_flag_id uuid,
  p_reason  text
) returns table (
  image_path text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flag         record;
  v_item_id      uuid;
  v_artist       text;
  v_title        text;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason required';
  end if;

  select * into v_flag from public.moderation_flags where id = p_flag_id;
  if v_flag.id is null then
    raise exception 'flag not found';
  end if;

  -- Find the underlying collection_items row, either by FK or by path.
  if v_flag.collection_item_id is not null then
    v_item_id := v_flag.collection_item_id;
  elsif v_flag.bucket = 'collection-images' then
    select id into v_item_id from public.collection_items
      where owner_id = v_flag.user_id and image_path = v_flag.storage_path
      limit 1;
  end if;

  -- If we found an item, snapshot it + write the tombstone + delete it,
  -- mirroring admin_delete_collection_item's flow.
  if v_item_id is not null then
    select ci.artist_name, ci.artwork_title
      into v_artist, v_title
      from public.collection_items ci
      where ci.id = v_item_id;

    -- Resolve any open reports against this piece in the same txn.
    update public.collection_item_reports
       set status          = 'resolved',
           resolved_by     = auth.uid(),
           resolved_at     = now(),
           resolution_note = 'piece removed by admin (auto-moderation reject): ' || trim(p_reason)
     where collection_item_id = v_item_id and status = 'open';

    -- Tombstone for owner's portal banner.
    insert into public.removed_collection_items (
      original_item_id, owner_id, artist_name, artwork_title, reason, removed_by
    ) values (
      v_item_id, v_flag.user_id, v_artist, v_title, trim(p_reason), auth.uid()
    );

    delete from public.collection_items where id = v_item_id;
  end if;

  -- Flip the flag itself.
  update public.moderation_flags
     set verdict     = 'rejected',
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         review_note = trim(p_reason)
   where id = p_flag_id;

  return query select v_flag.storage_path;
end;
$$;

revoke all on function public.admin_reject_moderation(uuid, text) from public, anon;
grant execute on function public.admin_reject_moderation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. get_public_collection — REPLACED with moderation-aware filtering
-- ---------------------------------------------------------------------------
-- Same UNION shape as the version in migration 061, but the native
-- collection_items branch now excludes any item whose latest image
-- scan is still 'pending'. Listings branch is unchanged (we don't
-- moderate listing-images uploads yet — that's deferred to a later
-- session per the Layer 2 scoping).
drop function if exists public.get_public_collection(uuid);
create function public.get_public_collection(
  p_owner_id uuid
) returns table (
  id                  uuid,
  artist_name         text,
  artwork_title       text,
  medium              text,
  artwork_category    text,
  image_path          text,
  height_in           numeric,
  width_in            numeric,
  depth_in            numeric,
  framed_size         text,
  coa_included        text,
  public_story        text,
  created_at          timestamptz,
  source_type         text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- Native collection_items branch — moderation-aware (cc-v224).
  select
    ci.id, ci.artist_name, ci.artwork_title, ci.medium, ci.artwork_category,
    ci.image_path, ci.height_in, ci.width_in, ci.depth_in, ci.framed_size,
    ci.coa_included, ci.public_story, ci.created_at,
    'collection_item'::text as source_type
  from public.collection_items ci
  join public.profiles p on p.user_id = ci.owner_id
  where ci.owner_id = p_owner_id
    and p.collection_is_public = true
    and p.is_trusted = true
    and ci.is_public = true
    -- Exclude pieces with a pending image moderation flag. Match by FK
    -- when present, otherwise by storage_path = image_path. We only
    -- check for 'pending' explicitly; 'approved' / 'pass' / 'rejected'
    -- never block (rejected items are deleted anyway).
    and not exists (
      select 1
      from public.moderation_flags mf
      where mf.verdict = 'pending'
        and (
          mf.collection_item_id = ci.id
          or (mf.collection_item_id is null
              and mf.bucket = 'collection-images'
              and mf.storage_path = ci.image_path)
        )
    )

  union all

  -- in_collection listings branch (UNMODIFIED). Listings aren't yet
  -- routed through the image moderation pipeline.
  select
    l.listing_id as id,
    l.artist_name,
    l.artwork_title,
    l.medium,
    l.artwork_category,
    (
      select li.storage_path from public.listing_images li
      where li.listing_id = l.listing_id
      order by li.position asc
      limit 1
    ) as image_path,
    l.height_in, l.width_in, l.depth_in,
    l.framed_size,
    l.coa_included,
    null::text as public_story,
    l.created_at,
    'listing'::text as source_type
  from public.listings l
  join public.profiles p on p.user_id = l.seller_id
  where l.seller_id = p_owner_id
    and l.status = 'in_collection'
    and p.collection_is_public = true
    and p.is_trusted = true
  order by created_at desc;
$$;

revoke all on function public.get_public_collection(uuid) from public;
grant execute on function public.get_public_collection(uuid) to authenticated, anon;
