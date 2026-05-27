-- =============================================================================
-- 032_push_subscriptions.sql
-- =============================================================================
-- Stores Web Push (PWA notification) subscriptions, one row per
-- browser+device the user opts in from. A single user can have multiple
-- rows (phone + laptop + tablet, or even multiple browsers on the same
-- device — each one gets its own endpoint).
--
-- Required for the iOS PWA notification path: per Apple's web-push spec
-- the user must install the PWA to their home screen, grant the permission
-- prompt, and then we store the resulting subscription. Same model on
-- Android Chrome but without the install-required step.
--
-- The endpoint column is what we POST to when sending a push. p256dh and
-- auth are the client-side encryption keys we use to encrypt the payload
-- so only the recipient's browser can decrypt it. We treat the endpoint
-- as unique — a duplicate subscribe from the same browser just overwrites
-- the existing row via ON CONFLICT.
-- =============================================================================

create table if not exists public.push_subscriptions (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- The browser's push service URL. Cloudflare/Mozilla/Apple/etc each run
  -- their own endpoint; the URL varies per browser per device. Unique
  -- per row so we can upsert cleanly when a client resubscribes.
  endpoint      text not null unique,
  -- Public encryption key (P-256 ECDH) — base64url encoded.
  p256dh        text not null,
  -- Symmetric auth secret — base64url encoded.
  auth_secret   text not null,
  -- Helpful for debugging which device a subscription belongs to. Not
  -- privacy-sensitive — just navigator.userAgent at subscribe time.
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  -- Track delivery failures so we can prune subscriptions that have
  -- been rejected too many times (e.g. user reinstalled iOS, app was
  -- uninstalled, etc.). Bumped from the edge function on 410/404.
  failure_count integer not null default 0
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- The user owns their own rows. They subscribe via the client (insert),
-- can list their devices (select), and can revoke (delete). Each policy
-- is the user-scoped check; admin policy below catches everything else.
drop policy if exists ps_select_self on public.push_subscriptions;
create policy ps_select_self
  on public.push_subscriptions for select
  using (user_id = auth.uid());

drop policy if exists ps_insert_self on public.push_subscriptions;
create policy ps_insert_self
  on public.push_subscriptions for insert
  with check (user_id = auth.uid());

drop policy if exists ps_update_self on public.push_subscriptions;
create policy ps_update_self
  on public.push_subscriptions for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists ps_delete_self on public.push_subscriptions;
create policy ps_delete_self
  on public.push_subscriptions for delete
  using (user_id = auth.uid());

drop policy if exists ps_admin_all on public.push_subscriptions;
create policy ps_admin_all
  on public.push_subscriptions for all
  using (public.is_admin())
  with check (public.is_admin());
