#!/usr/bin/env python3
"""
backfill_compress_images.py — One-time compression backfill for legacy
listing images in the `listing-images` Supabase Storage bucket.

The original `import_legacy.py` migration uploaded images verbatim from the
old catalog without resizing or recompressing, so legacy listings sit in
Supabase Storage at their original camera-roll resolutions (often 3-8MB
per file at 3000-4000px on the long edge). New uploads go through the
browser-side `compressImage()` helper in lib/supabase.js which caps them at
1200px / JPEG 80% quality.

This script brings legacy images down to the same target so:
  - Cached egress drops (much smaller files served to viewers)
  - Storage usage drops
  - Supabase image transformations have less work per origin image

Behavior:
  - Lists every row in the `listing_images` table.
  - Skips rows whose storage_path is an http(s) URL (those point at
    external CDNs we don't own; we can't rewrite them here).
  - For each Supabase-hosted storage_path:
      * Downloads the file.
      * If max dimension <= 1200px AND size < 500KB: skips (already small).
      * Otherwise: resizes to max 1200px on the long edge, saves as JPEG
        quality 80, flattens alpha against white.
      * If the new file is NOT smaller than the original, skips (never
        replaces with a larger file).
      * Otherwise uploads to the same storage_path with upsert=true.

Safety properties:
  - Idempotent — re-runs are no-ops on already-compressed images.
  - Never-grows — refuses to overwrite a file with a larger version.
  - `--dry-run` flag for a no-write audit pass.

Setup:
    cd CanvasCircle_2
    source .venv/bin/activate   # or: python3 -m venv .venv && source .venv/bin/activate
    pip install -r scripts/requirements.txt

    # NEVER commit it. NEVER paste it in chat. Treat it like a root password.
    export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
    export SUPABASE_URL="https://xwieomjsqwcswoadrvkv.supabase.co"

    # Audit pass — see what *would* change without writing anything:
    python scripts/backfill_compress_images.py --dry-run

    # Real pass — actually compress + re-upload:
    python scripts/backfill_compress_images.py
"""

from __future__ import annotations

import argparse
import io
import os
import sys
from typing import Optional

from PIL import Image, ImageOps
from supabase import create_client, Client


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://xwieomjsqwcswoadrvkv.supabase.co")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
BUCKET       = "listing-images"

MAX_DIM           = 1200    # matches browser-side compressImage()
JPEG_QUALITY      = 80      # matches browser-side compressImage()
SKIP_IF_UNDER_KB  = 500     # files this small are presumed already-compressed

