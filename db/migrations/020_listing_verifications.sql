-- =============================================================================
-- 020_listing_verifications.sql
-- =============================================================================
-- Ownership verification (Phase 1A — seller-initiated).
--
-- A seller can submit a short (≤10s) video showing their artwork with a
-- handwritten card displaying @theirhandle + today's date. The admin
-- reviews the video and either approves (the listing gets an "Ownership
-- Verified" badge) or rejects (with an optional note the seller sees).
--
-- IMPORTANT: this verifies PROOF OF POSSESSION, not authenticity of the
-- artwork itself. Public copy on the badge popover must make this clear.
--
-- Two database objects in play:
--
--   1. `listing_verifications` — one row per submission attempt. Stores the
--      video storage path, hash (for forever-after reuse detection),
--      submission/review timestamps, and the admin's decision.
--
--   2. `listings.verification_status` + `listings.verified_at` — denormalized
--      rollup of the listing's overall verification state. Kept in sync by
--      a trigger on listing_verifications. Cached here so catalog queries
--      can filter/display without an aggregate join on every request.
--
-- Listing-level state machine (computed from all of a listing's submission
-- rows by the trigger function):
--   none      → no submissions ever, or all withdrawn
--   pending   → has a submission awaiting admin review
--   verified  → has ≥1 approved submission. STICKY — once verified, stays
--               verified even if later submissions are rejected. (Admins
--               can manually revoke via direct UPDATE; not exposed in UI.)
--   rejected  → latest submission was rejected and no approved submission
--               exists. Seller can re-submit to get out of this state.
--
-- Storage:
--   New private bucket `verification-videos`. Public access DISABLED — the
--   videos are only accessible via admin-generated signed URLs in the
--   moderation queue. After admin review the video bytes are auto-deleted
--   (see migration adding pg_cron job in a later chunk); the row + hash +
--   audit fields persist forever for reuse detection and historical record.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. listing_verifications table
-- ---------------------------------------------------------------------------
create table if not exists public.listing_verifications (
  id                  uuid primary key default gen_random_uuid(),
  listing_id          uuid not null references public.listings(listing_id) on delete cascade,
  submitted_by        uuid not null references auth.users(id) on delete cascade,
  status              text not null default 'pending'
                        check (status in ('pending', 'approved', 'rejected')),
  -- Path inside the verification-videos bucket. Set on upload, then nulled
  -- after the cleanup cron deletes the underlying bytes. The audit trail
  -- (decision, who reviewed, when) lives in the row's other columns.
  video_storage_path  text,
  -- SHA-256 hex digest of the original uploaded file. Persists forever even
  -- after video_storage_path is nulled so we can detect reused videos
  -- across listings (a strong fraud signal).
  video_hash          text,
  video_size_bytes    bigint,
  video_duration_sec  numeric(5,2),  -- client-reported, capped at 10
  submitted_at        timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewed_by         uuid references public.profiles(user_id) on delete set null,
  review_notes        text,
  video_deleted_at    timestamptz
);

create index if not exists listing_verifications_listing_idx
  on public.listing_verifications (listing_id, submitted_at desc);
create index if not exists listing_verifications_status_idx
  on public.listing_verifications (status, submitted_at);
-- Partial index for the cleanup cron: only rows where bytes still exist
-- AND have been reviewed are candidates for deletion.
create index if not exists listing_verifications_cleanup_idx
  on public.listing_verifications (reviewed_at)
  where video_storage_path is not null and reviewed_at is not null;
-- For SHA-256 reuse-detection lookups.
create index if not exists listing_verifications_hash_idx
  on public.listing_verifications (video_hash)
  where video_hash is not null;

alter table public.listing_verifications enable row level security;

grant select, insert on public.listing_verifications to authenticated;

-- Seller can read their own verification rows (so they see status + rejection
-- notes inside their portal).
drop policy if exists listing_verifications_owner_read on public.listing_verifications;
create policy listing_verifications_owner_read
  on public.listing_verifications for select
  to authenticated
  using (submitted_by = auth.uid());

-- Seller can insert a verification row for one of THEIR OWN listings.
drop policy if exists listing_verifications_owner_insert on public.listing_verifications;
create policy listing_verifications_owner_insert
  on public.listing_verifications for insert
  to authenticated
  with check (
    submitted_by = auth.uid()
    and exists (
      select 1 from public.listings l
      where l.listing_id = listing_verifications.listing_id
        and l.seller_id = auth.uid()
    )
  );

-- Admins can do anything.
drop policy if exists listing_verifications_admin_all on public.listing_verifications;
create policy listing_verifications_admin_all
  on public.listing_verifications for all
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 2. Denormalized verification state on listings
-- ---------------------------------------------------------------------------
-- 'verified' is the user-facing label; 'rejected' surfaces only to the seller
-- inside their dashboard so they know to re-submit; 'pending' is visible to
-- admin + seller; 'none' is the default and never displayed.
alter table public.listings
  add column if not exists verification_status text not null default 'none'
    check (verification_status in ('none', 'pending', 'verified', 'rejected'));

alter table public.listings
  add column if not exists verified_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Trigger: keep listings.verification_status synced from rows in
--    listing_verifications. Recompute on every INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------
create or replace function public.sync_listing_verification_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_listing_id uuid;
  approved_count    int;
  pending_count     int;
  rejected_count    int;
  approved_when     timestamptz;
  new_status        text;
  new_verified_at   timestamptz;
begin
  -- Find the affected listing — same on INSERT/UPDATE/DELETE.
  target_listing_id := coalesce(new.listing_id, old.listing_id);

  -- Count rows by status. 'verified' is sticky: any approved row means the
  -- listing is verified regardless of newer submissions.
  select
    count(*) filter (where status = 'approved'),
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'rejected'),
    max(reviewed_at) filter (where status = 'approved')
  into approved_count, pending_count, rejected_count, approved_when
  from public.listing_verifications
  where listing_id = target_listing_id;

  if approved_count > 0 then
    new_status      := 'verified';
    new_verified_at := approved_when;
  elsif pending_count > 0 then
    new_status      := 'pending';
    new_verified_at := null;
  elsif rejected_count > 0 then
    new_status      := 'rejected';
    new_verified_at := null;
  else
    new_status      := 'none';
    new_verified_at := null;
  end if;

  update public.listings
     set verification_status = new_status,
         verified_at         = new_verified_at
   where listing_id = target_listing_id;

  return null;  -- AFTER trigger, return value ignored
