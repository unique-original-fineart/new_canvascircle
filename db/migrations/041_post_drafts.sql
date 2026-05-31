-- =============================================================================
-- 041_post_drafts.sql
-- =============================================================================
-- Saved Facebook sales-post compositions. Lets a seller pause mid-flow (or
-- after generating) and resume later — useful when they're preparing posts
-- across the week to drop into different FB groups, or when they get
-- interrupted before posting.
--
-- Why on profiles instead of a dedicated table:
--   Drafts are per-seller, low cardinality (UI cap of 10), and never
--   referenced by anything else. JSONB on profiles mirrors the post_presets
--   pattern (migration 040) and keeps the schema lean. If the cap rises or
--   we add cross-table joins later, we can promote to a real table without
--   data loss (jsonb_array_elements gives a clean migration path).
--
-- Shape of each element in post_drafts:
--   {
--     "id":                "draft_<rand>",
--     "name":              "Draft for Park West Group",
--     "listing_ids":       ["uuid", "uuid", ...],
--     "preset_id":         "preset_<rand>" | null,
--     "tiles_per_collage": 6,
--     "text_snapshot":     "...the generated post text (editable)...",
--     "created_at":        "2026-05-30T20:30:00Z"
--   }
--
-- The UI is the source of truth for the cap (10) — we don't enforce it at
-- the DB level because the limit is purely UX (keeping the drafts picker
-- manageable). Sellers who hit it see the oldest entry evicted on next save.
-- =============================================================================

alter table public.profiles
  add column if not exists post_drafts jsonb null;

comment on column public.profiles.post_drafts is
  'Saved Facebook sales post compositions. JSONB array of objects shaped { id, name, listing_ids[], preset_id, tiles_per_collage, text_snapshot, created_at }. Capped at 10 per profile by UI (auto-evicts oldest). Lets a seller resume an in-progress sales post — restores listing selection + active preset + tiles choice + the live editable text.';
