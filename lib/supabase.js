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

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,   // needed for magic-link redirects
  },
});

// -----------------------------------------------------------------------------
// Storage helpers
// -----------------------------------------------------------------------------

/**
 * Public URL for an object in the listing-images bucket.
 * The bucket is set to public read in db/schema.sql, so anyone can <img src=…>.
 */
export function publicImageUrl(storagePath) {
  if (!storagePath) return "";
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
