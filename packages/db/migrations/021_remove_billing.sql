-- Aegis Mail is open source and self-hosted. There are no plans, prices, subscriptions or payment processor, so their state goes.
-- What stays: usage counting, and per-workspace limits that the server's operators can set. With nothing set there is no limit.
--
--   * subscriptions, invoices, billing_webhook_events and usage_reports are dropped, with the seat-sync trigger and the
--     billing definer functions. organizations.plan goes too.
--   * tenant_entitlement_overrides becomes tenant_limit_overrides: numeric limits only. A JSON null value means "no limit for this
--     workspace", whatever the instance default is. Feature flags are gone: every feature is on for everyone.
--   * The billing_manager role is retired. Members who had it, pending invitations and SSO just-in-time roles become member.
--   * aegis_usage replaces aegis_billing as the cross-tenant context for usage and limits, with aegis_usage_definer owning its
--     definer functions. Roles are cluster-wide and other databases on the same cluster may still use the old ones, so this only
--     takes away everything they had in this database. They can be dropped once no database on the cluster refers to them.
--
-- Safe on a fresh database (every migration from 001 runs first) and on one that has been in use.

-- ===== New roles, same pattern as 009 =====
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_usage') THEN CREATE ROLE aegis_usage NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_usage_definer') THEN CREATE ROLE aegis_usage_definer NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT aegis_usage TO aegis_web_conn WITH INHERIT FALSE, SET TRUE;
GRANT aegis_usage TO aegis_worker_conn WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA app, public TO aegis_usage, aegis_usage_definer;
GRANT aegis_usage_definer TO CURRENT_USER;
GRANT aegis_operator_definer TO CURRENT_USER;

-- ===== Billing work that might still be queued =====
UPDATE jobs SET state = 'cancelled', finished_at = now(), locked_at = NULL WHERE kind LIKE 'billing.%' AND state IN ('queued', 'running', 'dead');

-- ===== Seat sync =====
DROP TRIGGER IF EXISTS memberships_seat_sync ON memberships;
DROP FUNCTION IF EXISTS app.enqueue_seat_sync();

-- ===== Operator functions that read billing state. Recreated below without it. =====
DROP FUNCTION op.plan_stats();
DROP FUNCTION op.paying_stats();
DROP FUNCTION op.extend_trial(uuid, timestamptz, text);
DROP FUNCTION op.list_tenants(text, int, int);
DROP FUNCTION op.tenant_detail(uuid);
DROP FUNCTION op.tenant_overrides(uuid);
DROP FUNCTION op.set_override(uuid, text, jsonb, text, timestamptz);
DROP FUNCTION op.clear_override(uuid, text, text);

-- ===== Billing functions =====
DROP FUNCTION billing_tenant_facts(uuid);
DROP FUNCTION billing_increment_usage(uuid, text, text, bigint);
DROP FUNCTION scheduler_billing_tenants();

-- ===== Billing tables =====
DROP TABLE billing_webhook_events;
DROP TABLE usage_reports;
DROP TABLE invoices;
DROP TABLE subscriptions;
ALTER TABLE organizations DROP COLUMN plan;

