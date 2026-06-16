-- =============================================================================
-- 066_r2_backup_cron.sql
-- =============================================================================
-- Schedules the nightly Cloudflare R2 backup of image storage buckets
-- via pg_cron. Pairs with the backup-to-r2 edge function deployed
-- in supabase/functions/backup-to-r2/ and the tracking table from
-- migration 065_r2_backup_runs.sql.
--
-- Trigger time: 4:00 AM UTC = midnight EST in winter / 12:00 AM EDT in
-- summer. Picked because that's the low-traffic window for CanvasCircle
-- (most sellers are US-based and asleep). The job only needs ~10
-- seconds for a handful of new files, so it doesn't compete with any
-- daytime workload.
--
-- ARCHITECTURE
--
-- pg_cron jobs run as the postgres role inside the database. They have
-- no access to edge function env vars (where SUPABASE_SERVICE_ROLE_KEY
-- lives), so we have to provide the auth key separately. The standard
-- Supabase pattern is to store it in vault.secrets — encrypted at rest,
-- readable only by SECURITY DEFINER functions.
--
-- Flow per nightly run:
--   1. cron.schedule fires public.cron_backup_to_r2() at 4 AM UTC.
--   2. That function reads the service role key from vault.
--   3. It calls pg_net.http_post against the backup-to-r2 edge fn
--      with `mode: "incremental"` so only NEW files since the last
--      successful run get processed.
--   4. The edge function logs a row in backup_runs and the run-id
--      can be cross-referenced against pg_net's request_id we return
--      from this wrapper.
--
-- MANUAL SETUP STEP REQUIRED BEFORE THIS CRON WILL WORK
--
-- The migration cannot embed the service role key directly (secrets
-- don't belong in version control). Once this migration is applied,
-- run the following ONCE via the Supabase Dashboard SQL Editor,
-- substituting your actual sb_secret_* value:
--
--   select vault.create_secret(
--     'sb_secret_REPLACE_ME',
--     'cron_service_role_key',
--     'Service role key used by the nightly R2 backup cron job'
--   );
--
-- Verify with:
--   select name, created_at from vault.decrypted_secrets where name = 'cron_service_role_key';
--
-- The vault secret is read by public.cron_backup_to_r2() at call time,
-- so a rotation later is: vault.update_secret(...) only — no code
-- redeploy needed.
--
-- MONITORING
--
-- After the first scheduled run lands, check it worked:
--   select * from cron.job_run_details
--    where jobname = 'r2-backup-nightly'
--    order by start_time desc limit 5;
--
--   select bucket_name, status, files_synced, bytes_synced,
--          synced_through, run_started_at
--   from public.backup_runs
--   order by run_started_at desc limit 10;
-- =============================================================================

-- Both extensions are typically pre-enabled on Supabase Pro projects,
-- but guard with IF NOT EXISTS so re-running the migration is safe.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Wrapper function. SECURITY DEFINER so it can read vault.decrypted_secrets
-- (which is locked to specific roles); the cron job runs as postgres
-- but our SECURITY DEFINER promotion lets it through. Returns the
-- pg_net request_id so we can correlate the HTTP call with its eventual
-- response in net._http_response if we ever need to debug a silent
-- failure.
create or replace function public.cron_backup_to_r2()
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_key        text;
  v_request_id bigint;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'cron_service_role_key'
  limit 1;

  if v_key is null then
    raise exception
      'cron_service_role_key not found in vault. Run vault.create_secret(...) — see 066_r2_backup_cron.sql header.';
  end if;

  select net.http_post(
    url     := 'https://xwieomjsqwcswoadrvkv.supabase.co/functions/v1/backup-to-r2',
    headers := jsonb_build_object(
      'apikey',       v_key,
      'Content-Type', 'application/json'
    ),
    body    := jsonb_build_object(
      'mode', 'incremental',
      'note', 'pg_cron nightly'
    ),
    -- Edge fn timeout is 150s; pg_net's own timeout default is 5s
    -- which would CANCEL successful slow runs. Bump to 180s so it
    -- only fires if the edge fn truly hangs.
    timeout_milliseconds := 180000
  ) into v_request_id;

  return v_request_id;
end;
$$;

comment on function public.cron_backup_to_r2() is
  'Called nightly by pg_cron job r2-backup-nightly. Reads service role key from vault and POSTs to the backup-to-r2 edge function. See 066_r2_backup_cron.sql.';

-- Idempotent schedule: drop any existing job by this name first so
-- re-running the migration replaces the schedule cleanly instead of
-- erroring on a duplicate.
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid from cron.job where jobname = 'r2-backup-nightly';
  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end $$;

select cron.schedule(
  'r2-backup-nightly',
  '0 4 * * *',  -- daily at 04:00 UTC
  $$select public.cron_backup_to_r2();$$
);
