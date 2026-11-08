-- Enrollment no longer touches the active factor: the new secret waits here until a code proves it works.
ALTER TABLE users ADD COLUMN totp_pending_enc bytea;

-- Mailbox counts by status for the Security Center. Counts only: no addresses, owners, or IDs. Admin roles only.
CREATE FUNCTION app.mailbox_coverage() RETURNS TABLE(status text, count int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.status, count(*)::int FROM mail_accounts a
  WHERE a.tenant_id = app.tenant_id() AND app.has_role('owner','security_admin') AND a.status <> 'disconnected'
  GROUP BY a.status
$$;
REVOKE ALL ON FUNCTION app.mailbox_coverage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mailbox_coverage() TO aegis_app;
