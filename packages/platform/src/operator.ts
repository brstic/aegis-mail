import type { Tx } from "@aegis/db";
import { AppError, conflict, notFound, type Platform } from "./context";
import { computeLimits, LIMIT_KEYS } from "./limits";
import type { SessionInfo } from "./auth";

/**
 * The people running the service. Hard rule from the product brief: strict content-blind boundaries, with no view-email control,
 * debug endpoint, impersonation, hidden export, raw prompt log or unreviewed override.
 *
 * Everything here goes through db.withOperator, whose role has no table grants, and calls an op.* function. A static test forbids
 * mail tables, envelope access and the tenant contexts in this file and in the route module.
 */
export interface OperatorCtx { userId: string; readonly __operator: true }

export type OperatorGate = { state: "none" } | { state: "needs_mfa" } | { state: "ok"; op: OperatorCtx };

/**
 * Is this session an operator? Answered from platform_admins, independently of any role in any tenant. Outside demo mode this session
 * must have presented a second factor: having one on the account says nothing about whoever holds this session, who may be the person
 * who just enrolled it. Demo-seeded operators are refused outside demo mode, in case a demo database is ever pointed at a real deployment.
 */
export async function operatorGate(p: Platform, session: Pick<SessionInfo, "userId" | "sessionId"> | null): Promise<OperatorGate> {
  if (!session) return { state: "none" };
  const me = await p.db.withOperator(session.userId, t => t.one<{ source: string; totp_enabled: boolean }>("SELECT source, totp_enabled FROM op.whoami()"));
  if (!me) return { state: "none" };
  if (!p.config.demoMode) {
    if (me.source === "demo") return { state: "none" };
    const s = await p.db.withSystem(t => t.one<{ mfa_passed: boolean }>("SELECT mfa_passed FROM sessions WHERE id=$1 AND user_id=$2", [session.sessionId, session.userId]));
    if (s?.mfa_passed !== true) return { state: "needs_mfa" };
  }
  return { state: "ok", op: { userId: session.userId, __operator: true } };
}

/** For route handlers. A non-operator can't tell this route exists. */
export async function requireOperator(p: Platform, session: Pick<SessionInfo, "userId" | "sessionId"> | null): Promise<OperatorCtx> {
  const g = await operatorGate(p, session);
  if (g.state !== "ok") throw notFound();
  return g.op;
}

/** Permission errors from the database get the same answer as the gate. Bad input raised by a function is the operator's to fix. */
async function run<T>(p: Platform, op: OperatorCtx, fn: (t: Tx) => Promise<T>): Promise<T> {
  try { return await p.db.withOperator(op.userId, fn); }
  catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "42501") throw notFound();
    if (code === "22023" || code === "23514") throw new AppError(400, "invalid", (e as Error).message);
    throw e;
  }
}

export async function operatorOverview(p: Platform, op: OperatorCtx) {
  return run(p, op, async t => ({
    tenants: await t.query<any>("SELECT * FROM op.tenant_stats()"),
    users: await t.one<any>("SELECT * FROM op.user_stats(30)"),
    mailboxes: await t.query<any>("SELECT * FROM op.mailbox_stats()"),
    queue: await t.query<any>("SELECT kind, state, error_code \"errorCode\", count FROM op.queue_stats()"),
    sync: await t.one<any>("SELECT * FROM op.sync_stats()"),
  }));
}

export async function operatorTenants(p: Platform, op: OperatorCtx, q: { search?: string; limit?: number; offset?: number } = {}) {
  return run(p, op, t => t.query<any>(`SELECT id, name, kind, members, mailboxes, created_at "createdAt", suspended_at "suspendedAt" FROM op.list_tenants($1,$2,$3)`, [q.search?.trim() || null, q.limit ?? 50, q.offset ?? 0]));
}

