-- Identity and communication: address verification, password reset, transactional mail, OIDC SSO, social sign-in,
-- SCIM provisioning and notifications. Grants to the per-process logins are explicit: see 003.

-- ===== Address verification =====
-- NULL means the person has never proved they control this address. Existing accounts start unverified, because they are.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
GRANT SELECT (email_verified_at) ON users TO aegis_app, aegis_worker;
-- The seeded demo users have synthetic addresses on a reserved domain that can't receive mail.
UPDATE users SET email_verified_at = now() WHERE lower(email) LIKE '%@demo.aegis.example';

-- Single-use links for verification and password reset. Only the hash is stored.
CREATE TABLE email_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email','password_reset')),
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);
GRANT SELECT, INSERT, UPDATE, DELETE ON email_tokens TO aegis_web_conn;
GRANT SELECT, DELETE ON email_tokens TO aegis_worker_conn;

-- ===== Transactional mail queue =====
-- Rendered mail can hold a one-time link, so it's sealed, read only by the worker, and wiped as soon as it's handed over.
-- Jobs carry only this row's id. There's no tenant column: reset mail can go to someone with no workspace.
CREATE TABLE outbound_mail (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('verify_email','password_reset','invite','digest')),
  content_enc bytea,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','failed')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT INSERT ON outbound_mail TO aegis_web_conn;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbound_mail TO aegis_worker_conn;

-- What the dev mailer "sent". Sealed as well. The page that reads it exists only when DEMO_MODE=true.
CREATE TABLE dev_outbox (
  id uuid PRIMARY KEY,
  content_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON dev_outbox TO aegis_web_conn;
GRANT INSERT, DELETE, SELECT ON dev_outbox TO aegis_worker_conn;

-- ===== Tenant SSO =====
CREATE TABLE sso_configs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  domain text NOT NULL,
  protocol text NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc','saml')),
  -- The OIDC issuer URL, or the SAML identity provider's entity ID.
  issuer text NOT NULL,
  client_id text,
  client_secret_enc bytea,
  saml_entry_point text,
  saml_idp_cert text,
  enabled boolean NOT NULL DEFAULT true,
  enforced boolean NOT NULL DEFAULT false,
  jit_enabled boolean NOT NULL DEFAULT true,
  jit_role text NOT NULL DEFAULT 'member' CHECK (jit_role IN ('member','workspace_manager','billing_manager','security_admin')),
  last_success_at timestamptz,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, domain),
  CHECK ((protocol = 'oidc' AND client_id IS NOT NULL AND client_secret_enc IS NOT NULL) OR (protocol = 'saml' AND saml_entry_point IS NOT NULL AND saml_idp_cert IS NOT NULL))
);
-- A domain signs in through one tenant's identity provider only.
CREATE UNIQUE INDEX sso_configs_domain_uq ON sso_configs (lower(domain));
ALTER TABLE sso_configs ENABLE ROW LEVEL SECURITY; ALTER TABLE sso_configs FORCE ROW LEVEL SECURITY;
-- Owner only. Whoever controls the identity provider can sign in as anyone on the domain, so a lesser role must not hold this.
CREATE POLICY owner_manage ON sso_configs TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner')) WITH CHECK (tenant_id = app.tenant_id() AND app.has_role('owner'));
CREATE POLICY worker_tenant ON sso_configs TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON sso_configs TO aegis_app;
GRANT SELECT, DELETE ON sso_configs TO aegis_worker;

-- Sign-in attempts in flight. The verifier and nonce are sealed under a key derived from a cookie held by the browser that
-- started the attempt, so the database alone can't complete one and neither can someone with only the callback URL.
CREATE TABLE sso_flows (
  state_hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('tenant','google','microsoft','saml')),
  config_id uuid REFERENCES sso_configs ON DELETE CASCADE,
  secret_enc bytea NOT NULL,
  next text,
  expires_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON sso_flows TO aegis_web_conn;
GRANT SELECT, DELETE ON sso_flows TO aegis_worker_conn;

-- ===== SCIM =====
CREATE TABLE scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE scim_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_manage ON scim_tokens TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner')) WITH CHECK (tenant_id = app.tenant_id() AND app.has_role('owner'));
CREATE POLICY worker_tenant ON scim_tokens TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE ON scim_tokens TO aegis_app;
GRANT SELECT, DELETE ON scim_tokens TO aegis_worker;

