-- =============================================================================
-- 034_preferred_contact_add_facebook.sql
-- =============================================================================
-- Adds 'facebook' as a valid value for profiles.preferred_contact. Sellers who
-- prefer Facebook Messenger as their primary contact channel can now signal
-- that preference; the listing-page hint chip surfaces a "Prefers Facebook
-- Messenger — tap Message on Facebook" message accordingly.
--
-- The portal-side UI warns the seller that picking Facebook narrows their
-- reachable audience (buyers without an FB account can't use that path).
-- That's a product decision, not a DB constraint — we still accept the value.
-- =============================================================================

alter table public.profiles
  drop constraint if exists profiles_preferred_contact_check;
alter table public.profiles
  add constraint profiles_preferred_contact_check
  check (preferred_contact in ('email', 'phone', 'facebook', 'either'));
