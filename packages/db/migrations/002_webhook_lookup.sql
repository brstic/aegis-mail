-- Webhooks arrive with no tenant context. These narrow definer functions answer exactly one question
-- each, so webhook handling never needs broad access to mail tables. No content is returned.
CREATE FUNCTION webhook_account_lookup(p_kind text, p_email text) RETURNS TABLE(id uuid, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.tenant_id FROM mail_accounts a WHERE a.kind = p_kind AND a.email = p_email AND a.status = 'active'
$$;
CREATE FUNCTION webhook_subscription_lookup(p_external text) RETURNS TABLE(account_id uuid, tenant_id uuid, client_state_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.account_id, s.tenant_id, s.client_state_hash FROM provider_subscriptions s WHERE s.external_id = p_external
$$;
-- Account scheduling for the tick job; IDs and status only.
CREATE FUNCTION scheduler_accounts() RETURNS TABLE(id uuid, tenant_id uuid, kind text, status text, last_attempt_at timestamptz, push_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.tenant_id, a.kind, a.status, s.last_attempt_at, p.expires_at
  FROM mail_accounts a LEFT JOIN sync_states s ON s.account_id = a.id LEFT JOIN provider_subscriptions p ON p.account_id = a.id
  WHERE a.status = 'active'
$$;
