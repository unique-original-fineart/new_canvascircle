-- =============================================================================
-- 042_user_blocks.sql
-- =============================================================================
-- User-level mutual blocking. Symmetric: when A blocks B, both A's view of B
-- AND B's view of A are filtered (B's listings hidden from A's catalog, A's
-- listings hidden from B's catalog, contact buttons disabled in either
-- direction). Privacy-preserving: B is not notified that A specifically
-- blocked them; B sees A's profile as "user not available" generically.
--
-- Why we need this:
--   At low scale (15 sellers today, ~50K-collector launch audience tomorrow),
--   personal conflicts are inevitable. Without a block tool, users have to
--   email the admin for every interpersonal friction, which doesn't scale
--   and creates admin-as-judge dynamic the platform deliberately avoids
--   (see /dispute-policy.html). Blocking is the emergency valve users
--   control themselves.
--
-- Critical design decisions:
--   1. Admin (profiles.is_admin = true) CANNOT be blocked. The admin is the
--      moderation channel — letting users block them would make moderation
--      unreachable. Enforced in the block_user() RPC.
--   2. Symmetric filtering — blocks apply both directions. The client uses
--      get_my_block_filter_uids() to fetch the union of "users I blocked"
--      and "users who blocked me," then filters catalog/seller/listing
--      views against that set.
--   3. Block list is private — B does not get a notification, and direct
--      RLS does not let B query rows where they were blocked. The privacy
--      isn't bulletproof (a user with zero outgoing blocks could deduce
--      who blocked them from the filter list), but the UI never tells them.
--   4. NOT a destructive cascade. Blocks are view-level filters. References
--      stay in the DB but are filtered out of any rendered view. Saved
--      listings stay saved but are hidden. Follows stay in the DB but
--      generate no notifications. This makes unblocking instantly reversible
--      — restore the row, everything reappears.
--
-- Off-platform comms: the block does NOT affect email or Facebook Messenger.
-- The block-confirm modal in the UI must say this explicitly so users know
-- the actual scope. CanvasCircle blocks what CanvasCircle controls.
-- =============================================================================

create table if not exists public.user_blocks (
  blocker_user_id uuid not null references public.profiles(user_id) on delete cascade,
  blocked_user_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

-- Lookup index for the reverse direction (used by get_my_block_filter_uids).
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_user_id);

-- RLS
alter table public.user_blocks enable row level security;

-- Users can SELECT only their own blocker rows. They cannot see rows where
-- they were blocked — that's the privacy guarantee at the row level.
drop policy if exists user_blocks_select_blocker on public.user_blocks;
create policy user_blocks_select_blocker on public.user_blocks
  for select using (auth.uid() = blocker_user_id);

-- Users insert their own blocks via the block_user RPC, which runs as
-- SECURITY DEFINER. The RPC encapsulates the admin-immunity check; direct
-- inserts via PostgREST bypass that check, which we don't want. Hence: no
-- direct INSERT policy, only RPC access.
-- Users can DELETE their own blocks directly via unblock_user RPC (also
-- SECURITY DEFINER) or by direct PostgREST call — no admin-immunity issue
-- on delete.
drop policy if exists user_blocks_delete_own on public.user_blocks;
create policy user_blocks_delete_own on public.user_blocks
  for delete using (auth.uid() = blocker_user_id);

-- =============================================================================
-- block_user(target_user_id) — insert a block row with admin immunity check
-- =============================================================================
create or replace function public.block_user(p_target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Must be signed in to block users.';
  end if;
  if p_target_user_id is null or p_target_user_id = v_caller_id then
    raise exception 'Invalid block target.';
  end if;

  -- Admin immunity. The admin is the platform's moderation channel — users
  -- blocking the admin would make moderation unreachable. Enforced here so
  -- no client-side bypass is possible.
  if exists (select 1 from public.profiles
              where user_id = p_target_user_id and is_admin = true) then
    raise exception 'This user cannot be blocked.';
  end if;

  insert into public.user_blocks (blocker_user_id, blocked_user_id)
  values (v_caller_id, p_target_user_id)
  on conflict (blocker_user_id, blocked_user_id) do nothing;

  return true;
end;
$$;

grant execute on function public.block_user(uuid) to authenticated;

-- =============================================================================
-- unblock_user(target_user_id) — remove a block row
-- =============================================================================
create or replace function public.unblock_user(p_target_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_id uuid;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception 'Must be signed in.';
  end if;

  delete from public.user_blocks
  where blocker_user_id = v_caller_id
    and blocked_user_id = p_target_user_id;

  return true;
end;
$$;

grant execute on function public.unblock_user(uuid) to authenticated;

-- =============================================================================
-- get_my_block_filter_uids() — union of "users I blocked" and "users who
-- blocked me." This is what the client filters catalog/seller/listing views
-- against. SECURITY DEFINER so the function can read rows where the caller
-- was the blocked party (bypassing the SELECT RLS that restricts that).
--
-- Privacy note: the returned set mixes both directions, so a paranoid user
-- who has made zero outgoing blocks could deduce that anyone in their
-- filter list blocked them. The platform's UI never tells them this — but
-- the data path doesn't perfectly obscure it. Real-world impact is low
-- because most users won't inspect the network tab.
-- =============================================================================
create or replace function public.get_my_block_filter_uids()
returns table(user_id uuid)
language sql
security definer
set search_path = public
as $$
  select blocked_user_id from public.user_blocks where blocker_user_id = auth.uid()
  union
  select blocker_user_id from public.user_blocks where blocked_user_id = auth.uid();
$$;

grant execute on function public.get_my_block_filter_uids() to authenticated;

-- =============================================================================
-- is_blocked_between(user_a, user_b) — returns true if EITHER user has blocked
-- the other. Used by send-email edge fn (via service role) to refuse contact-
-- seller inquiries between blocked parties. SECURITY DEFINER so callers don't
-- need direct table access.
-- =============================================================================
create or replace function public.is_blocked_between(p_user_a uuid, p_user_b uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_blocks
    where (blocker_user_id = p_user_a and blocked_user_id = p_user_b)
       or (blocker_user_id = p_user_b and blocked_user_id = p_user_a)
  );
$$;

grant execute on function public.is_blocked_between(uuid, uuid) to authenticated, service_role;

comment on table public.user_blocks is
  'User-to-user block list. Symmetric semantics applied client-side via get_my_block_filter_uids(). Admin (profiles.is_admin) cannot be blocked (enforced in block_user RPC). Blocks are view-level filters, not destructive cascades — references/follows/saves stay in DB but are filtered from rendered views. Unblock restores everything.';
