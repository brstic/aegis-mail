import type { Db, Tx } from "@aegis/db";
import { audit } from "./audit";

/**
 * The erasures themselves, in one place, so a live deletion and a replay after a restore can't drift apart.
 * Nothing here checks who's asking or calls a provider: that belongs to the live paths, and a replay can't do either.
 * Every function runs as aegis_app under the owner's RLS, or as aegis_worker for one tenant, and is safe to run twice.
 */

/** Everything derived from a message that could reveal it. The tombstone row stays so sync doesn't resurrect it. */
export async function purgeMessageContent(t: Tx, messageId: string, threadId: string | null) {
  for (const table of ["message_contents", "message_search", "message_embeddings", "security_analyses", "priority_decisions", "quarantine_items"]) await t.query(`DELETE FROM ${table} WHERE message_id=$1`, [messageId]);
  await t.query("DELETE FROM attachments WHERE message_id=$1", [messageId]);
  await t.query("DELETE FROM tasks WHERE message_id=$1", [messageId]);
  await t.query("DELETE FROM incident_shares WHERE message_id=$1", [messageId]);
  if (threadId) await t.query("DELETE FROM ai_artifacts WHERE thread_id=$1", [threadId]);
}

/** `where` is a fixed fragment from the caller, with values in params. */
export async function tombstoneAndPurge(t: Tx, where: string, params: unknown[]) {
  const rows = await t.query<{ id: string; thread_id: string | null; account_id: string }>(`UPDATE messages SET tombstoned_at=COALESCE(tombstoned_at, now()), envelope_enc=NULL, updated_at=now() WHERE ${where} RETURNING id, thread_id, account_id`, params);
  for (const m of rows) await purgeMessageContent(t, m.id, m.thread_id);
  return rows;
}

/** Sealing's erasure. A sealed_blob stays: a replay against a backup taken after the seal must not destroy the only copy. */
export async function eraseSealedPlaintext(t: Tx, messageId: string, threadId: string | null) {
  await t.query("UPDATE message_contents SET blob_enc=NULL WHERE message_id=$1", [messageId]);
  // Everything derived from the body goes too, or the server could still reveal it.
  await t.query("DELETE FROM message_search WHERE message_id=$1", [messageId]);
  await t.query("DELETE FROM message_embeddings WHERE message_id=$1", [messageId]);
  await t.query("UPDATE attachments SET blob_enc=NULL WHERE message_id=$1", [messageId]);
  await t.query("DELETE FROM tasks WHERE message_id=$1", [messageId]);
  if (threadId) await t.query("DELETE FROM ai_artifacts WHERE thread_id=$1", [threadId]);
}

export async function eraseMailboxContent(t: Tx, accountId: string) {
  for (const table of ["message_embeddings", "tasks", "drafts", "ai_artifacts", "contacts", "messages", "threads"]) await t.query(`DELETE FROM ${table} WHERE account_id=$1`, [accountId]);
}

export async function destroyCredential(t: Tx, accountId: string) {
  await t.query("DELETE FROM credential_envelopes WHERE account_id=$1", [accountId]);
  await t.query("DELETE FROM provider_subscriptions WHERE account_id=$1", [accountId]);
}

/** The plaintext search words that opting out removes. */
export async function eraseSearchWords(t: Tx, userId: string) {
  return t.query<{ message_id: string }>("DELETE FROM message_search WHERE account_id IN (SELECT id FROM mail_accounts WHERE owner_user_id=$1) RETURNING message_id", [userId]);
}

