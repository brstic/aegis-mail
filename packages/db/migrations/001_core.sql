-- Aegis Mail core schema. Ownership: every mail row belongs to a tenant AND a mailbox.
-- Tenant admins get NO row access to mail tables. See docs/adr 0002.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_app') THEN CREATE ROLE aegis_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aegis_worker') THEN CREATE ROLE aegis_worker NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app, public TO aegis_app, aegis_worker;

CREATE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app.tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ===== Identity (pre-auth; accessed through withSystem) =====
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  totp_secret_enc bytea,
  totp_enabled boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL;

-- Federated product sign-in. Distinct from mailbox authorization (oauth_grants).
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  active_tenant_id uuid,
  user_agent_summary text,
  mfa_passed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users ON DELETE CASCADE,
  purpose text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count int NOT NULL,
  window_start timestamptz NOT NULL
);

-- ===== Tenancy =====
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('personal','organization')),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  privacy_mode text NOT NULL DEFAULT 'managed' CHECK (privacy_mode IN ('managed','client_sealed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','billing_manager','security_admin','workspace_manager','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users,
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verified_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  domain text NOT NULL,
  verification_token text NOT NULL,
  verified_at timestamptz,
  UNIQUE (tenant_id, domain)
);

CREATE TABLE tenant_policies (
  tenant_id uuid PRIMARY KEY REFERENCES organizations ON DELETE CASCADE,
  policy jsonb NOT NULL DEFAULT '{}',
  retention_days int,
  updated_by uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_keys (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  key_class text NOT NULL CHECK (key_class IN ('body','credential','index','metadata')),
  version int NOT NULL,
  wrapped bytea NOT NULL,
  kms_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_class, version)
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  purpose text NOT NULL,
  granted boolean NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Mailboxes =====
CREATE TABLE mail_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('gmail','microsoft','imap','pop3','demo')),
  email text NOT NULL,
  display_name text NOT NULL,
  color text NOT NULL DEFAULT '#3d7a68',
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'connecting' CHECK (status IN ('connecting','active','paused','reconnect_required','disconnected','error')),
  status_detail text,
  read_only boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_user_id, kind, email)
);
CREATE INDEX mail_accounts_tenant ON mail_accounts (tenant_id);

-- Explicit delegation. Absence of a row means no access. Admin role never implies a row.
CREATE TABLE mailbox_grants (
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  grantee_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  granted_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, grantee_user_id)
);

CREATE TABLE credential_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL UNIQUE REFERENCES mail_accounts ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('oauth','password','demo')),
  blob bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_grants (
  account_id uuid PRIMARY KEY REFERENCES mail_accounts ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  provider text NOT NULL,
  scopes text[] NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

-- PKCE and state for mailbox authorization.
CREATE TABLE oauth_flows (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  provider text NOT NULL,
  verifier_enc bytea NOT NULL,
  read_only boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL
);

CREATE TABLE provider_subscriptions (
  account_id uuid PRIMARY KEY REFERENCES mail_accounts ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  external_id text,
  client_state_hash text,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_subscriptions_external ON provider_subscriptions (external_id);

CREATE TABLE sync_states (
  account_id uuid PRIMARY KEY REFERENCES mail_accounts ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  cursor_enc bytea,
  phase text NOT NULL DEFAULT 'initial' CHECK (phase IN ('initial','incremental','reconciling')),
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  consecutive_failures int NOT NULL DEFAULT 0,
  messages_synced int NOT NULL DEFAULT 0
);

-- Idempotency ledger: one row per provider event applied.
CREATE TABLE sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  event_key text NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, event_key)
);

-- ===== Mail =====
CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  provider_thread_id text,
  subject_hash text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  message_count int NOT NULL DEFAULT 0,
  last_from_me boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX threads_provider ON threads (account_id, provider_thread_id) WHERE provider_thread_id IS NOT NULL;
