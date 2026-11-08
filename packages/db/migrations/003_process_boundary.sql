-- Real process separation. Each process logs in as a role that can only SET ROLE to its own context:
--   web    login → aegis_web_conn    → may become aegis_app (never aegis_worker)
--   worker login → aegis_worker_conn → may become aegis_worker (never aegis_app)
-- Neither connection role has any privilege on mail tables or credentials outside those contexts.
-- Requires PostgreSQL 16+ for GRANT ... WITH SET/INHERIT options.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_web_conn') THEN CREATE ROLE aegis_web_conn NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_worker_conn') THEN CREATE ROLE aegis_worker_conn NOLOGIN; END IF;
END $$;
GRANT aegis_app TO aegis_web_conn WITH INHERIT FALSE, SET TRUE;
GRANT aegis_worker TO aegis_worker_conn WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA app, public TO aegis_web_conn, aegis_worker_conn;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO aegis_web_conn, aegis_worker_conn;

-- Pre-authentication surface for the web process. Deliberately no mail tables.
GRANT SELECT, INSERT, UPDATE ON users TO aegis_web_conn;
GRANT SELECT, INSERT, UPDATE ON sessions TO aegis_web_conn;
GRANT SELECT, INSERT, UPDATE, DELETE ON passkeys, auth_challenges, rate_limits, oauth_flows, identities TO aegis_web_conn;
GRANT SELECT, INSERT, DELETE ON memberships TO aegis_web_conn;
GRANT SELECT, INSERT ON organizations TO aegis_web_conn;
GRANT INSERT ON subscriptions, tenant_policies TO aegis_web_conn;
GRANT SELECT, UPDATE ON invitations TO aegis_web_conn;
GRANT INSERT ON audit_events TO aegis_web_conn;
GRANT SELECT, DELETE ON user_preferences TO aegis_web_conn;
GRANT SELECT, INSERT, UPDATE ON jobs TO aegis_web_conn;

-- The worker's system surface is the queue, nothing else.
GRANT SELECT, INSERT, UPDATE ON jobs TO aegis_worker_conn;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','memberships','organizations','subscriptions','tenant_policies','invitations','audit_events','user_preferences']
  LOOP
    EXECUTE format('CREATE POLICY web_conn ON %I TO aegis_web_conn USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Jobs: enqueue in the same transaction as the state change (ADR-0003). Contexts can only touch their own tenant.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY context_tenant ON jobs TO aegis_app, aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY conn_all ON jobs TO aegis_web_conn, aegis_worker_conn USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON jobs TO aegis_app, aegis_worker;

-- Crypto-shredding runs in the worker, after provider revocation has used the credential.
GRANT DELETE ON tenant_keys TO aegis_worker;

CREATE FUNCTION app.owns_account(acct uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM mail_accounts a WHERE a.id = acct AND a.tenant_id = app.tenant_id() AND a.owner_user_id = app.user_id())
$$;

-- Only a mailbox's owner can share it. Previously any member could grant themselves any mailbox with raw SQL.
DROP POLICY app_grants ON mailbox_grants;
CREATE POLICY app_read ON mailbox_grants FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND (grantee_user_id = app.user_id() OR app.owns_account(account_id)));
CREATE POLICY app_grant ON mailbox_grants FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND granted_by = app.user_id() AND app.owns_account(account_id));
CREATE POLICY app_revoke ON mailbox_grants FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND (grantee_user_id = app.user_id() OR app.owns_account(account_id)));

-- Grantees can read a shared mailbox but never change or remove the account itself.
DROP POLICY app_mailbox ON mail_accounts;
CREATE POLICY app_read ON mail_accounts FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND (owner_user_id = app.user_id() OR app.can_access_account(id)));
CREATE POLICY app_insert ON mail_accounts FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND owner_user_id = app.user_id());
CREATE POLICY app_update ON mail_accounts FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND owner_user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND owner_user_id = app.user_id());
CREATE POLICY app_delete ON mail_accounts FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND owner_user_id = app.user_id());

-- Only the owner can voluntarily share a message for incident review.
DROP POLICY sharer ON incident_shares;
CREATE POLICY sharer ON incident_shares TO aegis_app USING (tenant_id = app.tenant_id() AND shared_by = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND shared_by = app.user_id() AND app.owns_account(account_id));

-- Replaces a credential without giving the web role read access to envelopes.
CREATE FUNCTION app.replace_credential(acct uuid, p_kind text, p_blob bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app.owns_account(acct) THEN RAISE EXCEPTION 'not the mailbox owner' USING ERRCODE = '42501'; END IF;
  INSERT INTO credential_envelopes(tenant_id, account_id, kind, blob) VALUES (app.tenant_id(), acct, p_kind, p_blob)
  ON CONFLICT (account_id) DO UPDATE SET kind = EXCLUDED.kind, blob = EXCLUDED.blob, updated_at = now();
END $$;

-- Definer functions are private by default.
REVOKE ALL ON FUNCTION app.can_access_account(uuid), app.has_role(text[]), app.owns_account(uuid), app.replace_credential(uuid, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_access_account(uuid), app.has_role(text[]), app.owns_account(uuid) TO aegis_app, aegis_worker;
GRANT EXECUTE ON FUNCTION app.replace_credential(uuid, text, bytea) TO aegis_app;
REVOKE ALL ON FUNCTION webhook_account_lookup(text, text), webhook_subscription_lookup(text), scheduler_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_account_lookup(text, text), webhook_subscription_lookup(text) TO aegis_web_conn;
GRANT EXECUTE ON FUNCTION scheduler_accounts() TO aegis_worker_conn;