-- ===== Overrides become limits =====
DELETE FROM tenant_entitlement_overrides WHERE key NOT IN ('accounts', 'aiActionsPerMonth', 'automations', 'seats', 'indexBytes');
ALTER TABLE tenant_entitlement_overrides RENAME TO tenant_limit_overrides;
ALTER INDEX tenant_entitlement_overrides_pkey RENAME TO tenant_limit_overrides_pkey;
ALTER TABLE tenant_limit_overrides RENAME CONSTRAINT tenant_entitlement_overrides_tenant_id_fkey TO tenant_limit_overrides_tenant_id_fkey;
ALTER TABLE tenant_limit_overrides DROP CONSTRAINT tenant_entitlement_overrides_key_check;
-- Safety features were never nameable here, and still aren't: only these five limits are.
ALTER TABLE tenant_limit_overrides ADD CONSTRAINT tenant_limit_overrides_key_check CHECK (key IN ('accounts', 'aiActionsPerMonth', 'automations', 'seats', 'indexBytes'));
ALTER TABLE tenant_limit_overrides ADD CONSTRAINT tenant_limit_overrides_value_check CHECK (
  CASE jsonb_typeof(value) WHEN 'null' THEN true WHEN 'number' THEN (value #>> '{}')::numeric >= 0 ELSE false END
);

-- ===== billing_manager is retired =====
INSERT INTO audit_events(tenant_id, actor_user_id, event, target_type, target_id, meta)
SELECT m.tenant_id, NULL, 'member.role_changed', 'user', m.user_id::text, jsonb_build_object('role', 'member', 'outcome', 'role_retired')
FROM memberships m WHERE m.role = 'billing_manager';
UPDATE memberships SET role = 'member' WHERE role = 'billing_manager';
UPDATE invitations SET role = 'member' WHERE role = 'billing_manager';
UPDATE sso_configs SET jit_role = 'member', updated_at = now() WHERE jit_role = 'billing_manager';
ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner', 'security_admin', 'workspace_manager', 'member'));
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK (role IN ('owner', 'security_admin', 'workspace_manager', 'member'));
ALTER TABLE sso_configs DROP CONSTRAINT sso_configs_jit_role_check;
ALTER TABLE sso_configs ADD CONSTRAINT sso_configs_jit_role_check CHECK (jit_role IN ('member', 'workspace_manager', 'security_admin'));

-- A workspace's owners and security admins can see what an operator set on it. Nobody in the workspace can change it.
DROP POLICY tenant_read ON tenant_limit_overrides;
CREATE POLICY tenant_read ON tenant_limit_overrides FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner', 'security_admin'));

-- ===== The old billing roles lose everything they had here =====
DROP POLICY IF EXISTS billing_read ON tenant_limit_overrides;
DROP POLICY IF EXISTS billing_all ON usage_counters;
DROP POLICY IF EXISTS billing_read ON organizations;
DROP POLICY IF EXISTS billing_insert ON audit_events;
DROP POLICY IF EXISTS billing_definer_read ON memberships;
DROP POLICY IF EXISTS billing_definer_read ON mail_accounts;
DROP POLICY IF EXISTS billing_definer_read ON organizations;
DROP POLICY IF EXISTS billing_definer_read ON tenant_suspensions;
DROP POLICY IF EXISTS billing_definer_all ON usage_counters;
DROP POLICY IF EXISTS billing_definer_all ON jobs;
REVOKE ALL ON tenant_limit_overrides, usage_counters, organizations, audit_events FROM aegis_billing;
REVOKE ALL ON SEQUENCE audit_events_id_seq FROM aegis_billing;
REVOKE ALL ON memberships, mail_accounts, organizations, tenant_suspensions, usage_counters, jobs FROM aegis_billing_definer;

-- ===== The usage context: counters and limits across tenants, nothing about mail or people =====
GRANT SELECT, INSERT, UPDATE ON usage_counters TO aegis_usage;
GRANT SELECT ON tenant_limit_overrides TO aegis_usage;
CREATE POLICY usage_all ON usage_counters TO aegis_usage USING (true) WITH CHECK (true);
CREATE POLICY usage_read ON tenant_limit_overrides FOR SELECT TO aegis_usage USING (true);

-- ===== Usage definer functions =====
-- Whole-tenant counts for the member limit and the operator console. A request context only sees its own mailboxes.
CREATE FUNCTION usage_tenant_facts(p_tenant uuid) RETURNS TABLE(seats int, active_mailboxes int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = p_tenant),
         (SELECT count(*)::int FROM mail_accounts a WHERE a.tenant_id = p_tenant AND a.status <> 'disconnected')
$$;
-- The one way to add to a usage counter, callable from web and worker. Only known metrics, only upward.
CREATE FUNCTION usage_increment(p_tenant uuid, p_period text, p_metric text, p_n bigint) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO usage_counters(tenant_id, period, metric, value)
  SELECT p_tenant, p_period, p_metric, p_n WHERE p_n > 0 AND p_metric IN ('ai_actions') AND p_period ~ '^[0-9]{4}-[0-9]{2}$'
  ON CONFLICT (tenant_id, period, metric) DO UPDATE SET value = usage_counters.value + EXCLUDED.value
  RETURNING value
$$;
-- Workspaces whose usage gauges the worker refreshes nightly.
CREATE FUNCTION scheduler_usage_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM tenant_suspensions x WHERE x.tenant_id = o.id)
$$;

