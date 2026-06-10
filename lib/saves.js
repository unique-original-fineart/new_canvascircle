// =============================================================================
// saves.js — heart/save helpers
// =============================================================================
// Small wrapper around the saved_listings table. Caches the current user's
// saves in memory so the catalog can mark hearts without a per-card query.
//
// Public functions:
//   getCurrentUserSaves()   → Set<listing_id> | null  (null if not signed in)
//   toggleSave(listing_id)  → true if now-saved, false if now-unsaved
//   getSavedListings()      → array of listing rows (joined), newest-saved first
//   clearSavesCache()       → reset cache (call after sign-out)
// =============================================================================

import { supabase } from "./supabase.js?v=5";

let savesCache = null;     // Set<listing_id>
let cachedFor  = null;     // user_id the cache belongs to

/** Returns the Set of listing_ids the current user has saved, or null if unsigned. */
export async function getCurrentUserSaves() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    savesCache = null;
    cachedFor  = null;
    return null;
  }
  if (cachedFor === user.id && savesCache) return savesCache;
  const { data, error } = await supabase
    .from("saved_listings")
    .select("listing_id")
    .eq("user_id", user.id);
  if (error) {
    console.warn("[saves] could not fetch user saves:", error);
    return new Set();
  }
  cachedFor  = user.id;
  savesCache = new Set((data || []).map(r => r.listing_id));
  return savesCache;
}

/** Toggles save state for the current user. Throws if unsigned. */
export async function toggleSave(listingId) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("not-signed-in");
  const saves = (await getCurrentUserSaves()) || new Set();
  if (saves.has(listingId)) {
    const { error } = await supabase
      .from("saved_listings")
      .delete()
      .eq("user_id", user.id)
      .eq("listing_id", listingId);
    if (error) throw error;
    saves.delete(listingId);
    return false;
  } else {
    const { error } = await supabase
      .from("saved_listings")
      .insert({ user_id: user.id, listing_id: listingId });
    if (error) throw error;
    saves.add(listingId);
    return true;
  }
}

/** Full listing rows for everything the current user has saved, newest first. */
export async function getSavedListings() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("saved_listings")
    .select(`
      listing_id, created_at,
      listings (
        listing_id, listing_type, artist_name, artwork_title, artwork_category,
        asking_price_usd, previous_price_usd, shipping_offered,
        budget_min_usd, budget_max_usd,
        status, save_count, created_at,
        listing_images ( storage_path, position )
      )
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[saves] could not fetch saved listings:", error);
    return [];
  }
  return (data || [])
    .filter(r => r.listings)
    .map(r => ({ ...r.listings, saved_at: r.created_at }));
}

export function clearSavesCache() {
  savesCache = null;
  cachedFor  = null;
}
