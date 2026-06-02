-- =============================================================================
-- 044_shipping_calculator.sql
-- =============================================================================
-- Buyer-facing shipping calculator support: collect the data a buyer needs to
-- look up an exact rate at pirateship.com without contacting the seller first.
--
-- profiles.shipping_zip
--   5-digit US ZIP, optional, used by the in-platform shipping calculator
--   widget on listing.html. The existing profiles.location field ("Central NJ"
--   etc.) stays as-is for the public seller page; ZIP is finer-grained but
--   still not really PII at the same level as contact_email or facebook_url
--   (it's the same disclosure level a published-on-the-web seller already
--   accepts). Granted to anon so anon viewers also see the calculator.
--
-- listings.pack_box_length_in / width_in / height_in / weight_lbs
--   Per-listing packed-box outside dimensions + total weight. Optional.
--   Sellers fill these in when they know what box they'll ship with (often
--   not until they're actually packing the piece). When all four are
--   present AND the seller has set shipping_zip, the buyer-side "Estimate
--   shipping" button on the listing detail page becomes visible.
--
--   ISO listings (in-search-of) don't ship and the calculator hides for them
--   regardless. Numeric(5,1) gives plenty of headroom (up to 9,999.9 — far
--   beyond any realistic box dimension or art-package weight) and one decimal
--   of precision for the rare "45.5 inch" packing case.
-- =============================================================================

alter table public.profiles
  add column if not exists shipping_zip text;

alter table public.listings
  add column if not exists pack_box_length_in numeric(5,1),
  add column if not exists pack_box_width_in  numeric(5,1),
  add column if not exists pack_box_height_in numeric(5,1),
  add column if not exists pack_weight_lbs    numeric(5,1);

-- Anon viewers see the calculator too. shipping_zip is no more sensitive
-- than the city/state in profiles.location which anon already sees on
-- public seller pages (per migration 016 + 018 + the seller.html anon
-- column projection).
grant select (shipping_zip) on public.profiles to anon;

comment on column public.profiles.shipping_zip is
  'Seller US ZIP code (5 digits). Used only by the in-platform shipping calculator widget on listing.html to seed a Pirate Ship rate lookup for buyers. Not displayed prominently on the public seller page (UI choice), though granted to anon SELECT.';

comment on column public.listings.pack_box_length_in is
  'Packed-box outside length in inches. Buyer-facing shipping calculator uses L/W/H + weight to seed a Pirate Ship rate lookup. Optional. Calculator widget hides on listings that have any of the four fields missing.';
