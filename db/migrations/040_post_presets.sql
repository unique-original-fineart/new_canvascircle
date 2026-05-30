-- =============================================================================
-- 040_post_presets.sql
-- =============================================================================
-- Per-group Facebook sales post presets. Replaces the single post_header /
-- post_footer pair on profiles with a JSON array of named presets, each
-- carrying its own header, footer, and "include seller-page link" toggle.
--
-- Why named presets:
--   Most active sellers post the same listing batch to 3-5 different FB
--   collector groups (Park West Collectors, modern prints, regional
--   groups, etc.). Each group has different tone / hashtag / rule
--   conventions, so they want a separate header+footer per group rather
--   than re-typing every time. Old design forced them to overwrite the
--   single shared header on every group switch.
--
-- Why include_seller_link per preset (not a profile-wide toggle):
--   Some FB groups discourage external links (FB occasionally shadowbans
--   posts with off-platform URLs). A seller might want the catalog link
--   on most posts but suppress it on the more strict groups. Per-preset
--   gives them that control without a separate setting page.
--
-- Schema:
--   profiles.post_presets jsonb — array of preset objects:
--     [
--       { "id": "<stable id>",
--         "name": "Default",
--         "header": "...",
--         "footer": "...",
--         "include_seller_link": false },
--       ...
--     ]
--
-- Backward compat:
--   Legacy post_header / post_footer columns are NOT dropped here. They
--   stay as inert storage in case any other code path still reads them
--   (or for emergency rollback). The portal UI is the source of truth
--   for presets going forward; legacy columns can be cleaned up in a
--   future migration once we're confident nothing references them.
--
-- Data migration:
--   For every profile that has a non-null post_header OR post_footer and
--   no presets yet, seed a single "Default" preset from the legacy values.
--   include_seller_link defaults to false (opt-in) to match prior behavior.
-- =============================================================================

-- (1) Add the column. Nullable; the UI seeds a "Default" preset on first
--     interaction for any profile that doesn't have one yet.
alter table public.profiles
  add column if not exists post_presets jsonb null;

-- (2) Backfill: convert any existing legacy header/footer into a single
--     "Default" preset. Only fires for profiles that haven't been touched
--     by the new UI yet (post_presets is null) AND that have something to
--     migrate (post_header or post_footer is non-null).
--
--     Stable id derived from user_id so re-running the migration is
--     idempotent (won't generate a duplicate Default preset with a new id).
update public.profiles
set post_presets = jsonb_build_array(
  jsonb_build_object(
    'id',                  'preset_' || substr(md5(user_id::text || ':default'), 1, 12),
    'name',                'Default',
    'header',              coalesce(post_header, ''),
    'footer',              coalesce(post_footer, ''),
    'include_seller_link', false
  )
)
where post_presets is null
  and (
    (post_header is not null and post_header <> '')
    or (post_footer is not null and post_footer <> '')
  );

comment on column public.profiles.post_presets is
  'Per-group Facebook sales post presets. JSONB array of objects shaped { id, name, header, footer, include_seller_link }. Source of truth for the Sales Post builder Step 1 — legacy post_header/post_footer columns are retained for rollback only.';