if not SERVICE_KEY:
    sys.exit(
        "ERROR: SUPABASE_SERVICE_ROLE_KEY env var is not set.\n"
        "Get it from Supabase > Project Settings > API > service_role key,\n"
        "then run:  export SUPABASE_SERVICE_ROLE_KEY='eyJ...'"
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def humanize(n_bytes: float) -> str:
    """Render byte counts in a human-readable form for the log."""
    n = float(n_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def compress_image(raw: bytes) -> Optional[bytes]:
    """Returns compressed JPEG bytes, or None if the image couldn't be opened.

    CRITICAL: applies EXIF orientation BEFORE any other processing. Phone
    cameras store pixels in fixed sensor orientation plus an EXIF tag
    saying "rotate N° to display." If we don't physically apply the
    rotation here and then strip the EXIF (which Pillow does by default
    on save), the output JPEG shows sideways everywhere. `exif_transpose`
    bakes the rotation into the pixels so the result is correct regardless
    of EXIF support in viewers — same outcome as the browser-side
    compressImage helper in lib/supabase.js (browsers apply EXIF when
    loading <img>, so canvas output is already correctly oriented).

    Then: resizes the long edge to MAX_DIM (preserving aspect ratio),
    flattens any alpha channel against white, saves as JPEG at JPEG_QUALITY.
    """
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()  # force decode now so we catch malformed files early
    except Exception as e:
        print(f"    ! could not open as image: {e}")
        return None

    # Apply EXIF orientation to pixels, then drop the EXIF tag.
    img = ImageOps.exif_transpose(img)

    # Flatten alpha to white background if the source has transparency.
    # Otherwise just convert to RGB so JPEG encoding is happy.
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    # Resize if either dimension exceeds MAX_DIM.
    w, h = img.size
    if max(w, h) > MAX_DIM:
        scale = MAX_DIM / max(w, h)
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        img = img.resize((new_w, new_h), Image.LANCZOS)

    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Backfill-compress legacy listing images.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Audit only — don't upload anything, just report what would change.")
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

    # Skip http(s) URLs — those are external CDN pointers we don't own.
    candidates = [r for r in all_rows
                  if r.get("storage_path") and not r["storage_path"].lower().startswith("http")]
    skipped_external = len(all_rows) - len(candidates)

    print(f"Found {len(all_rows)} listing_images rows total.")
    if skipped_external:
        print(f"  ({skipped_external} are external/http URLs — skipping.)")
    print(f"Processing {len(candidates)} Supabase-hosted images…")
    if args.dry_run:
        print("** DRY RUN — no uploads will happen. **")
    print()

    compressed       = 0
    skipped_small    = 0
    skipped_no_gain  = 0
    errors           = 0
    total_before     = 0
    total_after      = 0

    for i, row in enumerate(candidates, 1):
        path = row["storage_path"]
        try:
            raw = sb.storage.from_(BUCKET).download(path)
        except Exception as e:
            errors += 1
            print(f"[{i:>4}/{len(candidates)}] {path}  ✗ download failed: {e}")
            continue

        size_before = len(raw)

        # Fast-path skip: file is already small AND not over the dimension cap.
        if size_before <= SKIP_IF_UNDER_KB * 1024:
            try:
                with Image.open(io.BytesIO(raw)) as quick:
                    if max(quick.size) <= MAX_DIM:
                        skipped_small += 1
                        total_before += size_before
                        total_after  += size_before
                        print(f"[{i:>4}/{len(candidates)}] {path}  ↳ already small "
                              f"({humanize(size_before)}, {quick.size[0]}×{quick.size[1]}) — skipping")
                        continue
            except Exception:
                pass  # fall through to compression attempt

        new_bytes = compress_image(raw)
        if new_bytes is None:
            errors += 1
            total_before += size_before
            total_after  += size_before
            print(f"[{i:>4}/{len(candidates)}] {path}  ✗ unprocessable")
            continue

        size_after = len(new_bytes)

        # Never replace with a larger file.
        if size_after >= size_before:
            skipped_no_gain += 1
            total_before += size_before
            total_after  += size_before
            print(f"[{i:>4}/{len(candidates)}] {path}  ↳ no size gain "
                  f"({humanize(size_before)} → {humanize(size_after)}) — skipping")
            continue

        if args.dry_run:
            compressed += 1
            total_before += size_before
            total_after  += size_after
            print(f"[{i:>4}/{len(candidates)}] {path}  [DRY] "
                  f"{humanize(size_before)} → {humanize(size_after)}  "
                  f"saves {humanize(size_before - size_after)}")
            continue

        # Delete-then-upload pattern. Avoids the supabase-py quirk where
        # `upload(..., upsert="true")` silently no-ops when an object
        # already exists at the path. With delete-then-upload, every
        # write hits the "fresh object" code path which is reliable.
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
            compressed += 1
            total_before += size_before
            total_after  += size_after
            print(f"[{i:>4}/{len(candidates)}] {path}  ✓ "
                  f"{humanize(size_before)} → {humanize(size_after)}  "
                  f"saved {humanize(size_before - size_after)}")
        except Exception as e:
            errors += 1
            total_before += size_before
            total_after  += size_before
            print(f"[{i:>4}/{len(candidates)}] {path}  ✗ upload failed: {e}")

    print()
    print("=" * 60)
    print(f"Total candidates:        {len(candidates)}")
    print(f"Compressed:              {compressed}")
    print(f"Skipped (already small): {skipped_small}")
    print(f"Skipped (no size gain):  {skipped_no_gain}")
    print(f"Errors:                  {errors}")
    print(f"Total bytes before:      {humanize(total_before)}")
    print(f"Total bytes after:       {humanize(total_after)}")
    if total_before:
        pct = (1 - total_after / total_before) * 100
        print(f"Net reduction:           {humanize(total_before - total_after)} ({pct:.1f}%)")
    if args.dry_run:
        print()
        print("** This was a DRY RUN — no files were modified. **")
        print("Run again without --dry-run to apply the changes.")


if __name__ == "__main__":
    main()
