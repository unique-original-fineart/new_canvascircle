// =============================================================================
// Cloudflare Pages Function — per-seller OG meta-tag injection (/seller.html)
// =============================================================================
// Routes: GET /seller.html  (the .html variant — both forms work on Pages)
//
// Sibling of /functions/seller.js. See that file's header for the full
// rationale on why a per-seller OG card matters AND why we duplicate
// the file rather than import a shared helper. If this file and
// seller.js diverge, fix seller.js first and mirror the change here.
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
  const fields = "user_id,display_name,handle,is_trusted,account_status,collection_is_public,collection_about_text,about_text";
  const rows = await pgFetch(
    `/rest/v1/profiles?handle=ilike.${encodeURIComponent(handle)}&select=${fields}&limit=1`
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function fetchFirstListingImage(sellerId) {
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
  const rows = await pgFetch(`/rest/v1/rpc/get_public_collection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ p_owner_id: ownerId }),
  });
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows[0]?.image_path || "";
}

function snippet(text, max = 200) {
  const s = String(text || "").trim().replace(/\s+/g, " ");
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function buildSellerMeta({ profile, mode, image, requestUrl }) {
  const displayName = (profile.display_name || profile.handle || "A collector").trim();
  const handle      = profile.handle || "";
  const handleStr   = handle ? `@${handle}` : "";

  let title, description;
  if (mode === "collection") {
    title = handleStr
      ? `${displayName}'s art Collection (${handleStr}) on CanvasCircle`
      : `${displayName}'s art Collection on CanvasCircle`;
    description = profile.collection_about_text
      ? snippet(profile.collection_about_text)
      : `Browse the pieces ${displayName} owns. Curated on CanvasCircle, the modern art listing platform for collectors.`;
  } else {
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

  const assetResponse = await env.ASSETS.fetch(request);

  if (!handle || !assetResponse.ok) return assetResponse;

  let profile;
  try {
    profile = await fetchSellerProfile(handle);
  } catch {
    return assetResponse;
  }
  if (!profile || profile.account_status !== "active") return assetResponse;

  const collectionMode = tab === "collection"
    && !!profile.collection_is_public
    && !!profile.is_trusted;

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
    headers.set("X-CC-OG-Injected", "seller");

    return new Response(transformed.body, {
      status: transformed.status,
      statusText: transformed.statusText,
      headers,
    });
  } catch {
    return assetResponse;
  }
}
