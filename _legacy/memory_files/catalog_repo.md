---
name: GitHub repo for canvascircle.art
description: External repo where the public catalog is built and deployed
type: reference
originSessionId: 38188128-99a7-4ee8-ade9-9710c34a025f
---
The CanvasCircle public catalog (canvascircle.art) is built and deployed from the GitHub repo `unique-original-fineart/art_catalog`. Default branch is `main`. The "Update Catalog" workflow at `.github/workflows/update_catalog.yml` runs on a 30-minute schedule and on `repository_dispatch` with `event_type: "rebuild-catalog"`. The Apps Script `triggerCatalogRebuild_` posts to that endpoint after every admin moderation update — so approvals and rejections in the admin portal trigger a catalog rebuild within ~30–60 seconds. The custom domain canvascircle.art is wired via a CNAME file in the repo root.