CREATE INDEX threads_account_recent ON threads (account_id, last_message_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  thread_id uuid REFERENCES threads ON DELETE SET NULL,
  provider_message_id text NOT NULL,
  ingestion_version int NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'discovered' CHECK (state IN ('discovered','normalized','scanned','classified','failed')),
  internal_date timestamptz NOT NULL,
  folder_role text NOT NULL DEFAULT 'inbox',
  is_read boolean NOT NULL DEFAULT false,
  is_starred boolean NOT NULL DEFAULT false,
  from_me boolean NOT NULL DEFAULT false,
  has_attachments boolean NOT NULL DEFAULT false,
  size_bytes int NOT NULL DEFAULT 0,
  sender_hash text,
  sender_domain_hash text,
  message_id_hash text,
  envelope_enc bytea,
  risk_label text,
  policy_action text,
  priority_score real,
  priority_section text,
  held boolean NOT NULL DEFAULT false,
  failure_code text,
  tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider_message_id)
);
CREATE INDEX messages_thread ON messages (thread_id, internal_date DESC);
CREATE INDEX messages_folder ON messages (account_id, folder_role, internal_date DESC) WHERE tombstoned_at IS NULL;
CREATE INDEX messages_sender ON messages (account_id, sender_hash);
CREATE INDEX messages_msgid ON messages (account_id, message_id_hash);

-- Body storage is segregated from metadata and may be purged independently.
CREATE TABLE message_contents (
  message_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  blob_enc bytea,
  sealed_blob bytea,
  sealed_meta jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Plaintext lexemes: disclosed in Privacy Center; per-user opt-out deletes these rows.
CREATE TABLE message_search (
  message_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  tsv tsvector NOT NULL
);
CREATE INDEX message_search_tsv ON message_search USING gin (tsv);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  sha256 text NOT NULL,
  size_bytes int NOT NULL,
  scan_status text NOT NULL,
  meta_enc bytea NOT NULL,
  blob_enc bytea
);
CREATE INDEX attachments_message ON attachments (message_id);

CREATE TABLE mail_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  remote_id text,
  name text NOT NULL,
  color text,
  UNIQUE (account_id, name)
);

CREATE TABLE message_labels (
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES mail_labels ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
);

CREATE TABLE mail_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  remote_id text NOT NULL,
  name text NOT NULL,
  role text NOT NULL,
  UNIQUE (account_id, remote_id)
);

-- ===== Security =====
CREATE TABLE security_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  engine_version text NOT NULL,
  threat_probability real NOT NULL,
  severity text NOT NULL,
  evidence_completeness real NOT NULL,
  label text NOT NULL,
  action text NOT NULL,
  reason_codes text[] NOT NULL,
  categories text[] NOT NULL,
  provenance text[] NOT NULL,
  detail_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, engine_version)
);

CREATE TABLE quarantine_items (
  message_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','released','deleted','pending_approval')),
  original_folder_role text NOT NULL,
  provider_moved boolean NOT NULL DEFAULT false,
  decided_by uuid REFERENCES users,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Aggregate, content-free. The only security table visible to security admins.
CREATE TABLE security_telemetry_daily (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  day date NOT NULL,
  label text NOT NULL,
  category text NOT NULL DEFAULT '-',
  action text NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, label, category, action)
);

CREATE TABLE security_reports_daily (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  day date NOT NULL,
  kind text NOT NULL,
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, kind)
);

CREATE TABLE user_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id, kind)
);

-- ===== Relationship graph (per mailbox owner) =====
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  sender_hash text NOT NULL,
  domain_hash text,
  identity_enc bytea,
  received_count int NOT NULL DEFAULT 0,
  sent_to_count int NOT NULL DEFAULT 0,
  replied_count int NOT NULL DEFAULT 0,
  dismissed_count int NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  is_vip boolean NOT NULL DEFAULT false,
  is_ignored boolean NOT NULL DEFAULT false,
  UNIQUE (account_id, sender_hash)
);
CREATE INDEX contacts_domain ON contacts (account_id, domain_hash);

-- ===== AI =====
CREATE TABLE priority_decisions (
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  version text NOT NULL,
  score real NOT NULL,
  section text NOT NULL,
  detail_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, version)
);

CREATE TABLE ai_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  thread_id uuid REFERENCES threads ON DELETE CASCADE,
  kind text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  blob_enc bytea NOT NULL,
  message_count_at int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ai_artifacts_thread_kind ON ai_artifacts (thread_id, kind);

