-- =============================================================================
-- 018_seller_about_text.sql
-- =============================================================================
-- Adds an optional "About" blurb to each seller's profile, with the same
-- admin-approval pattern as display name changes.
--
-- Columns:
--   about_text          — the LIVE, approved About text. Public-safe; anon
--                          can read it. NULL means the seller hasn't set
--                          one. Max 1000 chars (CHECK enforced).
--   pending_about_text  — what the seller submitted; waiting on admin
--                          approval. NOT anon-readable (only authenticated,
--                          and the seller themselves can write to it via
--                          existing RLS policies on profiles).
--   pending_about_at    — when the seller submitted the pending text.
--                          Used to sort the admin's pending-About queue.
--
-- The approval flow (handled in JS, not SQL):
--   Seller saves new About                  → writes pending_about_text + _at
--   Admin clicks Approve in the Sellers tab → copies pending → live, clears pending
--   Admin clicks Reject                     → clears pending, leaves live unchanged
--
-- The live `about_text` is added to the anon-safe column list (alongside
-- display_name, handle, account_status, created_at, is_trusted). The pending
-- fields stay locked to authenticated users.
-- =============================================================================

alter table public.profiles
  add column if not exists about_text text
    check (about_text is null or length(about_text) <= 1000),
  add column if not exists pending_about_text text
    check (pending_about_text is null or length(pending_about_text) <= 1000),
  add column if not exists pending_about_at timestamptz;

-- Index for the admin's "pending About reviews" listing (mirrors the one we
-- have for pending_display_name).
create index if not exists profiles_pending_about_at_idx
  on public.profiles (pending_about_at)
  where pending_about_text is not null;

-- Anon SELECT on the live About text only. Pending fields stay private.
grant select (about_text) on public.profiles to anon;