end;
$$;

drop trigger if exists trg_sync_listing_verification_status on public.listing_verifications;
create trigger trg_sync_listing_verification_status
  after insert or update or delete on public.listing_verifications
  for each row execute function public.sync_listing_verification_status();

-- ---------------------------------------------------------------------------
-- 4. Storage bucket: verification-videos (private)
-- ---------------------------------------------------------------------------
-- public=false → no anonymous reads. Admin generates signed URLs in the
-- moderation queue UI for playback. Sellers never need to read their own
-- videos back (they just submit them and wait for the decision).
insert into storage.buckets (id, name, public)
values ('verification-videos', 'verification-videos', false)
on conflict (id) do update set public = false;

-- Path convention: "{listing_id}/{verification_id}.mp4" (or .webm/.mov).
-- Sellers can INSERT into the folder of a listing they own.
drop policy if exists verification_videos_insert_owner on storage.objects;
create policy verification_videos_insert_owner
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'verification-videos'
    and exists (
      select 1 from public.listings l
      where l.listing_id::text = split_part(storage.objects.name, '/', 1)
        and l.seller_id = auth.uid()
    )
  );

-- Admins can do anything in the bucket — including SELECT for signed-URL
-- generation, UPDATE, and DELETE (which is what the cleanup cron uses).
drop policy if exists verification_videos_admin on storage.objects;
create policy verification_videos_admin
  on storage.objects for all
  using (bucket_id = 'verification-videos' and public.is_admin())
  with check (bucket_id = 'verification-videos' and public.is_admin());

-- Note: no public SELECT policy. Anonymous + authenticated-but-not-admin
-- users cannot list or read objects in this bucket. The seller who uploaded
-- a video can't even download it back — they don't need to.

-- =============================================================================
-- End of migration 020. Run order matters: this requires migration 019
-- (or any earlier migration that establishes the `public.is_admin()` helper
-- and the `listings`, `profiles`, `auth.users` tables) to have been run first.
-- =============================================================================
