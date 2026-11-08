-- What a session actually proved, ordering of billing state, and domains that stop being verified.
-- Grants to the per-process logins are explicit: see 003.

-- ===== Sessions =====
-- mfa_passed was written as true for every session, so it recorded nothing. From here on it means a second factor was presented
-- to this session. We can't tell which existing sessions earned it, so none keep it: operators sign in again once.
UPDATE sessions SET mfa_passed = false WHERE mfa_passed;

-- ===== Authenticator apps =====
-- The last 30-second step accepted, so a code works once. Reset with the secret.
ALTER TABLE users ADD COLUMN totp_last_step bigint;
-- Which session started an enrollment, and whether it typed the password to do so. Only the password counts toward the operator gate:
-- a recent sign-in is an age, and whoever stole that session has the same age.
ALTER TABLE users ADD COLUMN totp_pending_session uuid;
ALTER TABLE users ADD COLUMN totp_pending_password_proven boolean NOT NULL DEFAULT false;
-- Nothing can finish these: they have no session to match.
UPDATE users SET totp_pending_enc = NULL WHERE totp_pending_enc IS NOT NULL;

-- ===== Passkeys =====
-- Same distinction, for the same reason. Existing passkeys start false and earn trust through age. See PASSKEY_TRUST_HOURS.
ALTER TABLE passkeys ADD COLUMN added_with_password boolean NOT NULL DEFAULT false;

-- ===== Security notices =====
ALTER TABLE outbound_mail DROP CONSTRAINT outbound_mail_kind_check;
ALTER TABLE outbound_mail ADD CONSTRAINT outbound_mail_kind_check CHECK (kind IN ('verify_email','password_reset','invite','digest','security_notice'));

-- ===== Billing state =====
-- Goes up each time processor state is applied. A reader notes it before asking the processor and applies only if it hasn't moved,
-- so an answer that was slow to arrive can't overwrite one that committed while it was on its way.
ALTER TABLE subscriptions ADD COLUMN sync_version bigint NOT NULL DEFAULT 0;

-- ===== Domain verification lapses =====
-- A domain can change hands. txt_missing_since starts the grace period, and lapsing clears verified_at, so every check that trusts
-- the domain fails closed without knowing about any of this. lapsed_at is what tells that apart from a domain never verified.
ALTER TABLE verified_domains
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN txt_missing_since timestamptz,
  ADD COLUMN lapsed_at timestamptz;

-- Which tenants have something to re-check, as IDs. The check itself runs in that tenant's worker context.
CREATE FUNCTION scheduler_domain_tenants() RETURNS TABLE(tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT v.tenant_id FROM verified_domains v WHERE v.verified_at IS NOT NULL
$$;

-- One domain signs in through one tenant's provider, enforced by a unique index across tenants. That has to let go once the holder's
-- proof has lapsed, or a domain's new owner could never set up SSO. Only for a caller who has proven the domain themselves.
CREATE FUNCTION sso_release_lapsed_domain(p_domain text, p_tenant uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM verified_domains v WHERE v.tenant_id = p_tenant AND lower(v.domain) = lower(p_domain) AND v.verified_at IS NOT NULL) THEN RETURN 0; END IF;
  FOR r IN
    SELECT c.id, c.tenant_id FROM sso_configs c
    JOIN verified_domains v ON v.tenant_id = c.tenant_id AND lower(v.domain) = lower(c.domain)
    WHERE lower(c.domain) = lower(p_domain) AND c.tenant_id <> p_tenant AND v.verified_at IS NULL AND v.lapsed_at IS NOT NULL
  LOOP
    DELETE FROM identities WHERE provider LIKE 'sso:' || r.id || ':%' OR provider LIKE 'saml:' || r.id || ':%';
    DELETE FROM sso_configs WHERE id = r.id;
    INSERT INTO audit_events(tenant_id, event, target_type, target_id, meta) VALUES (r.tenant_id, 'sso.removed', 'sso_config', r.id::text, '{"reason":"domain_lapsed"}');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION scheduler_domain_tenants(), sso_release_lapsed_domain(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduler_domain_tenants() TO aegis_worker_conn;
GRANT EXECUTE ON FUNCTION sso_release_lapsed_domain(text, uuid) TO aegis_web_conn;
