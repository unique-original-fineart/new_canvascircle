-- =============================================================================
-- 031_listing_price_changes.sql
-- =============================================================================
-- New table that captures full price-change history for each listing — not
-- just the most recent change. Powers the per-listing Stats modal's
-- vertical dashed lines: every drop is a separate marker on the chart, so
-- sellers can see "I dropped from $1200 to $900 on day 4, then $900 to $700
-- on day 12 — which one moved the needle?"
--
-- The existing trigger (track_price_change in schema.sql) already snapshots
-- previous_price_usd + price_updated_at on every change. We extend that
-- same trigger here to ALSO insert a history row. Backfilling is best-effort:
-- if a listing has a non-null previous_price_usd, we seed one history row at
-- price_updated_at with old=previous, new=current. Earlier changes (more
-- than one drop ago) are lost — but the chart will still show what we know.
-- =============================================================================

create table if not exists public.listing_price_changes (
  id             bigint generated always as identity primary key,
  listing_id     uuid not null references public.listings(listing_id) on delete cascade,
  old_price_usd  numeric,         -- nullable: first change captures null → first-known-price
  new_price_usd  numeric not null,
  changed_at     timestamptz not null default now()
);

-- Indexes the Stats modal will hit: "all changes for this listing within
-- the chart window, oldest first" so we can draw the line in time order.
create index if not exists listing_price_changes_listing_idx
  on public.listing_price_changes (listing_id, changed_at);

-- ---- RLS: seller of the listing (and admins) can read history ----
alter table public.listing_price_changes enable row level security;

drop policy if exists lpc_select_seller on public.listing_price_changes;
create policy lpc_select_seller
  on public.listing_price_changes for select
  using (
    exists (
      select 1 from public.listings l
      where l.listing_id = listing_price_changes.listing_id
        and l.seller_id  = auth.uid()
    )
  );

drop policy if exists lpc_select_admin on public.listing_price_changes;
create policy lpc_select_admin
  on public.listing_price_changes for select
  using (public.is_admin());

-- ---- Extend the existing track_price_change trigger ----
-- We rewrite the function to do both the in-row snapshot (unchanged) AND a
-- history insert. SECURITY DEFINER + explicit search_path because RLS would
-- otherwise block the insert when a non-admin seller is editing their own
-- listing (the user has no INSERT policy on listing_price_changes).
create or replace function public.track_price_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.asking_price_usd is distinct from old.asking_price_usd then
    new.previous_price_usd = old.asking_price_usd;
    new.price_updated_at   = now();

    -- New: history row. Note we use new.price_updated_at (= now()) so the
    -- in-row stamp and the history row line up exactly.
    insert into public.listing_price_changes (listing_id, old_price_usd, new_price_usd, changed_at)
    values (new.listing_id, old.asking_price_usd, new.asking_price_usd, new.price_updated_at);
  end if;
  return new;
end;
$$;

-- Trigger definition itself doesn't change — the function it points to does.
-- Re-declare for idempotency.
drop trigger if exists listings_track_price_change on public.listings;
create trigger listings_track_price_change
  before update on public.listings
  for each row execute function public.track_price_change();

-- ---- Best-effort backfill ----
-- For every listing that already has a previous_price_usd recorded, insert
-- exactly one history row representing that most-recent change. We can't
-- recover history older than that — the schema only kept the single most
-- recent prior price — but this means existing listings still get a marker
-- on the chart for their last price drop.
insert into public.listing_price_changes (listing_id, old_price_usd, new_price_usd, changed_at)
select
  l.listing_id,
  l.previous_price_usd,
  l.asking_price_usd,
  coalesce(l.price_updated_at, l.created_at)
from public.listings l
where l.previous_price_usd is not null
  and l.previous_price_usd <> l.asking_price_usd
  and not exists (
    -- Idempotency: don't double-insert if migration runs twice.
    select 1 from public.listing_price_changes lpc
    where lpc.listing_id = l.listing_id
  );
