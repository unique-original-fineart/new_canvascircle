-- =============================================================================
-- 070_collection_removal_notices.sql
-- =============================================================================
-- Replaces the email-based admin-deletion notification (cc-v218, since
-- removed) with an in-portal banner system: when the admin force-deletes
-- a Collection piece, a tombstone row lands in removed_collection_items
-- and the owner sees a dismissable banner on their Collection tab the
-- next time they sign in. Mirrors the pattern users already know from
-- listing rejections and verification revocations.
--
-- Why this is better than email:
--   * Email has unreliable delivery (spam folders, dead addresses, users
--     who don't check inbox).
--   * In-portal banner is the same surface where the action's consequence
--     lives (their Collection tab) — context is co-located.
--   * Banner is sticky until the owner clicks "Got it" — they can't miss it.
--
-- The piece itself is STILL hard-deleted (collection_items row + storage
-- object both gone). Only the tombstone notice persists. The notice
-- contains snapshot fields (artist, title) so the banner can render
-- meaningfully even after the original row is gone, plus the admin's
-- reason text so the owner knows what happened.
-- =============================================================================

create table if not exists public.removed_collection_items (
  id              uuid primary key default gen_random_uuid(),
  -- The original collection_items.id at removal time. Useful for cross-
  -- referencing audit records (R2 backup of the image is keyed on the
  -- original path which embeds this uuid). Not a FK because the original
  -- row is intentionally deleted.
  original_item_id uuid not null,
  owner_id        uuid not null references auth.users(id) on delete cascade,
  -- Snapshot of identifying fields so the banner reads meaningfully
  -- after the row is gone. Kept short — we don't snapshot description /
  -- public_story / private fields, only what the user needs to recognize
  -- which piece this was about.
  artist_name     text,
  artwork_title   text,
  reason          text not null,
  removed_by      uuid references auth.users(id) on delete set null,
  removed_at      timestamptz not null default now(),
  -- When the owner clicked "Got it" / dismissed the banner. NULL until
  -- ack; after that, the banner stops appearing. We keep the row even
  -- after ack as an audit trail of admin actions against this owner.
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id) on delete set null
);

-- Fast lookup for "what unacknowledged notices does this owner have?"
-- Partial index on the null path keeps it small.
create index if not exists removed_collection_items_owner_unack_idx
  on public.removed_collection_items (owner_id, removed_at desc)
  where acknowledged_at is null;

-- Admin audit view, "show me all removal actions ordered by date".
create index if not exists removed_collection_items_removed_at_idx
  on public.removed_collection_items (removed_at desc);

alter table public.removed_collection_items enable row level security;
revoke all on public.removed_collection_items from public, anon, authenticated;
-- All access is through SECURITY DEFINER RPCs below. Service role and
-- admin clients hit the RPCs, owners hit the RPCs. No direct table
-- exposure, matches the security posture of collection_items itself.

-- ---------------------------------------------------------------------------
-- admin_delete_collection_item — REPLACED to also write tombstone
-- ---------------------------------------------------------------------------
-- Same external signature as the version in 069 (caller still passes
-- p_item_id + p_reason, still gets back the image_path for storage
-- cleanup). The internal change: snapshot the piece's identifying
-- fields into removed_collection_items BEFORE deleting the original
-- row so the owner's banner has something to render against.
create or replace function public.admin_delete_collection_item(
  p_item_id uuid,
  p_reason  text
) returns table (
  image_path text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason required';
  end if;

  -- Snapshot the piece before deletion. If the row doesn't exist this
  -- early-returns with no error (idempotent re-runs are safe).
  select ci.id, ci.owner_id, ci.artist_name, ci.artwork_title, ci.image_path
    into v_item
    from public.collection_items ci
    where ci.id = p_item_id;
  if v_item.id is null then
    return;
  end if;

  -- Auto-resolve any open reports against this piece. resolution_note
  -- includes the admin reason so the audit trail is searchable later.
  update public.collection_item_reports
     set status          = 'resolved',
         resolved_by     = auth.uid(),
         resolved_at     = now(),
         resolution_note = 'piece removed by admin: ' || trim(p_reason)
   where collection_item_id = p_item_id and status = 'open';

  -- Tombstone for the owner's in-portal banner. Lives until the owner
  -- clicks "Got it" (then acknowledged_at gets set), then persists as a
  -- silent audit record.
  insert into public.removed_collection_items (
    original_item_id, owner_id, artist_name, artwork_title, reason, removed_by
  ) values (
    v_item.id, v_item.owner_id, v_item.artist_name, v_item.artwork_title,
    trim(p_reason), auth.uid()
  );

  delete from public.collection_items where id = p_item_id;

  return query select v_item.image_path;
end;
$$;

revoke all on function public.admin_delete_collection_item(uuid, text) from public, anon;
grant execute on function public.admin_delete_collection_item(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- get_my_collection_removal_notices — owner-side fetch
-- ---------------------------------------------------------------------------
-- Returns the calling user's unacknowledged removal notices. Used by
-- portal/index.html on Collection tab open to render the banner stack.
-- Acknowledged notices are excluded — they stay in the table as audit
-- trail but never re-surface to the user.
create or replace function public.get_my_collection_removal_notices()
returns table (
  id              uuid,
  artist_name     text,
  artwork_title   text,
  reason          text,
  removed_at      timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;
  return query
  select r.id, r.artist_name, r.artwork_title, r.reason, r.removed_at
    from public.removed_collection_items r
   where r.owner_id = auth.uid()
     and r.acknowledged_at is null
   order by r.removed_at desc;
end;
$$;

revoke all on function public.get_my_collection_removal_notices() from public, anon;
grant execute on function public.get_my_collection_removal_notices() to authenticated;

-- ---------------------------------------------------------------------------
-- acknowledge_collection_removal_notice — owner dismisses a banner
-- ---------------------------------------------------------------------------
-- Called when the owner clicks "Got it" on a banner. Idempotent —
-- re-acking an already-acked notice is a no-op, not an error.
create or replace function public.acknowledge_collection_removal_notice(
  p_notice_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;
  update public.removed_collection_items
     set acknowledged_at = now(),
         acknowledged_by = auth.uid()
   where id = p_notice_id
     and owner_id = auth.uid()
     and acknowledged_at is null;
end;
$$;

revoke all on function public.acknowledge_collection_removal_notice(uuid) from public, anon;
grant execute on function public.acknowledge_collection_removal_notice(uuid) to authenticated;

comment on table public.removed_collection_items is
  'Tombstones for admin-deleted Collection pieces. Drives in-portal banner notices to owners. See 070_collection_removal_notices.sql.';
