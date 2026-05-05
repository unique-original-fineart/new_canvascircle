---
name: Drive image URLs in Apps Script iframes — iOS Safari quirk
description: Why the seller and admin portals use lh3.googleusercontent.com URLs instead of drive.google.com/thumbnail
type: reference
originSessionId: 38188128-99a7-4ee8-ade9-9710c34a025f
---
The seller portal and admin portal serve their HTML through Apps Script's HtmlService, which wraps the page in a `script.googleusercontent.com` iframe inside `script.google.com`. Inside that iframe context, **iOS Safari (and to a lesser extent other mobile browsers) intermittently blocks image requests to `drive.google.com/thumbnail?id=…&sz=w…`** — even when the file's sharing is set to ANYONE_WITH_LINK. Symptoms: empty cards with the iOS broken-image "?" glyph; works fine on desktop browsers and on the public catalog (which is served from canvascircle.art, not from inside an iframe).

**Fix:** in `processArtworkSubmissions.gs`, `buildDisplayImageUrl_` returns the underlying Google CDN URL directly:

```
https://lh3.googleusercontent.com/d/{fileId}=w1200
```

This is the URL that `drive.google.com/thumbnail` redirects to anyway. Skipping the redirect avoids whatever iOS Safari + iframe is doing that drops the request. The hardcoded brand-logo `<img>` in `seller_portal.html` also uses this format for the same reason.

**Defense-in-depth additions on the `<img>` tags themselves:**
- `referrerpolicy="no-referrer"` so the browser omits the Referer header (Drive's CDN serves anonymous requests fine)
- `loading="lazy"` (perf, not a correctness fix)

**What NOT to switch to:** `drive.google.com/thumbnail?id=…` — the original failure mode. `drive.google.com/uc?export=view&id=…` works for some files but has its own size-cap issues. Stick with `lh3.googleusercontent.com/d/{id}=w{N}`.

**Note for future image work:** the public catalog (`canvascircle.art`, served by GitHub Pages, not iframed) doesn't have this problem and uses the `drive.google.com/thumbnail` URL form in some places. Don't "fix" the catalog to match — only the portal files need the lh3 form.
