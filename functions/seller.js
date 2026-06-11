// =============================================================================
// Cloudflare Pages Function — per-seller OG meta-tag injection (/seller)
// =============================================================================
// Routes: GET /seller  (extensionless URL — what the site actually uses
//         when "Copy Your Page Link" / "Copy Collection Link" are shared).
//
// Sibling of /functions/seller.html.js. Cloudflare Pages routes functions
// by exact file path, so /seller and /seller.html each need their own
// file. Per [[cloudflare-pages-functions]], duplicate the file rather
// than import a shared helper — cross-route imports between Pages
// Functions can be inconsistently bundled. If this file and
// seller.html.js diverge, fix one and mirror the change.
//
// Behavior:
//   * Reads ?handle=<handle> and optional ?tab=<collection>
//   * Queries the profile via PostgREST anon (column-level grants from
//     migration 016/051 keep this safe — only public profile columns
//     are exposed to anon callers).
//   * If the seller is suspended/banned/missing, falls through to the
//     default OG card (don't help bots index dead accounts).
//   * Otherwise builds a per-seller OG card:
//     - default mode: shows their listings as the headline + first
//       listing image as the og:image
//     - ?tab=collection mode: title pivots to "{name}'s Collection on
//       CanvasCircle", description uses collection_about_text, og:image
//       is the first piece in their public Collection. Falls back to
//       listing image if the Collection is empty.
//   * Injects via HTMLRewriter and 5-minute edge cache so iMessage /
//     Slack / Discord / WhatsApp scrapers all see compelling cards
//     instead of the generic site OG.
// =============================================================================

const SUPABASE_URL      = "https://xwieomjsqwcswoadrvkv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWVvbWpzcXdjc3dvYWRydmt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MzMzOTAsImV4cCI6MjA5MzUwOTM5MH0.G2jYVS788F6zI7vHNPOPVRM0sYdD_iVb6k6gdw6BcfA";
const SITE_ORIGIN       = "https://canvascircle.art";
const SCRAPER_FETCH_TIMEOUT_MS = 2500;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Image URL builder. Same Supabase transform endpoint pattern as the
// listing function; bucket name is parameterized because Collection
// images live in 'collection-images' while listing images live in
// 'listing-images'.
function imageUrl(bucket, storagePath) {
  if (!storagePath) return "";
  if (/^https?:\/\//i.test(storagePath)) return storagePath;
  return `${SUPABASE_URL}/storage/v1/render/image/public/${bucket}/${storagePath}?width=1200&quality=75&resize=contain`;
}

async function pgFetch(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SCRAPER_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchSellerProfile(handle) {
  // Anon-safe columns only. profiles RLS + column-level grants (migration
  // 016/051) ensure that location/contact_email/etc. would 403 the query
  // if requested. Sticking to public fields keeps this read working.
  const fields = "user_id,display_name,handle,is_trusted,account_status,collection_is_public,collection_about_text,about_text";
  const rows = await pgFetch(
    `/rest/v1/profiles?handle=ilike.${encodeURIComponent(handle)}&select=${fields}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchFirstListingImage(sellerId) {
  // Newest approved + available sale listing's first image. ISO and sold
  // listings don't have hero photos as compelling; bias toward what's
  // actually buyable. listing_images embed sorted by position client-side.
  const fields = "listing_images(storage_path,position)";
  const rows = await pgFetch(
    `/rest/v1/listings?seller_id=eq.${sellerId}&moderation_status=eq.approved&status=eq.available&listing_type=eq.sale&select=${encodeURIComponent(fields)}&order=created_at.desc&limit=1`
  );
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const imgs = rows[0]?.listing_images;
  if (!Array.isArray(imgs) || imgs.length === 0) return "";
  imgs.sort((a, b) => (a.position || 0) - (b.position || 0));
  return imgs[0]?.storage_path || "";
}

async function fetchFirstCollectionImage(ownerId) {
  // collection_items is locked at the table level; the get_public_collection
  // RPC (security definer) is the only public read path. Anon-grant exists.
  // The RPC self-gates on the owner being is_trusted + collection_is_public
  // AND each item being is_public, so we'll only get publicly-visible
  // images back.
  const rows = await pgFetch(`/rest/v1/rpc/get_public_collection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_owner_id: ownerId }),
  });
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows[0]?.image_path || "";
}