-- Cost and latency only: no prompts, no completions.
CREATE TABLE ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid REFERENCES users ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  purpose text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  latency_ms int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  thread_id uuid REFERENCES threads ON DELETE SET NULL,
  message_id uuid REFERENCES messages ON DELETE SET NULL,
  blob_enc bytea NOT NULL,
  source text NOT NULL DEFAULT 'extracted',
  dedupe_key text,
  due_at timestamptz,
  due_uncertain boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dismissed')),
  remind_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, dedupe_key)
);

-- ===== Compose / send =====
CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  thread_id uuid REFERENCES threads ON DELETE SET NULL,
  blob_enc bytea NOT NULL,
  ai_generated boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'editing' CHECK (state IN ('editing','scheduled','sending','sent','failed','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The durable send ledger. A send must have an approval row made by a human session.
CREATE TABLE send_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES drafts ON DELETE CASCADE,
  approved_by uuid NOT NULL REFERENCES users,
  session_id uuid,
  idempotency_key text NOT NULL,
  rfc_message_id text NOT NULL,
  expected_from text NOT NULL,
  state text NOT NULL DEFAULT 'authorized' CHECK (state IN ('authorized','sending','completed','failed','unknown')),
  attempts int NOT NULL DEFAULT 0,
  remote_id text,
  error_code text,
  scheduled_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (account_id, idempotency_key)
);

-- ===== Automations =====
CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL,
  definition jsonb NOT NULL,
  risk_class text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  hourly_budget int NOT NULL DEFAULT 200,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid REFERENCES mail_accounts ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES automations ON DELETE CASCADE,
  message_id uuid REFERENCES messages ON DELETE SET NULL,
  outcome text NOT NULL,
  actions text[] NOT NULL DEFAULT '{}',
  dry_run boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automation_id, message_id, dry_run)
);

CREATE TABLE proposed_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  message_id uuid REFERENCES messages ON DELETE CASCADE,
  automation_id uuid REFERENCES automations ON DELETE CASCADE,
  action text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Incident sharing: user-initiated, time-limited, revocable, logged =====
CREATE TABLE incident_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  shared_by uuid NOT NULL REFERENCES users,
  analyst_user_id uuid NOT NULL REFERENCES users,
  redacted boolean NOT NULL DEFAULT true,
  snapshot_enc bytea NOT NULL,
  note text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Audit: content-free =====
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  actor_user_id uuid,
  event text NOT NULL,
  target_type text,
  target_id text,
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_tenant ON audit_events (tenant_id, created_at DESC);

-- ===== Billing =====
CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES organizations ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'active',
  provider text NOT NULL DEFAULT 'none',
  external_id text,
  seats int NOT NULL DEFAULT 1,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE usage_counters (
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  period text NOT NULL,
  metric text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period, metric)
);
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  external_id text,
  amount_cents int,
  currency text,
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Jobs: IDs only, never content =====
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','dead','cancelled')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 8,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error_code text,
  trace_id text NOT NULL DEFAULT encode(gen_random_bytes(8), 'hex'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
CREATE INDEX jobs_ready ON jobs (run_at) WHERE state = 'queued';

-- Synthetic server-side mailbox for DEMO_MODE. Contains only generated fixtures.
CREATE TABLE demo_mailbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  seq bigserial,
  remote_id text NOT NULL,
  remote_thread_id text,
  internal_date timestamptz NOT NULL,
  raw bytea NOT NULL,
  folder_role text NOT NULL DEFAULT 'inbox',
  is_read boolean NOT NULL DEFAULT false,
  is_starred boolean NOT NULL DEFAULT false,
  labels text[] NOT NULL DEFAULT '{}',
  deleted boolean NOT NULL DEFAULT false,
  UNIQUE (account_id, remote_id)
);

-- ===== Access predicates =====
-- SECURITY DEFINER so policies can consult ownership without granting broad table access.
CREATE FUNCTION app.can_access_account(acct uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM mail_accounts a WHERE a.id = acct AND a.tenant_id = app.tenant_id() AND a.owner_user_id = app.user_id())
      OR EXISTS (SELECT 1 FROM mailbox_grants g WHERE g.account_id = acct AND g.tenant_id = app.tenant_id() AND g.grantee_user_id = app.user_id())
$$;

