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

// Self-hosted at /vendor/ as of cc-v170. Originally loaded from esm.sh
// (cross-origin), but every CDN in our load path was a supply-chain attack
// vector — if the CDN got compromised (the polyfill.io incident in 2024
// hit thousands of sites this way), malicious JS would execute inside CC
// and steal every user's session token. Self-hosting eliminates that
// surface entirely and lets us tighten CSP to script-src 'self'.
//
// The file at /vendor/supabase-js-v2.esm.js is the same bundled ESM that
// esm.sh used to serve from https://esm.sh/@supabase/supabase-js@2?bundle:
// one self-contained file with every dependency inlined, so the browser
// only does ONE network request for the entire SDK. Update by running:
//   curl -L "https://esm.sh/@supabase/supabase-js@2?bundle" \
//        -o vendor/supabase-js-v2.esm.js
// and bumping the ?v=N query string below + everywhere else it's imported.
import { createClient } from "/vendor/supabase-js-v2.esm.js?v=1";
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
/**
 * Read the signed-in user's OWN contact_email. As of migration 050, the
 * column is REVOKED from authenticated, so a normal SELECT against
 * profiles.contact_email returns permission-denied. This RPC is a
 * SECURITY DEFINER helper that returns the calling user's own row's
 * contact_email and only works when there's an auth context.
 *
 * Returns null if not signed in or if no profile row exists yet.
 * Callers should handle null gracefully (fall back to auth user.email
 * which is the login email; usually the same as contact_email but not
 * always — users can set a different one in their profile).
 */
export async function getMyContactEmail() {
  const { data, error } = await supabase.rpc("get_my_contact_email");
  if (error) {
    console.warn("[getMyContactEmail] failed:", error);
    return null;
  }
  return data || null;
}

/**
 * Batch admin lookup of contact emails for a list of user_ids. Returns a
 * Map<user_id, contact_email>. Only callable by admins (the RPC enforces
 * is_admin() server-side). Used by admin moderation panels that display
 * sellers' / reporters' emails alongside other profile info.
 *
 * Pass at most ~100 ids per call; PostgREST has a query-size limit that
 * caps the safe batch size somewhere around 200-500 uuids per request.
 */
export async function getContactEmailsAsAdmin(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc("admin_get_contact_emails", {
    p_user_ids: userIds,
  });
  if (error) {
    console.warn("[getContactEmailsAsAdmin] failed:", error);
    return new Map();
  }
  const map = new Map();
  for (const row of (data || [])) {
    if (row?.user_id) map.set(row.user_id, row.contact_email || null);
  }
  return map;
}

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
 * Default: max dimension 1200px, quality 0.75. WebP-first / JPEG-fallback.
 * Preserves aspect ratio. Returns `{ blob, mime, ext }` — callers MUST use
 * these for the upload path + contentType rather than hardcoding ".webp",
 * because of the silent-fallback bug described below.
 *
 * Why the format choice is non-trivial:
 *   The naive code path was `canvas.toBlob("image/webp", quality)` →
 *   upload at path ".webp" with contentType "image/webp". That looks
 *   correct, and works on every modern desktop browser. But the HTML
 *   spec explicitly says: "If the user agent does not support the
 *   requested type, the implementation will fall back to image/png."
 *   PNG is LOSSLESS — a 1200px photo of a textured painting becomes
 *   3-5MB. We then upload that PNG with a `.webp` filename and
 *   `image/webp` content-type, producing a mislabeled 3MB blob.
 *
 *   iOS Safari has supported WebP toBlob since iOS 14, but iOS PWA
 *   standalone contexts can use a slightly different WebKit, and some
 *   HEIC-source files trigger the PNG fallback in subtle ways.
 *   Symptom: portal-uploaded listings landing at multi-MB sizes when
 *   they should be ~200-400KB.
 *
 *   This implementation detects the fallback by checking the returned
 *   blob's actual `.type`. If it isn't `image/webp`, we re-encode as
 *   JPEG, which is universally supported by canvas.toBlob and produces
 *   ~25% larger files than WebP but still ~10x smaller than PNG. The
 *   real mime + extension is returned to the caller so the upload is
 *   labeled correctly.
 *
 * The browser's <img> loader applies EXIF orientation when reading the
 * file, so the pixels drawn onto the canvas (and thus the output) are
 * already correctly rotated. No EXIF tag is needed in the output.
 *
 * @returns {Promise<{ blob: Blob, mime: string, ext: string }>}
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

    const encode = (mime, q) => new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob || null), mime, q);
    });

    // Try WebP first. If the browser silently falls back, the returned
    // blob.type will NOT be "image/webp" — typically it'll be
    // "image/png" (per the HTML spec fallback). We re-encode to JPEG
    // in that case for a guaranteed-small output.
    let blob = await encode("image/webp", quality);
    if (!blob || blob.type !== "image/webp") {
      blob = await encode("image/jpeg", quality);
      if (!blob) throw new Error("Compression produced no output.");
      return { blob, mime: "image/jpeg", ext: "jpg" };
    }
    return { blob, mime: "image/webp", ext: "webp" };
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

