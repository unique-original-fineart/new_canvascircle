// =============================================================================
// Cloudflare Pages Function — per-listing OG meta-tag injection
// =============================================================================
// Routes: GET /listing.html  (Pages auto-discovers by file path)
//
// Why this exists:
//   listing.html is a client-rendered page that fetches the listing data via
//   Supabase JS after the page loads. That means social-media scrapers
//   (iMessage, Slack, WhatsApp, Twitter, Facebook, Discord) — none of which
//   execute JS — only see the static <head>, which has a generic og:image
//   pointing at the CanvasCircle logo. Every shared listing link resolves to
//   the same boring preview card, and the user has to tap through to see
//   what was actually being shared. That kills the conversion rate of every
//   share-to-iMessage and every paste-into-Slack.
//
//   This Function runs on the edge BEFORE the HTML reaches the browser. It
//   fetches the listing from Supabase (using the public anon key + RLS to
//   stay safe), generates per-listing og:* + twitter:* meta tags, and
//   streams them into the response via HTMLRewriter. By the time iMessage
//   pings the URL to build a preview card, the meta tags are already there.
//
//   The browser still hydrates normally afterward — the existing client-side
//   setOgTags() in listing.html still runs and is harmless (it just
//   over-writes attributes we already set to the same values).
//
// Failure modes (all degrade gracefully back to the static HTML):
//   - No `?id=` in URL: pass through unchanged
//   - Supabase fetch fails or times out: pass through unchanged
//   - Listing not found OR not approved: pass through unchanged (don't leak
//     pending / rejected content to scrapers)
//   - HTMLRewriter throws: pass through unchanged
//
// Why hard-coded SUPABASE creds instead of env vars:
//   The anon key is a public JWT — it's already committed in lib/config.js
//   and ships to every browser. RLS protects the data; the key just identifies
//   the caller. Cloudflare Pages env vars add a moving part with no security
//   benefit here.
//
// Cache strategy:
//   Cache the rewritten response for 5 minutes at the edge. Listings update
//   infrequently enough that a 5-min lag in the share preview is invisible to
//   users; rebuilding the OG card on every share-link impression would be
//   wasted Supabase egress.
// =============================================================================

const SUPABASE_URL      = "https://xwieomjsqwcswoadrvkv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3aWVvbWpzcXdjc3dvYWRydmt2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MzMzOTAsImV4cCI6MjA5MzUwOTM5MH0.G2jYVS788F6zI7vHNPOPVRM0sYdD_iVb6k6gdw6BcfA";
const STORAGE_BUCKET    = "listing-images";
const SITE_ORIGIN       = "https://canvascircle.art";

const SCRAPER_FETCH_TIMEOUT_MS = 2500;  // upper bound on Supabase round-trip

// HTML-escape for attribute values. Keep tiny + dependency-free — this fn
// runs in the V8 isolate on every request.
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

// Resolve a Supabase Storage path to a public URL pointing at the on-the-fly
// image-transform endpoint, not the raw object. Two reasons:
//   1. Many of our legacy-imported images are 3-8MB (full camera-roll resolution
//      because import_legacy.py didn't recompress on insert). Sending a 3MB
//      file as og:image makes Slack render "(3 MB)" next to the preview and
//      slows iMessage's preview build to a crawl. The transform endpoint
//      resizes to 1200px on the long edge + quality 75 + WebP, dropping that
//      to ~150-300KB at the edge with no source-file change. Result is cached
//      at Supabase's CDN per URL so repeated scrapes hit the same byte stream.
//   2. Portal-uploaded images are already WebP @ 1200px / 0.75, so the
//      transform is near-idempotent on those (tiny quality re-encode, basically
//      free). Using one path for all images keeps the function simple.
// Legacy http(s) URLs (the old Google CDN imports) don't have transform
// support, so we pass them through unchanged.
function publicImageUrl(storagePath) {
  if (!storagePath) return "";
  if (/^https?:\/\//i.test(storagePath)) return storagePath;
  return `${SUPABASE_URL}/storage/v1/render/image/public/${STORAGE_BUCKET}/${storagePath}?width=1200&quality=75&resize=contain`;
}

async function fetchListing(listingId) {
  // Order images by position so the hero (position 0) shows up in [0].
  // Selecting only the fields we actually need keeps the response small.
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

  // Manual timeout — the iMessage scraper has its own deadline and we'd
  // rather serve a generic preview than a 504. If we run out of budget we
  // bail and the static HTML's default og:image wins.
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
    // og:url should match the URL the page was actually requested at —
    // some scrapers (notably Twitter) validate that og:url matches the
    // fetched URL, and using the request URL also keeps the canonical
    // URL consistent whether the user shared /listing?id=X or
    // /listing.html?id=X. Falls back to a hardcoded path if requestUrl
    // wasn't passed (defensive — shouldn't happen).
    url: requestUrl || `${SITE_ORIGIN}/listing?id=${encodeURIComponent(listingId)}`,
    // Page <title> includes the suffix so non-OG-aware previewers (Slack
    // sometimes uses <title>) still get a clean string.
    pageTitle: `${ogTitle} — CanvasCircle`,
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const listingId = url.searchParams.get("id");

  // The static HTML is what we start from regardless — env.ASSETS.fetch
  // returns the underlying /listing.html as Cloudflare Pages would have
  // served it without this Function.
  const assetResponse = await env.ASSETS.fetch(request);

  // No id, or asset request failed → pass through unchanged. Don't try
  // to be clever; the page can still render client-side for the user.
  if (!listingId || !assetResponse.ok) {
    return assetResponse;
  }

  let listing;
  try {
    listing = await fetchListing(listingId);
  } catch {
    return assetResponse;
  }

  // Listing missing OR not approved — don't leak pending / rejected content
  // to social scrapers. Pass through with the generic preview instead.
  if (!listing || listing.moderation_status !== "approved") {
    return assetResponse;
  }

  let meta;
  try {
    meta = buildMeta(listing, listingId, request.url);
  } catch {
    return assetResponse;
  }

  // HTMLRewriter streams the response and rewrites tags as they pass.
  // Cheap (no buffering) and well-supported on Pages Functions.
  //
  // What we do:
  //   - Overwrite <title>
  //   - Overwrite the static <meta property="og:image"> (generic fallback)
  //   - Append og:title, og:description, og:url, twitter:title,
  //     twitter:description, twitter:image to <head>
  //
  // We don't touch the JS-set og:* tags inside the page logic — those run
  // post-hydration and will simply re-set the same values for the live
  // browser. Harmless.
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

    // Re-wrap with our own caching headers so the edge caches per-listing
    // OG cards for 5 minutes. Without this, the original static asset's
    // headers (which assume the file never changes per URL) would be used.
    const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
    headers.set("X-CC-OG-Injected", "1");  // diagnostic — strip later if noisy

    return new Response(transformed.body, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  } catch {
    // Belt-and-braces: if HTMLRewriter throws for any reason, fall back to
    // the unmodified static asset so the page still loads.
    return assetResponse;
  }
}
