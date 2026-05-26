-- =============================================================================
-- 028_contact_messages.sql
-- =============================================================================
-- Audit trail for buyer → seller messages sent through the in-portal contact
-- form (the "Email Seller" button on listing.html). Previously that button
-- launched a mailto: URL, which gave us zero visibility into who reached out
-- to whom — meaning sellers had no real signal that their listings were
-- generating interest. The new contact form sends through the send-email
-- edge function instead, and this table is the durable record.
--
-- Two jobs this table does:
--   1. Server-side rate-limiting. The edge function checks "how many messages
--      has this buyer sent in the last hour?" before allowing a new send,
--      cheap protection against spam since the per-buyer counter lives here.
--   2. Foundation for a future "messages I've sent / received" inbox view.
--      We don't surface that UI yet, but capturing the rows now means no
--      data loss when we do.
--
-- Privacy / RLS posture:
--   - Buyers can INSERT their own row (sender_id = auth.uid()) — this is
--     what the edge function relies on when it impersonates the caller
--     (it hits Supabase with the user's Authorization header, not the
--     service role, for the insert).
--   - Buyers can SELECT their own rows (so a future "messages I sent" view
--     can list them).
--   - Sellers can SELECT rows where they were the recipient (future inbox).
--   - Admins can see everything (spam investigation, abuse reports).
--   - No UPDATE or DELETE policies — rows are immutable history.
--
-- Note on rate-limit table choice: we could have put rate-limit state in a
-- separate counter table, but using the audit log as the rate-limit source
-- of truth means we can't get out of sync. One write per send; one COUNT
-- query per send. The (sender_id, sent_at) index makes the hourly window
-- query effectively free.
-- =============================================================================

create table if not exists public.contact_messages (
  id            bigserial primary key,
  sender_id     uuid not null references auth.users(id) on delete cascade,
  recipient_id  uuid not null references auth.users(id) on delete cascade,
  listing_id    uuid     references public.listings(listing_id) on delete set null,
  subject       text not null check (length(subject) between 1 and 200),
  body          text not null check (length(body) between 1 and 5000),
  -- Reply-To address used when sending the email. Captured at send time
  -- so the audit log doesn't drift if the buyer later changes their
  -- profile contact email.
  reply_to      text,
  sent_at       timestamptz not null default now(),
  -- Buyer can't message themselves.
  constraint contact_messages_no_self check (sender_id <> recipient_id)
);

-- Rate-limit lookup: "how many messages from this sender in the last hour?"
create index if not exists contact_messages_sender_sent_idx
  on public.contact_messages (sender_id, sent_at desc);

-- Future-inbox lookup: "messages sent to me, newest first".
create index if not exists contact_messages_recipient_sent_idx
  on public.contact_messages (recipient_id, sent_at desc);

-- Per-listing analytics: "how many inquiries did this listing generate?"
create index if not exists contact_messages_listing_idx
  on public.contact_messages (listing_id);

alter table public.contact_messages enable row level security;

-- Buyer (sender) can insert their own row. The edge function uses the
-- caller's session, so auth.uid() resolves to the buyer at insert time.
drop policy if exists contact_messages_insert_self on public.contact_messages;
create policy contact_messages_insert_self
  on public.contact_messages for insert
  with check (sender_id = auth.uid());

-- Sender can see what they've sent.
drop policy if exists contact_messages_select_sender on public.contact_messages;
create policy contact_messages_select_sender
  on public.contact_messages for select
  using (sender_id = auth.uid());

-- Recipient can see what they've received (future inbox).
drop policy if exists contact_messages_select_recipient on public.contact_messages;
create policy contact_messages_select_recipient
  on public.contact_messages for select
  using (recipient_id = auth.uid());

-- Admin sees everything.
drop policy if exists contact_messages_admin_all on public.contact_messages;
create policy contact_messages_admin_all
  on public.contact_messages for all
  using (public.is_admin())
  with check (public.is_admin());
