import { CAPABILITIES, GrantRevokedError, RateLimitedError, type ProviderKind, UnsupportedOperationError } from "@aegis/domain";
import { randomToken } from "@aegis/cryptography";
import { createHash } from "node:crypto";
import { adapterFor, finishDisconnect } from "./accounts";
import { audit } from "./audit";
import type { Platform } from "./context";
import { deletionLogTick, recordErasure, shipDeletionLog } from "./deletion-log";
import { shredTenantTx } from "./erasure";
import { recheckHeld, syncAccount } from "./ingest";
import { claimJob, DeferJob, enqueue, finishJob, PermanentJobError, reapStuckJobs, sweepExpired, type ClaimedJob } from "./jobs";
import { resealTenant } from "./keys";
import { finishMemberRemoval, recheckDomains } from "./org";
import { errorCode } from "./log";
import { deliverMail, mailFailed } from "./mail-queue";
import { scanNotifications } from "./notifications";
import { traced } from "./telemetry";
import { retentionSweep } from "./privacy";
import { executeSend, reconcileSend } from "./send";
import { backfillEmbeddings, embedMessage } from "./semantic-search";
import { snapshotUsage } from "./limits";

async function providerChange(p: Platform, job: ClaimedJob) {
  const { accountId, messageId, change, reason } = job.payload;
  const tenantId = job.tenant_id!;
  const m = await p.db.withWorker(tenantId, t => t.one<any>("SELECT provider_message_id, tombstoned_at FROM messages WHERE id=$1", [messageId]));
  if (!m || m.tombstoned_at) return;
  const { adapter, account } = await adapterFor(p, tenantId, accountId);
  if (account.read_only) return;
  try {
    const applied = await adapter.applyChange(m.provider_message_id, change);
    // An IMAP move gives the message a new id. Following it here means the next sync sees a known message in a new
    // folder, rather than one deleted and a stranger arriving: that would re-analyze it and lose its thread and quarantine row.
    if (applied?.remoteId) await p.db.withWorker(tenantId, t => t.query("UPDATE messages SET provider_message_id=$2 WHERE id=$1", [messageId, applied.remoteId]));
    if (reason === "quarantine" && change.moveToRole) await p.db.withWorker(tenantId, t => t.query("UPDATE quarantine_items SET provider_moved=true WHERE message_id=$1", [messageId]));
  } catch (e) {
    if (e instanceof RateLimitedError) throw new DeferJob((e.retryAfterSeconds ?? 60) * 1000);
    if (e instanceof UnsupportedOperationError) throw new PermanentJobError("unsupported");
    if (e instanceof GrantRevokedError) {
      await p.db.withWorker(tenantId, async t => {
        await t.query("UPDATE mail_accounts SET status='reconnect_required', status_detail=$2 WHERE id=$1", [accountId, "Access to this mailbox was revoked. Reconnect to resume."]);
        await audit(t, { tenantId, event: "token.revoked", targetType: "account", targetId: accountId });
      });
      throw new PermanentJobError("grant_revoked");
    }
    throw e;
  } finally {
    await adapter.close?.().catch(() => {});
  }
}

async function renewPush(p: Platform, job: ClaimedJob) {
  const { accountId } = job.payload;
  const tenantId = job.tenant_id!;
  // clientState is per subscription, and must exist before the adapter is built, which reads it from settings.
  const clientState = await p.db.withWorker(tenantId, async t => {
    const a = await t.one<any>("SELECT kind, settings FROM mail_accounts WHERE id=$1", [accountId]);
    const existing = a?.settings?.graphClientState as string | undefined;
    if (existing || a?.kind !== "microsoft") return existing ?? randomToken(24);
    const fresh = randomToken(24);
    await t.query("UPDATE mail_accounts SET settings=settings || $2::jsonb WHERE id=$1", [accountId, JSON.stringify({ graphClientState: fresh })]);
    return fresh;
  });
  const { adapter } = await adapterFor(p, tenantId, accountId);
  if (!adapter.renewPush) return;
  const res = await adapter.renewPush();
  if (!res) return;
  await p.db.withWorker(tenantId, t => t.query(
    `INSERT INTO provider_subscriptions(account_id,tenant_id,external_id,client_state_hash,expires_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (account_id) DO UPDATE SET external_id=EXCLUDED.external_id, client_state_hash=EXCLUDED.client_state_hash, expires_at=EXCLUDED.expires_at, updated_at=now()`,
    [accountId, tenantId, res.state?.subscriptionId ?? null, createHash("sha256").update(clientState).digest("hex"), res.expiresAt]));
}

