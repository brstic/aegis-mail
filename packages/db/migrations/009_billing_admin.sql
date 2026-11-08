-- Billing state from a payment processor, metering, entitlement overrides, and the content-blind operator area.
--
-- Two new context roles, reachable only with SET ROLE from a connection role (same pattern as 003):
--   aegis_billing   billing tables, across tenants, for webhooks and metering. No mail tables.
--   aegis_operator  no table grants at all. EXECUTE on op.* functions, nothing else.
--
-- Definer functions are owned by dedicated non-superuser roles (same reasoning as 006): production has no superuser, every
-- table here is FORCE RLS, and a function owned by the migrator would silently return nothing there. The definer roles get
-- column grants, so the functions themselves can't reach a subject, a sender, a mailbox address or a job payload even if
-- someone edits one badly. aegis_operator_definer has no grant on any mail table. operator-roles tests assert that.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_billing') THEN CREATE ROLE aegis_billing NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_operator') THEN CREATE ROLE aegis_operator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_billing_definer') THEN CREATE ROLE aegis_billing_definer NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_operator_definer') THEN CREATE ROLE aegis_operator_definer NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT aegis_billing TO aegis_web_conn WITH INHERIT FALSE, SET TRUE;
GRANT aegis_billing TO aegis_worker_conn WITH INHERIT FALSE, SET TRUE;
GRANT aegis_operator TO aegis_web_conn WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA app, public TO aegis_billing, aegis_billing_definer, aegis_operator_definer;

-- Passkey sign-in counts as MFA for the operator area, so the session has to remember how it began.
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'password';

-- ===== Subscriptions and invoices =====
ALTER TABLE subscriptions
  ADD COLUMN customer_id text,
  ADD COLUMN price_id text,
  ADD COLUMN item_id text,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN current_period_start timestamptz,
  ADD COLUMN past_due_since timestamptz,
  ADD COLUMN trial_used_at timestamptz,
  ADD COLUMN canceled_at timestamptz,
  ADD CONSTRAINT subscriptions_status_known CHECK (status IN ('trialing','active','past_due','canceled','expired','incomplete'));
