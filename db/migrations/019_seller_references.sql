-- =============================================================================
-- 019_seller_references.sql
-- =============================================================================
-- Sales references: a seller can request that another collector vouch for
-- them by appearing on their public seller page / listing block. Two-party
-- consent: seller requests, target accepts or rejects. The target MUST be
-- an Established Member (profiles.is_trusted = true) for the request to be
-- valid — this is the trust anchor that prevents scammer-ring ref-trading.
--
-- Per the design discussion:
--   - 5 active references per seller (accepted + pending combined)
--   - Either party can revoke an accepted reference at any time
--   - Rejected requests stick around so the seller knows; they can delete
--     the row to clean up if desired
--   - Display layer filters references by reference.is_trusted=true AND
--     reference.account_status='active' so suspended/un-Established users
--     don't appear publicly, even on already-accepted rows
-- =============================================================================

create table if not exists public.seller_references (
  id                bigserial primary key,
  -- FK directly to profiles (not auth.users) so PostgREST can resolve the
  -- embedded join `seller_references!...fkey ( ... )` naturally. profiles
  -- already cascades from auth.users, so the chain still works.
  seller_user_id    uuid not null references public.profiles(user_id) on delete cascade,
  reference_user_id uuid not null references public.profiles(user_id) on delete cascade,
  status            text not null default 'pending'
                      check (status in ('pending', 'accepted', 'rejected')),
  requested_at      timestamptz not null default now(),
  responded_at      timestamptz,
  unique (seller_user_id, reference_user_id),
  check (seller_user_id != reference_user_id)  -- can't reference yourself
);

create index if not exists seller_references_seller_idx
  on public.seller_references (seller_user_id, status);
create index if not exists seller_references_reference_idx
  on public.seller_references (reference_user_id, status);

alter table public.seller_references enable row level security;

-- Base grants — RLS policies handle which rows the role can actually touch.
grant select, delete on public.seller_references to authenticated;
grant select on public.seller_references to anon;
grant usage, select on sequence public.seller_references_id_seq to authenticated;

-- Public read of accepted rows so anon visitors to /seller pages can see
-- the references list. Pending/rejected stay private to the two parties.
drop policy if exists seller_references_public_read on public.seller_references;
create policy seller_references_public_read
  on public.seller_references for select
  using (status = 'accepted');

-- Either party (seller or referenced user) can see their own private rows
-- regardless of status (so they can review their pending/rejected history).
drop policy if exists seller_references_owner_read on public.seller_references;
create policy seller_references_owner_read
  on public.seller_references for select
  to authenticated
  using (seller_user_id = auth.uid() or reference_user_id = auth.uid());

-- Either party can delete (revoke or clean up).
drop policy if exists seller_references_owner_delete on public.seller_references;
create policy seller_references_owner_delete
  on public.seller_references for delete
  to authenticated
  using (seller_user_id = auth.uid() or reference_user_id = auth.uid());

-- Admins can do anything (relies on existing public.is_admin() helper).
drop policy if exists seller_references_admin_all on public.seller_references;
create policy seller_references_admin_all
  on public.seller_references for all
  using (public.is_admin())
  with check (public.is_admin());

-- INSERT and UPDATE go through SECURITY DEFINER RPCs that check all the
-- business rules (Established status, cap, no self-reference, no duplicate).

-- ---------------------------------------------------------------------------
-- request_reference: seller asks another user to vouch for them.
-- Validates: target exists, is active, is Established, isn't the seller
-- themselves, isn't already in a relationship, seller has < 5 active.
-- ---------------------------------------------------------------------------
create or replace function public.request_reference(p_target_handle text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seller         uuid    := auth.uid();
  v_target         uuid;
  v_target_trusted boolean;
  v_target_status  text;
  v_existing       text;
  v_active_count   int;
  v_handle_trim    text    := btrim(coalesce(p_target_handle, ''));
begin
  if v_seller is null then
    raise exception 'You must be signed in to request a reference.';
  end if;
  if length(v_handle_trim) = 0 then
    raise exception 'Pick a handle to request from.';
  end if;

  select user_id, is_trusted, account_status
    into v_target, v_target_trusted, v_target_status
  from public.profiles
  where lower(handle) = lower(v_handle_trim)
  limit 1;

  if v_target is null then
    raise exception 'No CanvasCircle account exists at @%.', v_handle_trim;
  end if;
  if v_target = v_seller then
    raise exception 'You can''t request a reference from yourself.';
  end if;
  if v_target_status != 'active' then
    raise exception 'That account isn''t available right now.';
  end if;
  if not v_target_trusted then
    raise exception 'References can only be requested from Established Members. @% isn''t an Established Member yet.', v_handle_trim;
  end if;

  select status into v_existing
  from public.seller_references
  where seller_user_id = v_seller and reference_user_id = v_target;
  if v_existing is not null then
    raise exception 'You already have a % reference relationship with @%. Revoke the existing one before re-requesting.', v_existing, v_handle_trim;
  end if;

  select count(*) into v_active_count
  from public.seller_references
  where seller_user_id = v_seller
    and status in ('pending', 'accepted');
  if v_active_count >= 5 then
    raise exception 'You already have 5 active reference relationships. Revoke one before requesting a new one.';
  end if;

  insert into public.seller_references (seller_user_id, reference_user_id, status)
  values (v_seller, v_target, 'pending');

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.request_reference(text) to authenticated;

-- ---------------------------------------------------------------------------
-- respond_to_reference: the referenced user accepts or rejects a pending
-- request. Only the referenced user can call this on their own row, and
-- only on a pending row. Accepting also re-checks the seller's cap (in case
-- they have multiple pending and accepting this one would push over 5).
-- ---------------------------------------------------------------------------
create or replace function public.respond_to_reference(p_id bigint, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user   uuid := auth.uid();
  v_ref    public.seller_references%rowtype;
  v_active int;
begin
  if v_user is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_ref from public.seller_references where id = p_id;
  if v_ref.id is null then
    raise exception 'Reference request not found.';
  end if;
  if v_ref.reference_user_id != v_user then
    raise exception 'You can only respond to references requested of you.';
  end if;
  if v_ref.status != 'pending' then
    raise exception 'You''ve already responded to this request.';
  end if;

  if p_accept then
    select count(*) into v_active
    from public.seller_references
    where seller_user_id = v_ref.seller_user_id and status = 'accepted';
    if v_active >= 5 then
      raise exception 'The seller already has 5 accepted references — they need to revoke one before adding a new one.';
    end if;
  end if;

  update public.seller_references
  set status = case when p_accept then 'accepted' else 'rejected' end,
      responded_at = now()
  where id = p_id;
end;
$$;
grant execute on function public.respond_to_reference(bigint, boolean) to authenticated;
