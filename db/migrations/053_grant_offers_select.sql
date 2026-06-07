-- =============================================================================
-- 053_grant_offers_select.sql
-- =============================================================================
-- Fix for the visibility bug discovered after deploying migration 052: the
-- REVOKE ALL on public.offers stripped the authenticated role's grant
-- entirely, which meant even the RLS `offers_select_parties` policy
-- couldn't fire (RLS filters rows AFTER role-level grant is checked, not
-- instead of). Sellers were getting push notifications about incoming
-- offers (offer-fanout runs as service_role, no grant needed) but the
-- portal Offers tab was empty because the signed-in seller's SELECT was
-- blocked at the grant layer.
--
-- Mirrors the same gotcha hit in migration 050 for contact_email — column-
-- level REVOKE didn't override table-level GRANT, and there the fix was
-- migration 051 doing the table-REVOKE then column-GRANT pattern. Here
-- the analog is: we want RLS to filter rows but the role still needs the
-- base SELECT grant. INSERT/UPDATE/DELETE remain locked because all writes
-- go through SECURITY DEFINER RPCs (insert_offer, respond_to_offer,
-- respond_to_counter, withdraw_offer) which bypass both grants and RLS.
--
-- See [[actively-check-memories-before-sweeps]] — this is the same pattern
-- as the contact_email REVOKE. Next time I revoke ALL on a table, I need
-- to explicitly add back the SELECT grant for any role that needs to read
-- rows through RLS.
-- =============================================================================

-- Grant table-level SELECT to authenticated. The existing RLS policy
-- offers_select_parties (migration 052) filters rows to (proposer_id =
-- auth.uid() OR responder_id = auth.uid() OR is_admin()), so a buyer
-- only sees their own offers and a seller only sees offers on their
-- listings. Admin sees everything.
grant select on public.offers to authenticated;

-- Sanity check: confirm the grant + policy are in place. RAISE NOTICE
-- prints to the SQL editor output so the run is verifiable.
do $$
declare
  v_has_grant boolean;
  v_has_policy boolean;
begin
  select exists (
    select 1 from information_schema.table_privileges
      where table_schema = 'public'
        and table_name = 'offers'
        and grantee = 'authenticated'
        and privilege_type = 'SELECT'
  ) into v_has_grant;
  select exists (
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename = 'offers'
        and policyname = 'offers_select_parties'
  ) into v_has_policy;
  raise notice 'authenticated SELECT on offers: %, RLS policy present: %', v_has_grant, v_has_policy;
end $$;

-- =============================================================================
-- End of migration 053.
-- =============================================================================
