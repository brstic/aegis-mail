import { randomInt } from "node:crypto";
import type { Tx } from "@aegis/db";
import type { Platform } from "./context";
import { errorCode } from "./log";

export type JobKind = "sync.account" | "provider.change" | "quarantine.recheck" | "send.execute" | "send.reconcile" | "push.renew" | "tick" | "retention.sweep" | "account.disconnect" | "tenant.shred" | "member.removed" | "mail.send" | "notifications.scan" | "key.reseal" | "usage.nightly" | "usage.tenant_snapshot" | "embed.message" | "embed.backfill" | "domains.recheck" | "domains.tenant_recheck" | "deletion.ship";
const ID_KEYS = new Set(["accountId", "messageId", "approvalId", "draftId", "change", "rollback", "reason", "attempt", "automationId", "userId", "mailId"]);
const CHANGE_KEYS = new Set(["moveToRole", "isRead", "isStarred", "addLabels", "removeLabels", "folder_role", "is_read", "is_starred", "label_id", "label_applied"]);

/** Job payloads go to a plaintext table and may appear in logs, so they carry IDs and flags only. */
export function assertContentFree(payload: Record<string, unknown>) {
  for (const [k, v] of Object.entries(payload)) {
    if (!ID_KEYS.has(k)) throw new Error(`job payload key not allowed: ${k}`);
    if (k === "change" || k === "rollback") {
      for (const ck of Object.keys((v ?? {}) as object)) if (!CHANGE_KEYS.has(ck)) throw new Error(`job change key not allowed: ${ck}`);
    } else if (typeof v === "string" && v.length > 128) throw new Error(`job payload value too long: ${k}`);
  }
}

export async function enqueue(tx: Tx, job: { tenantId: string | null; kind: JobKind; payload?: Record<string, unknown>; dedupeKey?: string; runAt?: Date; maxAttempts?: number; /** The key has been used once, ever, even if that job has finished. For keys naming a time period. */ oncePerKey?: boolean }): Promise<string | null> {
  const payload = job.payload ?? {};
  assertContentFree(payload);
  const r = await tx.one<{ id: string }>(
    `INSERT INTO jobs(tenant_id, kind, payload, dedupe_key, run_at, max_attempts)
     SELECT $1::uuid, $2, $3::jsonb, $4::text, COALESCE($5::timestamptz, now()), COALESCE($6::int, 8)
     WHERE NOT ($7::boolean AND EXISTS (SELECT 1 FROM jobs WHERE dedupe_key=$4::text))
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running') DO NOTHING RETURNING id`,
    [job.tenantId, job.kind, JSON.stringify(payload), job.dedupeKey ?? null, job.runAt ?? null, job.maxAttempts ?? null, job.oncePerKey === true]);
  return r?.id ?? null;
}

export function backoffMs(attempt: number, base = 2000, cap = 15 * 60_000) {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  // Full jitter.
  return Math.floor(exp / 2) + randomInt(0, Math.max(1, Math.floor(exp / 2)));
}

export interface ClaimedJob { id: string; tenant_id: string | null; kind: JobKind; payload: any; attempts: number; max_attempts: number; trace_id: string }

/**
 * Run again later. Doesn't count toward failure by default, e.g. a provider's Retry-After.
 * Pass counted for polling work that must eventually give up, or it would poll forever.
 */
export class DeferJob extends Error { constructor(readonly delayMs: number, readonly counted = false) { super("defer"); this.name = "DeferJob"; } }
/** Permanent failure: straight to dead letter, no retries. */
export class PermanentJobError extends Error { constructor(readonly code: string) { super(code); this.name = "PermanentJobError"; } }

export type JobHandler = (job: ClaimedJob) => Promise<void>;
/** Runs after a job is dead-lettered, for rollback. */
export type DeadHandler = (job: ClaimedJob, code: string) => Promise<void>;

