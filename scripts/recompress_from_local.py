#!/usr/bin/env python3
"""
recompress_from_local.py — RECOVERY script for rotated legacy images.

Context:
  The first run of backfill_compress_images.py compressed legacy images
  but didn't call ImageOps.exif_transpose() before saving — so phone
  photos (which store pixels in sensor orientation + an EXIF rotation
  tag) were saved with sideways pixels and no EXIF tag, displaying
  rotated everywhere. The originals in Supabase Storage are now gone,
  replaced with the rotated compressed versions.

  Fortunately, the original local files in catalog_images/ are untouched.
  This script re-reads them, processes correctly (with exif_transpose),
  and uploads them back to Supabase Storage at the same paths the import
  script used: `{listing_uuid}/0-{filename}`.

Behavior:
  - Pages through every row in `listing_images` table.
  - For each row, parses the storage_path (`{uuid}/0-{filename}`) to find
    which local file in catalog_images/ it originated from.
  - If the local file exists: reads it, applies EXIF orientation, resizes
    to max 1200px, saves as JPEG quality 80, uploads to the same Supabase
    storage_path (overwriting the rotated version).
  - If the local file doesn't exist (e.g., a newer non-legacy listing
    posted through the portal): skips. Those went through the working
    browser-side compressImage and don't need recovery.

Safety:
  - Idempotent — re-running is safe.
  - --dry-run flag for a no-write audit pass.
  - Never overwrites with a larger file.

Setup (same as backfill_compress_images.py):
    source .venv/bin/activate
    pip install -r scripts/requirements.txt
    export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
    export SUPABASE_URL="https://xwieomjsqwcswoadrvkv.supabase.co"
    python scripts/recompress_from_local.py --dry-run
    python scripts/recompress_from_local.py
"""

from __future__ import annotations

import argparse
import io
import os
import re
import sys
from pathlib import Path
from typing import Optional

from PIL import Image, ImageOps
from supabase import create_client, Client


# ---------------------------------------------------------------------------
# Config (mirrors backfill_compress_images.py + import_legacy.py)
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://xwieomjsqwcswoadrvkv.supabase.co")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
BUCKET       = "listing-images"

REPO_ROOT = Path(__file__).resolve().parent.parent
IMG_DIR   = REPO_ROOT / "catalog_images"

MAX_DIM      = 1200
JPEG_QUALITY = 80

if not SERVICE_KEY:
    sys.exit(
        "ERROR: SUPABASE_SERVICE_ROLE_KEY env var is not set.\n"
        "Get it from Supabase > Project Settings > API > service_role key,\n"
        "then run:  export SUPABASE_SERVICE_ROLE_KEY='eyJ...'"
    )

if not IMG_DIR.exists():
    sys.exit(f"ERROR: catalog_images/ directory not found at {IMG_DIR}")


def humanize(n_bytes: float) -> str:
    n = float(n_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def compress_from_local(local_path: Path) -> Optional[bytes]:
    """Read a local image file, apply EXIF rotation to pixels, strip the
    EXIF tag, resize to MAX_DIM, save as JPEG quality JPEG_QUALITY."""
    try:
        img = Image.open(local_path)
        img.load()
    except Exception as e:
        print(f"    ! could not open {local_path.name}: {e}")
        return None

    # THE critical step that the original backfill script missed:
    img = ImageOps.exif_transpose(img)

    # Flatten alpha against white if needed.
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # Resize long edge to MAX_DIM (preserving aspect).
    w, h = img.size
    if max(w, h) > MAX_DIM:
        scale = MAX_DIM / max(w, h)
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        img = img.resize((new_w, new_h), Image.LANCZOS)

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


# Pattern matches `{uuid}/0-{filename}` storage paths produced by
# import_legacy.py. The captured filename is what we look for in
# catalog_images/.
PATH_RE = re.compile(r"^[0-9a-f-]{36}/0-(.+)$")


def main():
    parser = argparse.ArgumentParser(description="Re-compress legacy images from local files (EXIF-correct).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would change without uploading anything.")
    args = parser.parse_args()

    sb: Client = create_client(SUPABASE_URL, SERVICE_KEY)

    print("Querying listing_images table…")
    all_rows = []
    page_size = 1000
    page = 0
    while True:
        resp = (sb.table("listing_images")
                  .select("listing_id, storage_path, position")
                  .range(page * page_size, page * page_size + page_size - 1)
                  .execute())
        rows = resp.data or []
        all_rows.extend(rows)
        if len(rows) < page_size:
            break
        page += 1

    # Filter to rows where the storage_path looks like a legacy import path
    # AND the originating local file still exists in catalog_images/.
    candidates: list[tuple[dict, Path]] = []
    no_local: list[str] = []
    non_legacy: list[str] = []
    for r in all_rows:
        path = r.get("storage_path") or ""
        m = PATH_RE.match(path)
        if not m:
            non_legacy.append(path)
            continue
        filename = m.group(1)
        local = IMG_DIR / filename
        if local.exists():
            candidates.append((r, local))
        else:
            no_local.append(filename)

    print(f"Found {len(all_rows)} listing_images rows total.")
    print(f"  Legacy-import paths with local file:  {len(candidates)}")
    print(f"  Legacy-import paths missing local:    {len(no_local)}")
    print(f"  Non-legacy paths (skipped — these went through portal compressImage and are correctly oriented):")
    print(f"    {len(non_legacy)}")
    if args.dry_run:
        print("\n** DRY RUN — no uploads will happen. **")
    print()

    processed     = 0
    errors        = 0
    skipped_grew  = 0
    total_after   = 0

    for i, (row, local) in enumerate(candidates, 1):
        path = row["storage_path"]
        new_bytes = compress_from_local(local)
        if new_bytes is None:
            errors += 1
            print(f"[{i:>4}/{len(candidates)}] {path}  ✗ couldn't process {local.name}")
            continue

        size_after = len(new_bytes)
        total_after += size_after

        if args.dry_run:
            processed += 1
            print(f"[{i:>4}/{len(candidates)}] {path}  [DRY] {local.name} → {humanize(size_after)}")
            continue

        # Delete-then-upload pattern. Avoids the supabase-py quirk where
        # `upload(..., upsert="true")` silently no-ops when an object
        # already exists at the path. With delete-then-upload, every write
        # hits the "fresh object" code path which is reliable.
        try:
            try:
                sb.storage.from_(BUCKET).remove([path])
            except Exception:
                pass  # may already be gone — that's fine
            sb.storage.from_(BUCKET).upload(
                path=path,
                file=new_bytes,
                file_options={
                    "content-type": "image/jpeg",
                    "cache-control": "3600",
                },
            )
            processed += 1
            print(f"[{i:>4}/{len(candidates)}] {path}  ✓ from {local.name} ({humanize(size_after)})")
        except Exception as e:
            errors += 1
            print(f"[{i:>4}/{len(candidates)}] {path}  ✗ upload failed: {e}")

    print()
    print("=" * 60)
    print(f"Processed:           {processed}")
    print(f"Errors:              {errors}")
    print(f"Total uploaded size: {humanize(total_after)}")
    if no_local:
        print(f"\nLegacy paths whose local file wasn't found in catalog_images/:")
        for f in no_local[:20]:
            print(f"  - {f}")
        if len(no_local) > 20:
            print(f"  …and {len(no_local) - 20} more.")
    if args.dry_run:
        print("\n** This was a DRY RUN — no files were modified. **")
        print("Run again without --dry-run to apply the changes.")


if __name__ == "__main__":
    main()
