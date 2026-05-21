-- =============================================================================
-- 025_auto_cancel_pending_refs_on_demote.sql
-- =============================================================================
-- Soft-cancel pending Sales Reference requests when the target user loses
-- Established Member status (profiles.is_trusted flips true → false).
--
-- Why soft-cancel instead of hard-delete:
--   Silently deleting a requester's pending row leaves them confused —
--   "did the target reject me? did the system glitch?" Instead we flip
--   the row to a new status value 'target_demoted', which the seller
--   portal renders with a distinct grayed-out style + an explanation
--   ("Auto-cancelled — @target_handle is no longer an Established
--   Member") and a Dismiss button that DELETEs the row when the user
--   has seen it. Cleanest of both worlds: visible notice, no zombies.
--
-- Scope:
--   - Only affects PENDING rows. Accepted historical references are
--     not auto-touched — the admin's existing manual revoke is the
--     right lever for accepted relationships.
--   - Only fires on transition true → false. The trigger is a no-op
--     on initial signup (NEW only) or when is_trusted_locked changes
--     without changing is_trusted itself.
--
-- 5-cap impact:
--   request_reference() counts only pending + accepted toward the 5-
--   outgoing cap, so target_demoted rows do NOT consume a slot. A
--   requester whose target gets demoted can immediately request a new
--   Established Member without dismissing the cancelled row first.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend status check constraint to include 'target_demoted'
-- ---------------------------------------------------------------------------
alter table public.seller_references
  drop constraint if exists seller_references_status_check;
alter table public.seller_references
  add constraint seller_references_status_check
  check (status in ('pending', 'accepted', 'rejected', 'target_demoted'));

-- ---------------------------------------------------------------------------
-- 2. Trigger function: cancel pending references targeting a demoted user
-- ---------------------------------------------------------------------------
create or replace function public.auto_cancel_pending_refs_on_demote()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only act when is_trusted actually flips from true to false.
  -- Comparisons use IS DISTINCT FROM to handle null safely, though
  -- in practice is_trusted is non-null on existing rows.
  if old.is_trusted is true and new.is_trusted is false then
    update public.seller_references
       set status = 'target_demoted'
     where reference_user_id = new.user_id
       and status = 'pending';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_auto_cancel_pending_refs_on_demote on public.profiles;
create trigger trg_auto_cancel_pending_refs_on_demote
  after update of is_trusted on public.profiles
  for each row execute function public.auto_cancel_pending_refs_on_demote();

-- =============================================================================
-- End of migration 025. Requires migration 019 (seller_references table)
-- and any migration that exposes profiles.is_trusted. Portal-side renderer
-- and Dismiss button live in portal/index.html.
-- =============================================================================
