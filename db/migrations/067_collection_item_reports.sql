-- =============================================================================
-- 067_collection_item_reports.sql
-- =============================================================================
-- Lets any signed-in user report a public Collection item for violating
-- community rules. Mirrors the listing_reports pattern from migration
-- 011 — same insert-only-own + admin-sees-all RLS model, same
-- unique-per-(item, reporter) constraint to block spam-reporting.
--
-- Reports surface in the admin queue alongside listing reports so the
-- admin has a single place to triage problematic content regardless of
-- whether it lives in the catalog or in a public Collection.
--
-- Scope is PUBLIC Collection items only. A signed-in user can only
-- report what they can see, and our existing public-collection RLS +
-- get_public_collection RPC gates ensure private items aren't exposed
-- to other users in the first place. Bad actors who store prohibited
-- content under is_public=false are addressed by a separate admin
-- audit path (admin can view all Collection items regardless of
-- visibility flags) — see Layer 1 changes in seller.html / portal.
-- =============================================================================

create table if not exists public.collection_item_reports (
  id              bigserial primary key,
  collection_item_id  uuid not null references public.collection_items(id) on delete cascade,
  reporter_id     uuid not null references auth.users(id) on delete cascade,
  reason          text not null check (length(reason) > 0),
  status          text not null default 'open'
                    check (status in ('open', 'resolved')),
  resolved_by     uuid references auth.users(id) on delete set null,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  -- One user can't spam-report the same Collection item more than once.
  constraint collection_item_reports_unique_pair
    unique (collection_item_id, reporter_id)
);

create index if not exists collection_item_reports_status_idx
  on public.collection_item_reports (status, created_at desc);
create index if not exists collection_item_reports_item_idx
  on public.collection_item_reports (collection_item_id);

alter table public.collection_item_reports enable row level security;

-- Reporters insert their own reports only.
drop policy if exists collection_item_reports_insert_self on public.collection_item_reports;
create policy collection_item_reports_insert_self
  on public.collection_item_reports for insert
  with check (reporter_id = auth.uid());

-- Reporters can see their own reports (so the UI can show "you already
-- reported this" state). Mirrors listing_reports_select_self.
drop policy if exists collection_item_reports_select_self on public.collection_item_reports;
create policy collection_item_reports_select_self
  on public.collection_item_reports for select
  using (reporter_id = auth.uid());

-- Admins see + manage everything.
drop policy if exists collection_item_reports_admin_all on public.collection_item_reports;
create policy collection_item_reports_admin_all
  on public.collection_item_reports for all
  using (public.is_admin())
  with check (public.is_admin());

comment on table public.collection_item_reports is
  'User reports against public Collection items. Mirrors listing_reports. See db/migrations/067_collection_item_reports.sql.';