/** Destroys a tenant's wrapped keys and what's kept alongside them. Worker context only. Returns how many keys it found to destroy. */
export async function shredTenantTx(t: Tx, tenantId: string): Promise<number> {
  const keys = await t.query("DELETE FROM tenant_keys WHERE tenant_id=$1 RETURNING version", [tenantId]);
  // Unreadable without those keys, but there's no reason to keep the rows either.
  await t.query("DELETE FROM message_embeddings WHERE tenant_id=$1", [tenantId]);
  // Plaintext that isn't under those keys: rule text and the workspace name, which often holds a person's name.
  await t.query("DELETE FROM automations WHERE tenant_id=$1", [tenantId]);
  // Their secrets went with the keys, and nobody should sign in or provision through a shredded workspace.
  await t.query("DELETE FROM scim_tokens WHERE tenant_id=$1", [tenantId]);
  await t.query("DELETE FROM scim_users WHERE tenant_id=$1", [tenantId]);
  await t.query("DELETE FROM sso_configs WHERE tenant_id=$1", [tenantId]);
  await t.query("DELETE FROM notifications WHERE tenant_id=$1", [tenantId]);
  await t.query("UPDATE organizations SET name='Deleted workspace' WHERE id=$1", [tenantId]);
  return keys.length;
}

export interface AccountMembership { tenant_id: string; role: string; kind: string }
export async function accountMemberships(db: Db, userId: string) {
  return db.withSystem(t => t.query<AccountMembership>("SELECT m.tenant_id, m.role, o.kind FROM memberships m JOIN organizations o ON o.id=m.tenant_id WHERE m.user_id=$1", [userId]));
}

/** Where deleting an account differs between the live path and a replay. Everything else about it is eraseAccount. */
export interface ErasureScope {
  db: Db;
  tenantTx<T>(c: { tenantId: string; userId: string }, fn: (t: Tx) => Promise<T>): Promise<T>;
  eraseMailbox(c: { tenantId: string; userId: string }, accountId: string): Promise<void>;
  /** For a replay, which shreds as it goes: once memberships are gone an interrupted run couldn't find the tenant again. */
  shredPersonal?(tenantId: string): Promise<void>;
  /** In the transaction that removes the user. For the live path, which queues its shred and records the deletion here. */
  inScrub?(t: Tx, personalTenants: string[], userId: string): Promise<void>;
  auditMeta?: Record<string, unknown>;
}

/** Deleting an account, minus re-authentication and the checks a live request makes first. Disconnects every mailbox in every workspace, removes the user, and shreds personal workspaces' keys. */
export async function eraseAccount(s: ErasureScope, userId: string) {
  const memberships = await accountMemberships(s.db, userId);
  for (const m of memberships) {
    const c = { tenantId: m.tenant_id, userId };
    const accounts = await s.tenantTx(c, t => t.query<{ id: string }>("SELECT id FROM mail_accounts WHERE owner_user_id=$1", [userId]));
    for (const a of accounts) await s.eraseMailbox(c, a.id);
    await s.tenantTx(c, async t => {
      await t.query("DELETE FROM automations WHERE user_id=$1", [userId]);
      await t.query("DELETE FROM notifications WHERE user_id=$1", [userId]);
    });
    if (m.kind === "personal") await s.shredPersonal?.(m.tenant_id);
  }
  await s.db.withSystem(async t => {
    await t.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    await t.query("DELETE FROM user_preferences WHERE user_id=$1", [userId]);
    await t.query("DELETE FROM memberships WHERE user_id=$1", [userId]);
    await t.query("UPDATE users SET deleted_at=now(), email='deleted-' || id || '@deleted.invalid', name='Deleted user', password_hash=NULL, totp_secret_enc=NULL, totp_pending_enc=NULL, totp_enabled=false, totp_recovery_hashes='{}', totp_last_step=NULL WHERE id=$1 AND deleted_at IS NULL", [userId]);
    await t.query("DELETE FROM passkeys WHERE user_id=$1", [userId]);
    await t.query("DELETE FROM identities WHERE user_id=$1", [userId]);
    await t.query("DELETE FROM email_tokens WHERE user_id=$1", [userId]);
    await t.query("DELETE FROM scim_users WHERE user_id=$1", [userId]);
    for (const m of memberships) await audit(t, { tenantId: m.tenant_id, actor: null, event: "data.deleted", targetType: "user", meta: { kind: "account", ...s.auditMeta } });
    await s.inScrub?.(t, memberships.filter(m => m.kind === "personal").map(m => m.tenant_id), userId);
  });
}
