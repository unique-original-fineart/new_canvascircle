// =============================================================================
// Supabase client (browser-side)
// =============================================================================
// Single shared instance. Auth state is persisted to localStorage by default
// so users stay signed in across tabs and reloads.
//
// Usage from a page or module:
//   import { supabase } from "./lib/supabase.js";
//   const { data, error } = await supabase
//     .from("listings")
//     .select("*")
//     .eq("status", "available");
//
// Usage from inline <script type="module"> in an HTML file:
//   import { supabase } from "/lib/supabase.js";
// =============================================================================

// IMPORTANT — note the `?bundle` query parameter. Without it, esm.sh returns
// the top-level entry point which then triggers a cascade of cross-origin
// imports for every transitive dependency (gotrue-js, postgrest-js,
// realtime-js, etc). On a cold iOS PWA launch with weak cell signal, those
// secondary fetches hang and freeze the entire script before any of our
// defensive code (auth timeout, query timeout, freshness watchdog) can run.
//
// `?bundle` makes esm.sh return ONE self-contained file with every
// dependency inlined — so our service worker only needs to cache a single
// URL to make the library fully available offline.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2?bundle";
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from "./config.js";

if (!SUPABASE_URL || SUPABASE_ANON_KEY === "PASTE_ANON_KEY_HERE") {
  // Make the misconfiguration loud and obvious during local dev.
  console.error(
    "[CanvasCircle] Supabase config missing. Edit lib/config.js with your anon key."
  );
}

// supabase-js v2's default lock uses navigator.locks, which can deadlock
// across tabs if a previous tab crashed mid-auth (the lock is never released).
// Provide a simple in-memory lock so a stuck browser lock can never hang the
// UI. Trade-off: less safe across multiple tabs racing token refresh, which
// in practice never happens for our seller portal.
const _memoryLocks = new Map();
async function memoryLock(name, _acquireTimeout, fn) {
  while (_memoryLocks.get(name)) {
    await _memoryLocks.get(name);
  }
  let release;
  const wait = new Promise((r) => (release = r));
  _memoryLocks.set(name, wait);
  try {
    return await fn();
  } finally {
    _memoryLocks.delete(name);
    release();
  }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,   // needed for magic-link redirects
    lock: memoryLock,
  },
});

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------

/**
 * Public URL for an object in the listing-images bucket.
 * The bucket is set to public read in db/schema.sql, so anyone can <img src=…>.
 *
 * Convenience: if storagePath already looks like a full http(s) URL we return
 * it unchanged. This lets seed data point at external CDN URLs (e.g. the
 * legacy lh3.googleusercontent.com images) without uploading first.
 *
 * Optional second arg `opts` enables Supabase Storage image transformations
 * (Pro plan feature). Pass `{ width: 600 }` to request a smaller variant
 * suitable for a catalog grid — Supabase generates the resized image on the
 * fly and caches it at its CDN. Each visitor downloads only the bytes they
 * actually need, dramatically reducing cached egress.
 *
 *   publicImageUrl(path)                 // full size (default 1200px)
 *   publicImageUrl(path, { width: 600 }) // resized for grids
 *
 * When width is set, we also tell the transform engine to output WebP, which
 * is ~25-30% smaller than JPEG at equivalent visual quality. WebP support is
 * universal across browsers since 2020 (Safari iOS 14+) so this is safe.
 * Legacy JPEG sources are converted to WebP on the fly by the transform
 * engine — no need to re-upload existing files.
 *
 * Transforms ONLY apply to Supabase-hosted images. Legacy http(s) URLs pass
 * through unchanged (no transform support on Google's CDN).
 */
export function publicImageUrl(storagePath, opts = {}) {
  if (!storagePath) return "";
  if (/^https?:\/\//i.test(storagePath)) return storagePath;
  const supaOpts = opts.width
    ? { transform: { width: opts.width, quality: opts.quality || 75, resize: "contain", format: "webp" } }
    : undefined;
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath, supaOpts);
  return data?.publicUrl || "";
}

/**
 * Upload a File object into a listing's folder.
 * Path convention: "{listing_id}/{position}-{filename}".
 */
export async function uploadListingImage(listingId, file, position = 0) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path     = `${listingId}/${position}-${Date.now()}-${safeName}`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false });
  if (error) throw error;
  return path;
}

/**
 * Browser-side image compression.
 * Default: max dimension 1200px, WebP @ 0.75 quality. WebP is ~25-30% smaller
 * than JPEG at equivalent visual quality and has universal browser support
 * since 2020 (Safari iOS 14+, Chrome, Firefox). Override via args if needed.
 * Preserves aspect ratio. Returns a Blob with type "image/webp".
 *
 * The browser's <img> loader applies EXIF orientation when reading the file,
 * so the pixels drawn onto the canvas (and thus the output) are already
 * correctly rotated. No EXIF tag is needed in the output.
 */
export async function compressImage(file, maxDim = 1200, quality = 0.75) {
  if (!file || !file.type?.startsWith("image/")) {
    throw new Error("Selected file is not an image.");
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload  = () => resolve(i);
      i.onerror = () => reject(new Error("Could not read the image file."));
      i.src = url;
    });
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("Image has no dimensions.");
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width  = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("Compression produced no output.")),
        "image/webp",
        quality
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// -----------------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------------

/** Returns the current user, or null if not signed in. */
export async function currentUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

/** Returns the current user's profile row (or null). */
export async function currentProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("[CanvasCircle] failed to load profile", error);
    return null;
  }
  return data;
}
