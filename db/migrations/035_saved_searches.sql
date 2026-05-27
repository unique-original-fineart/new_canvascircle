-- =============================================================================
-- 035_saved_searches.sql
-- =============================================================================
-- Saved searches / "follow" feature. Buyers can follow specific artists or
-- specific sellers, and get a push + email notification when a new matching
-- listing becomes publicly visible (status=approved). Mirror image of the
-- inquiry push (sellers got push when a buyer messages) — buyers now get
-- push when a listing matching their interests appears.
--
-- Two tables:
--   1. saved_searches — one row per (user, kind, value) tuple. The "follow"
--      itself. kind='artist' means follow an artist by name; kind='seller'
--      means follow a seller by user_id. Unique constraint prevents
--      duplicate follows.
--   2. saved_search_notifications — audit log of every alert sent. Used for
--      (a) per-user daily rate-limit lookup (max 20 alerts/day), (b) per-
--      listing dedup (UNIQUE on user_id+listing_id stops the same buyer
--      from being notified twice about the same listing — e.g. if they
--      follow both the artist AND the seller and a listing matches both),
--      (c) future "your following activity" view if we ever expose it.
--
-- Privacy:
--   - Buyers see their own saved_searches (manage them in portal Saved tab).
--   - Sellers do NOT see who follows them (consistent with the "save count
--     reveals total but not identities" pattern). The notifications log is
--     similarly private to the buyer + admin.
--   - Admin sees everything for moderation / debugging.
-- =============================================================================

-- ---- saved_searches table --------------------------------------------------
create table if not exists public.saved_searches (
  id          bigserial primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('artist', 'seller')),
  -- For kind='artist': the artist name as the buyer entered/clicked it.
  -- For kind='seller': the seller's user_id (uuid serialized as text so
  -- this column can carry both shapes without a polymorphic foreign key).
  value       text not null,
  created_at  timestamptz not null default now(),
  -- One follow per (user, kind, value) — re-clicking Follow is a no-op
  -- via ON CONFLICT instead of duplicating rows.
  constraint saved_searches_user_kind_value_unique unique (user_id, kind, value)
);

-- Lookup index for the fanout: "find every saved_search whose value matches
-- this listing's artist." Case-insensitive on artist by lowercasing the
-- value at index time. Seller follows are matched by exact value (a uuid
-- string), so a regular b-tree is enough.
create index if not exists saved_searches_artist_lookup_idx
  on public.saved_searches (lower(value))
  where kind = 'artist';
create index if not exists saved_searches_seller_lookup_idx
  on public.saved_searches (value)
  where kind = 'seller';
-- And by user for the portal "what am I following?" view.
create index if not exists saved_searches_user_idx
  on public.saved_searches (user_id);

alter table public.saved_searches enable row level security;

drop policy if exists saved_searches_select_self on public.saved_searches;
create policy saved_searches_select_self
  on public.saved_searches for select
  using (user_id = auth.uid());

drop policy if exists saved_searches_insert_self on public.saved_searches;
create policy saved_searches_insert_self
  on public.saved_searches for insert
  with check (user_id = auth.uid());

drop policy if exists saved_searches_delete_self on public.saved_searches;
create policy saved_searches_delete_self
  on public.saved_searches for delete
  using (user_id = auth.uid());

drop policy if exists saved_searches_admin_all on public.saved_searches;
create policy saved_searches_admin_all
  on public.saved_searches for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---- saved_search_notifications table --------------------------------------
create table if not exists public.saved_search_notifications (
  id              bigserial primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  saved_search_id bigint references public.saved_searches(id) on delete set null,
  listing_id      uuid not null references public.listings(listing_id) on delete cascade,
  sent_at         timestamptz not null default now(),
  -- DEDUP: a single buyer can follow both the artist AND the seller of the
  -- same listing. We only want to notify them once. UNIQUE on (user, listing)
  -- enforces this at insert time — the fanout edge function uses
  -- ON CONFLICT DO NOTHING and a successful insert means "go ahead and
  -- send the notification; nothing if it conflicts".
  constraint ssn_user_listing_unique unique (user_id, listing_id)
);

-- Used by the daily-rate-limit query in the fanout function:
-- "how many notifications has this user received today?"
create index if not exists ssn_user_sent_idx
  on public.saved_search_notifications (user_id, sent_at desc);

alter table public.saved_search_notifications enable row level security;

-- Buyer sees their own notifications log (useful for "why did I get this?"
-- and future "your following activity" UI).
drop policy if exists ssn_select_self on public.saved_search_notifications;
create policy ssn_select_self
  on public.saved_search_notifications for select
  using (user_id = auth.uid());

-- Admin sees everything.
drop policy if exists ssn_admin_all on public.saved_search_notifications;
create policy ssn_admin_all
  on public.saved_search_notifications for all
  using (public.is_admin())
  with check (public.is_admin());

-- Note: no INSERT or DELETE policy for users — the fanout edge function
-- writes via service-role (bypassing RLS), and users have no need to
-- mutate the log themselves.
