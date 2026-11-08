-- Experimental SMTP security gateway. See docs/gateway-design.md and ADR-0007.
--
-- Process boundary: gateway login → aegis_gateway_conn → may become aegis_gateway (never aegis_app or aegis_worker).
-- The connection role reaches only a heartbeat table and a few definer functions that return IDs and counts.
-- The context role reaches gateway tables, one tenant at a time, plus what it needs to seal and scan. No mail tables.
--
-- Definer functions are owned by aegis_gateway_definer, not by the migrating role. Every table here is FORCE RLS and
-- production has no superuser, so a function owned by the migrator would run under RLS with no matching policy and
-- silently return nothing there while appearing to work on a developer's superuser login. Ownership by a dedicated,
-- non-superuser role with explicit read policies makes those functions behave the same in both places.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_gateway') THEN CREATE ROLE aegis_gateway NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_gateway_conn') THEN CREATE ROLE aegis_gateway_conn NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_gateway_definer') THEN CREATE ROLE aegis_gateway_definer NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
END $$;
GRANT aegis_gateway TO aegis_gateway_conn WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA app, public TO aegis_gateway, aegis_gateway_conn, aegis_gateway_definer;

-- ===== Domain configuration. One tenant per domain, globally, because RCPT routing must have one answer. =====
CREATE TABLE gateway_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  verified_domain_id uuid NOT NULL REFERENCES verified_domains ON DELETE CASCADE,
  domain text NOT NULL UNIQUE CHECK (domain = lower(domain)),
  enabled boolean NOT NULL DEFAULT false,
  downstream_host text,
  downstream_port int NOT NULL DEFAULT 25 CHECK (downstream_port BETWEEN 1 AND 65535),
  -- 'required' means STARTTLS or implicit TLS with a verified certificate. 'opportunistic' is the explicit opt-out.
  tls_mode text NOT NULL DEFAULT 'required' CHECK (tls_mode IN ('required','opportunistic')),
  fail_mode text NOT NULL DEFAULT 'fail_closed' CHECK (fail_mode IN ('fail_open','fail_closed')),
  malicious_action text NOT NULL DEFAULT 'hold' CHECK (malicious_action IN ('hold','reject')),
  test_recipient text,
  routing_ok boolean NOT NULL DEFAULT false,
  routing_checked_at timestamptz,
  routing_detail jsonb NOT NULL DEFAULT '{}',
  selftest_passed_at timestamptz,
  downstream_last_ok_at timestamptz,
  downstream_last_fail_at timestamptz,
  downstream_failures int NOT NULL DEFAULT 0,
  downstream_last_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR downstream_host IS NOT NULL)
);
CREATE INDEX gateway_domains_tenant ON gateway_domains (tenant_id);

-- Changing where mail goes voids earlier proof that protection works.
CREATE FUNCTION app.gateway_domain_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.downstream_host, NEW.downstream_port, NEW.tls_mode, NEW.enabled) IS DISTINCT FROM (OLD.downstream_host, OLD.downstream_port, OLD.tls_mode, OLD.enabled) THEN
    NEW.selftest_passed_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER gateway_domains_changed BEFORE UPDATE ON gateway_domains FOR EACH ROW EXECUTE FUNCTION app.gateway_domain_changed();

