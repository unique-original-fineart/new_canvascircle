# R2 Backup Restore Runbook

Last updated 2026-06-15 (cc-v214, after the initial backfill of 100 listing-images + 6 collection-images to `canvascircle-image-backup`).

## What this is

Step-by-step instructions for pulling image data back from the Cloudflare R2 backup into Supabase Storage. The nightly `backup-to-r2` edge function (cron: `r2-backup-nightly`, 4 AM UTC daily) maintains a mirror of two buckets in R2:

- `listing-images/` (catalog artwork photos)
- `collection-images/` (per-collector personal collection photos)

If anything ever goes wrong with Supabase Storage — accidental deletion, bucket drop, project suspension during a billing dispute, corruption from a bad migration — the R2 mirror is the recovery source.

## Before you do anything, diagnose

Don't restore reflexively. Most "missing image" reports turn out to be:

1. **Wrong bucket lookup in the frontend.** Check the browser console for the actual storage URL — sometimes it's a 404 from a stale `storage_path` value in the `listings` or `collection_items` row, not actual file loss.
2. **RLS policy change.** Check whether the file is genuinely gone from Storage, or just blocked at the read layer.
3. **A single seller's image vs. all images.** A user reporting "my images are missing" usually means one row, not bucket-wide loss.

Quick diagnostic SQL:

```sql
-- Does the row even point at a real path?
select listing_id, listing_type, status, listing_images
from public.listings
where listing_id = '<the-listing-uuid>';

-- Try fetching the path via service role to bypass RLS as a sanity check.
-- Use the Storage section of the Supabase dashboard with service role
-- toggled, or curl with service role key in Authorization header.
```

If you've confirmed the file truly doesn't exist in Supabase Storage but the `listing_images.storage_path` still references it, that's when this runbook applies.

## What you'll need

- The R2 API token credentials from when the backup system was set up (see `db/migrations/065_r2_backup_runs.sql` + `supabase/functions/backup-to-r2/index.ts`). Specifically:
  - `R2_ACCOUNT_ID` (the 32-char hex Cloudflare Account ID)
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `R2_BUCKET_NAME` (= `canvascircle-image-backup`)
- The Supabase service role key (the same `sb_secret_*` Default value used by every other ops task)
- `aws` CLI installed locally (or `rclone` if you prefer — both work against R2)

Install AWS CLI on Mac if not already:

```bash
brew install awscli
```

## Setup: one-time AWS CLI profile for R2

R2 is S3-compatible, so the AWS CLI talks to it natively as long as you point at the right endpoint. Configure a dedicated profile to avoid mixing it with any real AWS credentials you might have:

```bash
aws configure --profile cc-r2 set aws_access_key_id YOUR_R2_ACCESS_KEY_ID
aws configure --profile cc-r2 set aws_secret_access_key YOUR_R2_SECRET_ACCESS_KEY
aws configure --profile cc-r2 set region auto
aws configure --profile cc-r2 set output json
```

Set an env var with the R2 endpoint so you don't have to retype it every command:

```bash
export R2_ENDPOINT="https://YOUR_R2_ACCOUNT_ID.r2.cloudflarestorage.com"
```

Verify it works by listing the top of the backup bucket:

```bash
aws s3 ls s3://canvascircle-image-backup/ --profile cc-r2 --endpoint-url $R2_ENDPOINT
```

You should see two prefixes: `listing-images/` and `collection-images/`.

## Scenario 1: restore a single file

Most common case. One listing or collection item has lost its image but the database row still references the path.