CREATE FUNCTION app.has_role(VARIADIC roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app.tenant_id() AND m.user_id = app.user_id() AND m.role = ANY (roles))
$$;

-- Tables keyed by mailbox: owner/grantee only for aegis_app; single tenant for aegis_worker.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['threads','messages','message_contents','message_search','attachments','mail_labels','message_labels','mail_folders',
    'security_analyses','quarantine_items','user_feedback','contacts','priority_decisions','ai_artifacts','tasks','drafts','send_approvals','sync_states','sync_events',
    'proposed_actions','demo_mailbox','oauth_grants','provider_subscriptions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY app_mailbox ON %I TO aegis_app USING (tenant_id = app.tenant_id() AND app.can_access_account(account_id)) WITH CHECK (tenant_id = app.tenant_id() AND app.can_access_account(account_id))', t);
    EXECUTE format('CREATE POLICY worker_tenant ON %I TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aegis_app, aegis_worker', t);
  END LOOP;
END $$;

-- Mail accounts: owner/grantee see; members never see colleagues' accounts.
ALTER TABLE mail_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE mail_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY app_mailbox ON mail_accounts TO aegis_app USING (tenant_id = app.tenant_id() AND (owner_user_id = app.user_id() OR app.can_access_account(id)))
  WITH CHECK (tenant_id = app.tenant_id() AND owner_user_id = app.user_id());
CREATE POLICY worker_tenant ON mail_accounts TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_accounts TO aegis_app, aegis_worker;

-- Mailbox grants: owner manages; grantee reads.
ALTER TABLE mailbox_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE mailbox_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY app_grants ON mailbox_grants TO aegis_app USING (tenant_id = app.tenant_id() AND (grantee_user_id = app.user_id() OR granted_by = app.user_id()))
  WITH CHECK (tenant_id = app.tenant_id() AND granted_by = app.user_id());
GRANT SELECT, INSERT, DELETE ON mailbox_grants TO aegis_app;
CREATE POLICY worker_tenant ON mailbox_grants TO aegis_worker USING (tenant_id = app.tenant_id());
GRANT SELECT ON mailbox_grants TO aegis_worker;

-- Credentials: the app role may WRITE new envelopes and delete them, but can never read them.
ALTER TABLE credential_envelopes ENABLE ROW LEVEL SECURITY; ALTER TABLE credential_envelopes FORCE ROW LEVEL SECURITY;
CREATE POLICY app_write ON credential_envelopes FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND app.can_access_account(account_id));
GRANT INSERT ON credential_envelopes TO aegis_app;
CREATE POLICY worker_tenant ON credential_envelopes TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON credential_envelopes TO aegis_worker;

-- Telemetry: security_admin/owner read aggregates; written only by the worker.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['security_telemetry_daily','security_reports_daily']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY admin_read ON %I FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner','security_admin'))$p$, t);
    EXECUTE format('CREATE POLICY worker_tenant ON %I TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO aegis_app', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO aegis_worker', t);
  END LOOP;
END $$;
-- Reports are written from user feedback in the API.
CREATE POLICY app_write ON security_reports_daily FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY app_update ON security_reports_daily FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT INSERT, UPDATE ON security_reports_daily TO aegis_app;

-- Tenant-level config, readable by members, writable according to role (service layer + policy).
ALTER TABLE tenant_policies ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON tenant_policies FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id());
CREATE POLICY app_write ON tenant_policies FOR ALL TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner','security_admin')) WITH CHECK (tenant_id = app.tenant_id() AND app.has_role('owner','security_admin'));
CREATE POLICY worker_tenant ON tenant_policies TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE ON tenant_policies TO aegis_app; GRANT SELECT, INSERT ON tenant_policies TO aegis_worker;

-- Keys: both may use via envelope; never exposed through an API.
ALTER TABLE tenant_keys ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_only ON tenant_keys TO aegis_app, aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT ON tenant_keys TO aegis_app, aegis_worker;

-- Automations: per-user.
ALTER TABLE automations ENABLE ROW LEVEL SECURITY; ALTER TABLE automations FORCE ROW LEVEL SECURITY;
CREATE POLICY app_own ON automations TO aegis_app USING (tenant_id = app.tenant_id() AND user_id = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND user_id = app.user_id());
CREATE POLICY worker_tenant ON automations TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON automations TO aegis_app; GRANT SELECT ON automations TO aegis_worker;

