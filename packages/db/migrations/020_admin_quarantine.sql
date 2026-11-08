-- Blocked mail in an organization is the admins' to handle. Members never see it. These two functions let an owner or
-- security admin list and decide on held mail across every mailbox in the workspace, without reading it: they return
-- only which mailbox, when, the rating and the content-free reason codes. No subject, sender, body or attachment.

CREATE FUNCTION app.org_quarantine() RETURNS TABLE(
  message_id uuid, account_id uuid, mailbox text, owner_name text, received timestamptz, risk_label text,
  categories text[], state text, held_since timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.message_id, q.account_id, a.email, u.name, m.internal_date, m.risk_label,
         COALESCE((SELECT s.categories FROM security_analyses s WHERE s.message_id = q.message_id ORDER BY s.created_at DESC LIMIT 1), '{}'),
         q.state, q.created_at
  FROM quarantine_items q
  JOIN messages m ON m.id = q.message_id
  JOIN mail_accounts a ON a.id = q.account_id
  LEFT JOIN users u ON u.id = a.owner_user_id
  WHERE q.tenant_id = app.tenant_id() AND app.has_role('owner','security_admin') AND q.state IN ('held','pending_approval')
  ORDER BY q.created_at DESC
  LIMIT 500
$$;
REVOKE ALL ON FUNCTION app.org_quarantine() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.org_quarantine() TO aegis_app;

-- Releases or deletes one held message. Returns what the caller needs to tell the provider and write the audit event.
CREATE FUNCTION app.org_quarantine_decide(p_message uuid, p_decision text) RETURNS TABLE(account_id uuid, restored_to text, read_only boolean, risk_label text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record;
BEGIN
  IF NOT app.has_role('owner','security_admin') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('release','delete') THEN RAISE EXCEPTION 'bad decision' USING ERRCODE = '22023'; END IF;
  SELECT q.account_id, q.original_folder_role, q.state, a.read_only, m.risk_label INTO r
    FROM quarantine_items q JOIN messages m ON m.id = q.message_id JOIN mail_accounts a ON a.id = q.account_id
    WHERE q.message_id = p_message AND q.tenant_id = app.tenant_id() FOR UPDATE OF q;
  IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
  IF r.state NOT IN ('held','pending_approval') THEN RAISE EXCEPTION 'already decided' USING ERRCODE = '55000'; END IF;
  UPDATE quarantine_items SET state = CASE WHEN p_decision = 'release' THEN 'released' ELSE 'deleted' END, decided_by = app.user_id(), decided_at = now()
    WHERE quarantine_items.message_id = p_message;
  UPDATE messages SET held = false, folder_role = CASE WHEN p_decision = 'release' THEN r.original_folder_role ELSE 'trash' END, updated_at = now()
    WHERE messages.id = p_message;
  RETURN QUERY SELECT r.account_id, CASE WHEN p_decision = 'release' THEN r.original_folder_role ELSE 'trash' END, r.read_only, r.risk_label;
END $$;
REVOKE ALL ON FUNCTION app.org_quarantine_decide(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.org_quarantine_decide(uuid, text) TO aegis_app;