// Explicit profile column list (replaces "*" as of cc-v173 / migration 050).
// We can't use "*" anymore because contact_email is REVOKED at the column
// level for the authenticated role — PostgREST expands * to all columns at
// query time, hits the revoked column, and the whole query errors out.
// Owners read their own contact_email via getMyContactEmail() instead.
//
// Keep this list in sync with the columns added in migrations. has_contact_email
// (migration 049) and shipping_zip (044), collage_banner_settings (043),
// post_drafts (041), post_presets (040), preferred_contact (033),
// last_inquiry_seen_at (029), is_trusted_locked (023), about_text + pending_*
// (018), pending_display_name + status_changed_at (009/005), tos_accepted_at +
// tos_version (007). Add to this list when you add a new profile column.
const PROFILE_COLUMNS = [
  "user_id",
  "display_name",
  "handle",
  // NOTE: contact_email deliberately omitted — read via getMyContactEmail()
  "has_contact_email",
  "facebook_profile_url",
  "location",
  "shipping_zip",
  "about_text",
  "pending_about_text",
  "pending_about_at",
  "pending_display_name",
  "pending_display_name_at",
  "preferred_contact",
  "is_admin",
  "is_trusted",
  "is_trusted_locked",
  "account_status",
  "status_changed_at",
  "status_note",
  "created_at",
  "updated_at",
  "last_inquiry_seen_at",
  "post_presets",
  "post_drafts",
  "post_header",
  "post_footer",
  "collage_banner_settings",
  "tos_accepted_at",
  "tos_version",
  // Make-an-Offer auto-reject floor (migration 052). Owner-readable so
  // the Profile tab can render the configured value back into the input.
  "auto_reject_floor_usd",
].join(", ");

/** Returns the current user's profile row (or null). */
export async function currentProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) {
    console.error("[CanvasCircle] failed to load profile", error);
    return null;
  }
  return data;
}

// -----------------------------------------------------------------------------
// User-block filter
// -----------------------------------------------------------------------------
// Per-tab cached Set of user_ids the current viewer should NOT see (union of
// "users I blocked" + "users who blocked me"). Symmetric semantics — see the
// comment block in db/migrations/042_user_blocks.sql for the design.
//
// Callers across pages (catalog index.html, listing.html, seller.html, the
// portal) all use loadBlockFilter() on first paint to get a Set, then pass
// it to isBlockedUid(set, uid) when rendering each listing/profile.
//
// We refresh on demand (after block/unblock) by clearing the cache and
// re-fetching, rather than tracking individual mutations. Simple + correct.
let __blockFilterPromise = null;
export function clearBlockFilterCache() {
  __blockFilterPromise = null;
}
export async function loadBlockFilter() {
  if (__blockFilterPromise) return __blockFilterPromise;
  __blockFilterPromise = (async () => {
    const user = await currentUser();
    if (!user) return new Set();   // anon viewers don't have a block filter
    const { data, error } = await supabase.rpc("get_my_block_filter_uids");
    if (error) {
      console.warn("[CanvasCircle] block-filter fetch failed:", error);
      return new Set();
    }
    return new Set((data || []).map(r => r.user_id));
  })();
  return __blockFilterPromise;
}
export function isBlockedUid(blockSet, uid) {
  return !!(blockSet && uid && blockSet.has(uid));
}
