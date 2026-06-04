-- =============================================================================
-- 047_storage_quotas_and_video_limits.sql
-- =============================================================================
-- Two storage hardening additions:
--
-- 1. Per-uploader byte quota on listing-images. Without it, one malicious or
--    buggy account could upload 50GB of garbage and drain the Supabase
--    Storage quota for the whole project. Cap is 500 MB per non-admin
--    uploader, enforced via a BEFORE INSERT trigger on storage.objects.
--    At our 5MB per-file cap (migration 045) that's a generous 100+ photos
--    per account — well above what any real collector needs.
--
-- 2. MIME + size limits on the verification-videos bucket. Migration 020
--    created the bucket without configuring allowed_mime_types or
--    file_size_limit, so any file type and size could be uploaded as long
--    as the seller owned the listing. Lock down to video formats only,
--    capped at 100 MB. The cap is sized for two distinct paths:
--      (a) Compressed output (typical): client-side lib/video-compression
--          re-encodes to 720p/600kbps, producing 3-10 MB for a 30-second
--          clip. Well below the cap.
--      (b) No-compression fallback (older Safari without MediaRecorder,
--          plus the catch-block in portal/index.html when compression
--          errors out): the raw iPhone source uploads as-is. A 30-second
--          4K HEVC clip can be 50-80 MB. 100 MB covers this with margin
--          but rejects anything materially larger — almost certainly
--          abuse or a misconfigured upload.
--
-- Both additions are pre-launch hardening agreed in the cybersec checklist
-- (see [[security-hardening-checklist]]). Per-uploader quota was a Tier 2
-- item promoted up; video bucket tightening was a gap I noticed while
-- working on (1) and bundled in to avoid a separate migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Per-uploader byte quota on listing-images
-- ---------------------------------------------------------------------------
-- The trigger function sums bytes already owned by the uploader in the
-- bucket, adds the incoming file's size, and rejects if the total would
-- exceed the cap. Admin users bypass entirely so manual backfills aren't
-- throttled.
--
-- Note on `owner`: storage.objects has an `owner` column populated from
-- auth.uid() at upload time. This is the canonical signal for "who put
-- this here." Filtering by owner is more reliable than parsing the path,
-- since path conventions can change.
--
-- 500 MB cap: deliberately generous. At the 5 MB-per-file ceiling, that's
-- 100+ photos; at the typical 200-400 KB compressed size, 1500-2500.
-- Either way, far past what any individual seller's catalog ever needs.

create or replace function public.enforce_listing_images_quota()
returns trigger
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_total_bytes bigint;
  v_new_bytes   bigint;
  v_cap_bytes   bigint := 524288000;  -- 500 MB
begin
  -- Only enforce on the listing-images bucket. Other buckets get their
  -- own enforcement (verification-videos handled below, etc.).
  if new.bucket_id <> 'listing-images' then
    return new;
  end if;

  -- Admin bypass. Guy (or any future admin) might do backfills, support
  -- uploads, etc. that shouldn't be throttled. Check is_admin via the
  -- profiles table since storage.objects doesn't know about app roles.
  if exists (
    select 1 from public.profiles
    where user_id = new.owner and is_admin = true
  ) then
    return new;
  end if;

  -- Pull the new file's size from the metadata jsonb. Storage's
  -- standard insert pipeline sets metadata->>'size' to the byte count.
  -- Coalesce to 0 so a missing field (shouldn't happen, but defensive)
  -- doesn't NULL out the math.
  v_new_bytes := coalesce((new.metadata->>'size')::bigint, 0);

  -- Sum the uploader's existing bytes in the bucket. Indexed by
  -- (bucket_id, owner) in Supabase's standard storage schema; this
  -- query stays fast even at scale.
  select coalesce(sum((metadata->>'size')::bigint), 0)
    into v_total_bytes
    from storage.objects
    where bucket_id = 'listing-images'
      and owner = new.owner;

  if v_total_bytes + v_new_bytes > v_cap_bytes then
    raise exception 'Storage quota exceeded for this account (500 MB cap). Delete old listing photos before uploading more, or contact admin@canvascircle.art if you believe this is in error.'
      using errcode = 'P0001';  -- raise_exception, propagates as a 500 from the storage API but with the message intact
  end if;

  return new;
end $$;

drop trigger if exists enforce_listing_images_quota_trg on storage.objects;
create trigger enforce_listing_images_quota_trg
  before insert on storage.objects
  for each row execute function public.enforce_listing_images_quota();

-- ---------------------------------------------------------------------------
-- 2. verification-videos bucket MIME + size limits
-- ---------------------------------------------------------------------------
-- Migration 020 created this bucket without restrictions because at the
-- time the only enforcement was RLS-by-listing-ownership (so the worst
-- case was a seller wasting their own quota). Now that we're tightening
-- pre-launch, layer MIME + size caps so the server refuses garbage
-- uploads at the storage REST level, not just RLS.
--
-- 100 MB cap: 30-second clips. Compressed via lib/video-compression
-- (target 720p / 600 kbps) typically land 3-10 MB. The no-compression
-- fallback (older Safari + the catch-block in the submit handler) lets
-- raw iPhone clips through — a 30s 4K HEVC capture can be 50-80 MB.
-- 100 MB covers both paths with margin while still rejecting outliers.
--
-- MIME allowlist:
--   video/mp4       — primary capture format on most devices; also
--                     produced by MediaRecorder when MP4/AVC1 is the
--                     selected codec (iOS Safari preference)
--   video/webm      — Android Chrome / desktop MediaRecorder output
--                     (VP8 or VP9 inside WebM container)
--   video/quicktime — iPhone .mov fallback when the recorder produces it

update storage.buckets
set
  allowed_mime_types = array['video/mp4', 'video/webm', 'video/quicktime'],
  file_size_limit    = 104857600  -- 100 MB
where id = 'verification-videos';

-- Sanity check.
do $$
declare
  v_allowed text[];
  v_limit   bigint;
begin
  select allowed_mime_types, file_size_limit
    into v_allowed, v_limit
    from storage.buckets
    where id = 'verification-videos';
  if v_allowed is null then
    raise exception 'verification-videos bucket not found or update failed';
  end if;
  raise notice 'verification-videos allowed_mime_types = %, file_size_limit = %', v_allowed, v_limit;
end $$;

-- =============================================================================
-- End of migration 047.
-- =============================================================================