**Path conventions inside R2** (these are the same paths you'll write back to Supabase Storage, just with the bucket prefix stripped):

- Listing image: `listing-images/<seller_uuid>/<filename>.webp`
- Collection item image: `collection-images/<user_uuid>/<item_uuid>/image.webp`

Where to find the path: in the database row's `storage_path` column (for collection items) or `listing_images.storage_path` (for listings).

**Step 1: download the file from R2**

```bash
# Replace the path with the real one. Example below restores
# a specific listing image.
aws s3 cp \
  "s3://canvascircle-image-backup/listing-images/abc-uuid/0-1234567890.webp" \
  ./restore.webp \
  --profile cc-r2 --endpoint-url $R2_ENDPOINT
```

You should see "download" output and a local `restore.webp` file.

**Step 2: upload it back to Supabase Storage**

Set your service role key in a shell variable (same `$KEY` pattern used throughout ops):

```bash
KEY="sb_secret_PASTE_REAL_VALUE_HERE"
```

Use the Supabase Storage REST API to PUT the file at the original path. The path is the R2 key MINUS the leading `<bucket-name>/` prefix:

```bash
curl -X POST \
  "https://xwieomjsqwcswoadrvkv.supabase.co/storage/v1/object/listing-images/abc-uuid/0-1234567890.webp" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: image/webp" \
  --data-binary "@./restore.webp"
```

Expected response: `{"Key":"listing-images/abc-uuid/0-1234567890.webp"}` (HTTP 200).

If you get `Duplicate` or `already exists` errors, switch from POST to PUT — POST refuses to overwrite, PUT will:

```bash
curl -X PUT \
  "https://xwieomjsqwcswoadrvkv.supabase.co/storage/v1/object/listing-images/abc-uuid/0-1234567890.webp" \
  -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: image/webp" \
  --data-binary "@./restore.webp"
```

**Step 3: verify**

Refresh the public catalog or listing page in a browser, force a hard reload (Cmd+Shift+R). The image should render. If you still see a broken image, check the browser network tab for the actual URL being requested and confirm it matches what you restored.

## Scenario 2: restore an entire bucket

Rare but catastrophic. Use this if `listing-images` or `collection-images` is fully gone or empty.

**Step 1: bulk-download the entire bucket prefix from R2 to local disk**

```bash
mkdir -p ./r2-restore/listing-images
aws s3 sync \
  "s3://canvascircle-image-backup/listing-images/" \
  ./r2-restore/listing-images/ \
  --profile cc-r2 --endpoint-url $R2_ENDPOINT
```

Same for collection-images:

```bash
mkdir -p ./r2-restore/collection-images
aws s3 sync \
  "s3://canvascircle-image-backup/collection-images/" \
  ./r2-restore/collection-images/ \
  --profile cc-r2 --endpoint-url $R2_ENDPOINT
```

This pulls down everything in those R2 prefixes into matching local folders. With ~177 MB total today, the whole download takes seconds. Verify file count matches what you expect:

```bash
find ./r2-restore/listing-images -type f | wc -l
find ./r2-restore/collection-images -type f | wc -l
```

Cross-check against the latest `backup_runs` row:

```sql
select bucket_name, files_synced, bytes_synced, synced_through, run_started_at
from public.backup_runs
where status = 'success'
order by run_started_at desc
limit 4;
```

The cumulative files synced across all successful runs (minus deletes that occurred after backup) is the number you should see locally.

**Step 2: re-upload everything to Supabase Storage**

The fastest path is a one-shot Node script. Save the following as `bulk-restore.mjs` somewhere local:

```javascript
// Usage: KEY=sb_secret_... node bulk-restore.mjs <local-folder> <supabase-bucket>
// Example:
//   KEY=sb_secret_... node bulk-restore.mjs ./r2-restore/listing-images listing-images
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SUPABASE_URL = "https://xwieomjsqwcswoadrvkv.supabase.co";
const KEY = process.env.KEY;
if (!KEY) { console.error("Set KEY=sb_secret_..."); process.exit(1); }

const [localRoot, bucket] = process.argv.slice(2);
if (!localRoot || !bucket) {
  console.error("usage: node bulk-restore.mjs <local-folder> <supabase-bucket>");
  process.exit(1);
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...await walk(p));
    else files.push(p);
  }
  return files;
}

const guessMime = (path) => {
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".png")) return "image/png";
  return "application/octet-stream";
};

const files = await walk(localRoot);
console.log(`Found ${files.length} files to restore to ${bucket}`);

let ok = 0, fail = 0;
for (const filePath of files) {
  const key = relative(localRoot, filePath).split("\\").join("/");
  const body = await readFile(filePath);
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": guessMime(filePath),
    },
    body,
  });
  if (res.ok) {
    ok++;
    if (ok % 20 === 0) console.log(`  ${ok}/${files.length} restored`);
  } else {
    fail++;
    const text = await res.text().catch(() => "");
    console.warn(`  FAIL ${key}: ${res.status} ${text.slice(0, 120)}`);
  }
}
console.log(`Done. ok=${ok} fail=${fail}`);
```

Run it for each bucket:

```bash
KEY="sb_secret_PASTE_REAL_VALUE" node bulk-restore.mjs ./r2-restore/listing-images listing-images
KEY="sb_secret_PASTE_REAL_VALUE" node bulk-restore.mjs ./r2-restore/collection-images collection-images
```

This uses PUT, so it overwrites any existing files. If you only want to restore MISSING files and skip ones that are already in Supabase Storage, change the curl to POST in the script — POST returns 409 on duplicate and the script's `fail++` will count those, which is fine.

**Step 3: verify**

After the bulk restore finishes, sample-check a few image URLs from the live catalog. Confirm Supabase Storage now reports the expected file count via the dashboard or via:

```sql
-- Approximate file count by inspecting referenced paths.
select count(distinct storage_path)
from public.listing_images;

-- For collection items:
select count(*) from public.collection_items where storage_path is not null;
```

## Scenario 3: switch providers

If you ever want to migrate OFF Supabase Storage (e.g. to host images directly from R2 with a public domain), the R2 mirror is most of the work already done. You'd:

1. Make the R2 bucket public (or front it with a Cloudflare Worker for signed URLs).
2. Update `imageUrl()` helpers in the codebase to point at the R2 public URL instead of the Supabase Storage transform endpoint.
3. Update the Cloudflare Pages Functions in `functions/seller.js` + `functions/seller.html.js` similarly.

This is out of scope for "restore" and would be its own project.

## Rotating R2 credentials

If you ever revoke the R2 API token (suspected leak, employee leaving, etc):

1. In Cloudflare dashboard → R2 → Manage API Tokens, click **Revoke** on the old token.
2. Create a new Account API token with the same scope (`canvascircle-image-backup`, Object Read & Write).
3. Re-set the Supabase secrets with the new values:
   ```bash
   cd /Users/gjscuderi/Documents/CanvasCircle_2
   supabase secrets set R2_ACCESS_KEY_ID=NEW_ID R2_SECRET_ACCESS_KEY='NEW_SECRET'
   ```
4. No edge function redeploy needed — secrets are read at invoke time. The next cron run uses the new credentials automatically.
5. Verify by manually firing `select public.cron_backup_to_r2();` in the SQL editor and checking `status_code: 200` in `net._http_response`.

## Rotating the service role key

Same idea but two places to update:

1. The Supabase secret used by the edge function: implicit, auto-injected by Supabase whenever you rotate the actual `service_role` key in the dashboard. No manual step.
2. The vault secret used by the pg_cron wrapper:
   ```sql
   select vault.update_secret(
     (select id from vault.secrets where name = 'cron_service_role_key'),
     'NEW_SERVICE_ROLE_KEY_VALUE'
   );
   ```

After both are updated, manually fire `select public.cron_backup_to_r2();` and confirm 200.

## Monitoring the backup system

Run these periodically — or build a small admin panel later that queries them:

```sql
-- Last 7 days of nightly runs. Should be 14 rows (2 buckets × 7 days),
-- all status='success'. Gaps = check pg_cron logs.
select bucket_name, status, files_synced, bytes_synced,
       synced_through, run_started_at
from public.backup_runs
where run_started_at > now() - interval '7 days'
order by run_started_at desc;

-- The cron job itself — has it actually been firing?
select jobname, status, return_message, start_time, end_time
from cron.job_run_details
where jobname = 'r2-backup-nightly'
order by start_time desc
limit 10;

-- Any pg_net HTTP failures?
select id, status_code, created
from net._http_response
where status_code != 200
order by created desc
limit 10;
```

A red flag is any of: missing nightly run, status='partial' on a backup_runs row (means some files failed within the run — check the `notes` column for `failures`), or status_code != 200 in net._http_response.

## Cost monitoring

R2 storage is $0.015/GB/month. At current scale (~177MB) that's ~$0.003/month. Class A operations (writes) are $4.50 per million; nightly cron adds maybe ~5 PUTs per day = ~150/month = effectively free. There's nothing to optimize at this scale.

If the bucket grows past 10GB, the Cloudflare free tier ($0 for 10GB storage, 1M Class A, 10M Class B per month) stops covering it and you start paying. Even then it's pennies. Re-check the math here if it ever gets above 100GB.
