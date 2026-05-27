-- =============================================================================
-- 033_phone_on_inquiry_and_preferred_contact.sql
-- =============================================================================
-- Two related additions for the "phone-friendly inquiries" rollout:
--
--   1. contact_messages.sender_phone — an OPTIONAL phone number a buyer can
--      include with their inquiry. If present, it's shown to the recipient
--      (seller) only, who can then choose to call/text instead of replying
--      by email. We deliberately do NOT store phone numbers on profiles
--      and do NOT expose them publicly. The buyer opts in per-inquiry; the
--      seller never has a stored phone field to scrape.
--
--   2. profiles.preferred_contact — a soft signal the seller can set to
--      let buyers know if they prefer email / phone / either. Visible to
--      signed-in users. Does NOT expose any phone number — just signals
--      a preference so the buyer knows whether to include their phone
--      when they reach out via the inquiry form.
--
-- No new RLS policies needed:
--   - contact_messages already has the right policies (sender/recipient/admin SELECT,
--     sender INSERT); sender_phone is just another column they can see.
--   - profiles.preferred_contact follows existing profile RLS (signed-in users
--     can see, owner can update).
-- =============================================================================

-- ---- 1. sender_phone on contact_messages -----------------------------------
alter table public.contact_messages
  add column if not exists sender_phone text;

-- Loose validation: any non-empty string up to 30 chars (accommodates
-- international formats like "+44 20 7946 0958" without being prescriptive).
-- Empty string would be misleading (looks like "they shared a number, but
-- it's blank") so we coerce empties to null at the application layer too.
alter table public.contact_messages
  drop constraint if exists contact_messages_phone_length;
alter table public.contact_messages
  add constraint contact_messages_phone_length
  check (sender_phone is null or length(sender_phone) between 1 and 30);

-- ---- 2. preferred_contact on profiles --------------------------------------
alter table public.profiles
  add column if not exists preferred_contact text not null default 'either';

alter table public.profiles
  drop constraint if exists profiles_preferred_contact_check;
alter table public.profiles
  add constraint profiles_preferred_contact_check
  check (preferred_contact in ('email', 'phone', 'either'));