export async function operatorTenant(p: Platform, op: OperatorCtx, tenantId: string) {
  const out = await run(p, op, async t => {
    const tenant = await t.one<any>(`SELECT id, name, kind, members, mailboxes, created_at "createdAt", suspended_at "suspendedAt", suspended_reason "suspendedReason" FROM op.tenant_detail($1)`, [tenantId]);
    if (!tenant) return null;
    return {
      tenant,
      mailboxes: await t.query<any>("SELECT * FROM op.tenant_mailboxes($1)", [tenantId]),
      usage: await t.query<any>("SELECT * FROM op.tenant_usage($1)", [tenantId]),
      overrides: await t.query<any>(`SELECT key, value, reason, expires_at "expiresAt", updated_at "updatedAt" FROM op.tenant_overrides($1)`, [tenantId]),
    };
  });
  if (!out) throw notFound();
  // What applies now, and where it comes from. Null is no limit.
  const effective = computeLimits(p.config.limits, out.overrides.map((o: any) => ({ key: o.key, value: o.value, expiresAt: o.expiresAt })), p.now());
  const limits = LIMIT_KEYS.map(key => ({ key, value: effective[key], instanceDefault: p.config.limits?.[key] ?? null, source: effective.overridden.includes(key) ? "override" : p.config.limits?.[key] !== undefined ? "instance" : "none" }));
  return { ...out, limits };
}

/** One owner's name and address, for support, with a reason. Logged for operators and shown in the tenant's own audit log. */
export async function operatorOwnerContact(p: Platform, op: OperatorCtx, tenantId: string, reason: string) {
  const r = await run(p, op, t => t.one<{ name: string; email: string }>("SELECT name, email FROM op.owner_contact($1,$2)", [tenantId, reason]));
  if (!r) throw notFound();
  return r;
}

/** A number is the most allowed for this workspace. Null means no limit here, whatever the instance default says. */
export async function operatorSetOverride(p: Platform, op: OperatorCtx, tenantId: string, input: { key: string; value: number | null; reason: string; expiresAt?: string | null }) {
  await run(p, op, t => t.query("SELECT op.set_override($1,$2,$3,$4,$5)", [tenantId, input.key, JSON.stringify(input.value), input.reason, input.expiresAt ?? null]));
}
export async function operatorClearOverride(p: Platform, op: OperatorCtx, tenantId: string, key: string, reason: string) {
  const r = await run(p, op, t => t.one<{ ok: boolean }>("SELECT op.clear_override($1,$2,$3) ok", [tenantId, key, reason]));
  if (!r?.ok) throw notFound();
}

export async function operatorSuspend(p: Platform, op: OperatorCtx, tenantId: string, reason: string) {
  const r = await run(p, op, t => t.one<{ ok: boolean }>("SELECT op.suspend_tenant($1,$2) ok", [tenantId, reason]));
  if (!r?.ok) throw notFound();
}
export async function operatorUnsuspend(p: Platform, op: OperatorCtx, tenantId: string, reason: string) {
  const r = await run(p, op, t => t.one<{ ok: boolean }>("SELECT op.unsuspend_tenant($1,$2) ok", [tenantId, reason]));
  if (!r?.ok) throw conflict("not_suspended", "This tenant isn't suspended.");
}

export async function operatorJobs(p: Platform, op: OperatorCtx, state: "dead" | "queued" | "running") {
  return run(p, op, t => t.query<any>(`SELECT id, kind, state, attempts, max_attempts "maxAttempts", error_code "errorCode", created_at "createdAt", finished_at "finishedAt" FROM op.list_jobs($1,100)`, [state]));
}
export async function operatorRetryJob(p: Platform, op: OperatorCtx, id: string) {
  const r = await run(p, op, t => t.one<{ outcome: string }>("SELECT op.retry_job($1) outcome", [id]));
  if (r?.outcome === "not_dead") throw conflict("not_dead", "Only dead jobs can be retried.");
  if (r?.outcome === "already_queued") throw conflict("already_queued", "The same work is already queued.");
}

