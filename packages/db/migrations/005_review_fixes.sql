-- Fixes from the adversarial review. See docs/STATUS.md.

-- A mailbox grant is read access. Only the owner writes: otherwise a grantee could send as the owner, trash their mail,
-- or destroy a message by sealing it with junk.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['threads','messages','message_contents','message_search','attachments','mail_labels','message_labels','mail_folders',
    'security_analyses','quarantine_items','user_feedback','contacts','priority_decisions','ai_artifacts','tasks','drafts','send_approvals','sync_states','sync_events',
    'proposed_actions','demo_mailbox','oauth_grants','provider_subscriptions']
  LOOP
    EXECUTE format('DROP POLICY app_mailbox ON %I', t);
    EXECUTE format('CREATE POLICY app_read ON %I FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.can_access_account(account_id))', t);
    EXECUTE format('CREATE POLICY app_insert ON %I FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND app.owns_account(account_id))', t);
    EXECUTE format('CREATE POLICY app_update ON %I FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND app.owns_account(account_id)) WITH CHECK (tenant_id = app.tenant_id() AND app.owns_account(account_id))', t);
    EXECUTE format('CREATE POLICY app_delete ON %I FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND app.owns_account(account_id))', t);
  END LOOP;
END $$;

-- Reports are counted through one narrow function. The admin-only read policy made ON CONFLICT DO UPDATE fail for members,
-- so ordinary users couldn't report phishing or decide their own quarantine.
DROP POLICY app_write ON security_reports_daily;
DROP POLICY app_update ON security_reports_daily;
REVOKE INSERT, UPDATE ON security_reports_daily FROM aegis_app;
CREATE FUNCTION app.bump_report(p_day date, p_kind text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO security_reports_daily(tenant_id, day, kind, count) SELECT app.tenant_id(), p_day, p_kind, 1 WHERE app.tenant_id() IS NOT NULL AND p_kind IN ('report_phishing','not_a_threat','quarantine_released','quarantine_deleted')
  ON CONFLICT (tenant_id, day, kind) DO UPDATE SET count = security_reports_daily.count + 1
$$;
REVOKE ALL ON FUNCTION app.bump_report(date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bump_report(date, text) TO aegis_app;

-- Worker duties: removing a member's mailboxes, and full purges for retention and deletion.

CREATE POLICY worker_tenant ON incident_shares TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, DELETE ON incident_shares TO aegis_worker;
GRANT DELETE ON automations, invitations TO aegis_worker;
GRANT DELETE ON automation_runs TO aegis_worker;
CREATE POLICY worker_scrub ON organizations FOR UPDATE TO aegis_worker USING (id = app.tenant_id()) WITH CHECK (id = app.tenant_id());
GRANT UPDATE (name) ON organizations TO aegis_worker;
-- Removal needs to see which grants a person holds, and remove them.
GRANT DELETE ON mailbox_grants TO aegis_worker;
DROP POLICY worker_tenant ON mailbox_grants;
CREATE POLICY worker_tenant ON mailbox_grants TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());

-- Retention has to run for tenants with kept data and no active mailbox, too.
CREATE FUNCTION scheduler_retention_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.tenant_id FROM tenant_policies p WHERE p.retention_days IS NOT NULL
$$;
REVOKE ALL ON FUNCTION scheduler_retention_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduler_retention_tenants() TO aegis_worker_conn;

-- Housekeeping: these tables otherwise grow without bound, including from unauthenticated requests.
GRANT DELETE ON auth_challenges, oauth_flows, rate_limits, jobs TO aegis_worker_conn;
GRANT SELECT ON auth_challenges, oauth_flows, rate_limits TO aegis_worker_conn;
