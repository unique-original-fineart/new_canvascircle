---
name: Apps Script deployment config and auth model
description: Web app deployment settings and how admin/seller auth works
type: reference
originSessionId: 38188128-99a7-4ee8-ade9-9710c34a025f
---
The Apps Script web app for `processArtworkSubmissions.gs` is deployed with:

- **Execute as**: Me (gjscuderi@gmail.com) — required so the script can read/write the spreadsheet, manage Drive files, and send email without each visitor needing access.
- **Who has access**: Anyone with Google account — required so `Session.getActiveUser().getEmail()` returns the visitor's email for the admin gate.

**Auth model:**

- **Admin portal** at `?page=admin` is gated by `isAdminUser_()` which compares `Session.getActiveUser().getEmail()` against the `ADMIN_EMAIL` constant (= gjscuderi@gmail.com). `getAdminListings`, `updateModerationStatus`, and `rotateSellerTokenByEmail` are also server-gated as defense in depth.
- **Seller portal** uses magic-link UUID tokens via `?seller_token=<uuid>`. Tokens never expire automatically; they can be rotated on demand via the admin portal's "Rotate seller link" UI when a seller reports a leaked link. Rotation invalidates the old token and emails the seller a fresh one.

**Script properties** contain `GITHUB_PAT` (fine-grained PAT scoped to art_catalog with **Contents: read+write** — note: not Actions, despite the intuition; that's a GitHub API quirk) and `GITHUB_REPO` (= `unique-original-fineart/art_catalog`).

**Deploy gotcha**: when `.gs` code changes, Guy must redeploy a new version (Manage deployments → ✏️ → New version → Deploy) for the deployed `/exec` URL to pick up the changes. Saving alone doesn't deploy. Also: any time a new Google API scope is added (e.g., `UrlFetchApp` for the dispatch call), Guy needs to manually run a function from the editor once to trigger the OAuth re-authorization for the new scope; web app invocations can't trigger auth prompts.
