-- Duplicate detection without merging threads: same sender, same content.
ALTER TABLE messages ADD COLUMN content_hash text;
ALTER TABLE messages ADD COLUMN duplicate_of uuid REFERENCES messages ON DELETE SET NULL;
CREATE INDEX messages_content_hash ON messages (account_id, content_hash) WHERE content_hash IS NOT NULL;

-- Tenant-wide campaign correlation by keyed hash. No sender, subject or link is stored or recoverable, and the tenant's
-- blind-index key makes values meaningless outside it.
CREATE TABLE security_campaigns (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  campaign_hash text NOT NULL,
  first_seen date NOT NULL DEFAULT now(),
  last_seen date NOT NULL DEFAULT now(),
  message_count int NOT NULL DEFAULT 0,
  worst_label text NOT NULL,
  PRIMARY KEY (tenant_id, campaign_hash)
);
ALTER TABLE security_campaigns ENABLE ROW LEVEL SECURITY; ALTER TABLE security_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_tenant ON security_campaigns TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY admin_read ON security_campaigns FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner','security_admin'));
GRANT SELECT, INSERT, UPDATE ON security_campaigns TO aegis_worker;
GRANT SELECT ON security_campaigns TO aegis_app;

-- Delegated send is a separate, explicit permission. A plain grant is read only.
ALTER TABLE mailbox_grants ADD COLUMN can_send boolean NOT NULL DEFAULT false;
CREATE FUNCTION app.can_send_account(acct uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.owns_account(acct) OR EXISTS (SELECT 1 FROM mailbox_grants g WHERE g.account_id = acct AND g.tenant_id = app.tenant_id() AND g.grantee_user_id = app.user_id() AND g.can_send)
$$;
REVOKE ALL ON FUNCTION app.can_send_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.can_send_account(uuid) TO aegis_app, aegis_worker;
DROP POLICY app_insert ON drafts; DROP POLICY app_update ON drafts; DROP POLICY app_delete ON drafts;
CREATE POLICY app_insert ON drafts FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id() AND app.can_send_account(account_id));
CREATE POLICY app_update ON drafts FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id() AND app.can_send_account(account_id)) WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id() AND app.can_send_account(account_id));
CREATE POLICY app_delete ON drafts FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id());
DROP POLICY app_insert ON send_approvals;
CREATE POLICY app_insert ON send_approvals FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND approved_by = app.user_id() AND app.can_send_account(account_id));
DROP POLICY app_delete ON send_approvals;
CREATE POLICY app_delete ON send_approvals FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND approved_by = app.user_id());

-- Re-sealing touches every encrypted column, which the worker can already update except these.
GRANT UPDATE (snapshot_enc) ON incident_shares TO aegis_worker;