-- Who the identity provider manages here, including people it has switched off, whose membership is gone.
CREATE TABLE scim_users (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  external_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE scim_users ENABLE ROW LEVEL SECURITY; ALTER TABLE scim_users FORCE ROW LEVEL SECURITY;
-- SCIM authenticates by token, before any request context exists. Every query in scim.ts filters by the token's tenant.
CREATE POLICY web_conn ON scim_users TO aegis_web_conn USING (true) WITH CHECK (true);
CREATE POLICY owner_read ON scim_users FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner'));
CREATE POLICY worker_tenant ON scim_users TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_users TO aegis_web_conn;
GRANT SELECT ON scim_users TO aegis_app;
GRANT SELECT, DELETE ON scim_users TO aegis_worker;
-- Deprovisioning removes the person's pending invitations, as removeMember does.
GRANT DELETE ON invitations TO aegis_web_conn;

-- ===== Notifications =====
-- References only. Titles come from the kind when the owner reads them, so a row holds no message content.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('held_message','account_reconnect','send_failed','reminder_due','followup_due')),
  severity text NOT NULL DEFAULT 'normal' CHECK (severity IN ('normal','critical')),
  ref_id uuid,
  dedupe_key text NOT NULL,
  deliver_at timestamptz NOT NULL,
  read_at timestamptz,
  digested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, dedupe_key)
);
CREATE INDEX notifications_inbox ON notifications (tenant_id, user_id, deliver_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY; ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
-- The person it's for, and nobody else. Admin roles get no row.
CREATE POLICY own_read ON notifications FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id());
CREATE POLICY own_update ON notifications FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());
CREATE POLICY own_delete ON notifications FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id());
CREATE POLICY worker_tenant ON notifications TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, DELETE ON notifications TO aegis_app;
GRANT UPDATE (read_at) ON notifications TO aegis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO aegis_worker;

CREATE TABLE notification_digests (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  last_sent_on date NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE notification_digests ENABLE ROW LEVEL SECURITY; ALTER TABLE notification_digests FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_tenant ON notification_digests TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE ON notification_digests TO aegis_worker;

-- ===== Narrow pre-authentication lookups =====
-- Same pattern as 002: each answers one question, for the web login only. None returns anything about a person.
CREATE FUNCTION sso_discover(p_domain text) RETURNS TABLE(config_id uuid, tenant_id uuid, enforced boolean, protocol text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.tenant_id, c.enforced, c.protocol FROM sso_configs c
  JOIN verified_domains v ON v.tenant_id = c.tenant_id AND lower(v.domain) = lower(c.domain) AND v.verified_at IS NOT NULL
  WHERE lower(c.domain) = lower(p_domain) AND c.enabled
$$;
-- The sealed client secret goes to the web process, which opens it through the tenant's key to reach the token endpoint.
CREATE FUNCTION sso_flow_config(p_id uuid) RETURNS TABLE(tenant_id uuid, domain text, protocol text, issuer text, client_id text, client_secret_enc bytea, saml_entry_point text, saml_idp_cert text, jit_enabled boolean, jit_role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.tenant_id, c.domain, c.protocol, c.issuer, c.client_id, c.client_secret_enc, c.saml_entry_point, c.saml_idp_cert, c.jit_enabled, c.jit_role FROM sso_configs c
  JOIN verified_domains v ON v.tenant_id = c.tenant_id AND lower(v.domain) = lower(c.domain) AND v.verified_at IS NOT NULL
  WHERE c.id = p_id AND c.enabled
$$;
CREATE FUNCTION sso_mark_success(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE sso_configs SET last_success_at = now() WHERE id = p_id
$$;
CREATE FUNCTION sso_any_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM sso_configs c JOIN verified_domains v ON v.tenant_id = c.tenant_id AND lower(v.domain) = lower(c.domain) AND v.verified_at IS NOT NULL WHERE c.enabled)
$$;
CREATE FUNCTION tenant_domain_verified(p_tenant uuid, p_domain text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM verified_domains v WHERE v.tenant_id = p_tenant AND lower(v.domain) = lower(p_domain) AND v.verified_at IS NOT NULL)
$$;
-- Default role for people the identity provider creates. No secret, no address.
CREATE FUNCTION tenant_scim_default_role(p_tenant uuid, p_domain text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.jit_role FROM sso_configs c WHERE c.tenant_id = p_tenant AND lower(c.domain) = lower(p_domain)
$$;
CREATE FUNCTION scim_token_lookup(p_hash text) RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE scim_tokens s SET last_used_at = now() WHERE s.token_hash = p_hash AND s.revoked_at IS NULL RETURNING s.id, s.tenant_id
$$;
-- Which tenants have mailboxes to raise notifications about. Unlike scheduler_accounts this includes broken ones.
CREATE FUNCTION scheduler_notification_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT a.tenant_id FROM mail_accounts a WHERE a.status <> 'disconnected'
$$;
REVOKE ALL ON FUNCTION sso_discover(text), sso_flow_config(uuid), sso_mark_success(uuid), sso_any_enabled(), tenant_domain_verified(uuid, text), tenant_scim_default_role(uuid, text), scim_token_lookup(text), scheduler_notification_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sso_discover(text), sso_flow_config(uuid), sso_mark_success(uuid), sso_any_enabled(), tenant_domain_verified(uuid, text), tenant_scim_default_role(uuid, text), scim_token_lookup(text) TO aegis_web_conn;
GRANT EXECUTE ON FUNCTION scheduler_notification_tenants() TO aegis_worker_conn;
