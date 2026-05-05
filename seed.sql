-- =============================================================================
-- CanvasCircle — Seed test data
-- =============================================================================
-- Use this to populate the empty catalog with a few example listings so you
-- can see the UI render and click through end-to-end. Safe to run multiple
-- times — every row uses ON CONFLICT DO NOTHING.
--
-- Setup before running:
--   1. In Supabase, go to Authentication > Users > "Add user".
--      Create one user (use your real email, e.g. gjscuderi@gmail.com).
--      Pick "Auto Confirm User" so you don't have to verify email for seeds.
--      Copy the resulting User UID — it looks like
--      "1f2e3d4c-5b6a-7980-1234-567890abcdef".
--   2. Replace the placeholder below (SEED_USER_ID) with that UUID.
--   3. Open SQL Editor > New query > paste this entire file > Run.
--
-- After running:
--   - Visit https://new-canvascircle.pages.dev — you should see 4 cards.
--   - Click any card to open listing.html — full detail page should render.
-- =============================================================================

-- Make this user an admin for downstream testing.
do $$
declare
  seed_user_id uuid := '2b03f77b-8f49-4bc2-b9b3-2c2a881e70a1'::uuid;
begin
  -- Promote to admin
  update public.profiles
     set is_admin = true,
         display_name = coalesce(display_name, 'Guy'),
         location     = coalesce(location, 'New York, NY'),
         facebook_profile_url = coalesce(facebook_profile_url, 'https://facebook.com/canvascircle')
   where user_id = seed_user_id;

  -- Listing 1: a clearly-available painting with a price drop
  insert into public.listings (
    listing_id, seller_id, artist_name, artwork_title, artwork_category,
    medium, year_created, height_in, width_in,
    condition_notes, description,
    asking_price_usd, previous_price_usd, price_updated_at,
    shipping_offered, coa_included,
    status, moderation_status, seller_mood
  ) values (
    '11111111-1111-1111-1111-111111111111', seed_user_id,
    'Helen Frankenthaler', 'Untitled (study in blue)', 'Painting',
    'Acrylic on canvas', '1972', 24, 36,
    'Excellent. No tears, no restoration. Light frame wear.',
    'A late-period color-field study from a private New England estate. Acquired directly from the family in 2019.',
    4800, 5500, now() - interval '3 days',
    'Yes', 'No',
    'available', 'approved', 'Open to Offers'
  ) on conflict (listing_id) do nothing;

  insert into public.listing_images (listing_id, storage_path, position) values
    ('11111111-1111-1111-1111-111111111111',
     'https://images.unsplash.com/photo-1549887534-1541e9326642?w=1200', 0)
  on conflict do nothing;

  -- Listing 2: a sculpture, motivated to sell
  insert into public.listings (
    listing_id, seller_id, artist_name, artwork_title, artwork_category,
    medium, year_created, height_in, width_in, depth_in,
    description,
    asking_price_usd,
    shipping_offered, coa_included,
    status, moderation_status, seller_mood
  ) values (
    '22222222-2222-2222-2222-222222222222', seed_user_id,
    'Anonymous Mid-Century', 'Bronze figural form', 'Sculpture',
    'Patinated bronze on marble base', 'c. 1965', 14, 6, 6,
    'Unsigned mid-century bronze, cast in the manner of Henry Moore. Patina intact.',
    1250,
    'Yes', 'Yes',
    'available', 'approved', 'Motivated to Sell'
  ) on conflict (listing_id) do nothing;

  insert into public.listing_images (listing_id, storage_path, position) values
    ('22222222-2222-2222-2222-222222222222',
     'https://images.unsplash.com/photo-1578321272176-b7bbc0679853?w=1200', 0)
  on conflict do nothing;

  -- Listing 3: a print, price firm
  insert into public.listings (
    listing_id, seller_id, artist_name, artwork_title, artwork_category,
    medium, year_created, height_in, width_in,
    condition_notes, provenance, description,
    asking_price_usd,
    shipping_offered, coa_included,
    status, moderation_status, seller_mood
  ) values (
    '33333333-3333-3333-3333-333333333333', seed_user_id,
    'Roy Lichtenstein', 'Sweet Dreams Baby! (study)', 'Print',
    'Screenprint, edition of 200', '1965', 30, 22,
    'Pencil-signed, numbered 47/200. Slight handling marks at margin.',
    'From the collection of a retired NY gallerist. Documentation available on request.',
    'A study impression from the artist''s 1965 series of war-era pop comic prints. Vibrant colors, bold registration.',
    18500,
    'Yes', 'Yes',
    'available', 'approved', 'Price Firm'
  ) on conflict (listing_id) do nothing;

  insert into public.listing_images (listing_id, storage_path, position) values
    ('33333333-3333-3333-3333-333333333333',
     'https://images.unsplash.com/photo-1513364776144-60967b0f800f?w=1200', 0)
  on conflict do nothing;

  -- Listing 4: a sold drawing (still visible per RLS policy)
  insert into public.listings (
    listing_id, seller_id, artist_name, artwork_title, artwork_category,
    medium, year_created, height_in, width_in,
    description,
    asking_price_usd,
    shipping_offered, coa_included,
    status, moderation_status
  ) values (
    '44444444-4444-4444-4444-444444444444', seed_user_id,
    'Egon Schiele (after)', 'Seated nude', 'Drawing',
    'Pencil and watercolor on paper', '1918', 16, 12,
    'A close period copy after Schiele''s 1918 nudes. Unsigned. Beautifully rendered.',
    900,
    'No', 'No',
    'sold', 'approved'
  ) on conflict (listing_id) do nothing;

  insert into public.listing_images (listing_id, storage_path, position) values
    ('44444444-4444-4444-4444-444444444444',
     'https://images.unsplash.com/photo-1579783901586-d88db74b4fe4?w=1200', 0)
  on conflict do nothing;

  raise notice 'Seed complete. Listings inserted under user %', seed_user_id;
end $$;


-- =============================================================================
-- Tear down: if you want to wipe seeds and start fresh, run this section
-- separately (commented out by default). It only deletes the four seed UUIDs.
-- =============================================================================
-- delete from public.listings where listing_id in (
--   '11111111-1111-1111-1111-111111111111',
--   '22222222-2222-2222-2222-222222222222',
--   '33333333-3333-3333-3333-333333333333',
--   '44444444-4444-4444-4444-444444444444'
-- );
