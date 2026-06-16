// =============================================================================
// backup-to-r2 — nightly Cloudflare R2 mirror of image storage buckets
// =============================================================================
// Deploy with:
//   cd /Users/gjscuderi/Documents/CanvasCircle_2
//   supabase functions deploy backup-to-r2 --no-verify-jwt
//
// Required Supabase secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   R2_ACCOUNT_ID          — Cloudflare account ID (from R2 dashboard)
//   R2_ACCESS_KEY_ID       — R2 API token "Access Key ID"
//   R2_SECRET_ACCESS_KEY   — R2 API token "Secret Access Key"
//   R2_BUCKET_NAME         — destination bucket (e.g. "canvascircle-image-backup")
//
// Set them with:
//   supabase secrets set R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
//                        R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=...
//
// Auth model (same pattern as saved-search-fanout, see
//   [[supabase-new-key-format-internal-fn-calls]] memory):
//   - Deployed --no-verify-jwt so the gateway accepts requests without
//     a JWT (sb_secret_ keys aren't JWTs).
//   - Internal apikey check at top of handler verifies caller presented
//     the SERVICE_ROLE_KEY. The pg_cron job + manual `supabase functions
//     invoke` from the CLI both supply this.
//
// Trigger points (callers):
//   1. pg_cron nightly job (set up after this function is deployed +
//      verified; see db/migrations for the cron migration).
//   2. Manual invoke from CLI for the initial backfill and for ad-hoc
//      verification runs.
//
// Request body (all optional):
//   {
//     buckets?: string[],  // default: ["listing-images", "collection-images"]
//     mode?: "incremental" | "full",  // default: "incremental"
//     dry_run?: boolean,   // default: false — list-only, no R2 writes
//     note?: string        // free-form annotation stored in backup_runs.notes
//   }
//
// Mode semantics:
//   - "incremental": only syncs files whose Storage created_at is
//     STRICTLY GREATER than the synced_through of the most recent
//     successful run for that bucket. This is the normal nightly mode.
//   - "full": ignores prior runs and walks the whole bucket. Used for
//     the one-time backfill and for occasional integrity verification.
//
// Flow per bucket:
//   1. Open a "running" backup_runs row so concurrent invocations can
//      see each other (though we don't currently lock — pg_cron runs
//      once per night so contention is unlikely).
//   2. List Supabase Storage objects under the bucket (paginated).
//   3. For each object newer than the cutoff:
//      a. Download from Supabase Storage (server-side download via
//         service-role storage API).
//      b. PUT to R2 at the same key path. R2 is S3-compatible so the
//         AWS SDK works unchanged once endpoint is set.
//      c. Track count + total bytes.
//   4. Close the run row with status='success' (or 'partial' if any
//      file failed) and synced_through = max(created_at) of files
//      processed.
//
// Idempotency / safety:
//   - R2 PUTs are unconditional; re-running on the same files just
//     overwrites the same content. No risk of duplicates.
//   - If a run crashes mid-way, the next incremental run picks up from
//     the LAST SUCCESSFUL synced_through (NOT the partial one), so we
//     may re-upload some files that already made it. That's fine and
//     keeps the logic simple.
// =============================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// aws4fetch instead of the full AWS SDK: the SDK's npm: import on Deno
// has multi-tens-of-seconds cold-start and unreliable body handling
// under V8 isolates (symptom: 7 Class A R2 ops registered but 0 bytes
// stored on a 99-file backfill attempt). aws4fetch is a ~10KB AWS Sig
// v4 signer that wraps the native fetch() API — same R2 protocol, no
// SDK weight, body bytes go through cleanly because we just pass them
// to fetch directly.
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const R2_ACCOUNT_ID        = Deno.env.get("R2_ACCOUNT_ID") ?? "";
const R2_ACCESS_KEY_ID     = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
const R2_BUCKET_NAME       = Deno.env.get("R2_BUCKET_NAME") ?? "";

// Default buckets to back up. listing-images is the catalog source of
// truth; collection-images backs the per-collector public Collection
// pages. We deliberately exclude verification-videos (PII, larger,
// recovery story is "re-record"). If we ever add another image bucket
// (Sales Post collages?) add it here.
const DEFAULT_BUCKETS = ["listing-images", "collection-images"];

