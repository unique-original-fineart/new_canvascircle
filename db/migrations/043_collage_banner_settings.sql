-- =============================================================================
-- 043_collage_banner_settings.sql
-- =============================================================================
-- Per-seller styling for the Sales Post Builder's generated collage tiles.
-- Until now, every collage tile rendered with the same hardcoded dark-brown
-- header strip (#1f1a17 bg / white Georgia text) and a fixed red "SOLD"
-- overlay. Sellers asked for two things (cc-v142):
--   1. Turn the header banner off entirely — some sellers prefer a clean
--      image with no text overlay at all.
--   2. Customize the banner color, font, and the SOLD label text — so a
--      seller can theme their Facebook posts to match their personal brand.
--
-- Settings live on profiles as a single jsonb column rather than 6 columns
-- because the schema may grow (new banner positions, gradient backgrounds,
-- etc.) and we'd rather not migrate every time. The column is NOT NULL with
-- a default so query code never has to handle null.
--
-- Defaults match the pre-feature behavior exactly: dark header on, SOLD
-- overlay on, the original color + font + label. So sellers who never open
-- the settings panel see no visual change.
--
-- See [[sales-post-strategic-importance]] memory for context on why this
-- feature is weight-bearing despite being aesthetic — convenience compounding
-- on the Sales Post Builder is the platform's seller-acquisition lever.
-- =============================================================================

alter table public.profiles
  add column if not exists collage_banner_settings jsonb not null default jsonb_build_object(
    'header_enabled',  true,
    'sold_enabled',    true,
    'bg_color',        '#1f1a17',
    'text_color',      '#ffffff',
    'font_family',     'Georgia, ''Times New Roman'', serif',
    'sold_label',      'SOLD'
  );

-- Backfill any existing rows that somehow predate the default — safe no-op
-- in the normal case where the column default already populated everything.
update public.profiles
   set collage_banner_settings = jsonb_build_object(
     'header_enabled',  true,
     'sold_enabled',    true,
     'bg_color',        '#1f1a17',
     'text_color',      '#ffffff',
     'font_family',     'Georgia, ''Times New Roman'', serif',
     'sold_label',      'SOLD'
   )
 where collage_banner_settings is null
    or collage_banner_settings = '{}'::jsonb;

comment on column public.profiles.collage_banner_settings is
  'Sales Post Builder collage tile styling. JSON keys: header_enabled (bool, show artist–title strip), sold_enabled (bool, show SOLD overlay), bg_color (hex, header strip + SOLD overlay tint), text_color (hex), font_family (CSS font-family string), sold_label (text, what the SOLD overlay says). Defaults preserve pre-feature look.';
