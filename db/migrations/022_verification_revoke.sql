-- =============================================================================
-- 022_verification_revoke.sql
-- =============================================================================
-- Ownership Verification revoke support — two paths:
--
--   1) MANUAL admin revoke. Admin calls revoke_listing_verification(listing_id,
--      reason) from the moderation portal. All currently-approved-and-active
--      verification rows on that listing get stamped with revoked_at /
--      revoked_by / revoke_reason. The sync trigger then flips
--      listings.verification_status from 'verified' to 'revoked' (a new state).
--
--   2) AUTOMATIC revoke when the listing's content materially changes.
--      Two triggers watch the data:
--        - listings: any change to artist_name, artwork_title, or
--          artwork_category on a currently-verified listing auto-revokes.
--        - listing_images: any change that swaps the position-0 (primary)
--          image — INSERT at pos 0, UPDATE that touches pos-0 storage_path or
--          position, or DELETE of a pos-0 row — auto-revokes.
--      Auto-revocations are stamped with a synthetic revoked_by = null and a
--      descriptive revoke_reason so the seller (and any admin auditing) sees
--      exactly which field triggered the revocation.
--
-- State machine after this migration:
--   none      → no submissions ever, or all withdrawn
--   pending   → there's a submission awaiting admin review (overrides
--               revoked — i.e., if a previously-revoked listing has the seller
--               trying again, we want them to see "pending" not "revoked")
--   verified  → at least one approved-AND-not-revoked submission
--   revoked   → had ≥1 approved submission, but all approved rows are now
--               revoked (manual or auto) AND no pending submission exists
--   rejected  → no approved/pending exists, latest meaningful row is rejected
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add revocation columns to listing_verifications
-- ---------------------------------------------------------------------------
alter table public.listing_verifications
  add column if not exists revoked_at    timestamptz,
  add column if not exists revoked_by    uuid references public.profiles(user_id) on delete set null,
  add column if not exists revoke_reason text;

-- Index so the sync trigger's "approved AND not revoked" count stays cheap.
create index if not exists listing_verifications_active_approved_idx
  on public.listing_verifications (listing_id)
  where status = 'approved' and revoked_at is null;

-- ---------------------------------------------------------------------------
-- 2. Add 'revoked' to listings.verification_status check constraint
-- ---------------------------------------------------------------------------
alter table public.listings
  drop constraint if exists listings_verification_status_check;
alter table public.listings
  add constraint listings_verification_status_check
  check (verification_status in ('none', 'pending', 'verified', 'rejected', 'revoked'));

-- ---------------------------------------------------------------------------
-- 3. Replace the sync trigger function — now handles revoked state
-- ---------------------------------------------------------------------------
-- An approved row with revoked_at IS NOT NULL no longer counts toward
-- 'verified'. A listing that USED to be verified but no longer is (because
-- all its approved rows got revoked) flips to 'revoked' rather than back to
-- 'none' or 'rejected', so the seller sees a clear "your badge was taken
-- away" state in the portal.
--
-- Order of precedence:
--   approved-active > 0  → verified
--   pending > 0          → pending  (seller is actively trying again)
--   approved-revoked > 0 → revoked  (had a badge, lost it)
--   rejected > 0         → rejected
--   else                 → none
-- ---------------------------------------------------------------------------
create or replace function public.sync_listing_verification_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_listing_id      uuid;
  approved_active_count  int;
  approved_revoked_count int;
  pending_count          int;
  rejected_count         int;
  approved_when          timestamptz;
  new_status             text;
  new_verified_at        timestamptz;
begin
  target_listing_id := coalesce(new.listing_id, old.listing_id);

  select
    count(*) filter (where status = 'approved' and revoked_at is null),
    count(*) filter (where status = 'approved' and revoked_at is not null),
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'rejected'),
    max(reviewed_at) filter (where status = 'approved' and revoked_at is null)
  into approved_active_count, approved_revoked_count, pending_count, rejected_count, approved_when
  from public.listing_verifications
  where listing_id = target_listing_id;

  if approved_active_count > 0 then
    new_status      := 'verified';
    new_verified_at := approved_when;
  elsif pending_count > 0 then
    new_status      := 'pending';
    new_verified_at := null;
  elsif approved_revoked_count > 0 then
    new_status      := 'revoked';
    new_verified_at := null;
  elsif rejected_count > 0 then
    new_status      := 'rejected';
    new_verified_at := null;
  else
    new_status      := 'none';
    new_verified_at := null;
  end if;

  update public.listings
     set verification_status = new_status,
         verified_at         = new_verified_at
   where listing_id = target_listing_id;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RPC for admin manual revoke
