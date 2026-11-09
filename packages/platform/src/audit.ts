import type { EventType } from "@aegis/domain";
import type { Tx } from "@aegis/db";

const META_ALLOWED = new Set(["provider", "role", "outcome", "code", "count", "label", "reason", "provider_moved", "scopes", "hours", "redacted", "kind", "fields", "automation_id", "attempt", "action", "ip_hash", "scope", "by"]);

export function cleanMeta(meta: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!META_ALLOWED.has(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 120);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === "string").slice(0, 20).map(x => (x as string).slice(0, 80));
  }
  return out;
}

/** Content-free by construction: unknown meta keys are dropped, so call sites can't leak subjects or addresses. */
export async function audit(tx: Tx, e: { tenantId: string | null; actor?: string | null; event: EventType; targetType?: string; targetId?: string; meta?: Record<string, unknown> }) {
  await tx.query("INSERT INTO audit_events(tenant_id, actor_user_id, event, target_type, target_id, meta) VALUES ($1,$2,$3,$4,$5,$6)",
    [e.tenantId, e.actor ?? null, e.event, e.targetType ?? null, e.targetId ?? null, JSON.stringify(cleanMeta(e.meta))]);
}
