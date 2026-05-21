-- =============================================================================
-- 027_non_established_listing_cap.sql
-- =============================================================================
-- Cap non-Established Members at 10 active SALE listings.
--
-- "Active" for this purpose means status IN ('available', 'pending',
-- 'not_renewed'). Sold and delisted listings don't count — sellers keep
-- their portfolio history without it counting against the cap.
--
-- ISO listings are NOT capped. The constraint is about preventing new
-- sellers from flooding the sale catalog before they've built trust;
-- ISO posts are buyer requests and don't have the same risk profile.
--
-- Established Members (profiles.is_trusted = true) have no cap. The
-- expected onramp: post up to 10 listings, verify 4 of them, request 3
-- references — at which point the auto-promotion trigger from migration
-- 023 fires and the cap lifts.
--
-- The DB trigger is authoritative — the portal-side check at the +New
-- Post button is just to give the user a clear "you're at cap" message
-- before they invest effort in the form. A client that bypasses the
-- portal still hits this trigger.
-- =============================================================================

create or replace function public.enforce_non_established_listing_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_trusted    boolean;
  v_current_count int;
  v_cap           int := 10;
begin
  -- Only enforce on sale-listing inserts. ISO posts are unrestricted.
  if new.listing_type is distinct from 'sale' then
    return new;
  end if;

  -- Established Members are exempt. Look up the seller's trust state.
  select is_trusted into v_is_trusted
    from public.profiles
   where user_id = new.seller_id;

  if v_is_trusted is true then
    return new;
  end if;

  -- Count the seller's current active sale listings (excluding sold +
  -- delisted, which are "dead" listings). The new row hasn't been
  -- inserted yet, so we're comparing the pre-insert count.
  select count(*) into v_current_count
    from public.listings
   where seller_id    = new.seller_id
     and listing_type = 'sale'
     and status in ('available', 'pending', 'not_renewed');

  if v_current_count >= v_cap then
    raise exception
      'Listing cap reached: non-Established Members can have at most % active sale listings at once (currently %). To lift this cap, become an Established Member by getting 4 Ownership Verified listings + 3 accepted Sales References. See your Profile tab for progress.',
      v_cap, v_current_count;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_non_established_listing_cap on public.listings;
create trigger trg_enforce_non_established_listing_cap
  before insert on public.listings
  for each row execute function public.enforce_non_established_listing_cap();

-- =============================================================================
-- End of migration 027. Requires public.profiles.is_trusted (existing).
-- Portal-side UX (count indicator, disabled "+ New post" button) lives in
-- portal/index.html.
-- =============================================================================
