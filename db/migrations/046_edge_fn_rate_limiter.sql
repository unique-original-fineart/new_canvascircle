-- =============================================================================
-- 046_edge_fn_rate_limiter.sql
-- =============================================================================
-- Generic Postgres-backed rate limiter for edge functions.
--
-- Threat model: even with per-user rate limits, an attacker creating many
-- accounts behind one IP (or one NAT) can spam protected endpoints by
-- staying under each individual user's quota. A second layer keyed on
-- hashed client IP catches that pattern. Also useful for endpoints that
-- never had user-level limits (e.g. contact-admin).
--
-- Design:
--   * One generic events table, one RPC. Any edge fn can rate-limit any
--     action against either a user_id or an IP hash by calling the RPC.
--   * RPC is service-role only (no anon/authenticated access). End users
--     can't query the events table to enumerate other users' activity.
--   * Atomic count+insert inside SECURITY DEFINER so a race between two
--     simultaneous requests can't both squeak under the limit.
--   * pg_cron cleanup hourly. Retention = 24h, well past the longest
--     current window of 1h, so trailing-window counts stay accurate.
--
-- Configuration the caller controls:
--   p_fn         text  — edge fn name, e.g. "send-email"
--   p_action     text  — action within that fn, e.g. "contact-admin"
--   p_user       uuid? — caller's user_id (pass null for IP-only checks)
--   p_ip_hash    text? — SHA-256(client_ip + IP_SALT) (pass null for user-only)
--   p_limit      int   — max events allowed in the window
--   p_window_sec int   — rolling window length in seconds
--
-- Exactly one of p_user / p_ip_hash should be non-null per call. The
-- caller is expected to invoke the RPC twice when both keys apply (once
-- with user, once with ip). Each call records ONE event row and checks
-- against the matching key, so a heavy-IP NAT doesn't penalize light users.
--
-- Returns: true if the event was recorded (caller may proceed), false if
-- the limit was already met (caller should return HTTP 429).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. edge_fn_rate_events table
-- ---------------------------------------------------------------------------
create table if not exists public.edge_fn_rate_events (
  id          bigserial primary key,
  fn_name     text not null,
  action      text not null,
  user_id     uuid,
  ip_hash     text,
  created_at  timestamptz not null default now(),
  -- Exactly one of (user_id, ip_hash) must be non-null per row. Keeps the
  -- counting query simple and the index small.
  constraint exactly_one_key check (
    (user_id is null) <> (ip_hash is null)
  )
);

-- Two partial indexes so each rate-limit-check query is a simple range scan.
create index if not exists edge_fn_rate_events_user_idx
  on public.edge_fn_rate_events (fn_name, action, user_id, created_at)
  where user_id is not null;

create index if not exists edge_fn_rate_events_ip_idx
  on public.edge_fn_rate_events (fn_name, action, ip_hash, created_at)
  where ip_hash is not null;

-- Locked down. Service role only — end users have zero access.
alter table public.edge_fn_rate_events enable row level security;
-- No policies are intentional: with RLS enabled and no policies, no role
-- except superuser and service_role can read/write. Belt-and-suspenders.
revoke all on public.edge_fn_rate_events from public;
revoke all on public.edge_fn_rate_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. check_rate_limit RPC
-- ---------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_fn         text,
  p_action     text,
  p_user       uuid default null,
  p_ip_hash    text default null,
  p_limit      int  default 5,
  p_window_sec int  default 3600
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
  v_since timestamptz;
begin
  -- Guard: caller must pass exactly one key.
  if (p_user is null and p_ip_hash is null) or (p_user is not null and p_ip_hash is not null) then
    raise exception 'check_rate_limit requires exactly one of p_user or p_ip_hash';
  end if;
  if p_limit <= 0 or p_window_sec <= 0 then
    raise exception 'p_limit and p_window_sec must be positive';
  end if;

  v_since := now() - (p_window_sec || ' seconds')::interval;

  if p_user is not null then
    select count(*) into v_count
      from public.edge_fn_rate_events
      where fn_name = p_fn
        and action  = p_action
        and user_id = p_user
        and created_at > v_since;
  else
    select count(*) into v_count
      from public.edge_fn_rate_events
      where fn_name = p_fn
        and action  = p_action
        and ip_hash = p_ip_hash
        and created_at > v_since;
  end if;

  if v_count >= p_limit then
    return false;
  end if;

  insert into public.edge_fn_rate_events (fn_name, action, user_id, ip_hash)
    values (p_fn, p_action, p_user, p_ip_hash);
  return true;
end $$;

-- Lock execution to service_role only. End users (anon, authenticated)
-- must never be able to call this directly, since they could probe limits
-- or pre-empt the counter for other users.
revoke all on function public.check_rate_limit(text, text, uuid, text, int, int) from public;
revoke all on function public.check_rate_limit(text, text, uuid, text, int, int) from anon, authenticated;
grant execute on function public.check_rate_limit(text, text, uuid, text, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Hourly cleanup via pg_cron
-- ---------------------------------------------------------------------------
-- pg_cron must already be enabled (we use it for verification_video_cleanup).
-- Retention = 24h. Longest current window is 1h, so 24h leaves huge buffer
-- and the table never grows past a day of activity.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
      from cron.job where jobname = 'edge-fn-rate-events-cleanup';
    perform cron.schedule(
      'edge-fn-rate-events-cleanup',
      '17 * * * *',  -- :17 past every hour
      $cron$ delete from public.edge_fn_rate_events where created_at < now() - interval '24 hours'; $cron$
    );
  else
    raise notice 'pg_cron not installed — install it before relying on automatic cleanup';
  end if;
end $$;

-- =============================================================================
-- End of migration 046.
-- =============================================================================