const PAGE_SIZE = 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface StorageObject {
  name: string;
  id: string;
  created_at: string;
  updated_at: string;
  metadata: { size?: number; mimetype?: string } | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json(405, { error: "POST only" });

  // Internal auth — service-role key in `apikey` header. Same pattern
  // as saved-search-fanout. Mismatched key 401s instantly.
  const callerKey = req.headers.get("apikey") || req.headers.get("Apikey");
  if (!callerKey || callerKey !== SERVICE_KEY) {
    return json(401, { error: "Unauthorized" });
  }

  // Validate required R2 config before doing any work.
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
    return json(500, {
      error: "Missing R2 configuration",
      hint: "Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME via `supabase secrets set`.",
    });
  }

  let body: {
    buckets?: string[];
    mode?: "incremental" | "full";
    dry_run?: boolean;
    note?: string;
    limit?: number;
  } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const buckets = Array.isArray(body.buckets) && body.buckets.length > 0
    ? body.buckets
    : DEFAULT_BUCKETS;
  const mode    = body.mode === "full" ? "full" : "incremental";
  const dryRun  = body.dry_run === true;
  // Per-invocation file cap (applies across all buckets combined).
  // The Supabase edge function gateway has a 150-second idle timeout,
  // and our worst-case is ~1.5s per file (download from Storage +
  // upload to R2). A limit of ~40 leaves comfortable headroom while
  // letting a single curl finish a meaningful chunk. Caller can
  // override with `limit` in the body; 0 / negative / missing means
  // "no limit" (use when you know the run will fit, like the nightly
  // incremental that only handles a handful of new files).
  const limit = Number.isFinite(body.limit) && (body.limit as number) > 0
    ? Math.floor(body.limit as number)
    : 0;

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // aws4fetch client — region="auto" + service="s3" is the canonical
  // pairing for Cloudflare R2's S3-compatible endpoint. The signer
  // computes AWS Sig v4 against each fetch() call we make. No
  // long-lived connection / cold-start cost.
  const r2 = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    region: "auto",
    service: "s3",
  });
  const r2Endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  const results: Record<string, unknown> = {};
  // Budget tracker shared across buckets. Each syncBucket call
  // decrements remaining; when it hits 0 subsequent buckets are
  // skipped with a "deferred" marker so the caller knows to invoke
  // again. Mutated by the helper.
  const budget = { remaining: limit > 0 ? limit : Infinity };

  for (const bucket of buckets) {
    if (budget.remaining <= 0) {
      results[bucket] = { status: "deferred", reason: "limit reached on a previous bucket this run" };
      continue;
    }
    try {
      results[bucket] = await syncBucket({
        supabase,
        r2,
        r2Endpoint,
        bucket,
        mode,
        dryRun,
        note: body.note || null,
        budget,
      });
    } catch (err) {
      results[bucket] = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return json(200, {
    ok: true,
    mode,
    dry_run: dryRun,
    limit: limit > 0 ? limit : null,
    results,
  });
});

async function syncBucket(opts: {
  supabase: ReturnType<typeof createClient>;
  r2: AwsClient;
  r2Endpoint: string;
  bucket: string;
  mode: "incremental" | "full";
  dryRun: boolean;
  note: string | null;
  budget: { remaining: number };
}) {
  const { supabase, r2, r2Endpoint, bucket, mode, dryRun, note, budget } = opts;

  // Resolve the cutoff. Incremental mode reads the most-recent
  // SUCCESSFUL run's synced_through. Full mode starts from epoch zero.
  let cutoff = new Date(0).toISOString();
  if (mode === "incremental") {
    const { data, error } = await supabase
      .from("backup_runs")
      .select("synced_through")
      .eq("bucket_name", bucket)
      .eq("status", "success")
      .order("synced_through", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`Failed to read last successful run: ${error.message}`);
    if (data?.synced_through) cutoff = data.synced_through;
  }

  // Open a "running" row so we can update it at the end. If we crash
  // mid-run the row stays as 'running' and we'll spot it in monitoring;
  // the next incremental run still reads from the last SUCCESS so we
  // don't lose data.
  let runId: string | null = null;
  if (!dryRun) {
    const { data, error } = await supabase
      .from("backup_runs")
      .insert({
        bucket_name: bucket,
        synced_through: cutoff,
        status: "running",
        notes: note ? { note, mode } : { mode },
      })
      .select("id")
      .single();
    if (error) throw new Error(`Failed to open backup_runs row: ${error.message}`);
    runId = data.id;
  }

  let filesSynced = 0;
  let bytesSynced = 0;
  let filesRemaining = 0;
  let maxSeen = cutoff;
  const failures: { path: string; error: string }[] = [];
  let limitHit = false;

  // Recursive bucket walk. Different image buckets use different
  // path depths — listing-images is "<seller_id>/<filename>" (2 levels)
  // while collection-images is "<user_id>/<item_id>/<filename>" (3
  // levels). The previous implementation hard-coded a 2-level walk and
  // silently missed every collection image. walkBucket recurses
  // depth-first into any entry that doesn't look like a file (no `id`),
  // so the function works on any depth without further changes if a
  // future bucket nests deeper.
  //
  // Flatten + sort eligible candidates by created_at ascending so that
  // when the per-invocation budget caps us partway through, we always
  // process the OLDEST not-yet-backed-up files first. That guarantees
  // the next invocation's incremental-mode cutoff (which uses the max
  // synced_through across successful runs) moves forward monotonically
  // without leaving gaps in the middle.
  type Candidate = { obj: StorageObject; folder: string };
  const candidates: Candidate[] = await walkBucket(supabase, bucket, "", mode, cutoff);
  candidates.sort((a, b) => a.obj.created_at.localeCompare(b.obj.created_at));

  for (const { obj, folder } of candidates) {
    if (budget.remaining <= 0) {
      filesRemaining = candidates.length - (filesSynced + failures.length);
      limitHit = true;
      break;
    }
    const result = await processObject(obj, folder, { supabase, r2, r2Endpoint, bucket, dryRun });
    if (result.ok) {
      filesSynced++;
      bytesSynced += result.bytes;
      if (result.createdAt > maxSeen) maxSeen = result.createdAt;
    } else {
      failures.push({ path: folder ? `${folder}/${obj.name}` : obj.name, error: result.error });
    }
    budget.remaining--;
  }
  // If we didn't hit the limit, the bucket is fully drained for this
  // cutoff — anything still in the bucket is older than what we just
  // processed and was already covered by a prior run.
  if (!limitHit) filesRemaining = 0;

  const status = failures.length === 0 ? "success" : "partial";

  if (runId) {
    const { error } = await supabase
      .from("backup_runs")
      .update({
        run_finished_at: new Date().toISOString(),
        synced_through: maxSeen,
        files_synced: filesSynced,
        bytes_synced: bytesSynced,
        status,
        error_message: failures.length ? `${failures.length} file(s) failed` : null,
        notes: {
          mode,
          ...(note ? { note } : {}),
          ...(failures.length ? { failures: failures.slice(0, 50) } : {}),
        },
      })
      .eq("id", runId);
    if (error) {
      // Non-fatal — the run still happened. Log into the response.
      return {
        status: "completed_but_unable_to_persist",
        files_synced: filesSynced,
        bytes_synced: bytesSynced,
        synced_through: maxSeen,
        persist_error: error.message,
        failures: failures.slice(0, 10),
      };
    }
  }

  return {
    status,
    run_id: runId,
    files_synced: filesSynced,
    bytes_synced: bytesSynced,
    synced_through: maxSeen,
    limit_hit: limitHit,
    files_remaining: filesRemaining,
    failures: failures.slice(0, 10),
  };
}