-- ===== The spool. Nothing here is readable by web or worker: raw_enc and envelope_enc are for this process only. =====
CREATE TABLE gateway_spool (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES gateway_domains,
  kind text NOT NULL DEFAULT 'inbound' CHECK (kind IN ('inbound','dsn','system','selftest_clean','selftest_canary')),
  state text NOT NULL CHECK (state IN ('received','scanning','ready','done','rejected')),
  size_bytes int NOT NULL,
  raw_enc bytea,
  envelope_enc bytea,
  verdict_enc bytea,
  label text,
  action text,
  reason_codes text[] NOT NULL DEFAULT '{}',
  verdict_source text CHECK (verdict_source IN ('scan','stamp','fail_open','fail_closed','unparseable','none')),
  flagged boolean NOT NULL DEFAULT false,
  sender_null boolean NOT NULL DEFAULT false,
  auth_failed boolean NOT NULL DEFAULT false,
  hop int NOT NULL DEFAULT 0,
  scan_attempts int NOT NULL DEFAULT 0,
  scan_lease_until timestamptz,
  selftest_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  verdict_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX gateway_spool_scan ON gateway_spool (received_at) WHERE state IN ('received','scanning');
CREATE INDEX gateway_spool_tenant_live ON gateway_spool (tenant_id) WHERE raw_enc IS NOT NULL;
CREATE INDEX gateway_spool_finished ON gateway_spool (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE gateway_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spool_id uuid NOT NULL REFERENCES gateway_spool ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  position int NOT NULL,
  rcpt_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','queued','delivering','delivered','held','bounced','expired','deleted','rejected')),
  attempts int NOT NULL DEFAULT 0,
  queued_at timestamptz,
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_response_code int,
  last_error_code text,
  delivered_at timestamptz,
  UNIQUE (spool_id, position)
);
CREATE INDEX gateway_recipients_ready ON gateway_recipients (next_attempt_at) WHERE state = 'queued';
CREATE INDEX gateway_recipients_lease ON gateway_recipients (lease_until) WHERE state = 'delivering';

-- ===== Holds: the only gateway table the web process can see. Metadata, never the message. =====
CREATE TABLE gateway_holds (
  id uuid PRIMARY KEY REFERENCES gateway_recipients ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  spool_id uuid NOT NULL REFERENCES gateway_spool ON DELETE CASCADE,
  rcpt_hash text NOT NULL,
  owner_user_id uuid REFERENCES users ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','pending_approval','released','deleted','expired','cleared')),
  reason text NOT NULL CHECK (reason IN ('policy','engine_failure','unparseable')),
  label text,
  reason_codes text[] NOT NULL DEFAULT '{}',
  -- Envelope-level minimum, sealed: SMTP sender and recipient. Security admins may see this for holds nobody owns.
  min_meta_enc bytea NOT NULL,
  size_bytes int NOT NULL,
  held_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by uuid REFERENCES users ON DELETE SET NULL,
  decided_at timestamptz,
  applied_at timestamptz,
  last_rescan_at timestamptz
);
CREATE INDEX gateway_holds_owner ON gateway_holds (owner_user_id) WHERE state IN ('held','pending_approval');
CREATE INDEX gateway_holds_tenant ON gateway_holds (tenant_id, held_at DESC);
CREATE INDEX gateway_holds_pending ON gateway_holds (decided_at) WHERE applied_at IS NULL AND state IN ('released','deleted');

-- Header From and Subject live apart, in a table an admin never gets a row from, because they're message content.
CREATE TABLE gateway_hold_owner_meta (
  hold_id uuid PRIMARY KEY REFERENCES gateway_holds ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  owner_user_id uuid REFERENCES users ON DELETE SET NULL,
  meta_enc bytea NOT NULL
);

-- Who owns an address is proved by receiving a code at it, delivered through the customer's own mail server. A profile
-- email isn't enough: anyone with invite rights could otherwise create "the recipient" and see that person's held mail.
CREATE TABLE gateway_address_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES gateway_domains ON DELETE CASCADE,
  rcpt_hash text NOT NULL,
  address_enc bytea NOT NULL,
  code_enc bytea NOT NULL,
  code_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','verified','expired')),
  attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  applied_at timestamptz
);
CREATE INDEX gateway_claims_address ON gateway_address_claims (tenant_id, rcpt_hash) WHERE state = 'verified';
CREATE INDEX gateway_claims_user ON gateway_address_claims (user_id, created_at DESC);

CREATE TABLE gateway_selftests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES gateway_domains ON DELETE CASCADE,
  requested_by uuid REFERENCES users ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','passed','failed')),
  clean_delivered boolean,
  canary_stopped boolean,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX gateway_selftests_domain ON gateway_selftests (domain_id, created_at DESC);
CREATE UNIQUE INDEX gateway_selftests_one_active ON gateway_selftests (domain_id) WHERE state IN ('pending','running');

-- Counts and durations by day. No sender, subject, recipient or message identity.
CREATE TABLE gateway_stats_daily (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  day date NOT NULL,
  metric text NOT NULL,
  count bigint NOT NULL DEFAULT 0,
  sum_ms bigint NOT NULL DEFAULT 0,
  max_ms bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, metric)
);

-- Liveness of gateway processes. Not tenant data.
CREATE TABLE gateway_heartbeats (
  instance_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  limits jsonb NOT NULL DEFAULT '{}'
);