// Fetch a single piece by id via get_public_collection_item (migration 064).
// Returns null when the piece doesn't exist OR is not currently publicly
// visible (owner not Established, Collection toggled private, item set
// private, account suspended, etc.). Pages Function falls through to
// seller-level OG when this returns null, so a private/missing piece
// silently degrades to the default card.
async function fetchPublicCollectionItem(itemId) {
  const rows = await pgFetch(`/rest/v1/rpc/get_public_collection_item`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_item_id: itemId }),
  });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

function snippet(text, max = 200) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

// Build piece-specific OG meta. Title is the artwork itself; description
// pulls from the piece's public Story (when set) or falls back to a
// generic "From {owner}'s Collection on CanvasCircle" line. Image is
// the piece's image. Used when the URL has ?piece=<id> and the piece
// resolves to a publicly visible collection_item.
function buildPieceMeta({ piece, requestUrl }) {
  const artist = (piece.artist_name || "").trim();
  const work   = (piece.artwork_title || "").trim();
  const pieceLabel = [artist, work].filter(Boolean).join(", ") || "An artwork";

  const ownerName = (piece.owner_display_name || piece.owner_handle || "A collector").trim();
  const ownerHandle = piece.owner_handle ? `@${piece.owner_handle}` : "";

  const title = ownerHandle
    ? `${pieceLabel} — In ${ownerName}'s (${ownerHandle}) Collection on CanvasCircle`
    : `${pieceLabel} — In ${ownerName}'s Collection on CanvasCircle`;

  let description;
  if (piece.public_story) {
    description = snippet(piece.public_story);
  } else {
    const parts = [];
    if (piece.artwork_category) parts.push(piece.artwork_category);
    if (piece.acquired_year) {
      const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
      const monthName = piece.acquired_month ? months[piece.acquired_month - 1] : null;
      parts.push(monthName ? `acquired ${monthName} ${piece.acquired_year}` : `acquired ${piece.acquired_year}`);
    }
    if (piece.via_canvascircle) parts.push("acquired through CanvasCircle");
    parts.push(`from ${ownerName}'s Collection on CanvasCircle`);
    description = parts.join(", ").replace(/^./, c => c.toUpperCase()) + ".";
  }

  const ogImage = piece.image_path
    ? imageUrl("collection-images", piece.image_path)
    : `${SITE_ORIGIN}/assets/og-image.png`;

  return {
    title,
    description,
    image: ogImage,
    url: requestUrl,
    pageTitle: title,
  };
}