CREATE UNIQUE INDEX subscriptions_customer_uq ON subscriptions (customer_id) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_external_uq ON subscriptions (provider, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE invoices
  ADD COLUMN provider text NOT NULL DEFAULT 'stripe',
  ADD COLUMN number text,
  ADD COLUMN hosted_url text,
  ADD COLUMN pdf_url text,
  ADD COLUMN period_start timestamptz,
  ADD COLUMN period_end timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX invoices_external_uq ON invoices (provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX invoices_tenant ON invoices (tenant_id, created_at DESC);

-- A request context could previously write its own plan. Plan state now comes only from the billing context.
REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM aegis_app, aegis_worker;
REVOKE INSERT, UPDATE, DELETE ON usage_counters FROM aegis_app, aegis_worker;
-- Invoices are for the people who manage billing, not every member.
REVOKE ALL ON invoices FROM aegis_app, aegis_worker;
DROP POLICY tenant_only ON invoices;
CREATE POLICY billing_roles_read ON invoices FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner','billing_manager'));
GRANT SELECT ON invoices TO aegis_app;

-- Idempotency ledger: one row per provider event, however many times it's delivered.
CREATE TABLE billing_webhook_events (
  event_id text PRIMARY KEY,
  provider text NOT NULL,
  type text NOT NULL,
  tenant_id uuid,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- What's already gone to the processor's meters, so a nightly run sends only the difference.
CREATE TABLE usage_reports (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  period text NOT NULL,
  metric text NOT NULL,
  reported_value bigint NOT NULL DEFAULT 0,
  reported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period, metric)
);

-- Per-tenant feature flags and limits, set by operators. Safety features can't be named here: see the CHECK.
CREATE TABLE tenant_entitlement_overrides (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('accounts','aiActionsPerMonth','automations','seats','gatewayMessagesPerMonth','indexBytes','policies','securityCenter','sso','sharedMailboxes')),
  value jsonb NOT NULL,
  reason text NOT NULL,
  set_by uuid,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- A row means suspended. Sign-in and sync stop. Nothing is deleted. Writes go only through op.suspend_tenant and op.unsuspend_tenant.
CREATE TABLE tenant_suspensions (
  tenant_id uuid PRIMARY KEY REFERENCES organizations ON DELETE CASCADE,
  reason text NOT NULL,
  suspended_by uuid,
  suspended_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_heartbeats (
  component text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_webhook_events','usage_reports','tenant_entitlement_overrides','tenant_suspensions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- The billing context: every tenant's billing rows, and nothing about mail.
GRANT SELECT, INSERT, UPDATE ON subscriptions, invoices, billing_webhook_events, usage_counters, usage_reports TO aegis_billing;
GRANT DELETE ON billing_webhook_events TO aegis_billing;
GRANT SELECT ON tenant_entitlement_overrides TO aegis_billing;
GRANT SELECT (id, name) ON organizations TO aegis_billing;
GRANT INSERT ON audit_events TO aegis_billing;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO aegis_billing;
CREATE POLICY billing_all ON subscriptions TO aegis_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_all ON invoices TO aegis_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_all ON billing_webhook_events TO aegis_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_all ON usage_counters TO aegis_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_all ON usage_reports TO aegis_billing USING (true) WITH CHECK (true);
CREATE POLICY billing_read ON tenant_entitlement_overrides FOR SELECT TO aegis_billing USING (true);
CREATE POLICY billing_read ON organizations FOR SELECT TO aegis_billing USING (true);
CREATE POLICY billing_insert ON audit_events FOR INSERT TO aegis_billing WITH CHECK (true);

-- A tenant can see what's been set on it, and that it's suspended.
GRANT SELECT ON tenant_entitlement_overrides, tenant_suspensions TO aegis_app;
GRANT SELECT ON tenant_suspensions TO aegis_worker, aegis_web_conn;
CREATE POLICY tenant_read ON tenant_entitlement_overrides FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner','billing_manager','security_admin'));
CREATE POLICY tenant_read ON tenant_suspensions FOR SELECT TO aegis_app, aegis_worker USING (tenant_id = app.tenant_id());
CREATE POLICY web_conn ON tenant_suspensions FOR SELECT TO aegis_web_conn USING (true);

GRANT SELECT, INSERT, UPDATE ON service_heartbeats TO aegis_worker_conn;

-- ===== Billing definer functions =====
-- Whole-tenant counts for caps and seat sync. A request context only sees its own mailboxes, and a count needs no more.
CREATE FUNCTION billing_tenant_facts(p_tenant uuid) RETURNS TABLE(seats int, active_mailboxes int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = p_tenant),
         (SELECT count(*)::int FROM mail_accounts a WHERE a.tenant_id = p_tenant AND a.status <> 'disconnected')
$$;

-- The one way to add to a usage counter, callable from web, worker and gateway. Only known metrics, only upward.
CREATE FUNCTION billing_increment_usage(p_tenant uuid, p_period text, p_metric text, p_n bigint) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO usage_counters(tenant_id, period, metric, value)
  SELECT p_tenant, p_period, p_metric, p_n WHERE p_n > 0 AND p_metric IN ('ai_actions','gateway_messages') AND p_period ~ '^[0-9]{4}-[0-9]{2}$'
  ON CONFLICT (tenant_id, period, metric) DO UPDATE SET value = usage_counters.value + EXCLUDED.value
  RETURNING value
$$;

CREATE FUNCTION scheduler_billing_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM tenant_suspensions x WHERE x.tenant_id = o.id)
$$;
CREATE FUNCTION scheduler_suspended_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.tenant_id FROM tenant_suspensions x
$$;

GRANT SELECT (tenant_id) ON memberships TO aegis_billing_definer;
GRANT SELECT (tenant_id, status) ON mail_accounts TO aegis_billing_definer;
GRANT SELECT (id) ON organizations TO aegis_billing_definer;
GRANT SELECT ON tenant_suspensions TO aegis_billing_definer;
GRANT SELECT, INSERT, UPDATE ON usage_counters TO aegis_billing_definer;
CREATE POLICY billing_definer_read ON memberships FOR SELECT TO aegis_billing_definer USING (true);
CREATE POLICY billing_definer_read ON mail_accounts FOR SELECT TO aegis_billing_definer USING (true);
CREATE POLICY billing_definer_read ON organizations FOR SELECT TO aegis_billing_definer USING (true);
CREATE POLICY billing_definer_read ON tenant_suspensions FOR SELECT TO aegis_billing_definer USING (true);
CREATE POLICY billing_definer_all ON usage_counters TO aegis_billing_definer USING (true) WITH CHECK (true);

-- Seat sync follows every membership change, whichever path made it: invitations, removal, SSO JIT, SCIM, account deletion.
-- Only tenants with a live processor subscription queue anything. The job carries no payload.
CREATE FUNCTION app.enqueue_seat_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = v_tenant AND s.external_id IS NOT NULL AND s.status IN ('trialing','active','past_due')) THEN
    INSERT INTO jobs(tenant_id, kind, dedupe_key) VALUES (v_tenant, 'billing.seat_sync', 'seats:' || v_tenant::text)
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running') DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_seat_sync AFTER INSERT OR DELETE ON memberships FOR EACH ROW EXECUTE FUNCTION app.enqueue_seat_sync();
GRANT SELECT (tenant_id, external_id, status) ON subscriptions TO aegis_billing_definer;
CREATE POLICY billing_definer_read ON subscriptions FOR SELECT TO aegis_billing_definer USING (true);
GRANT SELECT (dedupe_key, state), INSERT (tenant_id, kind, dedupe_key) ON jobs TO aegis_billing_definer;
CREATE POLICY billing_definer_all ON jobs TO aegis_billing_definer USING (true) WITH CHECK (true);

-- ===== Operator area =====
CREATE TABLE platform_admins (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('env','cli','demo')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Every operator action. Insert-only: the definer role has no UPDATE or DELETE, and the trigger stops the table owner too.
CREATE TABLE operator_audit_log (
  id bigserial PRIMARY KEY,
  operator_user_id uuid,
  action text NOT NULL,
  tenant_id uuid,
  target text,
  reason text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_audit_recent ON operator_audit_log (id DESC);
ALTER TABLE operator_audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE operator_audit_log FORCE ROW LEVEL SECURITY;
CREATE FUNCTION app.operator_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'operator_audit_log is append-only' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER operator_audit_append_only BEFORE UPDATE OR DELETE ON operator_audit_log FOR EACH ROW EXECUTE FUNCTION app.operator_audit_immutable();
REVOKE ALL ON FUNCTION app.operator_audit_immutable() FROM PUBLIC;

-- What op.* functions may read and change. Column grants: these are the only places an operator's data comes from.
GRANT SELECT, INSERT ON operator_audit_log TO aegis_operator_definer;
GRANT USAGE ON SEQUENCE operator_audit_log_id_seq TO aegis_operator_definer;
CREATE POLICY op_definer_read ON operator_audit_log FOR SELECT TO aegis_operator_definer USING (true);
CREATE POLICY op_definer_insert ON operator_audit_log FOR INSERT TO aegis_operator_definer WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON platform_admins TO aegis_operator_definer;
GRANT SELECT (id, name, email, totp_enabled, deleted_at, created_at) ON users TO aegis_operator_definer;
CREATE POLICY op_definer_read ON users FOR SELECT TO aegis_operator_definer USING (true);
GRANT SELECT (user_id, last_seen_at) ON sessions TO aegis_operator_definer;
GRANT SELECT (id, kind, name, created_at) ON organizations TO aegis_operator_definer;
CREATE POLICY op_definer_read ON organizations FOR SELECT TO aegis_operator_definer USING (true);
GRANT SELECT (tenant_id, user_id, role, created_at) ON memberships TO aegis_operator_definer;
CREATE POLICY op_definer_read ON memberships FOR SELECT TO aegis_operator_definer USING (true);
-- Provider and status. Not the email column.
GRANT SELECT (id, tenant_id, kind, status) ON mail_accounts TO aegis_operator_definer;
CREATE POLICY op_definer_read ON mail_accounts FOR SELECT TO aegis_operator_definer USING (true);
GRANT SELECT (tenant_id, consecutive_failures, last_error_code) ON sync_states TO aegis_operator_definer;
CREATE POLICY op_definer_read ON sync_states FOR SELECT TO aegis_operator_definer USING (true);
GRANT SELECT (tenant_id, plan, status, provider, seats, trial_ends_at, current_period_end, cancel_at_period_end, past_due_since, updated_at, external_id) ON subscriptions TO aegis_operator_definer;
GRANT UPDATE (status, trial_ends_at, updated_at) ON subscriptions TO aegis_operator_definer;
CREATE POLICY op_definer_all ON subscriptions TO aegis_operator_definer USING (true) WITH CHECK (true);
GRANT SELECT (tenant_id, period, metric, value) ON usage_counters TO aegis_operator_definer;
CREATE POLICY op_definer_read ON usage_counters FOR SELECT TO aegis_operator_definer USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_entitlement_overrides, tenant_suspensions TO aegis_operator_definer;
CREATE POLICY op_definer_all ON tenant_entitlement_overrides TO aegis_operator_definer USING (true) WITH CHECK (true);
CREATE POLICY op_definer_all ON tenant_suspensions TO aegis_operator_definer USING (true) WITH CHECK (true);
GRANT INSERT ON audit_events TO aegis_operator_definer;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO aegis_operator_definer;
CREATE POLICY op_definer_insert ON audit_events FOR INSERT TO aegis_operator_definer WITH CHECK (true);
-- Jobs: kind, state and error code. Never payload, and never the tenant, so the queue view can't be read as activity per customer.
GRANT SELECT (id, kind, state, attempts, max_attempts, last_error_code, created_at, finished_at, run_at) ON jobs TO aegis_operator_definer;
GRANT UPDATE (state, attempts, run_at, finished_at, last_error_code, locked_at) ON jobs TO aegis_operator_definer;
CREATE POLICY op_definer_all ON jobs TO aegis_operator_definer USING (true) WITH CHECK (true);
GRANT SELECT ON service_heartbeats TO aegis_operator_definer;
GRANT SELECT (last_seen_at) ON gateway_heartbeats TO aegis_operator_definer;

CREATE SCHEMA op;
GRANT USAGE ON SCHEMA op TO aegis_operator, aegis_operator_definer;

-- The independent check. Every function below applies it, whatever the web layer already decided.
CREATE FUNCTION op.operator_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.user_id FROM platform_admins a JOIN users u ON u.id = a.user_id
  WHERE a.user_id = NULLIF(current_setting('app.operator_id', true), '')::uuid AND a.revoked_at IS NULL AND u.deleted_at IS NULL
$$;
CREATE FUNCTION op.require_operator() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v uuid := op.operator_id();
BEGIN
  IF v IS NULL THEN RAISE EXCEPTION 'not an operator' USING ERRCODE = '42501'; END IF;
  RETURN v;
END $$;
CREATE FUNCTION op.require_reason(p_reason text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  RETURN left(btrim(p_reason), 500);
END $$;
-- Private. Writes the operator log and, when the tenant should see it, an entry in the tenant's own audit log with no actor.
CREATE FUNCTION op.record(p_operator uuid, p_action text, p_tenant uuid, p_target text, p_reason text, p_meta jsonb, p_tenant_event text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO operator_audit_log(operator_user_id, action, tenant_id, target, reason, meta) VALUES (p_operator, p_action, p_tenant, p_target, p_reason, COALESCE(p_meta, '{}'));
  IF p_tenant_event IS NOT NULL THEN
    INSERT INTO audit_events(tenant_id, actor_user_id, event, target_type, target_id, meta)
    VALUES (p_tenant, NULL, p_tenant_event, 'operator', NULL, COALESCE(p_meta, '{}') || jsonb_build_object('reason', left(p_reason, 120)));
  END IF;
END $$;

CREATE FUNCTION op.whoami() RETURNS TABLE(user_id uuid, source text, totp_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.user_id, a.source, u.totp_enabled FROM platform_admins a JOIN users u ON u.id = a.user_id WHERE a.user_id = op.operator_id()
$$;

-- ----- Aggregates -----
CREATE FUNCTION op.tenant_stats() RETURNS TABLE(kind text, tenants int, suspended int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.kind, count(*)::int, count(x.tenant_id)::int FROM organizations o LEFT JOIN tenant_suspensions x ON x.tenant_id = o.id
  WHERE op.operator_id() IS NOT NULL GROUP BY o.kind ORDER BY o.kind
$$;
CREATE FUNCTION op.user_stats(p_days int) RETURNS TABLE(total int, active int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*)::int FROM users u WHERE u.deleted_at IS NULL),
         (SELECT count(DISTINCT s.user_id)::int FROM sessions s WHERE s.last_seen_at > now() - (p_days * interval '1 day'))
  WHERE op.operator_id() IS NOT NULL
$$;
CREATE FUNCTION op.mailbox_stats() RETURNS TABLE(provider text, status text, count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.kind, a.status, count(*)::int FROM mail_accounts a WHERE op.operator_id() IS NOT NULL GROUP BY a.kind, a.status ORDER BY a.kind, a.status
$$;
CREATE FUNCTION op.queue_stats() RETURNS TABLE(kind text, state text, error_code text, count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.kind, j.state, j.last_error_code, count(*)::int FROM jobs j
  WHERE op.operator_id() IS NOT NULL AND j.state IN ('queued','running','dead') GROUP BY j.kind, j.state, j.last_error_code ORDER BY j.state, count(*) DESC
$$;
CREATE FUNCTION op.sync_stats() RETURNS TABLE(mailboxes int, failing int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int, count(*) FILTER (WHERE s.consecutive_failures > 0)::int FROM sync_states s WHERE op.operator_id() IS NOT NULL
$$;
CREATE FUNCTION op.plan_stats() RETURNS TABLE(plan text, status text, tenants int, seats int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.plan, s.status, count(*)::int, COALESCE(sum(s.seats), 0)::int FROM subscriptions s WHERE op.operator_id() IS NOT NULL GROUP BY s.plan, s.status ORDER BY s.plan, s.status
$$;
-- Paying subscriptions per plan. A count, not money: prices live in the processor.
CREATE FUNCTION op.paying_stats() RETURNS TABLE(plan text, subscriptions int, seats int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.plan, count(*)::int, COALESCE(sum(s.seats), 0)::int FROM subscriptions s
  WHERE op.operator_id() IS NOT NULL AND s.provider = 'stripe' AND s.status IN ('active','past_due') GROUP BY s.plan ORDER BY s.plan
$$;

-- ----- Tenants -----
-- A personal workspace is named after its person by default, so operators get a generic label instead. Organization names stay.
CREATE FUNCTION op.display_name(p_kind text, p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_kind = 'personal' THEN 'Personal workspace' ELSE p_name END
$$;
CREATE FUNCTION op.list_tenants(p_search text, p_limit int, p_offset int) RETURNS TABLE(id uuid, name text, kind text, plan text, status text, seats int, members int, mailboxes int, created_at timestamptz, suspended_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, op.display_name(o.kind, o.name), o.kind, COALESCE(s.plan, 'free'), COALESCE(s.status, 'active'), COALESCE(s.seats, 1),
    (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = o.id),
    (SELECT count(*)::int FROM mail_accounts a WHERE a.tenant_id = o.id AND a.status <> 'disconnected'),
    o.created_at, x.suspended_at
  FROM organizations o LEFT JOIN subscriptions s ON s.tenant_id = o.id LEFT JOIN tenant_suspensions x ON x.tenant_id = o.id
  WHERE op.operator_id() IS NOT NULL AND (p_search IS NULL OR (o.kind <> 'personal' AND position(lower(p_search) IN lower(o.name)) > 0))
  ORDER BY o.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;
-- Viewing a tenant is itself an operator action, so this writes to the log.
CREATE FUNCTION op.tenant_detail(p_tenant uuid) RETURNS TABLE(id uuid, name text, kind text, plan text, status text, provider text, seats int, members int, mailboxes int, created_at timestamptz, trial_ends_at timestamptz, current_period_end timestamptz, cancel_at_period_end boolean, past_due_since timestamptz, suspended_at timestamptz, suspended_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_op uuid := op.require_operator();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_tenant) THEN RETURN; END IF;
  PERFORM op.record(v_op, 'tenant.viewed', p_tenant, NULL, NULL, '{}', NULL);
  RETURN QUERY
  SELECT o.id, op.display_name(o.kind, o.name), o.kind, COALESCE(s.plan, 'free'), COALESCE(s.status, 'active'), COALESCE(s.provider, 'none'), COALESCE(s.seats, 1),
    (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = o.id),
    (SELECT count(*)::int FROM mail_accounts a WHERE a.tenant_id = o.id AND a.status <> 'disconnected'),
    o.created_at, s.trial_ends_at, s.current_period_end, COALESCE(s.cancel_at_period_end, false), s.past_due_since, x.suspended_at, x.reason
  FROM organizations o LEFT JOIN subscriptions s ON s.tenant_id = o.id LEFT JOIN tenant_suspensions x ON x.tenant_id = o.id
  WHERE o.id = p_tenant;
END $$;
CREATE FUNCTION op.tenant_mailboxes(p_tenant uuid) RETURNS TABLE(provider text, status text, count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.kind, a.status, count(*)::int FROM mail_accounts a WHERE op.operator_id() IS NOT NULL AND a.tenant_id = p_tenant GROUP BY a.kind, a.status ORDER BY a.kind, a.status
$$;
CREATE FUNCTION op.tenant_usage(p_tenant uuid) RETURNS TABLE(period text, metric text, value bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.period, u.metric, u.value FROM usage_counters u WHERE op.operator_id() IS NOT NULL AND u.tenant_id = p_tenant ORDER BY u.period DESC, u.metric LIMIT 48
$$;
CREATE FUNCTION op.tenant_overrides(p_tenant uuid) RETURNS TABLE(key text, value jsonb, reason text, expires_at timestamptz, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.key, o.value, o.reason, o.expires_at, o.updated_at FROM tenant_entitlement_overrides o WHERE op.operator_id() IS NOT NULL AND o.tenant_id = p_tenant ORDER BY o.key
$$;
-- The only member detail an operator can reach: one owner, for a stated support reason, logged in both places.
CREATE FUNCTION op.owner_contact(p_tenant uuid, p_reason text) RETURNS TABLE(name text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_tenant) THEN RETURN; END IF;
  PERFORM op.record(v_op, 'tenant.owner_contact_viewed', p_tenant, NULL, v_reason, '{}', 'operator.owner_contact_viewed');
  RETURN QUERY SELECT u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant AND m.role = 'owner' AND u.deleted_at IS NULL ORDER BY m.created_at LIMIT 1;
END $$;

-- ----- Actions: reason required, audited, visible to the tenant -----
CREATE FUNCTION op.set_override(p_tenant uuid, p_key text, p_value jsonb, p_reason text, p_expires timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason);
BEGIN
  IF p_key IN ('policies','securityCenter','sso','sharedMailboxes') THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN RAISE EXCEPTION 'this override takes true or false' USING ERRCODE = '22023'; END IF;
  ELSIF jsonb_typeof(p_value) <> 'number' OR (p_value #>> '{}')::numeric < 0 THEN RAISE EXCEPTION 'this override takes a number, zero or more' USING ERRCODE = '22023'; END IF;
  INSERT INTO tenant_entitlement_overrides(tenant_id, key, value, reason, set_by, expires_at, updated_at) VALUES (p_tenant, p_key, p_value, v_reason, v_op, p_expires, now())
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, expires_at = EXCLUDED.expires_at, updated_at = now();
  PERFORM op.record(v_op, 'tenant.override_set', p_tenant, p_key, v_reason, jsonb_build_object('fields', jsonb_build_array(p_key), 'value', p_value), 'operator.override_set');
END $$;
CREATE FUNCTION op.clear_override(p_tenant uuid, p_key text, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason); v_found boolean;
BEGIN
  DELETE FROM tenant_entitlement_overrides o WHERE o.tenant_id = p_tenant AND o.key = p_key;
  v_found := FOUND;
  IF v_found THEN PERFORM op.record(v_op, 'tenant.override_cleared', p_tenant, p_key, v_reason, jsonb_build_object('fields', jsonb_build_array(p_key)), 'operator.override_cleared'); END IF;
  RETURN v_found;
END $$;
-- A trial that's running, or one that ended without converting. Anything else isn't a trial to extend.
CREATE FUNCTION op.extend_trial(p_tenant uuid, p_until timestamptz, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason);
BEGIN
  IF p_until IS NULL OR p_until <= now() THEN RAISE EXCEPTION 'the new end must be in the future' USING ERRCODE = '22023'; END IF;
  UPDATE subscriptions s SET trial_ends_at = p_until, status = 'trialing', updated_at = now() WHERE s.tenant_id = p_tenant AND s.status IN ('trialing','expired');
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM op.record(v_op, 'tenant.trial_extended', p_tenant, NULL, v_reason, jsonb_build_object('until', p_until), 'operator.trial_extended');
  RETURN true;
END $$;
CREATE FUNCTION op.suspend_tenant(p_tenant uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_tenant) THEN RETURN false; END IF;
  INSERT INTO tenant_suspensions(tenant_id, reason, suspended_by) VALUES (p_tenant, v_reason, v_op) ON CONFLICT (tenant_id) DO NOTHING;
  IF NOT FOUND THEN RETURN true; END IF;
  PERFORM op.record(v_op, 'tenant.suspended', p_tenant, NULL, v_reason, '{}', 'operator.tenant_suspended');
  RETURN true;
END $$;
CREATE FUNCTION op.unsuspend_tenant(p_tenant uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_reason text := op.require_reason(p_reason);
BEGIN
  DELETE FROM tenant_suspensions x WHERE x.tenant_id = p_tenant;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM op.record(v_op, 'tenant.unsuspended', p_tenant, NULL, v_reason, '{}', 'operator.tenant_unsuspended');
  RETURN true;
END $$;

-- ----- Queue and health -----
CREATE FUNCTION op.list_jobs(p_state text, p_limit int) RETURNS TABLE(id uuid, kind text, state text, attempts int, max_attempts int, error_code text, created_at timestamptz, finished_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.id, j.kind, j.state, j.attempts, j.max_attempts, j.last_error_code, j.created_at, j.finished_at FROM jobs j
  WHERE op.operator_id() IS NOT NULL AND j.state = p_state ORDER BY j.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;
CREATE FUNCTION op.retry_job(p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_op uuid := op.require_operator(); v_kind text;
BEGIN
  BEGIN
    UPDATE jobs j SET state = 'queued', attempts = 0, run_at = now(), finished_at = NULL, last_error_code = NULL, locked_at = NULL WHERE j.id = p_id AND j.state = 'dead' RETURNING j.kind INTO v_kind;
  EXCEPTION WHEN unique_violation THEN
    -- The same work is already queued under this job's dedupe key.
    PERFORM op.record(v_op, 'job.retry_skipped', NULL, p_id::text, NULL, jsonb_build_object('outcome', 'already_queued'), NULL);
    RETURN 'already_queued';
  END;
  IF v_kind IS NULL THEN RETURN 'not_dead'; END IF;
  PERFORM op.record(v_op, 'job.retried', NULL, p_id::text, NULL, jsonb_build_object('kind', v_kind), NULL);
  RETURN 'queued';
END $$;
CREATE FUNCTION op.heartbeats() RETURNS TABLE(component text, last_seen_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT h.component, h.last_seen_at FROM service_heartbeats h WHERE op.operator_id() IS NOT NULL
  UNION ALL
  SELECT 'gateway', max(g.last_seen_at) FROM gateway_heartbeats g WHERE op.operator_id() IS NOT NULL HAVING max(g.last_seen_at) IS NOT NULL
$$;
CREATE FUNCTION op.audit_log(p_limit int, p_before bigint) RETURNS TABLE(id bigint, at timestamptz, operator_name text, action text, tenant_id uuid, tenant_name text, target text, reason text, meta jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.created_at, u.name, l.action, l.tenant_id, op.display_name(o.kind, o.name), l.target, l.reason, l.meta
  FROM operator_audit_log l LEFT JOIN users u ON u.id = l.operator_user_id LEFT JOIN organizations o ON o.id = l.tenant_id
  WHERE op.operator_id() IS NOT NULL AND (p_before IS NULL OR l.id < p_before) ORDER BY l.id DESC LIMIT LEAST(GREATEST(p_limit, 1), 200)
$$;

-- ----- Granting operator access: the migrating role only, through the CLI. Nothing the web or worker logins can call. -----
CREATE FUNCTION op.cli_grant(p_user uuid, p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO platform_admins(user_id, source) VALUES (p_user, p_source)
  ON CONFLICT (user_id) DO UPDATE SET source = EXCLUDED.source, revoked_at = NULL;
  PERFORM op.record(NULL, 'operator.granted', NULL, p_user::text, NULL, jsonb_build_object('source', p_source), NULL);
END $$;
CREATE FUNCTION op.cli_revoke(p_user uuid, p_source text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins a SET revoked_at = now() WHERE a.user_id = p_user AND a.revoked_at IS NULL AND (p_source IS NULL OR a.source = p_source);
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM op.record(NULL, 'operator.revoked', NULL, p_user::text, NULL, '{}', NULL);
  RETURN true;
END $$;
CREATE FUNCTION op.cli_list() RETURNS TABLE(user_id uuid, source text, revoked_at timestamptz, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.user_id, a.source, a.revoked_at, u.email FROM platform_admins a JOIN users u ON u.id = a.user_id ORDER BY a.created_at
$$;

-- ===== Ownership and execute rights =====
GRANT aegis_billing_definer TO CURRENT_USER;
GRANT aegis_operator_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA public, app TO aegis_billing_definer;
GRANT CREATE ON SCHEMA op TO aegis_operator_definer;
ALTER FUNCTION billing_tenant_facts(uuid) OWNER TO aegis_billing_definer;
ALTER FUNCTION billing_increment_usage(uuid, text, text, bigint) OWNER TO aegis_billing_definer;
ALTER FUNCTION scheduler_billing_tenants() OWNER TO aegis_billing_definer;
ALTER FUNCTION scheduler_suspended_tenants() OWNER TO aegis_billing_definer;
ALTER FUNCTION app.enqueue_seat_sync() OWNER TO aegis_billing_definer;
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'op'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO aegis_operator_definer', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public, app FROM aegis_billing_definer;
REVOKE ALL ON FUNCTION app.enqueue_seat_sync() FROM PUBLIC;
REVOKE CREATE ON SCHEMA op FROM aegis_operator_definer;

REVOKE ALL ON FUNCTION billing_tenant_facts(uuid), billing_increment_usage(uuid, text, text, bigint), scheduler_billing_tenants(), scheduler_suspended_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION billing_tenant_facts(uuid) TO aegis_billing;
GRANT EXECUTE ON FUNCTION billing_increment_usage(uuid, text, text, bigint) TO aegis_web_conn, aegis_worker_conn, aegis_gateway_conn, aegis_app, aegis_worker, aegis_gateway, aegis_billing;
GRANT EXECUTE ON FUNCTION scheduler_billing_tenants(), scheduler_suspended_tenants() TO aegis_worker_conn;

GRANT EXECUTE ON FUNCTION op.whoami(), op.tenant_stats(), op.user_stats(int), op.mailbox_stats(), op.queue_stats(), op.sync_stats(), op.plan_stats(), op.paying_stats(),
  op.list_tenants(text, int, int), op.tenant_detail(uuid), op.tenant_mailboxes(uuid), op.tenant_usage(uuid), op.tenant_overrides(uuid), op.owner_contact(uuid, text),
  op.set_override(uuid, text, jsonb, text, timestamptz), op.clear_override(uuid, text, text), op.extend_trial(uuid, timestamptz, text),
  op.suspend_tenant(uuid, text), op.unsuspend_tenant(uuid, text), op.list_jobs(text, int), op.retry_job(uuid), op.heartbeats(), op.audit_log(int, bigint) TO aegis_operator;
GRANT EXECUTE ON FUNCTION op.cli_grant(uuid, text), op.cli_revoke(uuid, text), op.cli_list() TO CURRENT_USER;
