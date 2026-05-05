---
name: Catalog generator filename — now in sync
description: The local file and repo file are now both named generate_catalog.py
type: reference
originSessionId: 38188128-99a7-4ee8-ade9-9710c34a025f
---
The Python catalog generator lives at the same name in both locations:

- Local working copy: `/Users/gjscuderi/Documents/CanvasCircle/generate_catalog.py`
- GitHub repo (what the workflow runs): `unique-original-fineart/art_catalog/generate_catalog.py`

(Earlier in 2026 the local copy was named `generate_catalog_artwork_category_filter.py`, requiring a manual sync step. Guy renamed the local file to match the repo, eliminating that divergence.)

When updating the generator, Guy still needs to copy the contents from local to the repo (or push the local file as the repo's `generate_catalog.py`) before changes take effect on canvascircle.art — the workflow runs the repo version, not the local one.
