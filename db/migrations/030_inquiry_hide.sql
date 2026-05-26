-- =============================================================================
-- 030_inquiry_hide.sql
-- =============================================================================
-- Lets a seller dismiss an inquiry from their Inquiries tab once they've
-- handled it (or once they've decided it's not worth replying to). This is
-- a soft delete — we set a recipient_hidden_at timestamp instead of removing
-- the row, so:
--   - The audit trail stays intact for admin (spam investigation, abuse
--     pattern analysis across multiple recipients).
--   - If a real harassment case develops, the dismissed messages aren't
--     lost — admin can still pull them.
--   - The sender's "messages I've sent" view (future inbox) keeps showing
--     them, since dismissal is purely a recipient-side decision.
--
-- The seller's tab filters out rows with recipient_hidden_at IS NOT NULL.
-- Same filter applies to the unread-count badge query — once dismissed, a
-- message no longer counts toward the badge even if it was unread when the
-- seller hid it.
-- =============================================================================

alter table public.contact_messages
  add column if not exists recipient_hidden_at timestamptz;

-- Index supports the "newest non-hidden inquiries for this recipient" query
-- and the unread-count query without a full table scan.
create index if not exists contact_messages_recipient_visible_idx
  on public.contact_messages (recipient_id, sent_at desc)
  where recipient_hidden_at is null;

-- RPC: only the recipient can hide their own inquiry. SECURITY DEFINER so
-- it runs with elevated privileges, but the function-level check pins the
-- target row to the caller. Without this we'd need a broad UPDATE policy
-- on contact_messages, which would let recipients edit other columns too.
create or replace function public.hide_inquiry(message_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  select recipient_id into v_recipient
    from public.contact_messages
   where id = message_id;

  if v_recipient is null then
    raise exception 'Inquiry not found' using errcode = '42704';
  end if;
  if v_recipient <> auth.uid() then
    raise exception 'Not your inquiry to dismiss' using errcode = '42501';
  end if;

  update public.contact_messages
     set recipient_hidden_at = now()
   where id = message_id
     and recipient_hidden_at is null;  -- idempotent: already-hidden is a no-op
end;
$$;

grant execute on function public.hide_inquiry(bigint) to authenticated;