ALTER TABLE automation_runs ENABLE ROW LEVEL SECURITY; ALTER TABLE automation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON automation_runs FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_id AND a.user_id = app.user_id()));
CREATE POLICY app_write ON automation_runs FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_id AND a.user_id = app.user_id()));
CREATE POLICY worker_tenant ON automation_runs TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT ON automation_runs TO aegis_app, aegis_worker;

-- Incident shares: the sharer and the named analyst only, unexpired and unrevoked for the analyst.
ALTER TABLE incident_shares ENABLE ROW LEVEL SECURITY; ALTER TABLE incident_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY sharer ON incident_shares TO aegis_app USING (tenant_id = app.tenant_id() AND shared_by = app.user_id()) WITH CHECK (tenant_id = app.tenant_id() AND shared_by = app.user_id() AND app.can_access_account(account_id));
CREATE POLICY analyst ON incident_shares FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND analyst_user_id = app.user_id() AND revoked_at IS NULL AND expires_at > now());
GRANT SELECT, INSERT, UPDATE ON incident_shares TO aegis_app;

-- Audit: insert from either role; read by owner/security_admin, or a user's own events.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON audit_events FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND (actor_user_id = app.user_id() OR app.has_role('owner','security_admin')));
CREATE POLICY app_insert ON audit_events FOR INSERT TO aegis_app WITH CHECK (tenant_id = app.tenant_id() AND (actor_user_id IS NULL OR actor_user_id = app.user_id()));
CREATE POLICY worker_insert ON audit_events FOR INSERT TO aegis_worker WITH CHECK (tenant_id = app.tenant_id());
GRANT SELECT, INSERT ON audit_events TO aegis_app; GRANT INSERT ON audit_events TO aegis_worker;
GRANT USAGE ON SEQUENCE audit_events_id_seq TO aegis_app, aegis_worker;
GRANT USAGE ON SEQUENCE demo_mailbox_seq_seq TO aegis_app, aegis_worker;

-- AI usage, subscriptions, usage counters: tenant scoped.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage','usage_counters','subscriptions','invoices','invitations','verified_domains','consent_records']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_only ON %I TO aegis_app, aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO aegis_app, aegis_worker', t);
  END LOOP;
END $$;

-- Memberships and orgs: read your own tenant; users table: names of tenant co-members only.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY same_tenant ON memberships FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id());
CREATE POLICY admin_change ON memberships FOR UPDATE TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner')) WITH CHECK (tenant_id = app.tenant_id());
CREATE POLICY admin_remove ON memberships FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND app.has_role('owner'));
CREATE POLICY worker_read ON memberships FOR SELECT TO aegis_worker USING (tenant_id = app.tenant_id());
GRANT SELECT, UPDATE, DELETE ON memberships TO aegis_app; GRANT SELECT ON memberships TO aegis_worker;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY own_tenant ON organizations FOR SELECT TO aegis_app, aegis_worker USING (id = app.tenant_id());
CREATE POLICY owner_update ON organizations FOR UPDATE TO aegis_app USING (id = app.tenant_id() AND app.has_role('owner')) WITH CHECK (id = app.tenant_id());
GRANT SELECT, UPDATE ON organizations TO aegis_app; GRANT SELECT ON organizations TO aegis_worker;

-- Column-level: never expose password hashes or TOTP secrets to request roles.
GRANT SELECT (id, email, name, totp_enabled, created_at) ON users TO aegis_app, aegis_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO aegis_app;
GRANT SELECT ON user_preferences TO aegis_worker;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO aegis_app, aegis_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO aegis_app, aegis_worker;

-- Row policies on users: yourself and co-members.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY self_or_comember ON users FOR SELECT TO aegis_app, aegis_worker USING (
  id = app.user_id() OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app.tenant_id()));
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY self ON user_preferences TO aegis_app USING (user_id = app.user_id()) WITH CHECK (user_id = app.user_id());
CREATE POLICY worker_comember ON user_preferences FOR SELECT TO aegis_worker USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = user_preferences.user_id AND m.tenant_id = app.tenant_id()));
