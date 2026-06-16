-- =============================================================================
-- 065_r2_backup_runs.sql
-- =============================================================================
-- Tracking table for the nightly Cloudflare R2 backup of CanvasCircle
-- image buckets (listing-images + collection-images). Used by the
-- backup-to-r2 edge function to make the sync idempotent and to give
-- us a paper trail of what ran when.
--
-- Background (see [[deployment-pipeline]] for the broader context):
-- All listing + collection images currently live only in Supabase
-- Storage. That's a single point of failure if the Supabase project
-- gets suspended, a bucket gets accidentally dropped, or a bug
-- overwrites files. R2 is cheap insurance against that single-vendor
-- risk (storage at $0.015/GB/month, no egress, S3-compatible API). We
-- DON'T back up the verification-videos bucket — it's PII (faces +
-- spoken challenge codes), larger, and the recovery story is "ask the
-- seller to re-record" which is acceptable.
--
-- The function reads the most-recent successful run per bucket and
-- only syncs files created after that timestamp. New rows get inserted
-- per-bucket per-run so we can see drift and debug failures.
--
-- Access model:
--   * Reads + writes go through the service role only — no public RPC
--     surface, no anon SELECT. Backup state is operational data; sellers
--     and admin UI don't need to see it. If we want a status panel later
--     we can add a SECURITY DEFINER RPC.
--   * RLS enabled but no policies, so PostgREST anon/auth requests get
--     zero rows by default. The edge function uses the service role
--     which bypasses RLS.
-- =============================================================================

create table if not exists public.backup_runs (
  id              uuid primary key default gen_random_uuid(),
  bucket_name     text not null,
  -- The "high water mark" for this run — files in the bucket whose
  -- created_at is <= this value are considered backed up. The next
  -- run uses MAX(synced_through) WHERE status='success' as its
  -- starting point.
  synced_through  timestamptz not null,
  run_started_at  timestamptz not null default now(),
  run_finished_at timestamptz,
  files_synced    integer not null default 0,
  bytes_synced    bigint  not null default 0,
  status          text    not null default 'running'
    check (status in ('running', 'success', 'partial', 'failed')),
  error_message   text,
  -- Free-form per-run notes — e.g. "backfill" for the one-time
  -- historical sync, or specific file paths that failed within an
  -- otherwise-successful run.
  notes           jsonb
);

-- Lookup index for "what was the last successful run for this bucket".
create index if not exists backup_runs_bucket_status_idx
  on public.backup_runs (bucket_name, status, synced_through desc);

-- General time-ordered lookup for debugging / status panels.
create index if not exists backup_runs_started_idx
  on public.backup_runs (run_started_at desc);

alter table public.backup_runs enable row level security;
-- Intentionally no policies — service role only. PostgREST callers
-- (anon / authenticated) will see zero rows, which is what we want.

comment on table public.backup_runs is
  'Tracks nightly R2 backup runs for image buckets. Service-role only. See db/migrations/065_r2_backup_runs.sql.';