/** Rolls back the optimistic local change when the provider ultimately refuses it. */
async function onDead(p: Platform, job: ClaimedJob, code: string) {
  if (job.kind === "mail.send") await mailFailed(p, job.payload.mailId, code);
  if (job.kind === "provider.change" && job.payload.rollback && Object.keys(job.payload.rollback).length) {
    const r = job.payload.rollback;
    await p.db.withWorker(job.tenant_id!, async t => {
      await t.query("UPDATE messages SET folder_role=COALESCE($2,folder_role), is_read=COALESCE($3,is_read), is_starred=COALESCE($4,is_starred) WHERE id=$1", [job.payload.messageId, r.folder_role ?? null, r.is_read ?? null, r.is_starred ?? null]);
      if (r.label_id) {
        if (r.label_applied) await t.query("INSERT INTO message_labels(message_id,label_id,tenant_id,account_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [job.payload.messageId, r.label_id, job.tenant_id, job.payload.accountId]);
        else await t.query("DELETE FROM message_labels WHERE message_id=$1 AND label_id=$2", [job.payload.messageId, r.label_id]);
      }
      // The requester is the actor, so they can read this row and be told. Automations leave it null.
      await audit(t, { tenantId: job.tenant_id!, actor: job.payload.userId ?? null, event: "provider.sync_failed", targetType: "message", targetId: job.payload.messageId, meta: { code, outcome: "rolled_back" } });
    });
  }
}

// Work a suspension stops. Sync just stops, because a later sync catches up. Sends and anything that deletes wait, so nothing is lost.
const SUSPENSION_SKIPS = new Set<string>(["sync.account", "push.renew", "retention.sweep", "notifications.scan", "usage.tenant_snapshot", "embed.message", "embed.backfill"]);
const SUSPENSION_WAITS = new Set<string>(["provider.change", "send.execute", "account.disconnect", "tenant.shred", "member.removed"]);
const SUSPENSION_RECHECK_MS = 3600_000;

export async function runJob(p: Platform, job: ClaimedJob) {
  const tenantId = job.tenant_id!;
  if (tenantId && (SUSPENSION_SKIPS.has(job.kind) || SUSPENSION_WAITS.has(job.kind))) {
    const suspended = await p.db.withWorker(tenantId, t => t.one("SELECT 1 FROM tenant_suspensions WHERE tenant_id=$1", [tenantId]));
    if (suspended) {
      if (SUSPENSION_WAITS.has(job.kind)) throw new DeferJob(SUSPENSION_RECHECK_MS);
      return;
    }
  }
  switch (job.kind) {
    case "sync.account": return syncAccount(p, tenantId, job.payload.accountId);
    case "provider.change": return providerChange(p, job);
    case "quarantine.recheck": await recheckHeld(p, tenantId, job.payload.accountId); return;
    case "send.execute": return executeSend(p, tenantId, job.payload.approvalId);
    case "send.reconcile": return reconcileSend(p, tenantId, job.payload.approvalId, job.attempts, job.max_attempts);
    case "push.renew": return renewPush(p, job);
    case "retention.sweep": await retentionSweep(p, tenantId); return;
    case "tick": return tick(p);
    case "account.disconnect": return finishDisconnect(p, tenantId, job.payload.accountId, job.payload.reason === "delete");
    case "tenant.shred": return shredTenant(p, tenantId);
    case "key.reseal": await resealTenant(p, tenantId); return;
    case "member.removed": return finishMemberRemoval(p, tenantId, job.payload.userId);
    case "mail.send": return deliverMail(p, job.payload.mailId);
    case "notifications.scan": return scanNotifications(p, tenantId);
    case "usage.nightly": return usageFanOut(p);
    case "usage.tenant_snapshot": return snapshotUsage(p, tenantId);
    case "domains.recheck": return domainFanOut(p);
    case "domains.tenant_recheck": return recheckDomains(p, tenantId);
    case "embed.message": return embedMessage(p, tenantId, job.payload.accountId, job.payload.messageId);
    case "embed.backfill": await backfillEmbeddings(p, tenantId, job.payload.accountId, job.payload.messageId); return;
    case "deletion.ship": await shipDeletionLog(p); return;
  }
}

/** Destroys a tenant's keys, after any revocations queued ahead of it finish. A backup taken earlier holds its own copy of them until it expires. */
async function shredTenant(p: Platform, tenantId: string) {
  const pending = await p.db.withWorker(tenantId, t => t.one("SELECT 1 FROM jobs WHERE tenant_id=$1 AND kind='account.disconnect' AND state IN ('queued','running') LIMIT 1", [tenantId]));
  if (pending) throw new DeferJob(2000);
  await p.db.withWorker(tenantId, async t => {
    await shredTenantTx(t, tenantId);
    await audit(t, { tenantId, event: "key.shredded", meta: { kind: "tenant" } });
    await recordErasure(t, { kind: "tenant_shred", tenantId });
  });
  p.envelope.forget(tenantId);
}

/** Schedules polling, push renewal, and retention. Each account's budget comes from its capability flags. */
export async function tick(p: Platform) {
  const suspended = new Set((await p.db.withSystem(t => t.query<{ tenant_id: string }>("SELECT tenant_id FROM scheduler_suspended_tenants()"))).map(r => r.tenant_id));
  const accounts = (await p.db.withSystem(t => t.query<any>("SELECT * FROM scheduler_accounts()"))).filter(a => !suspended.has(a.tenant_id));
  await scheduleUsageNightly(p);
  await scheduleDomainRecheck(p);
  await deletionLogTick(p);
  const now = p.now().getTime();
  await p.db.withSystem(async t => {
    const tenants = new Set<string>();
    for (const a of accounts) {
      tenants.add(a.tenant_id);
      // Catches up mail from before this was switched on, and anything whose job died. A dedupe key only covers active jobs, so at most hourly is checked here.
      if (p.embeddings && !(await t.one("SELECT 1 FROM jobs WHERE kind='embed.backfill' AND tenant_id=$1 AND payload->>'accountId'=$2 AND created_at > now() - interval '1 hour' LIMIT 1", [a.tenant_id, a.id]))) await enqueue(t, { tenantId: a.tenant_id, kind: "embed.backfill", payload: { accountId: a.id }, dedupeKey: `embed-backfill:${a.id}:tick` });
      const cap = CAPABILITIES[a.kind as ProviderKind];
      // A provider can push only when this deployment gave it somewhere to push to. Without a Pub/Sub topic or a webhook
      // address, the mailbox is polled like any other: otherwise new mail would wait for the six-hourly reconcile.
      const push = cap.pushNotifications && (a.kind === "gmail" ? !!p.config.google?.pubsubTopic : a.kind === "microsoft" ? !!p.config.microsoft?.webhookUrl : true);
      // Push providers still reconcile periodically, because notifications can be dropped.
      const interval = (push ? 6 * 3600 : cap.latencyBudgetSeconds) * 1000;
      const last = a.last_attempt_at ? new Date(a.last_attempt_at).getTime() : 0;
      if (now - last >= interval) await enqueue(t, { tenantId: a.tenant_id, kind: "sync.account", payload: { accountId: a.id }, dedupeKey: `sync:${a.id}` });
      if (push) {
        const exp = a.push_expires_at ? new Date(a.push_expires_at).getTime() : 0;
        // Gmail wants daily renewal; Graph max is under 7 days. A day's margin covers both.
        if (exp - now < 24 * 3600_000) await enqueue(t, { tenantId: a.tenant_id, kind: "push.renew", payload: { accountId: a.id }, dedupeKey: `renew:${a.id}` });
      }
    }
    // Includes tenants with kept data and no active mailbox.
    for (const r of await t.query<{ tenant_id: string }>("SELECT tenant_id FROM scheduler_retention_tenants()")) tenants.add(r.tenant_id);
    for (const id of tenants) await enqueue(t, { tenantId: id, kind: "retention.sweep", dedupeKey: `retention:${id}:${p.now().toISOString().slice(0, 13)}`, oncePerKey: true });
    for (const r of await t.query<{ tenant_id: string }>("SELECT tenant_id FROM scheduler_notification_tenants()")) await enqueue(t, { tenantId: r.tenant_id, kind: "notifications.scan", dedupeKey: `notify:${r.tenant_id}:${p.now().toISOString().slice(0, 16)}` });
  });
}

/** At most one fan-out in any 20 hours, which keeps it nightly-ish across restarts without a fixed hour. */
async function scheduleUsageNightly(p: Platform) {
  await p.db.withSystem(async t => {
    if (await t.one("SELECT 1 FROM jobs WHERE kind='usage.nightly' AND created_at > now() - interval '20 hours' LIMIT 1")) return;
    await enqueue(t, { tenantId: null, kind: "usage.nightly", dedupeKey: "usage-nightly" });
  });
}
/** Refreshes the usage gauges: what operators see, and what the search index size limit reads. */
async function usageFanOut(p: Platform) {
  await p.db.withSystem(async t => {
    for (const r of await t.query<{ tenant_id: string }>("SELECT tenant_id FROM scheduler_usage_tenants()")) await enqueue(t, { tenantId: r.tenant_id, kind: "usage.tenant_snapshot", dedupeKey: `usage-nightly:${r.tenant_id}` });
  });
}

/** Daily. Suspended tenants too: this looks at DNS and touches nothing of theirs, and a domain can change hands during a suspension. */
async function scheduleDomainRecheck(p: Platform) {
  await p.db.withSystem(async t => {
    if (await t.one("SELECT 1 FROM jobs WHERE kind='domains.recheck' AND created_at > now() - interval '20 hours' LIMIT 1")) return;
    await enqueue(t, { tenantId: null, kind: "domains.recheck", dedupeKey: "domains-recheck" });
  });
}
async function domainFanOut(p: Platform) {
  await p.db.withSystem(async t => {
    for (const r of await t.query<{ tenant_id: string }>("SELECT tenant_id FROM scheduler_domain_tenants()")) await enqueue(t, { tenantId: r.tenant_id, kind: "domains.tenant_recheck", dedupeKey: `domains-recheck:${r.tenant_id}` });
  });
}

/** Liveness for the operator health page. Not tenant data. */
async function workerHeartbeat(p: Platform) {
  await p.db.withSystem(t => t.query("INSERT INTO service_heartbeats(component,last_seen_at) VALUES ('worker',now()) ON CONFLICT (component) DO UPDATE SET last_seen_at=now()"));
}

/** Processes jobs until none are ready. Used by tests and demo seeding. */
export async function drainJobs(p: Platform, max = 1000): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimJob(p);
    if (!job) break;
    await runOne(p, job);
  }
  return n;
}