GRANT SELECT (tenant_id) ON memberships TO aegis_usage_definer;
GRANT SELECT (tenant_id, status) ON mail_accounts TO aegis_usage_definer;
GRANT SELECT (id) ON organizations TO aegis_usage_definer;
GRANT SELECT ON tenant_suspensions TO aegis_usage_definer;
GRANT SELECT, INSERT, UPDATE ON usage_counters TO aegis_usage_definer;
CREATE POLICY usage_definer_read ON memberships FOR SELECT TO aegis_usage_definer USING (true);
CREATE POLICY usage_definer_read ON mail_accounts FOR SELECT TO aegis_usage_definer USING (true);
CREATE POLICY usage_definer_read ON organizations FOR SELECT TO aegis_usage_definer USING (true);
CREATE POLICY usage_definer_read ON tenant_suspensions FOR SELECT TO aegis_usage_definer USING (true);
CREATE POLICY usage_definer_all ON usage_counters TO aegis_usage_definer USING (true) WITH CHECK (true);

GRANT CREATE ON SCHEMA public TO aegis_usage_definer;
ALTER FUNCTION usage_tenant_facts(uuid) OWNER TO aegis_usage_definer;
ALTER FUNCTION usage_increment(uuid, text, text, bigint) OWNER TO aegis_usage_definer;
ALTER FUNCTION scheduler_usage_tenants() OWNER TO aegis_usage_definer;
-- Not about billing, but owned by its definer until now.
ALTER FUNCTION scheduler_suspended_tenants() OWNER TO aegis_usage_definer;
REVOKE CREATE ON SCHEMA public FROM aegis_usage_definer;
REVOKE USAGE ON SCHEMA app, public FROM aegis_billing, aegis_billing_definer;

REVOKE ALL ON FUNCTION usage_tenant_facts(uuid), usage_increment(uuid, text, text, bigint), scheduler_usage_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage_tenant_facts(uuid) TO aegis_usage;
GRANT EXECUTE ON FUNCTION usage_increment(uuid, text, text, bigint) TO aegis_web_conn, aegis_worker_conn, aegis_app, aegis_worker, aegis_usage;
GRANT EXECUTE ON FUNCTION scheduler_usage_tenants() TO aegis_worker_conn;