-- ---------------------------------------------------------------------------
-- Marks every currently-approved-and-active verification row on the listing
-- as revoked, stamping admin's user_id + the reason. The sync trigger will
-- then flip the listing's verification_status to 'revoked'.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_listing_verification(
  p_listing_id uuid,
  p_reason     text
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  if not public.is_admin() then
    raise exception 'Only admins can revoke verifications';
  end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A revoke reason is required';
  end if;

  update public.listing_verifications
     set revoked_at    = now(),
         revoked_by    = auth.uid(),
         revoke_reason = p_reason
   where listing_id = p_listing_id
     and status = 'approved'
     and revoked_at is null;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.revoke_listing_verification(uuid, text) from public;
revoke all on function public.revoke_listing_verification(uuid, text) from anon;
grant execute on function public.revoke_listing_verification(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Auto-revoke trigger on listings — fires when material content changes
-- ---------------------------------------------------------------------------
-- Watches artist_name, artwork_title, artwork_category. If any of those
-- change on a listing that's currently verified, all active approved
-- verifications are revoked with a synthetic revoke_reason naming the field
-- (or fields) that changed.
-- ---------------------------------------------------------------------------
create or replace function public.auto_revoke_on_listing_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes text[] := array[]::text[];
begin
  if old.artist_name      is distinct from new.artist_name      then v_changes := array_append(v_changes, 'artist name');      end if;
  if old.artwork_title    is distinct from new.artwork_title    then v_changes := array_append(v_changes, 'artwork title');    end if;
  if old.artwork_category is distinct from new.artwork_category then v_changes := array_append(v_changes, 'artwork category'); end if;

  if array_length(v_changes, 1) > 0
     and old.verification_status = 'verified' then
    update public.listing_verifications
       set revoked_at    = now(),
           revoked_by    = null,  -- system action, not an admin
           revoke_reason = 'Auto-revoked: listing changed ('
                           || array_to_string(v_changes, ', ') || ')'
     where listing_id = new.listing_id
       and status = 'approved'
       and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_auto_revoke_on_listing_change on public.listings;
create trigger trg_auto_revoke_on_listing_change
  after update of artist_name, artwork_title, artwork_category
  on public.listings
  for each row execute function public.auto_revoke_on_listing_change();

-- ---------------------------------------------------------------------------
-- 6. Auto-revoke trigger on listing_images — fires when primary image swaps
-- ---------------------------------------------------------------------------
-- The "primary" image is the row with position = 0. We auto-revoke when:
--   INSERT — a new row at position 0 appears (either first image ever, or
--            replacing one in a delete-then-insert flow)
--   UPDATE — a row's position becomes 0 (promotion), a row's position
--            stops being 0 (demotion), or the storage_path of a pos-0 row
--            changes (most common path — the seller portal does this)
--   DELETE — a pos-0 row is removed
-- ---------------------------------------------------------------------------
create or replace function public.auto_revoke_on_primary_image_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing_id     uuid;
  v_should_revoke  boolean := false;
begin
  v_listing_id := coalesce(new.listing_id, old.listing_id);

  if tg_op = 'INSERT' and new.position = 0 then
    v_should_revoke := true;
  elsif tg_op = 'UPDATE' and (
       (new.position = 0 and old.position is distinct from 0)
    or (old.position = 0 and new.position is distinct from 0)
    or (new.position = 0 and old.position = 0 and new.storage_path is distinct from old.storage_path)
  ) then
    v_should_revoke := true;
  elsif tg_op = 'DELETE' and old.position = 0 then
    v_should_revoke := true;
  end if;

  if v_should_revoke then
    -- Only revoke if the listing currently has the verified badge. Avoids
    -- pointless writes when (e.g.) a new listing's first image is uploaded.
    if exists (
      select 1 from public.listings
       where listing_id = v_listing_id
         and verification_status = 'verified'
    ) then
      update public.listing_verifications
         set revoked_at    = now(),
             revoked_by    = null,
             revoke_reason = 'Auto-revoked: listing primary image changed'
       where listing_id = v_listing_id
         and status = 'approved'
         and revoked_at is null;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_auto_revoke_on_primary_image_change on public.listing_images;
create trigger trg_auto_revoke_on_primary_image_change
  after insert or update or delete
  on public.listing_images
  for each row execute function public.auto_revoke_on_primary_image_change();

-- =============================================================================
-- End of migration 022. Requires migration 020 (listing_verifications + the
-- sync_listing_verification_status trigger this migration replaces).
-- =============================================================================
