-- =============================================================================
-- 048_admin_audit_log.sql
-- =============================================================================
-- Append-only audit log of every admin moderation action.
--
-- Purpose:
--   * Reconstruct the timeline of decisions when a dispute escalates
--     ("when did you suspend my account, and why?").
--   * Demonstrate non-negligence — if a buyer or seller alleges admin
--     misconduct, the row in this table is the evidentiary trail.
--   * Future-proof against having multiple admins: today only Guy can
--     act, but the schema captures admin_user_id so the log stays
--     correct if/when more admins are added.
--
-- Design:
--   * Append-only by design: no UPDATE or DELETE policies. The only way
--     to write is through log_admin_action(), which itself can only be
--     called by an admin (is_admin() gate inside the SECURITY DEFINER
--     body). Even a compromised admin account can't tamper with prior
--     rows — they can only append more.
--   * Schema is intentionally generic: action / target_type / target_id
--     lets us log any future admin action without a schema change. The
--     before_value + after_value jsonb columns capture state snapshots
--     where useful; the notes field carries free-text context (reject
--     reasons, revoke reasons, etc.).
--   * RLS: admin-only SELECT. No row visible to anon or signed-in
--     non-admin users. We don't expose audit history publicly even for
--     a user's own account — that conversation goes through admin@
--     support channels if requested.
--
-- Performance:
--   * Three indexes covering the common query patterns:
--       - "what has admin X done recently" (admin_user_id, created_at desc)
--       - "what's the history on target T" (target_type, target_id, created_at)
--       - "all approvals last week" (action, created_at)
--   * Bigserial id so the table can grow indefinitely without pk collisions.
--     At ~10 admin actions per day, even after a decade the table is
--     < 50K rows — trivial for Postgres.
-- =============================================================================

create table if not exists public.admin_audit_log (
  id            bigserial primary key,
  -- Admin who performed the action. on delete set null so we don't lose
  -- the log row if an admin's auth row is ever deleted (shouldn't happen,
  -- but defensive). admin_user_id should always be non-null in practice.
  admin_user_id uuid references auth.users(id) on delete set null,
  -- Action name. Conventions:
  --   approve_listing, reject_listing
  --   approve_verification, reject_verification
  --   revoke_verification
  --   reset_trusted_lock
  --   set_is_trusted (manual admin toggle)
  --   set_account_status (suspend/ban/reactivate)
  --   extend_renewal
  --   broadcast_email
  -- New actions added later just use a new string — no schema change.
  action        text not null,
  -- Type of thing the action targets: 'listing', 'verification', 'profile',
  -- 'reference', 'email', etc.
  target_type   text not null,
  -- ID of the targeted row, as text. UUIDs cast to text; integer ids
  -- formatted; etc. Stored as text so different target types can share
  -- the same column.
  target_id     text not null,
  -- Human-readable label of the target for fast scanning in the UI
  -- ("Romero Britto — Love Grows", "@handle", etc). Optional but
  -- strongly recommended for any new action.
  target_label  text,
  -- State snapshot BEFORE the change (when applicable; null if not
  -- meaningful, e.g. for one-shot actions like sending a broadcast).
  before_value  jsonb,
  -- State snapshot AFTER the change.
  after_value   jsonb,
  -- Free-text notes: rejection reason, revoke reason, broadcast subject,
  -- whatever else the action surface wants to record.
  notes         text,
  created_at    timestamptz not null default now()
);

-- Indexes for the three common access patterns.
create index if not exists admin_audit_log_admin_idx
  on public.admin_audit_log (admin_user_id, created_at desc);
create index if not exists admin_audit_log_target_idx
  on public.admin_audit_log (target_type, target_id, created_at desc);
create index if not exists admin_audit_log_action_idx
  on public.admin_audit_log (action, created_at desc);

-- RLS — admin-only SELECT, no INSERT/UPDATE/DELETE policies (writes go
-- through the log_admin_action RPC below; updates and deletes are never
-- allowed since the table is append-only).
alter table public.admin_audit_log enable row level security;

drop policy if exists admin_audit_log_admin_read on public.admin_audit_log;
create policy admin_audit_log_admin_read
  on public.admin_audit_log
  for select
  using (public.is_admin());

-- Belt-and-suspenders: revoke all default privileges from regular roles.
revoke all on public.admin_audit_log from public;
revoke all on public.admin_audit_log from anon, authenticated;

-- ---------------------------------------------------------------------------
-- log_admin_action RPC — the only write path into admin_audit_log.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the RPC runs with elevated privileges and can write
-- to the audit table even though regular grants are revoked. The body
-- gates on is_admin(), so calls from non-admin sessions raise an
-- exception before any row is inserted.
--
-- Returns the inserted row's id, which lets the client tie related logs
-- together if needed (e.g., "rejected this verification, then revoked
-- this badge as part of the same action").

create or replace function public.log_admin_action(
  p_action       text,
  p_target_type  text,
  p_target_id    text,
  p_target_label text default null,
  p_before       jsonb default null,
  p_after        jsonb default null,
  p_notes        text default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
begin
  if not public.is_admin() then
    raise exception 'log_admin_action requires admin privileges';
  end if;
  if p_action is null or p_action = '' then
    raise exception 'action is required';
  end if;
  if p_target_type is null or p_target_type = '' then
    raise exception 'target_type is required';
  end if;
  if p_target_id is null or p_target_id = '' then
    raise exception 'target_id is required';
  end if;

  insert into public.admin_audit_log (
    admin_user_id, action, target_type, target_id,
    target_label, before_value, after_value, notes
  ) values (
    auth.uid(), p_action, p_target_type, p_target_id,
    p_target_label, p_before, p_after, p_notes
  )
  returning id into v_id;

  return v_id;
end $$;

-- Lock execution to authenticated users only; the is_admin() check inside
-- the body provides the actual gate.
revoke all on function public.log_admin_action(text, text, text, text, jsonb, jsonb, text) from public;
revoke all on function public.log_admin_action(text, text, text, text, jsonb, jsonb, text) from anon;
grant execute on function public.log_admin_action(text, text, text, text, jsonb, jsonb, text) to authenticated;

-- =============================================================================
-- End of migration 048.
-- =============================================================================
