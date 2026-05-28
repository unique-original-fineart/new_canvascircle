// =============================================================================
// Cloudflare Pages Function — per-listing OG meta-tag injection (/listing)
// =============================================================================
// Routes: GET /listing  (extensionless URL — what the site actually uses)
//
// This is a sibling of /functions/listing.html.js. Cloudflare Pages routes
// functions by exact file path: /functions/listing.html.js handles
// /listing.html, but the catalog and seller pages link to /listing?id=X
// (no extension — Pages serves the .html content via its pretty-URL feature).
// Without this second file, every shared link to /listing?id=X would bypass
// the function entirely and scrapers would see only the generic OG card.
//
// The handler logic is identical to listing.html.js. Duplicating the file
// (rather than importing a shared helper) is the most reliable pattern for
// Pages Functions, since cross-route imports between /functions/*.js files
// can be inconsistently bundled. If this file and listing.html.js ever
// diverge, fix the canonical implementation in listing.html.js first and
// mirror the change here.
// =============================================================================

const SUPABASE_URL      = "https://xwieomjsqwcswoadrvkv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWVvbWpzcXdjc3dvYWRydmt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MzMzOTAsImV4cCI6MjA5MzUwOTM5MH0.G2jYVS788F6zI7vHNPOPVRM0sYdD_iVb6k6gdw6BcfA";
const STORAGE_BUCKET    = "listing-images";
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

function fmtPrice(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return "$" + num.toLocaleString();
}

function publicImageUrl(storagePath) {
  if (!storagePath) return "";
  if (/^https?:\/\//i.test(storagePath)) return storagePath;
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;
}

async function fetchListing(listingId) {
  const fields = [
    "listing_id",
    "artist_name",
    "artwork_title",
    "asking_price_usd",
    "listing_type",
    "status",
    "moderation_status",
    "artwork_category",
    "listing_images(storage_path,position)",
  ].join(",");
  const url = `${SUPABASE_URL}/rest/v1/listings?listing_id=eq.${encodeURIComponent(listingId)}&select=${fields}&limit=1`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SCRAPER_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function buildMeta(listing, listingId, requestUrl) {
  const isIso  = listing.listing_type === "iso";
  const artist = (listing.artist_name || "").trim();
  const work   = (listing.artwork_title || "").trim();
  const piece  = [artist, work].filter(Boolean).join(" — ") || "A listing on CanvasCircle";

  let ogTitle;
  if (isIso) {
    ogTitle = `In Search Of: ${piece}`;
  } else {
    ogTitle = piece;
  }

  let ogDescription;
  if (isIso) {
    ogDescription = `A collector on CanvasCircle is looking for ${piece}. See if you can help find this piece.`;
  } else if (listing.status === "sold") {
    ogDescription = `${piece} — sold on CanvasCircle.`;
  } else if (listing.status === "pending_sale") {
    ogDescription = `${piece} — pending sale on CanvasCircle.`;
  } else {
    const price = fmtPrice(listing.asking_price_usd);
    const cat   = listing.artwork_category ? String(listing.artwork_category).replace(/_/g, " ") : "";
    const parts = [piece];
    if (cat)   parts.push(cat);
    if (price) parts.push(price);
    ogDescription = parts.join(" • ") + " on CanvasCircle.";
  }

  const images = Array.isArray(listing.listing_images)
    ? [...listing.listing_images].sort((a, b) => (a.position || 0) - (b.position || 0))
    : [];
  const heroPath = images[0]?.storage_path || "";
  const ogImage  = publicImageUrl(heroPath) || `${SITE_ORIGIN}/assets/og-image.png`;

  return {
    title: ogTitle,
    description: ogDescription,
    image: ogImage,
    url: requestUrl || `${SITE_ORIGIN}/listing?id=${encodeURIComponent(listingId)}`,
    pageTitle: `${ogTitle} — CanvasCircle`,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const listingId = url.searchParams.get("id");

  const assetResponse = await env.ASSETS.fetch(request);

  if (!listingId || !assetResponse.ok) {
    return assetResponse;
  }

  let listing;
  try {
    listing = await fetchListing(listingId);
  } catch {
    return assetResponse;
  }

  if (!listing || listing.moderation_status !== "approved") {
    return assetResponse;
  }

  let meta;
  try {
    meta = buildMeta(listing, listingId, request.url);
  } catch {
    return assetResponse;
  }

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
            `\n  <meta name="twitter:title"       content="${esc(meta.title)}" />` +
            `\n  <meta name="twitter:description" content="${esc(meta.description)}" />` +
            `\n  <meta name="twitter:image"       content="${esc(meta.image)}" />\n`,
            { html: true }
          );
        },
      });

    const transformed = rewriter.transform(assetResponse);

    const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
    headers.set("X-CC-OG-Injected", "1");

    return new Response(transformed.body, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  } catch {
    return assetResponse;
  }
}