-- ===== RLS =====
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['gateway_domains','gateway_spool','gateway_recipients','gateway_holds','gateway_hold_owner_meta','gateway_address_claims','gateway_selftests','gateway_stats_daily']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY gateway_tenant ON %I TO aegis_gateway USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('CREATE POLICY definer_read ON %I FOR SELECT TO aegis_gateway_definer USING (true)', t);
    EXECUTE format('GRANT SELECT ON %I TO aegis_gateway_definer', t);
  END LOOP;
END $$;
GRANT SELECT ON gateway_heartbeats TO aegis_gateway_definer;

-- The definer's own view of tables it must consult, so these functions work without a superuser or BYPASSRLS.
GRANT SELECT ON verified_domains, organizations, memberships TO aegis_gateway_definer;
CREATE POLICY gateway_definer_read ON verified_domains FOR SELECT TO aegis_gateway_definer USING (true);
CREATE POLICY gateway_definer_read ON organizations FOR SELECT TO aegis_gateway_definer USING (true);
CREATE POLICY gateway_definer_read ON memberships FOR SELECT TO aegis_gateway_definer USING (true);

-- Gateway context: its own tables, and only what it needs from the rest.
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_spool, gateway_recipients, gateway_holds, gateway_hold_owner_meta, gateway_stats_daily TO aegis_gateway;
GRANT SELECT, UPDATE ON gateway_selftests, gateway_address_claims TO aegis_gateway;
GRANT SELECT ON gateway_domains TO aegis_gateway;
GRANT UPDATE (routing_ok, routing_checked_at, routing_detail, selftest_passed_at, downstream_last_ok_at, downstream_last_fail_at, downstream_failures, downstream_last_code) ON gateway_domains TO aegis_gateway;

GRANT SELECT, INSERT ON tenant_keys TO aegis_gateway;
CREATE POLICY gateway_keys ON tenant_keys TO aegis_gateway USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT ON tenant_policies TO aegis_gateway;
CREATE POLICY gateway_read ON tenant_policies FOR SELECT TO aegis_gateway USING (tenant_id = app.tenant_id());
GRANT SELECT ON verified_domains TO aegis_gateway;
CREATE POLICY gateway_read ON verified_domains FOR SELECT TO aegis_gateway USING (tenant_id = app.tenant_id());
GRANT INSERT ON audit_events TO aegis_gateway;
CREATE POLICY gateway_insert ON audit_events FOR INSERT TO aegis_gateway WITH CHECK (tenant_id = app.tenant_id());
GRANT USAGE ON SEQUENCE audit_events_id_seq TO aegis_gateway;

-- Connection role: liveness only. It can't read a single gateway row outside a tenant context.
GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_heartbeats TO aegis_gateway_conn;

-- Web: setup for admins. selftest_passed_at isn't writable from the web process, so only the gateway can record that
-- a message really went through it. The role check sits inside a definer helper so it works without a superuser.
CREATE FUNCTION app.gateway_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app.tenant_id() AND m.user_id = app.user_id() AND m.role IN ('owner','security_admin'))
$$;

GRANT SELECT ON gateway_domains TO aegis_app;
GRANT INSERT (tenant_id, verified_domain_id, domain, enabled, downstream_host, downstream_port, tls_mode, fail_mode, malicious_action, test_recipient) ON gateway_domains TO aegis_app;
GRANT UPDATE (enabled, downstream_host, downstream_port, tls_mode, fail_mode, malicious_action, test_recipient, routing_ok, routing_checked_at, routing_detail) ON gateway_domains TO aegis_app;
CREATE POLICY app_read ON gateway_domains FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id());
CREATE POLICY app_insert ON gateway_domains FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND app.gateway_is_admin());
CREATE POLICY app_update ON gateway_domains FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND app.gateway_is_admin()) WITH CHECK (tenant_id = app.tenant_id() AND app.gateway_is_admin());

