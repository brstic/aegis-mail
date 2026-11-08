-- The deletion log. A restore brings erased data back, so each durable erasure leaves an entry that outlives the database.
-- A row is written in the same transaction as the erasure, and a worker job ships it to a sink outside the database.
-- Ids, a kind and a time. There's no foreign key on purpose: the row has to outlive what it names.
CREATE TABLE deletion_outbox (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('account','tenant_shred','mailbox','credential','message_sealed','message_purged','search_off','vectors_off')),
  tenant_id uuid,
  user_id uuid,
  account_id uuid,
  message_id uuid,
  erased_at timestamptz NOT NULL DEFAULT now(),
  -- Where the sink put it. A restored database still holds these, which makes it a witness to what the log must contain.
  shipped_at timestamptz,
  sink_seq bigint,
  sink_hash text,
  CHECK (kind = 'account' OR tenant_id IS NOT NULL),
  CHECK (kind <> 'account' OR user_id IS NOT NULL),
  CHECK (kind NOT IN ('mailbox','credential') OR account_id IS NOT NULL),
  CHECK (kind NOT IN ('message_sealed','message_purged') OR message_id IS NOT NULL),
  CHECK (kind NOT IN ('search_off','vectors_off') OR user_id IS NOT NULL)
);
CREATE INDEX deletion_outbox_unshipped ON deletion_outbox (erased_at, id) WHERE shipped_at IS NULL;
CREATE INDEX deletion_outbox_seq ON deletion_outbox (sink_seq) WHERE sink_seq IS NOT NULL;

ALTER TABLE deletion_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_outbox FORCE ROW LEVEL SECURITY;

-- Contexts append and never read. A request context can only record what its own user can erase.
CREATE POLICY app_append ON deletion_outbox FOR INSERT TO aegis_app WITH CHECK (
  tenant_id = app.tenant_id() AND (
    (kind IN ('mailbox','message_sealed') AND app.owns_account(account_id))
    OR (kind IN ('search_off','vectors_off') AND user_id = app.user_id())
  ));
CREATE POLICY worker_append ON deletion_outbox FOR INSERT TO aegis_worker WITH CHECK (tenant_id = app.tenant_id());
GRANT INSERT ON deletion_outbox TO aegis_app, aegis_worker;

-- Deleting an account runs on the web login's system surface, and belongs to no one tenant.
CREATE POLICY web_conn_append ON deletion_outbox FOR INSERT TO aegis_web_conn WITH CHECK (kind = 'account');
GRANT INSERT ON deletion_outbox TO aegis_web_conn;

-- Shipping crosses tenants, like the queue itself: the log is one chain. It only moves ids.
CREATE POLICY worker_conn_ship ON deletion_outbox TO aegis_worker_conn USING (true) WITH CHECK (true);
GRANT SELECT, DELETE ON deletion_outbox TO aegis_worker_conn;
GRANT UPDATE (shipped_at, sink_seq, sink_hash) ON deletion_outbox TO aegis_worker_conn;

-- The restore operator's login, for `pnpm restore:reapply`. It becomes the worker context for tenant data, and gets just enough
-- identity surface to scrub a deleted user. It can't become aegis_app, and can't read a password hash or a TOTP secret.
-- It holds no KMS access, so it can delete mail without being able to read it. Create a login with: IN ROLE aegis_restore_conn.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_restore_conn') THEN CREATE ROLE aegis_restore_conn NOLOGIN; END IF;
END $$;
GRANT aegis_worker TO aegis_restore_conn WITH INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA app, public TO aegis_restore_conn;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO aegis_restore_conn;

GRANT SELECT (id, deleted_at) ON users TO aegis_restore_conn;
GRANT UPDATE (deleted_at, email, name, password_hash, totp_secret_enc, totp_pending_enc, totp_enabled, totp_recovery_hashes, totp_last_step) ON users TO aegis_restore_conn;
GRANT SELECT (user_id) ON passkeys, identities, email_tokens, scim_users TO aegis_restore_conn;
GRANT SELECT (user_id, revoked_at) ON sessions TO aegis_restore_conn;
GRANT UPDATE (revoked_at) ON sessions TO aegis_restore_conn;
GRANT DELETE ON passkeys, identities, email_tokens, scim_users TO aegis_restore_conn;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO aegis_restore_conn;
GRANT SELECT, DELETE ON memberships TO aegis_restore_conn;
GRANT SELECT (id, kind) ON organizations TO aegis_restore_conn;
GRANT INSERT ON audit_events TO aegis_restore_conn;
GRANT SELECT, INSERT, UPDATE ON jobs TO aegis_restore_conn;
GRANT SELECT ON deletion_outbox TO aegis_restore_conn;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','memberships','organizations','user_preferences','scim_users','audit_events','jobs','deletion_outbox']
  LOOP
    EXECUTE format('CREATE POLICY restore_conn ON %I TO aegis_restore_conn USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
