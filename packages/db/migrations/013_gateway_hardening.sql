-- Experimental SMTP gateway: fixes from an independent review. See docs/gateway-design.md.
--
-- 1. Where mail goes is the owner's decision alone. Every change bumps a generation, pauses delivery until a self-test passes
--    against the new server, tells every admin, and leaves holds pinned to the generation they were held under.
-- 2. Delivery work is listed fairly across tenants, and bounces are listed apart, so one party's slow server can't fill the queue.
-- 3. Held mail has its own quota, so what gets held can't refuse clean mail.

-- ===== Where mail goes =====
ALTER TABLE gateway_domains
  ADD COLUMN downstream_generation int NOT NULL DEFAULT 1,
  ADD COLUMN downstream_changed_at timestamptz,
  ADD COLUMN delivery_paused_at timestamptz;

CREATE FUNCTION app.gateway_is_owner() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app.tenant_id() AND m.user_id = app.user_id() AND m.role = 'owner')
$$;

-- Holds the rule below the application: a web session that isn't the owner can't move mail, whichever code path it reaches.
-- The password check can't live here, so that part is in configureGatewayDomain.
CREATE OR REPLACE FUNCTION app.gateway_domain_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.downstream_host, NEW.downstream_port, NEW.tls_mode) IS DISTINCT FROM (OLD.downstream_host, OLD.downstream_port, OLD.tls_mode) THEN
    IF current_user = 'aegis_app' AND NOT app.gateway_is_owner() THEN
      RAISE EXCEPTION 'only the workspace owner can change where gateway mail is delivered' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.downstream_generation := OLD.downstream_generation + 1;
    NEW.downstream_changed_at := now();
    -- Replacing a server stops delivery. Naming the first one doesn't: nothing has been flowing, and setup runs the self-test anyway.
    IF OLD.downstream_host IS NOT NULL THEN NEW.delivery_paused_at := now(); END IF;
  END IF;
  IF (NEW.downstream_host, NEW.downstream_port, NEW.tls_mode, NEW.enabled) IS DISTINCT FROM (OLD.downstream_host, OLD.downstream_port, OLD.tls_mode, OLD.enabled) THEN
    NEW.selftest_passed_at := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP POLICY app_insert ON gateway_domains;
CREATE POLICY app_insert ON gateway_domains FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND app.gateway_is_admin() AND (downstream_host IS NULL OR app.gateway_is_owner()));

-- Only the gateway process can record that a self-test passed, so only it can lift the pause.
GRANT UPDATE (delivery_paused_at) ON gateway_domains TO aegis_gateway;

-- Every admin hears about it, from a trigger, so no code path can change the server and skip this. A reference only, no content.
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('held_message','account_reconnect','send_failed','reminder_due','followup_due','rule_matched','gateway_downstream_changed'));

GRANT INSERT ON notifications TO aegis_gateway_definer;
CREATE POLICY gateway_definer_notify ON notifications FOR INSERT TO aegis_gateway_definer WITH CHECK (true);

CREATE FUNCTION app.gateway_downstream_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.downstream_host IS NULL AND (TG_OP = 'INSERT' OR OLD.downstream_host IS NULL) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.downstream_generation = OLD.downstream_generation THEN RETURN NULL; END IF;
  INSERT INTO notifications(tenant_id, user_id, kind, severity, ref_id, dedupe_key, deliver_at)
    SELECT NEW.tenant_id, m.user_id, 'gateway_downstream_changed', 'critical', NEW.id, 'gateway-downstream:' || NEW.id || ':' || NEW.downstream_generation, now()
    FROM memberships m WHERE m.tenant_id = NEW.tenant_id AND m.role IN ('owner','security_admin','workspace_manager');
  RETURN NULL;
END $$;
CREATE TRIGGER gateway_domains_notify AFTER INSERT OR UPDATE ON gateway_domains FOR EACH ROW EXECUTE FUNCTION app.gateway_downstream_notify();

-- ===== Holds: which server they were held for, and where they came from =====
ALTER TABLE gateway_holds
  ADD COLUMN domain_id uuid REFERENCES gateway_domains ON DELETE CASCADE,
  ADD COLUMN pinned_generation int NOT NULL DEFAULT 1,
  ADD COLUMN source_hash text;
-- The tenant's own keyed hash of the sending address, so holds can be grouped by source without storing an IP.
ALTER TABLE gateway_spool
  ADD COLUMN held boolean NOT NULL DEFAULT false,
  ADD COLUMN source_hash text;

-- These tables are FORCE RLS and production has no superuser, so without this the owner's UPDATE would match no rows, silently.
ALTER TABLE gateway_holds NO FORCE ROW LEVEL SECURITY;
ALTER TABLE gateway_spool NO FORCE ROW LEVEL SECURITY;
UPDATE gateway_holds h SET domain_id = s.domain_id FROM gateway_spool s WHERE s.id = h.spool_id;
UPDATE gateway_spool s SET held = true
  WHERE s.raw_enc IS NOT NULL
    AND EXISTS (SELECT 1 FROM gateway_recipients r WHERE r.spool_id = s.id AND r.state = 'held')
    AND NOT EXISTS (SELECT 1 FROM gateway_recipients r WHERE r.spool_id = s.id AND r.state IN ('pending','queued','delivering'));
ALTER TABLE gateway_holds FORCE ROW LEVEL SECURITY;
ALTER TABLE gateway_spool FORCE ROW LEVEL SECURITY;