-- Holds. The recipient owner sees theirs. A security admin sees a row only when nobody owns it, or the owner asked for
-- approval, or they just decided it, because Postgres re-checks read visibility on the row an UPDATE produces.
GRANT SELECT (id, tenant_id, spool_id, owner_user_id, state, reason, label, reason_codes, min_meta_enc, size_bytes, held_at, expires_at, decided_by, decided_at) ON gateway_holds TO aegis_app;
GRANT UPDATE (state, decided_by, decided_at) ON gateway_holds TO aegis_app;
CREATE POLICY owner_read ON gateway_holds FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND owner_user_id = app.user_id());
CREATE POLICY admin_min ON gateway_holds FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.gateway_is_admin() AND (owner_user_id IS NULL OR state = 'pending_approval' OR decided_by = app.user_id()));
CREATE POLICY owner_decide ON gateway_holds FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND owner_user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY admin_decide ON gateway_holds FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND app.gateway_is_admin() AND (owner_user_id IS NULL OR state = 'pending_approval')) WITH CHECK (tenant_id = app.tenant_id());

GRANT SELECT ON gateway_hold_owner_meta TO aegis_app;
CREATE POLICY owner_only ON gateway_hold_owner_meta FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND owner_user_id = app.user_id());

-- Address claims: yours only. The sealed code can be written from web and read only by the gateway.
GRANT SELECT (id, tenant_id, user_id, domain_id, rcpt_hash, code_hash, state, attempts, created_at, expires_at, verified_at) ON gateway_address_claims TO aegis_app;
GRANT INSERT (id, tenant_id, user_id, domain_id, rcpt_hash, address_enc, code_enc, code_hash, expires_at) ON gateway_address_claims TO aegis_app;
GRANT UPDATE (state, attempts, verified_at) ON gateway_address_claims TO aegis_app;
CREATE POLICY own_claims ON gateway_address_claims TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());

GRANT SELECT, INSERT ON gateway_selftests TO aegis_app;
CREATE POLICY admin_selftest ON gateway_selftests TO aegis_app USING (tenant_id = app.tenant_id() AND app.gateway_is_admin()) WITH CHECK (tenant_id = app.tenant_id() AND app.gateway_is_admin());

GRANT SELECT ON gateway_stats_daily TO aegis_app;
CREATE POLICY admin_read ON gateway_stats_daily FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.gateway_is_admin());

-- Worker duties: destroying a tenant's spool at crypto-shred, and unmapping a removed member's holds.
GRANT SELECT (id, tenant_id), DELETE ON gateway_spool TO aegis_worker;
CREATE POLICY worker_shred ON gateway_spool TO aegis_worker USING (tenant_id = app.tenant_id());
GRANT SELECT (id, tenant_id, enabled), UPDATE (enabled) ON gateway_domains TO aegis_worker;
CREATE POLICY worker_disable ON gateway_domains TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT (owner_user_id, tenant_id), UPDATE (owner_user_id) ON gateway_holds TO aegis_worker;
CREATE POLICY worker_unmap ON gateway_holds TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT (owner_user_id, tenant_id), UPDATE (owner_user_id) ON gateway_hold_owner_meta TO aegis_worker;
CREATE POLICY worker_unmap ON gateway_hold_owner_meta TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT (user_id, tenant_id), DELETE ON gateway_address_claims TO aegis_worker;
CREATE POLICY worker_remove ON gateway_address_claims TO aegis_worker USING (tenant_id = app.tenant_id());

