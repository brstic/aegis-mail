-- Sealed sentence embeddings for semantic search. A vector can be inverted back towards its text, so it's treated as content:
-- envelope-encrypted per record with AAD bound to the message, exactly like message_contents. There's no pgvector and no
-- plaintext vector anywhere, so the database can't rank these. The application opens them in memory, per query. See docs/privacy-modes.md.
-- model is the only plaintext column beyond the keys, and says nothing about the mail.
CREATE TABLE message_embeddings (
  message_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES organizations ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES mail_accounts ON DELETE CASCADE,
  model text NOT NULL,
  vector_enc bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_embeddings_account ON message_embeddings (account_id);

ALTER TABLE message_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_embeddings FORCE ROW LEVEL SECURITY;

-- Anyone who can open a mailbox can search it, same as message_search. Only its owner can erase its vectors: opting out and
-- sealing a message both happen in the web process. Nothing in a request context writes a vector, only the worker does.
CREATE POLICY app_read ON message_embeddings FOR SELECT TO aegis_app USING (tenant_id = app.tenant_id() AND app.can_access_account(account_id));
CREATE POLICY app_delete ON message_embeddings FOR DELETE TO aegis_app USING (tenant_id = app.tenant_id() AND app.owns_account(account_id));
CREATE POLICY worker_tenant ON message_embeddings TO aegis_worker USING (tenant_id = app.tenant_id()) WITH CHECK (tenant_id = app.tenant_id());

GRANT SELECT, DELETE ON message_embeddings TO aegis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_embeddings TO aegis_worker;
-- Nothing for the connection roles, the gateway, billing or operators. process-boundary.test.ts and semantic-search.test.ts prove it.