// Depth-first recursive walk of a Supabase Storage bucket. Returns a
// flat list of file candidates with their containing folder path
// (relative to the bucket root). Folders are detected by entries
// missing an `id` (Supabase Storage convention). Already filters by
// `cutoff` in incremental mode so we don't pull huge lists of objects
// we'll never touch.
async function walkBucket(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
  mode: "incremental" | "full",
  cutoff: string,
): Promise<{ obj: StorageObject; folder: string }[]> {
  const out: { obj: StorageObject; folder: string }[] = [];
  const entries = await listAll(supabase, bucket, prefix);
  for (const entry of entries) {
    if (entry.id) {
      // File
      if (mode === "incremental" && entry.created_at <= cutoff) continue;
      out.push({ obj: entry, folder: prefix });
    } else {
      // Folder — recurse
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const deeper = await walkBucket(supabase, bucket, childPrefix, mode, cutoff);
      out.push(...deeper);
    }
  }
  return out;
}

async function listAll(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const all: StorageObject[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: PAGE_SIZE,
      offset,
      sortBy: { column: "created_at", order: "asc" },
    });
    if (error) throw new Error(`Storage list failed for ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as StorageObject[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function processObject(
  obj: StorageObject,
  folder: string,
  opts: {
    supabase: ReturnType<typeof createClient>;
    r2: AwsClient;
    r2Endpoint: string;
    bucket: string;
    dryRun: boolean;
  },
): Promise<
  | { ok: true; bytes: number; createdAt: string }
  | { ok: false; error: string }
> {
  const { supabase, r2, r2Endpoint, bucket, dryRun } = opts;
  const key = folder ? `${folder}/${obj.name}` : obj.name;

  if (dryRun) {
    return { ok: true, bytes: obj.metadata?.size ?? 0, createdAt: obj.created_at };
  }

  try {
    const { data: blob, error } = await supabase.storage.from(bucket).download(key);
    if (error || !blob) {
      return { ok: false, error: `download: ${error?.message ?? "no data"}` };
    }
    const buf = new Uint8Array(await blob.arrayBuffer());

    // R2 key uses a bucket-prefixed path so multiple Supabase buckets
    // can share one R2 bucket without colliding. e.g.:
    //   listing-images/abc-uuid/0-1234567890.webp →
    //     listing-images/abc-uuid/0-1234567890.webp under R2
    const r2Key = `${bucket}/${key}`;
    const url = `${r2Endpoint}/${R2_BUCKET_NAME}/${encodeR2Key(r2Key)}`;
    const contentType = obj.metadata?.mimetype || blob.type || "application/octet-stream";

    const res = await r2.fetch(url, {
      method: "PUT",
      body: buf,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(buf.byteLength),
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `r2 PUT ${res.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true, bytes: buf.byteLength, createdAt: obj.created_at };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Encode each path segment so spaces / unicode / etc. survive the URL,
// but DON'T escape the slashes between segments — R2 expects them
// literally in the path.
function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