function buildSellerMeta({ profile, mode, image, requestUrl }) {
  const displayName = (profile.display_name || profile.handle || "A collector").trim();
  const handle      = profile.handle || "";
  const handleStr   = handle ? `@${handle}` : "";

  let title, description;
  if (mode === "collection") {
    // Collection-deep-link share. Headline puts the focus on the Collection
    // and the description disclaims the pieces are NOT for sale — otherwise
    // first-time viewers click through expecting to buy and get confused.
    title = `${displayName}'s Collection on CanvasCircle`;
    description = profile.collection_about_text
      ? `${snippet(profile.collection_about_text, 160)} (Personal collection on CanvasCircle, not for sale.)`
      : `Browse this collector's personal art collection on CanvasCircle. Artworks are owned, not for sale.`;
  } else {
    // Default seller-page share. Headline shows their identity + the
    // listings angle. About text is used as the description when set.
    title = handleStr
      ? `${displayName} (${handleStr}) on CanvasCircle`
      : `${displayName} on CanvasCircle`;
    description = profile.about_text
      ? snippet(profile.about_text)
      : `See ${displayName}'s art listings on CanvasCircle, the modern art listing platform for collectors.`;
  }

  const ogImage = image || `${SITE_ORIGIN}/assets/og-image.png`;

  return {
    title,
    description,
    image: ogImage,
    url: requestUrl,
    pageTitle: title,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const handle = (url.searchParams.get("handle") || "").trim().replace(/^@+/, "");
  const tab    = (url.searchParams.get("tab") || "").trim();
  const piece  = (url.searchParams.get("piece") || "").trim();

  const assetResponse = await env.ASSETS.fetch(request);

  // No handle, asset error, or non-HTML response → passthrough.
  if (!handle || !assetResponse.ok) return assetResponse;

  // Piece-share mode: ?piece=<uuid>. Try a per-piece OG card first.
  // If the piece resolves AND is currently publicly visible, build the
  // per-piece meta and short-circuit. Otherwise fall through to the
  // seller-level OG below — graceful degradation when a piece has been
  // unpublished or the Collection has been flipped private.
  if (piece) {
    let pieceRow = null;
    try { pieceRow = await fetchPublicCollectionItem(piece); } catch {}
    if (pieceRow) {
      try {
        const meta = buildPieceMeta({ piece: pieceRow, requestUrl: request.url });
        return injectOgMeta(assetResponse, meta, "piece");
      } catch { /* fall through */ }
    }
    // If piece lookup failed or piece is no longer visible, drop to the
    // seller-level OG. We don't reveal "this piece is private" via OG.
  }

  let profile;
  try {
    profile = await fetchSellerProfile(handle);
  } catch {
    return assetResponse;
  }
  if (!profile || profile.account_status !== "active") return assetResponse;

  // "Collection share" mode triggers when the URL explicitly asks for
  // Collection AND the owner has opted in to a public Collection AND
  // is currently Established. If any gate fails we render the default
  // seller card instead (don't leak a Collection mode for a private
  // Collection — would be confusing if the visitor lands and finds
  // the tab missing).
  const collectionMode = tab === "collection"
    && !!profile.collection_is_public
    && !!profile.is_trusted;

  // Pick the og:image. Collection mode prefers a Collection piece;
  // default mode prefers a listing; both fall back across to the other
  // if the preferred source is empty. Final fallback = generic OG image.
  let imagePath = "";
  let imageBucket = "";
  try {
    if (collectionMode) {
      imagePath = await fetchFirstCollectionImage(profile.user_id);
      imageBucket = "collection-images";
      if (!imagePath) {
        imagePath = await fetchFirstListingImage(profile.user_id);
        imageBucket = "listing-images";
      }
    } else {
      imagePath = await fetchFirstListingImage(profile.user_id);
      imageBucket = "listing-images";
      if (!imagePath && profile.collection_is_public && profile.is_trusted) {
        imagePath = await fetchFirstCollectionImage(profile.user_id);
        imageBucket = "collection-images";
      }
    }
  } catch { /* fall through to generic */ }
  const image = imagePath ? imageUrl(imageBucket, imagePath) : "";

  let meta;
  try {
    meta = buildSellerMeta({
      profile,
      mode: collectionMode ? "collection" : "default",
      image,
      requestUrl: request.url,
    });
  } catch {
    return assetResponse;
  }

  return injectOgMeta(assetResponse, meta, "seller");
}

// Shared HTMLRewriter injection helper. Used by both the seller-level
// and piece-level OG modes. The `kind` param ('seller' | 'piece') gets
// surfaced as an X-CC-OG-Injected response header for debugging which
// branch ran on a given request.
function injectOgMeta(assetResponse, meta, kind) {
  try {
    const rewriter = new HTMLRewriter()
      .on("title", {
        element(el) { el.setInnerContent(meta.pageTitle); },
      })
      .on('meta[property="og:image"]', {
        element(el) { el.setAttribute("content", meta.image); },
      })
      .on("head", {
        element(head) {
          head.append(
            `\n  <meta property="og:title"       content="${esc(meta.title)}" />` +
            `\n  <meta property="og:description" content="${esc(meta.description)}" />` +
            `\n  <meta property="og:url"         content="${esc(meta.url)}" />` +
            `\n  <meta property="og:type"        content="profile" />` +
            `\n  <meta name="twitter:title"       content="${esc(meta.title)}" />` +
            `\n  <meta name="twitter:description" content="${esc(meta.description)}" />` +
            `\n  <meta name="twitter:image"       content="${esc(meta.image)}" />` +
            `\n  <meta name="twitter:card"        content="summary_large_image" />\n`,
            { html: true }
          );
        },
      });

    const transformed = rewriter.transform(assetResponse);

    const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
    headers.set("X-CC-OG-Injected", kind);

    return new Response(transformed.body, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  } catch {
    return assetResponse;
  }
}