-- ===== Operator functions, without plans =====
CREATE FUNCTION op.list_tenants(p_search text, p_limit int, p_offset int) RETURNS TABLE(id uuid, name text, kind text, members int, mailboxes int, created_at timestamptz, suspended_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, op.display_name(o.kind, o.name), o.kind,
    (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = o.id),
    (SELECT count(*)::int FROM mail_accounts a WHERE a.tenant_id = o.id AND a.status <> 'disconnected'),
    o.created_at, x.suspended_at
  FROM organizations o LEFT JOIN tenant_suspensions x ON x.tenant_id = o.id
  WHERE op.operator_id() IS NOT NULL AND (p_search IS NULL OR (o.kind <> 'personal' AND position(lower(p_search) IN lower(o.name)) > 0))
  ORDER BY o.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;
-- Viewing a tenant is itself an operator action, so this writes to the log.
CREATE FUNCTION op.tenant_detail(p_tenant uuid) RETURNS TABLE(id uuid, name text, kind text, members int, mailboxes int, created_at timestamptz, suspended_at timestamptz, suspended_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_op uuid := op.require_operator();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_tenant) THEN RETURN; END IF;
  PERFORM op.record(v_op, 'tenant.viewed', p_tenant, NULL, NULL, '{}', NULL);
  RETURN QUERY
  SELECT o.id, op.display_name(o.kind, o.name), o.kind,
    (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = o.id),
    (SELECT count(*)::int FROM mail_accounts a WHERE a.tenant_id = o.id AND a.status <> 'disconnected'),
    o.created_at, x.suspended_at, x.reason
  FROM organizations o LEFT JOIN tenant_suspensions x ON x.tenant_id = o.id
  WHERE o.id = p_tenant;
END $$;
CREATE FUNCTION op.tenant_overrides(p_tenant uuid) RETURNS TABLE(key text, value jsonb, reason text, expires_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.key, o.value, o.reason, o.expires_at, o.updated_at FROM tenant_limit_overrides o WHERE op.operator_id() IS NOT NULL AND o.tenant_id = p_tenant ORDER BY o.key
$$;
-- A whole number of zero or more, or JSON null for no limit on this workspace. Reason required, audited, visible to the tenant.
CREATE FUNCTION op.set_override(p_tenant uuid, p_key text, p_value jsonb, p_reason text, p_expires timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason); v_n numeric;
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('accounts', 'aiActionsPerMonth', 'automations', 'seats', 'indexBytes') THEN
    RAISE EXCEPTION 'that is not a limit' USING ERRCODE = '22023';
  END IF;
  IF p_value IS NULL THEN RAISE EXCEPTION 'a limit takes a whole number, zero or more, or null for no limit' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(p_value) = 'number' THEN
    v_n := (p_value #>> '{}')::numeric;
    IF v_n < 0 OR v_n <> trunc(v_n) THEN RAISE EXCEPTION 'a limit takes a whole number, zero or more, or null for no limit' USING ERRCODE = '22023'; END IF;
  ELSIF jsonb_typeof(p_value) <> 'null' THEN
    RAISE EXCEPTION 'a limit takes a whole number, zero or more, or null for no limit' USING ERRCODE = '22023';
  END IF;
  INSERT INTO tenant_limit_overrides(tenant_id, key, value, reason, set_by, expires_at, updated_at) VALUES (p_tenant, p_key, p_value, v_reason, v_op, p_expires, now())
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, expires_at = EXCLUDED.expires_at, updated_at = now();
  PERFORM op.record(v_op, 'tenant.override_set', p_tenant, p_key, v_reason, jsonb_build_object('fields', jsonb_build_array(p_key), 'value', p_value), 'operator.override_set');
END $$;
CREATE FUNCTION op.clear_override(p_tenant uuid, p_key text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason); v_found boolean;
BEGIN
  DELETE FROM tenant_limit_overrides o WHERE o.tenant_id = p_tenant AND o.key = p_key;
  v_found := FOUND;
  IF v_found THEN PERFORM op.record(v_op, 'tenant.override_cleared', p_tenant, p_key, v_reason, jsonb_build_object('fields', jsonb_build_array(p_key)), 'operator.override_cleared'); END IF;
  RETURN v_found;
END $$;

GRANT CREATE ON SCHEMA op TO aegis_operator_definer;
ALTER FUNCTION op.list_tenants(text, int, int) OWNER TO aegis_operator_definer;
ALTER FUNCTION op.tenant_detail(uuid) OWNER TO aegis_operator_definer;
ALTER FUNCTION op.tenant_overrides(uuid) OWNER TO aegis_operator_definer;
ALTER FUNCTION op.set_override(uuid, text, jsonb, text, timestamptz) OWNER TO aegis_operator_definer;
ALTER FUNCTION op.clear_override(uuid, text, text) OWNER TO aegis_operator_definer;
REVOKE CREATE ON SCHEMA op FROM aegis_operator_definer;
REVOKE ALL ON FUNCTION op.list_tenants(text, int, int), op.tenant_detail(uuid), op.tenant_overrides(uuid), op.set_override(uuid, text, jsonb, text, timestamptz), op.clear_override(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION op.list_tenants(text, int, int), op.tenant_detail(uuid), op.tenant_overrides(uuid), op.set_override(uuid, text, jsonb, text, timestamptz), op.clear_override(uuid, text, text) TO aegis_operator;
