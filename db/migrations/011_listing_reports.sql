-- =============================================================================
-- 011_listing_reports.sql
-- =============================================================================
-- Lets any signed-in user report a listing for violating group rules. Reports
-- show up in the admin tab for review. Admins can dismiss (false alarm) or
-- act on them via the existing moderation tools (reject the listing, suspend
-- the seller, etc).
-- =============================================================================

create table if not exists public.listing_reports (
  id            bigserial primary key,
  listing_id    uuid not null references public.listings(listing_id) on delete cascade,
  reporter_id   uuid not null references auth.users(id) on delete cascade,
  reason        text not null check (length(reason) > 0),
  status        text not null default 'open'
                  check (status in ('open', 'resolved')),
  resolved_by   uuid references auth.users(id) on delete set null,
  resolved_at   timestamptz,
  resolution_note text,
  created_at    timestamptz not null default now(),
  -- A single user can't spam-report the same listing more than once.
  constraint listing_reports_unique_pair unique (listing_id, reporter_id)
);

create index if not exists listing_reports_status_idx
  on public.listing_reports (status, created_at desc);
create index if not exists listing_reports_listing_idx
  on public.listing_reports (listing_id);

alter table public.listing_reports enable row level security;

-- Reporters can insert their own reports.
drop policy if exists listing_reports_insert_self on public.listing_reports;
create policy listing_reports_insert_self
  on public.listing_reports for insert
  with check (reporter_id = auth.uid());

-- Reporters can see their own reports (so the UI can show "you reported this").
drop policy if exists listing_reports_select_self on public.listing_reports;
create policy listing_reports_select_self
  on public.listing_reports for select
  using (reporter_id = auth.uid());

-- Admins can see and update everything.
drop policy if exists listing_reports_admin_all on public.listing_reports;
create policy listing_reports_admin_all
  on public.listing_reports for all
  using (public.is_admin())
  with check (public.is_admin());