const WORKER_STALE_MS = 3 * 60_000;
/** Configuration as yes or no. No key, host or secret value leaves this function. */
export async function operatorHealth(p: Platform, op: OperatorCtx) {
  const beats = await run(p, op, t => t.query<{ component: string; last_seen_at: Date }>("SELECT * FROM op.heartbeats()"));
  const worker = beats.find(b => b.component === "worker");
  const deletionLog = beats.find(b => b.component === "deletion_log");
  const now = p.now().getTime();
  const fresh = (d?: Date) => !!d && now - new Date(d).getTime() < WORKER_STALE_MS;
  return {
    database: { ok: true },
    worker: { ok: fresh(worker?.last_seen_at), lastSeenAt: worker?.last_seen_at ?? null },
    scanner: { configured: !!p.config.clamd, kind: p.config.clamd ? "clamd" : "baseline" },
    kms: { type: p.kms.id.split(":")[0]! },
    hostedAi: { configured: !!p.config.anthropicApiKey },
    limits: { instanceDefaults: Object.fromEntries(LIMIT_KEYS.map(k => [k, p.config.limits?.[k] ?? null])) },
    mail: { configured: !!p.mailer },
    // From the worker, which is the process that ships it. A worker with no sink never writes this, and one that's fallen behind stops.
    deletionLog: { configured: !!deletionLog, ok: fresh(deletionLog?.last_seen_at), lastSeenAt: deletionLog?.last_seen_at ?? null },
    demoMode: p.config.demoMode,
  };
}

export async function operatorAudit(p: Platform, op: OperatorCtx, q: { limit?: number; before?: number } = {}) {
  return run(p, op, t => t.query<any>(`SELECT id, at, operator_name "operator", action, tenant_id "tenantId", tenant_name "tenant", target, reason, meta FROM op.audit_log($1,$2)`, [q.limit ?? 100, q.before ?? null]));
}

// ---------- Granting access. CLI and seed only, on the migrating connection. No web or worker login can call these. ----------
const norm = (e: string) => e.trim().toLowerCase();

/**
 * Binds an operator to an existing account whose address has been verified, so someone can't claim the role by signing up with a
 * listed address first. The grant holds the user ID: changing the address later doesn't move it.
 */
export async function grantOperator(p: Platform, email: string, source: "env" | "cli" | "demo" = "cli"): Promise<{ outcome: "granted" | "no_account" | "unverified"; userId?: string; mfa?: boolean }> {
  const u = await p.db.withSystem(t => t.one<{ id: string; email_verified_at: Date | null; totp_enabled: boolean }>("SELECT id, email_verified_at, totp_enabled FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [norm(email)]));
  if (!u) return { outcome: "no_account" };
  if (!u.email_verified_at) return { outcome: "unverified", userId: u.id };
  await p.db.withSystem(t => t.query("SELECT op.cli_grant($1,$2)", [u.id, source]));
  return { outcome: "granted", userId: u.id, mfa: u.totp_enabled };
}
export async function revokeOperator(p: Platform, email: string) {
  const u = await p.db.withSystem(t => t.one<{ id: string }>("SELECT id FROM users WHERE lower(email)=$1", [norm(email)]));
  if (!u) return false;
  return (await p.db.withSystem(t => t.one<{ ok: boolean }>("SELECT op.cli_revoke($1,NULL) ok", [u.id])))?.ok === true;
}
/** Makes env-sourced operators match AEGIS_PLATFORM_ADMINS. Operators granted by name through the CLI aren't touched. */
export async function syncOperatorsFromEnv(p: Platform, list: string | undefined) {
  const emails = [...new Set((list ?? "").split(",").map(norm).filter(Boolean))];
  const results: { email: string; outcome: string; mfa?: boolean }[] = [];
  const keep = new Set<string>();
  for (const email of emails) {
    const r = await grantOperator(p, email, "env");
    results.push({ email, outcome: r.outcome, mfa: r.mfa });
    if (r.userId && r.outcome === "granted") keep.add(r.userId);
  }
  const current = await p.db.withSystem(t => t.query<{ user_id: string; source: string; revoked_at: Date | null; email: string }>("SELECT * FROM op.cli_list()"));
  for (const c of current) {
    if (c.source === "env" && !c.revoked_at && !keep.has(c.user_id)) {
      await p.db.withSystem(t => t.query("SELECT op.cli_revoke($1,'env')", [c.user_id]));
      results.push({ email: c.email, outcome: "revoked" });
    }
  }
  return results;
}
export const listOperators = (p: Platform) => p.db.withSystem(t => t.query<{ user_id: string; source: string; revoked_at: Date | null; email: string }>("SELECT * FROM op.cli_list()"));
