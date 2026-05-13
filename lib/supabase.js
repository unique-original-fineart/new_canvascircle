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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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
 * Second argument is an optional `{ width, quality }` transform. When set,
 * Supabase's image-render endpoint returns a server-resized JPEG, which is
 * vastly smaller than the original 1200px file — perfect for catalog cards
 * displayed at ~300px. Falls back to the original URL for non-Supabase
 * sources (legacy lh3.googleusercontent.com seed data). See:
 * https://supabase.com/docs/guides/storage/serving/image-transformations
 */
export function publicImageUrl(storagePath, opts = {}) {
  if (!storagePath) return "";
  if (/^https?:\/\//i.test(storagePath)) return storagePath;
  const { width, quality } = opts;
  if (width) {
    // Use the render endpoint to scale the image down to the requested width
    // while preserving the original aspect ratio. We intentionally DON'T
    // specify height + resize:cover here — the CSS on the card already
    // handles cropping via object-fit, and double-cropping (server crop +
    // CSS crop) was zooming in too aggressively and cutting off signatures.
    const { data } = supabase.storage.from(STORAGE_BUCKET)
      .getPublicUrl(storagePath, {
        transform: {
          width,
          quality: quality || 75,
        },
      });
    return data?.publicUrl || "";
  }
  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
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
 * Default: max dimension 1200px, JPEG @ 0.80. Smaller files load faster on
 * the public catalog and use less storage quota. Override via args if needed.
 * Preserves aspect ratio. Returns a Blob.
 */
export async function compressImage(file, maxDim = 1200, quality = 0.80) {
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
        "image/jpeg",
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
