-- =============================================================================
-- 021_verification_video_cleanup.sql
-- =============================================================================
-- Daily cleanup job for ownership-verification videos.
--
-- Retention policy: video bytes are deleted 1 day after admin review.
-- Rationale:
--   - Once an admin has approved or rejected a submission, the video has
--     served its purpose. It no longer appears anywhere in the admin UI.
--   - Storing video bytes longer than necessary is a privacy + storage
--     liability with no operational benefit.
--   - The 1-day buffer exists only as a recovery window in case an admin
--     wants to re-review immediately after the decision; not a hard SLA.
--
-- WHY pg_net (not direct DELETE on storage.objects):
--   Supabase's storage extension installs a protect_delete trigger that
--   forbids direct SQL deletion of storage rows ("Direct deletion from
--   storage tables is not allowed. Use the Storage API instead."). The
--   canonical way to delete a storage object from SQL is to call the
--   Storage REST API via pg_net using the service role key. The service
--   role key is kept in Supabase Vault (`vault.decrypted_secrets`) so it
--   isn't hardcoded into the migration.
--
-- PREREQS (do these BEFORE running this migration):
--   1. Enable extensions: pg_cron, pg_net  (Database → Extensions)
--   2. Add two Vault secrets (Project Settings → Vault → New Secret):
--        name = 'project_url'       value = https://<your-ref>.supabase.co
--        name = 'service_role_key'  value = <your service_role API key>
--
-- WHAT IS PRESERVED (forever):
--   - The listing_verifications row itself (id, listing_id, submitted_by)
--   - status (pending/approved/rejected) — the audit decision
--   - video_hash — SHA-256 for cross-listing reuse detection
--   - video_size_bytes, video_duration_sec — submission metadata
--   - submitted_at, reviewed_at, reviewed_by, review_notes — audit trail
--   - video_deleted_at — set to now() when bytes are wiped
--
-- WHAT IS DELETED (1 day after review):
--   - The object in the verification-videos storage bucket (via HTTP API)
--   - listing_verifications.video_storage_path is nulled
--
-- The denormalized listings.verification_status is NOT affected — once
-- verified, listings stay verified per the sticky-verified semantics.
-- =============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop any prior version of the function. Needed because the return type
-- changed between the original (cleaned_count, scanned_count) and the
-- pg_net rewrite (which adds failed_count) — CREATE OR REPLACE can't
-- redefine the return shape of an existing function.
drop function if exists public.cleanup_verification_videos();

-- ---------------------------------------------------------------------------
-- 1. The cleanup function.
--
--    SECURITY DEFINER so it can read vault.decrypted_secrets and write
--    to public.listing_verifications regardless of who invokes it (the
--    cron job runs as the postgres role; this also lets an admin trigger
--    it manually).
--
--    Mechanics:
--      - For each eligible row: fire an async HTTP DELETE to the Storage
--        API, then wait for the response synchronously.
--      - Treat 200/204 (deleted) AND 404 (already gone) as success and
--        proceed to null the path + stamp video_deleted_at.
--      - Any other status leaves the row alone so the next run retries.
-- ---------------------------------------------------------------------------
create or replace function public.cleanup_verification_videos()
returns table (
  cleaned_count int,
  scanned_count int,
  failed_count  int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record       record;
  v_cleaned      int := 0;
  v_scanned      int := 0;
  v_failed       int := 0;
  v_project_url  text;
  v_service_key  text;
  v_url          text;
  v_row_ids      uuid[] := array[]::uuid[];
  v_paths        text[] := array[]::text[];
  v_max_wait_s   int    := 60;  -- shared wait for storage to reflect deletes
  v_waited       int;
  v_pending      int;
  v_still_exists boolean;
begin
  -- Pull project URL + service role key from Vault.
  select decrypted_secret into v_project_url
    from vault.decrypted_secrets
   where name = 'project_url';
  select decrypted_secret into v_service_key
    from vault.decrypted_secrets
   where name = 'service_role_key';

  if v_project_url is null or v_service_key is null then
    raise exception 'Missing Vault secret(s): need both "project_url" and "service_role_key" set under Project Settings → Vault.';
  end if;

  -- ---------- PHASE 1: fire DELETE requests for every eligible row ----------
  -- We use pg_net's async http_delete and don't bother tracking request_ids.
  -- Ground truth lives in storage.objects: when Supabase finishes a delete,
  -- the row disappears from that table. We'll watch THERE instead of trying
  -- to race pg_net's response polling.
  for v_record in
    select id, video_storage_path
      from public.listing_verifications
     where video_storage_path is not null
       and reviewed_at is not null
       and reviewed_at < (now() - interval '1 day')
  loop
    v_scanned := v_scanned + 1;

    v_url := v_project_url
          || '/storage/v1/object/verification-videos/'
          || v_record.video_storage_path;

    perform net.http_delete(
      url     := v_url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_service_key,
        'apikey',        v_service_key
      )
    );

    v_row_ids := array_append(v_row_ids, v_record.id);
    v_paths   := array_append(v_paths, v_record.video_storage_path);
  end loop;

  if v_scanned = 0 then
    return query select 0, 0, 0;
    return;
  end if;

  -- ---------- PHASE 2: wait until all target paths have left storage ----------
  -- Poll storage.objects directly. As soon as a path no longer has a row,
  -- the underlying S3 object is gone and we can reconcile. We watch up to
  -- v_max_wait_s seconds; anything still present after that gets left
  -- alone and will be retried on the next cron run.
  v_waited := 0;
  loop
    select count(*) into v_pending
      from unnest(v_paths) as p
     where exists (
       select 1 from storage.objects
        where bucket_id = 'verification-videos'
          and name = p
     );
    exit when v_pending = 0;
    exit when v_waited >= v_max_wait_s;
    perform pg_sleep(1);
    v_waited := v_waited + 1;
  end loop;

  -- ---------- PHASE 3: reconcile rows against actual storage state ----------
  for i in 1..array_length(v_paths, 1) loop
    select exists (
      select 1 from storage.objects
       where bucket_id = 'verification-videos'
         and name = v_paths[i]
    ) into v_still_exists;

    if not v_still_exists then
      update public.listing_verifications
         set video_storage_path = null,
             video_deleted_at   = now()
       where id = v_row_ids[i];
      v_cleaned := v_cleaned + 1;
    else
      v_failed := v_failed + 1;
      raise notice 'verification-video still present after delete: row_id=% path=%',
        v_row_ids[i], v_paths[i];
    end if;
  end loop;

  return query select v_cleaned, v_scanned, v_failed;
end;
$$;

-- Lock the function down — anonymous + authenticated users should never
-- be able to call this. Only the postgres role (cron) and admins.
revoke all on function public.cleanup_verification_videos() from public;
revoke all on function public.cleanup_verification_videos() from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Schedule the job via pg_cron.
--    Runs every day at 03:17 UTC (off-peak). The jobname is stable so
--    re-running this migration replaces the existing schedule rather
--    than duplicating it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
    from cron.job
   where jobname = 'cleanup-verification-videos';
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
end $$;

select cron.schedule(
  'cleanup-verification-videos',
  '17 3 * * *',
  $$select public.cleanup_verification_videos();$$
);

-- =============================================================================
-- End of migration 021. Requires migration 020 (listing_verifications +
-- verification-videos bucket), the pg_cron and pg_net extensions, and the
-- two Vault secrets listed in the PREREQS comment above.
-- =============================================================================