-- ===== Definer functions. Each answers one question and returns IDs or counts, never content. =====
-- RCPT routing. Unverified, disabled, personal-workspace and downstream-less domains don't exist as far as SMTP knows.
CREATE FUNCTION gateway_route_lookup(p_domain text) RETURNS TABLE(tenant_id uuid, domain_id uuid, domain text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.tenant_id, g.id, g.domain
  FROM gateway_domains g
  JOIN verified_domains v ON v.id = g.verified_domain_id AND v.tenant_id = g.tenant_id AND v.domain = g.domain
  JOIN organizations o ON o.id = g.tenant_id
  WHERE g.domain = lower(p_domain) AND g.enabled AND g.downstream_host IS NOT NULL AND v.verified_at IS NOT NULL AND o.kind = 'organization'
$$;

-- Work across tenants, as IDs. The work itself then runs inside that tenant's context.
CREATE FUNCTION gateway_next_work(p_limit int) RETURNS TABLE(tenant_id uuid, kind text, item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  (SELECT s.tenant_id, 'scan'::text, s.id FROM gateway_spool s
    WHERE s.state = 'received' OR (s.state = 'scanning' AND s.scan_lease_until < now()) ORDER BY s.received_at LIMIT p_limit)
  UNION ALL
  (SELECT r.tenant_id, 'deliver'::text, r.spool_id FROM gateway_recipients r
    WHERE (r.state = 'queued' AND r.next_attempt_at <= now()) OR (r.state = 'delivering' AND r.lease_until < now())
    GROUP BY r.tenant_id, r.spool_id ORDER BY min(r.next_attempt_at) LIMIT p_limit)
  UNION ALL
  (SELECT h.tenant_id, 'decision'::text, h.id FROM gateway_holds h WHERE h.applied_at IS NULL AND h.state IN ('released','deleted') ORDER BY h.decided_at LIMIT p_limit)
  UNION ALL
  (SELECT t.tenant_id, 'selftest'::text, t.id FROM gateway_selftests t WHERE t.state = 'pending' ORDER BY t.created_at LIMIT p_limit)
  UNION ALL
  (SELECT c.tenant_id, 'claim'::text, c.id FROM gateway_address_claims c WHERE c.state = 'pending' ORDER BY c.created_at LIMIT p_limit)
$$;

CREATE FUNCTION gateway_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT g.tenant_id FROM gateway_domains g
$$;

-- Whole-process queue view for /health. No tenant identity.
CREATE FUNCTION gateway_queue_summary() RETURNS TABLE(state text, count bigint, oldest_at timestamptz, bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.state, count(*), min(s.received_at), COALESCE(sum(s.size_bytes), 0)::bigint
  FROM gateway_recipients r JOIN gateway_spool s ON s.id = r.spool_id
  WHERE r.state IN ('pending','queued','delivering','held') AND s.kind IN ('inbound','dsn','system') GROUP BY r.state
$$;

-- Security Center and setup: this tenant's queue as counts, for admins only.
CREATE FUNCTION app.gateway_tenant_queue() RETURNS TABLE(state text, count int, oldest_at timestamptz, bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.state, count(*)::int, min(s.received_at), COALESCE(sum(s.size_bytes), 0)::bigint
  FROM gateway_recipients r JOIN gateway_spool s ON s.id = r.spool_id
  WHERE r.tenant_id = app.tenant_id() AND app.gateway_is_admin() AND r.state IN ('pending','queued','delivering','held') AND s.kind IN ('inbound','dsn','system')
  GROUP BY r.state
$$;
CREATE FUNCTION app.gateway_hold_counts() RETURNS TABLE(state text, reason text, label text, count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT h.state, h.reason, h.label, count(*)::int FROM gateway_holds h
  WHERE h.tenant_id = app.tenant_id() AND app.gateway_is_admin() GROUP BY h.state, h.reason, h.label
$$;
CREATE FUNCTION app.gateway_process_health() RETURNS TABLE(instances int, last_seen_at timestamptz, limits jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int, max(b.last_seen_at), (SELECT b2.limits FROM gateway_heartbeats b2 ORDER BY b2.last_seen_at DESC LIMIT 1)
  FROM gateway_heartbeats b WHERE b.last_seen_at > now() - interval '5 minutes'
$$;

-- Hand the functions to the definer role. It needs CREATE on the schema only for the moment ownership changes.
GRANT aegis_gateway_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA public, app TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_is_admin() OWNER TO aegis_gateway_definer;
ALTER FUNCTION gateway_route_lookup(text) OWNER TO aegis_gateway_definer;
ALTER FUNCTION gateway_next_work(int) OWNER TO aegis_gateway_definer;
ALTER FUNCTION gateway_tenants() OWNER TO aegis_gateway_definer;
ALTER FUNCTION gateway_queue_summary() OWNER TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_tenant_queue() OWNER TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_hold_counts() OWNER TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_process_health() OWNER TO aegis_gateway_definer;
REVOKE CREATE ON SCHEMA public, app FROM aegis_gateway_definer;

REVOKE ALL ON FUNCTION app.gateway_is_admin(), gateway_route_lookup(text), gateway_next_work(int), gateway_tenants(), gateway_queue_summary(), app.gateway_tenant_queue(), app.gateway_hold_counts(), app.gateway_process_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_route_lookup(text), gateway_next_work(int), gateway_tenants(), gateway_queue_summary() TO aegis_gateway_conn;
GRANT EXECUTE ON FUNCTION app.gateway_is_admin(), app.gateway_tenant_queue(), app.gateway_hold_counts(), app.gateway_process_health() TO aegis_app;
GRANT EXECUTE ON FUNCTION app.gateway_is_admin() TO aegis_gateway_definer;