/** How often a running job renews its lease. Well inside reapStuckJobs' window, so only a dead worker's jobs are reaped. */
const LEASE_RENEW_MS = 30_000;

async function runOne(p: Platform, job: ClaimedJob) {
  // A first sync of a large mailbox runs longer than any fixed lease. Without renewal the reaper would hand the same
  // mailbox to a second loop while the first was still working on it.
  const renew = setInterval(() => { void p.db.withSystem(t => t.query("UPDATE jobs SET locked_at=now() WHERE id=$1 AND state='running'", [job.id])).catch(() => {}); }, LEASE_RENEW_MS);
  try { await runOneLeased(p, job); } finally { clearInterval(renew); }
}

async function runOneLeased(p: Platform, job: ClaimedJob) {
  try { await traced(`job.${job.kind}`, { jobId: job.id, jobKind: job.kind, attempt: job.attempts, traceId: job.trace_id }, () => runJob(p, job)); await finishJob(p, job); }
  catch (e) {
    await finishJob(p, job, e, (j, c) => onDead(p, j, c)).catch(err => p.log.error("job.finish_failed", { jobId: job.id, errorCode: errorCode(err) }));
  }
}

/** Long-running worker loop. Graceful stop via the returned function. */
export function startWorker(p: Platform, opts: { concurrency?: number; pollMs?: number; tickMs?: number } = {}) {
  let stopped = false;
  const concurrency = opts.concurrency ?? 4, pollMs = opts.pollMs ?? 1000, tickMs = opts.tickMs ?? 30_000;
  const loop = async () => {
    while (!stopped) {
      const job = await claimJob(p).catch(() => null);
      if (!job) { await new Promise(r => setTimeout(r, pollMs)); continue; }
      await runOne(p, job);
    }
  };
  const loops = Array.from({ length: concurrency }, loop);
  void workerHeartbeat(p).catch(e => p.log.error("heartbeat.failed", { errorCode: errorCode(e) }));
  const timer = setInterval(() => { void workerHeartbeat(p).catch(e => p.log.error("heartbeat.failed", { errorCode: errorCode(e) })); void tick(p).catch(e => p.log.error("tick.failed", { errorCode: errorCode(e) })); void reapStuckJobs(p).catch(e => p.log.error("reap.failed", { errorCode: errorCode(e) })); void sweepExpired(p).catch(e => p.log.error("sweep.failed", { errorCode: errorCode(e) })); }, tickMs);
  void tick(p).catch(e => p.log.error("tick.failed", { errorCode: errorCode(e) }));
  return { stop: async () => { stopped = true; clearInterval(timer); await Promise.allSettled(loops); } };
}
export { enqueue };