CREATE INDEX gateway_spool_tenant_held ON gateway_spool (tenant_id, held) WHERE raw_enc IS NOT NULL;
CREATE INDEX gateway_spool_source ON gateway_spool (tenant_id, source_hash) WHERE raw_enc IS NOT NULL AND held;

GRANT SELECT (domain_id, pinned_generation, source_hash) ON gateway_holds TO aegis_app;
-- Accepting a new server for one hold is the explicit decision, recorded with the release.
GRANT UPDATE (pinned_generation) ON gateway_holds TO aegis_app;

-- ===== Work listing =====
-- Each tenant's oldest item comes first, then each tenant's second, and so on, so one tenant's backlog can't fill the page.
-- p_skip_delivery names tenants already at their delivery limit, so a page isn't spent on work that can't start.
DROP FUNCTION gateway_next_work(int);
CREATE FUNCTION gateway_next_work(p_limit int, p_skip_delivery uuid[] DEFAULT '{}') RETURNS TABLE(tenant_id uuid, kind text, item_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  (SELECT x.tenant_id, 'scan'::text, x.id FROM (
     SELECT s.tenant_id, s.id, s.received_at AS due, row_number() OVER (PARTITION BY s.tenant_id ORDER BY s.received_at) AS rn FROM gateway_spool s
     WHERE s.state = 'received' OR (s.state = 'scanning' AND s.scan_lease_until < now())
   ) x ORDER BY x.rn, x.due LIMIT p_limit)
  UNION ALL
  -- A paused domain delivers nothing except the self-test that can lift the pause.
  (SELECT x.tenant_id, 'deliver'::text, x.spool_id FROM (
     SELECT r.tenant_id, r.spool_id, min(r.next_attempt_at) AS due, row_number() OVER (PARTITION BY r.tenant_id ORDER BY min(r.next_attempt_at)) AS rn
     FROM gateway_recipients r JOIN gateway_spool s ON s.id = r.spool_id JOIN gateway_domains g ON g.id = s.domain_id
     WHERE ((r.state = 'queued' AND r.next_attempt_at <= now()) OR (r.state = 'delivering' AND r.lease_until < now()))
       AND s.kind <> 'dsn' AND (g.delivery_paused_at IS NULL OR s.kind = 'selftest_clean') AND NOT (r.tenant_id = ANY(p_skip_delivery))
     GROUP BY r.tenant_id, r.spool_id
   ) x ORDER BY x.rn, x.due LIMIT p_limit)
  UNION ALL
  -- Bounces go to the sender's server, which an outsider chooses, so they're listed apart and get their own capacity.
  (SELECT x.tenant_id, 'bounce'::text, x.spool_id FROM (
     SELECT r.tenant_id, r.spool_id, min(r.next_attempt_at) AS due, row_number() OVER (PARTITION BY r.tenant_id ORDER BY min(r.next_attempt_at)) AS rn
     FROM gateway_recipients r JOIN gateway_spool s ON s.id = r.spool_id
     WHERE ((r.state = 'queued' AND r.next_attempt_at <= now()) OR (r.state = 'delivering' AND r.lease_until < now())) AND s.kind = 'dsn'
     GROUP BY r.tenant_id, r.spool_id
   ) x ORDER BY x.rn, x.due LIMIT p_limit)
  UNION ALL
  (SELECT x.tenant_id, 'decision'::text, x.id FROM (
     SELECT h.tenant_id, h.id, h.decided_at AS due, row_number() OVER (PARTITION BY h.tenant_id ORDER BY h.decided_at) AS rn FROM gateway_holds h
     WHERE h.applied_at IS NULL AND h.state IN ('released','deleted')
   ) x ORDER BY x.rn, x.due LIMIT p_limit)
  UNION ALL
  (SELECT t.tenant_id, 'selftest'::text, t.id FROM gateway_selftests t WHERE t.state = 'pending' ORDER BY t.created_at LIMIT p_limit)
  UNION ALL
  (SELECT c.tenant_id, 'claim'::text, c.id FROM gateway_address_claims c WHERE c.state = 'pending' ORDER BY c.created_at LIMIT p_limit)
$$;

-- What held mail is using, for this tenant's admins. Counts only.
CREATE FUNCTION app.gateway_hold_usage() RETURNS TABLE(messages int, bytes bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int, COALESCE(sum(s.size_bytes), 0)::bigint FROM gateway_spool s
  WHERE s.tenant_id = app.tenant_id() AND app.gateway_is_admin() AND s.raw_enc IS NOT NULL AND s.held
$$;

-- ===== Ownership and grants, the same way as 006 =====
GRANT aegis_gateway_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA public, app TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_is_owner() OWNER TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_downstream_notify() OWNER TO aegis_gateway_definer;
ALTER FUNCTION gateway_next_work(int, uuid[]) OWNER TO aegis_gateway_definer;
ALTER FUNCTION app.gateway_hold_usage() OWNER TO aegis_gateway_definer;
REVOKE CREATE ON SCHEMA public, app FROM aegis_gateway_definer;

REVOKE ALL ON FUNCTION app.gateway_is_owner(), app.gateway_downstream_notify(), gateway_next_work(int, uuid[]), app.gateway_hold_usage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_next_work(int, uuid[]) TO aegis_gateway_conn;
GRANT EXECUTE ON FUNCTION app.gateway_is_owner(), app.gateway_hold_usage() TO aegis_app;
GRANT EXECUTE ON FUNCTION app.gateway_is_owner() TO aegis_gateway_definer;