export async function claimJob(p: Platform): Promise<ClaimedJob | null> {
  return p.db.withSystem(t => t.one<ClaimedJob>(
    `UPDATE jobs SET state='running', locked_at=now(), attempts=attempts+1 WHERE id = (
       SELECT id FROM jobs WHERE state='queued' AND run_at <= now() ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
     ) RETURNING id, tenant_id, kind, payload, attempts, max_attempts, trace_id`));
}

export async function finishJob(p: Platform, job: ClaimedJob, err?: unknown, onDead?: DeadHandler) {
  if (!err) {
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='done', finished_at=now(), last_error_code=NULL WHERE id=$1", [job.id]));
    return;
  }
  if (err instanceof DeferJob) {
    await p.db.withSystem(t => t.query(`UPDATE jobs SET state='queued', attempts=${err.counted ? "attempts" : "GREATEST(attempts-1,0)"}, run_at=now() + ($2::int * interval '1 millisecond') WHERE id=$1`, [job.id, err.delayMs]));
    return;
  }
  const code = err instanceof PermanentJobError ? err.code : errorCode(err);
  const dead = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
  p.log.warn("job.failed", { jobId: job.id, jobKind: job.kind, attempt: job.attempts, errorCode: code, traceId: job.trace_id, status: dead ? "dead" : "retry" });
  if (dead) {
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='dead', finished_at=now(), last_error_code=$2 WHERE id=$1", [job.id, code]));
    await onDead?.(job, code);
  } else {
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='queued', last_error_code=$2, run_at=now() + ($3::int * interval '1 millisecond') WHERE id=$1", [job.id, code, backoffMs(job.attempts)]));
  }
}

export async function cancelJobs(tx: Tx, accountId: string) {
  await tx.query("UPDATE jobs SET state='cancelled', finished_at=now() WHERE state='queued' AND payload->>'accountId' = $1 AND kind <> 'account.disconnect'", [accountId]);
}

/**
 * A worker that died leaves 'running' rows; return them to the queue after a lease timeout. Attempts count, so a job that
 * kills its worker every time eventually dead-letters instead of looping forever. A live worker renews each running job's
 * lease every 30 seconds, so the window only has to cover a missed renewal or two, not the longest job.
 */
export async function reapStuckJobs(p: Platform, leaseMs = 3 * 60_000) {
  await p.db.withSystem(async t => {
    await t.query("UPDATE jobs SET state='dead', finished_at=now(), last_error_code='lease_expired' WHERE state='running' AND locked_at < now() - ($1::int * interval '1 millisecond') AND attempts >= max_attempts", [leaseMs]);
    await t.query("UPDATE jobs SET state='queued', run_at=now() WHERE state='running' AND locked_at < now() - ($1::int * interval '1 millisecond')", [leaseMs]);
  });
}

/** Expired rows from auth and rate limiting grow without bound otherwise, some from unauthenticated requests. */
export async function sweepExpired(p: Platform) {
  await p.db.withSystem(async t => {
    await t.query("DELETE FROM auth_challenges WHERE expires_at < now()");
    await t.query("DELETE FROM oauth_flows WHERE expires_at < now()");
    await t.query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
    await t.query("DELETE FROM jobs WHERE state IN ('done','cancelled') AND finished_at < now() - interval '7 days'");
    await t.query("DELETE FROM sso_flows WHERE expires_at < now()");
    await t.query("DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day'");
    await t.query("DELETE FROM outbound_mail WHERE state <> 'queued' AND finished_at < now() - interval '7 days'");
    await t.query("DELETE FROM dev_outbox WHERE created_at < now() - interval '7 days'");
    // Shipped rows are in the log by now. The newest stays, so a shipper can always tell if the log has been cut below it.
    await t.query("DELETE FROM deletion_outbox WHERE shipped_at < now() - interval '30 days' AND sink_seq < (SELECT max(sink_seq) FROM deletion_outbox)");
  });
}
