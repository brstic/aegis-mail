import { constantTimeEqual } from "@aegis/cryptography";
import { createHash } from "node:crypto";
import type { Platform } from "./context";
import { enqueue } from "./jobs";
import { rateLimit } from "./auth";

/**
 * Webhooks are hints, never data (ADR-0005). The most a forged call can do is cause a deduplicated sync.
 * The caller verifies Pub/Sub's OIDC JWT before handing over the payload.
 */
export async function handleGmailPush(p: Platform, emailAddress: string): Promise<{ enqueued: number }> {
  const emailHash = createHash("sha256").update(emailAddress.toLowerCase()).digest("hex");
  await rateLimit(p, `push:gmail:${emailHash}`, 120, 60);
  const accounts = await p.db.withSystem(t => t.query<{ id: string; tenant_id: string }>("SELECT id, tenant_id FROM webhook_account_lookup('gmail', $1)", [emailAddress.toLowerCase()]));
  await p.db.withSystem(async t => { for (const a of accounts) await enqueue(t, { tenantId: a.tenant_id, kind: "sync.account", payload: { accountId: a.id, reason: "push" }, dedupeKey: `sync:${a.id}` }); });
  return { enqueued: accounts.length };
}

export async function handleGraphNotifications(p: Platform, notes: { subscriptionId: string; clientState?: string; lifecycleEvent?: string }[]) {
  let enqueued = 0;
  for (const n of notes.slice(0, 100)) {
    const sub = await p.db.withSystem(t => t.one<{ account_id: string; tenant_id: string; client_state_hash: string | null }>("SELECT * FROM webhook_subscription_lookup($1)", [n.subscriptionId]));
    if (!sub?.client_state_hash || !n.clientState) continue;
    if (!constantTimeEqual(createHash("sha256").update(n.clientState).digest("hex"), sub.client_state_hash)) { p.log.warn("webhook.client_state_mismatch", { accountId: sub.account_id }); continue; }
    await p.db.withSystem(async t => {
      await enqueue(t, { tenantId: sub.tenant_id, kind: "sync.account", payload: { accountId: sub.account_id, reason: "push" }, dedupeKey: `sync:${sub.account_id}` });
      if (n.lifecycleEvent === "subscriptionRemoved" || n.lifecycleEvent === "reauthorizationRequired") await enqueue(t, { tenantId: sub.tenant_id, kind: "push.renew", payload: { accountId: sub.account_id }, dedupeKey: `renew:${sub.account_id}` });
    });
    enqueued++;
  }
  return { enqueued };
}
