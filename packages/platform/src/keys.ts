import type { KeyClass } from "@aegis/cryptography";
import { audit } from "./audit";
import type { Ctx, Platform } from "./context";
import { enqueue } from "./jobs";
import { requireRole } from "./org";

/** Every encrypted column, with the context it was sealed under. The record column is what AAD binds to. */
const SEALED: { table: string; column: string; id: string; keyClass: KeyClass; seal: string; sealId?: string }[] = [
  { table: "messages", column: "envelope_enc", id: "id", keyClass: "body", seal: "messages" },
  { table: "message_contents", column: "blob_enc", id: "message_id", keyClass: "body", seal: "message_contents" },
  { table: "message_embeddings", column: "vector_enc", id: "message_id", keyClass: "body", seal: "message_embeddings" },
  { table: "security_analyses", column: "detail_enc", id: "message_id", keyClass: "body", seal: "security_analyses" },
  { table: "priority_decisions", column: "detail_enc", id: "message_id", keyClass: "body", seal: "priority_decisions" },
  { table: "attachments", column: "meta_enc", id: "id", keyClass: "body", seal: "attachments" },
  { table: "attachments", column: "blob_enc", id: "id", keyClass: "body", seal: "attachments.blob" },
  { table: "tasks", column: "blob_enc", id: "id", keyClass: "body", seal: "tasks" },
  { table: "drafts", column: "blob_enc", id: "id", keyClass: "body", seal: "drafts" },
  { table: "ai_artifacts", column: "blob_enc", id: "id", keyClass: "body", seal: "ai_artifacts" },
  { table: "incident_shares", column: "snapshot_enc", id: "id", keyClass: "body", seal: "incident_shares" },
  { table: "contacts", column: "identity_enc", id: "id", keyClass: "metadata", seal: "contacts" },
  { table: "sync_states", column: "cursor_enc", id: "account_id", keyClass: "metadata", seal: "sync_states" },
  { table: "credential_envelopes", column: "blob", id: "account_id", keyClass: "credential", seal: "credential_envelopes" },
];
const BATCH = 200;

/** Owner action: new key versions now, and old data moved onto them in the background. */
export async function rotateTenantKeys(p: Platform, ctx: Ctx) {
  await requireRole(p, ctx, "managePolicy");
  const classes: KeyClass[] = ["body", "metadata", "credential"];
  for (const c of classes) await p.envelope.rotate(ctx.tenantId, c);
  await p.db.withUser(ctx, async t => {
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "policy.changed", meta: { kind: "key_rotation" } });
    await enqueue(t, { tenantId: ctx.tenantId, kind: "key.reseal", dedupeKey: `reseal:${ctx.tenantId}` });
  });
}

/** Resumable and idempotent: anything already on the active version is skipped, so a retry just continues. */
export async function resealTenant(p: Platform, tenantId: string): Promise<number> {
  let total = 0;
  for (const s of SEALED) {
    for (let after = ""; ;) {
      const rows = await p.db.withWorker(tenantId, t => t.query<any>(`SELECT ${s.id} AS id, ${s.column} AS blob FROM ${s.table} WHERE tenant_id=$1 AND ${s.column} IS NOT NULL AND ${s.id}::text > $2 ORDER BY ${s.id}::text LIMIT ${BATCH}`, [tenantId, after]));
      if (!rows.length) break;
      for (const r of rows) {
        const fresh = await p.envelope.resealIfOld({ tenantId, keyClass: s.keyClass, table: s.seal, recordId: r.id }, r.blob);
        if (!fresh) continue;
        // Compare-and-swap: a concurrent update wins, and the next run picks it up.
        const changed = await p.db.withWorker(tenantId, t => t.query(`UPDATE ${s.table} SET ${s.column}=$2 WHERE ${s.id}=$1 AND ${s.column}=$3 RETURNING 1`, [r.id, fresh, r.blob]));
        total += changed.length;
      }
      after = String(rows[rows.length - 1].id);
    }
  }
  await p.db.withWorker(tenantId, t => audit(t, { tenantId, event: "policy.changed", meta: { kind: "key_reseal", count: total } }));
  return total;
}
