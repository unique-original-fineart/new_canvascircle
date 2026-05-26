-- =============================================================================
-- 029_last_inquiry_seen_at.sql
-- =============================================================================
-- Tracks when each user last viewed their incoming-inquiries panel on the
-- portal dashboard. We compare this against contact_messages.sent_at to
-- compute the "unread" count shown as a small badge on the My Account
-- nav link (and on the panel header).
--
-- Why a column on profiles instead of a per-message read flag:
--   - Inquiries aren't actually a two-way inbox; the seller's reply goes
--     out via their email client (Reply-To routing), not the portal. So we
--     don't need per-row state. One "high-water mark" timestamp does it.
--   - One column, one write per dashboard visit. No fanout problem.
--
-- Default null = treat all existing messages as unread on first visit. As
-- soon as the seller lands on the dashboard the column gets set to now()
-- and the count drops to 0. This is intentional — sellers who already
-- received inquiries before this feature shipped will see a one-time
-- "look, here's what came in" surge on their next visit, which is the
-- desired bootstrap behavior.
-- =============================================================================

alter table public.profiles
  add column if not exists last_inquiry_seen_at timestamptz;

-- Single-statement RPC the dashboard calls to "mark all read". Avoids
-- needing an UPDATE policy on profiles for arbitrary columns — this RPC
-- only touches the caller's own row and only that one column.
create or replace function public.mark_inquiries_seen()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  update public.profiles
     set last_inquiry_seen_at = v_now
   where user_id = auth.uid();
  return v_now;
end;
$$;

grant execute on function public.mark_inquiries_seen() to authenticated;
