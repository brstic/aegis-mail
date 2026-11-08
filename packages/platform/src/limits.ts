import type { Tx } from "@aegis/db";
import { AppError, type Ctx, type Platform } from "./context";

/**
 * Instance limits. A self-hosted server has none unless its admin sets them: every limit is `null`, meaning no limit, until an
 * instance-wide default is set through the environment (AEGIS_LIMIT_*) or the operator console sets one for a single workspace.
 * An operator's setting for a workspace wins over the instance default, and can itself be "no limit".
 *
 * Over-limit workspaces keep everything they have. A limit only refuses something new. Safety features aren't limits and are
 * always on: nothing here can reach security warnings, analysis, Quarantine or export.
 */
export const LIMIT_KEYS = ["accounts", "aiActionsPerMonth", "automations", "seats", "indexBytes"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export const isLimitKey = (v: unknown): v is LimitKey => typeof v === "string" && (LIMIT_KEYS as readonly string[]).includes(v);

/** A number is the most allowed. `null` means no limit. */
export type Limit = number | null;
export type Limits = Record<LimitKey, Limit>;

/** The environment variable for each limit. Unset or empty means no limit. */
export const LIMIT_ENV: Record<LimitKey, string> = {
  accounts: "AEGIS_LIMIT_ACCOUNTS",
  aiActionsPerMonth: "AEGIS_LIMIT_AI_ACTIONS_PER_MONTH",
  automations: "AEGIS_LIMIT_AUTOMATIONS",
  seats: "AEGIS_LIMIT_SEATS",
  indexBytes: "AEGIS_LIMIT_INDEX_BYTES",
};

export const UNLIMITED: Limits = { accounts: null, aiActionsPerMonth: null, automations: null, seats: null, indexBytes: null };

/** Reads instance defaults. A value that isn't a whole number of zero or more stops the server from starting, rather than being ignored. */
export function limitsFromEnv(env: NodeJS.ProcessEnv): Partial<Limits> {
  const out: Partial<Limits> = {};
  for (const key of LIMIT_KEYS) {
    const raw = env[LIMIT_ENV[key]]?.trim();
    if (!raw) continue;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${LIMIT_ENV[key]} must be a whole number of zero or more, or unset for no limit.`);
    out[key] = Number(raw);
  }
  return out;
}

export interface LimitOverride { key: string; value: unknown; expiresAt: Date | null }

/** Pure, so the precedence is testable without a database: an operator's unexpired setting, then the instance default, then no limit. */
export function computeLimits(defaults: Partial<Limits> | undefined, overrides: LimitOverride[], now: Date): Limits & { overridden: LimitKey[] } {
  const out: Limits & { overridden: LimitKey[] } = { ...UNLIMITED, ...defaults, overridden: [] };
  for (const o of overrides) {
    if (!isLimitKey(o.key)) continue;
    if (o.expiresAt && o.expiresAt.getTime() <= now.getTime()) continue;
    if (o.value === null) out[o.key] = null;
    else if (typeof o.value === "number" && Number.isFinite(o.value) && o.value >= 0) out[o.key] = o.value;
    else continue;
    out.overridden.push(o.key);
  }
  return out;
}

export async function readOverrides(t: Tx, tenantId: string): Promise<LimitOverride[]> {
  const rows = await t.query<{ key: string; value: unknown; expires_at: Date | null }>("SELECT key, value, expires_at FROM tenant_limit_overrides WHERE tenant_id=$1", [tenantId]);
  return rows.map(r => ({ key: r.key, value: r.value, expiresAt: r.expires_at }));
}

/** The one place limits are worked out. Every check below goes through this. */
export async function limitsFor(p: Platform, tenantId: string) {
  const overrides = await p.db.withUsage(t => readOverrides(t, tenantId));
  return computeLimits(p.config.limits, overrides, p.now());
}

export const limitReached = (message: string) => new AppError(403, "limit_reached", message);
const ADMIN = "The server admin can raise it.";
const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

// ---------- Usage. Counted whether or not a limit is set, so operators can see it. ----------
export type CounterMetric = "ai_actions";
export const usagePeriod = (d: Date) => d.toISOString().slice(0, 7);

/** Adds to a usage counter. Any process can call this. */
export async function incrementUsage(p: Platform, tenantId: string, metric: CounterMetric, n = 1): Promise<number> {
  const r = await p.db.withSystem(t => t.one<{ value: number | null }>("SELECT usage_increment($1,$2,$3,$4) AS value", [tenantId, usagePeriod(p.now()), metric, n]));
  return r?.value ?? 0;
}

export async function usageFor(p: Platform, tenantId: string) {
  const period = usagePeriod(p.now());
  return p.db.withUsage(async t => {
    const rows = await t.query<{ metric: string; value: number }>("SELECT metric, value FROM usage_counters WHERE tenant_id=$1 AND period=$2", [tenantId, period]);
    const facts = await t.one<{ seats: number; active_mailboxes: number }>("SELECT * FROM usage_tenant_facts($1)", [tenantId]);
    const v = (m: string) => rows.find(r => r.metric === m)?.value ?? 0;
    return { period, aiActions: v("ai_actions"), indexBytes: v("index_bytes"), seats: facts?.seats ?? 0, activeMailboxes: facts?.active_mailboxes ?? 0 };
  });
}

/** Refreshes the gauges the operator console shows, and the one the index size limit reads. Index size is an estimate from column sizes. */
export async function snapshotUsage(p: Platform, tenantId: string) {
  const bytes = await p.db.withWorker(tenantId, t => t.one<{ b: number }>("SELECT COALESCE(sum(pg_column_size(tsv)),0)::bigint b FROM message_search"));
  const period = usagePeriod(p.now());
  await p.db.withUsage(async t => {
    const f = await t.one<{ seats: number; active_mailboxes: number }>("SELECT * FROM usage_tenant_facts($1)", [tenantId]);
    for (const [metric, value] of [["index_bytes", bytes?.b ?? 0], ["seats", f?.seats ?? 0], ["active_mailboxes", f?.active_mailboxes ?? 0]] as const) {
      await t.query("INSERT INTO usage_counters(tenant_id,period,metric,value) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,period,metric) DO UPDATE SET value=EXCLUDED.value", [tenantId, period, metric, value]);
    }
  });
}

// ---------- Checks. Each one is a no-op when its limit is null. ----------

/**
 * Counts one hosted AI action. Local rules cost nothing and aren't counted, so reaching the cap never removes summaries,
 * and it never touches security analysis.
 */
export async function countAiAction(p: Platform, ctx: Pick<Ctx, "tenantId">) {
  const [l, used] = await Promise.all([limitsFor(p, ctx.tenantId), incrementUsage(p, ctx.tenantId, "ai_actions", 1)]);
  if (l.aiActionsPerMonth !== null && used > l.aiActionsPerMonth) throw limitReached(`This workspace's limit is ${plural(l.aiActionsPerMonth, "hosted AI action", "hosted AI actions")} a month. ${ADMIN} On-device features still work, and security checks aren't affected.`);
}

export async function checkAccountLimit(p: Platform, ctx: Ctx) {
  const l = await limitsFor(p, ctx.tenantId);
  if (l.accounts !== null) {
    const own = await p.db.withUser(ctx, t => t.one<{ c: number }>("SELECT count(*)::int c FROM mail_accounts WHERE status<>'disconnected' AND owner_user_id=$1", [ctx.userId]));
    if ((own?.c ?? 0) >= l.accounts) throw limitReached(`This workspace's limit is ${plural(l.accounts, "connected account", "connected accounts")}. ${ADMIN}`);
  }
  if (l.indexBytes !== null) {
    const usage = await usageFor(p, ctx.tenantId);
    if (usage.indexBytes >= l.indexBytes) throw limitReached(`This workspace has reached its search index size limit. Existing mailboxes keep working. ${ADMIN}`);
  }
}

export async function checkAutomationLimit(p: Platform, ctx: Ctx) {
  const l = await limitsFor(p, ctx.tenantId);
  if (l.automations === null) return;
  const r = await p.db.withUser(ctx, t => t.one<{ c: number }>("SELECT count(*)::int c FROM automations WHERE user_id=$1", [ctx.userId]));
  if ((r?.c ?? 0) >= l.automations) throw limitReached(`This workspace's limit is ${plural(l.automations, "rule", "rules")} per person. Existing rules keep working. ${ADMIN}`);
}

export const seatLimitMessage = (seats: number) => `This workspace's limit is ${plural(seats, "member", "members")}, and every place is taken. ${ADMIN}`;

/** Inviting someone. Pending invitations hold a place. */
export async function checkSeatLimit(p: Platform, ctx: Ctx) {
  const l = await limitsFor(p, ctx.tenantId);
  if (l.seats === null) return;
  const used = await p.db.withUser(ctx, t => t.one<{ c: number }>("SELECT (SELECT count(*) FROM memberships)::int + (SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND expires_at>now())::int c"));
  if ((used?.c ?? 0) >= l.seats) throw limitReached(`${seatLimitMessage(l.seats)} Current members keep their access.`);
}

/**
 * Whether one more person fits. Call inside the transaction that adds them, with `seats` read beforehand. The lock serializes adding
 * people to this tenant until that transaction ends, so two sign-ins can't both see the last free place. Pending invitations hold a
 * place, as they do in checkSeatLimit, except one meant for this same person. With no limit there's nothing to check or lock.
 */
export async function seatAvailable(t: Tx, tenantId: string, seats: Limit, email: string) {
  if (seats === null) return true;
  await t.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 727002))", [`seats:${tenantId}`]);
  const r = await t.one<{ used: number }>("SELECT (SELECT count(*) FROM memberships WHERE tenant_id=$1)::int + (SELECT count(*) FROM invitations WHERE tenant_id=$1 AND accepted_at IS NULL AND expires_at>now() AND lower(email)<>lower($2))::int used", [tenantId, email]);
  return (r?.used ?? 0) < seats;
}

/** What a signed-in person sees: the limits that apply to them, and how much of each is used. Null limits are shown as none. */
export async function getLimits(p: Platform, ctx: Ctx) {
  const [l, usage, own] = await Promise.all([
    limitsFor(p, ctx.tenantId), usageFor(p, ctx.tenantId),
    p.db.withUser(ctx, t => t.one<{ c: number }>("SELECT count(*)::int c FROM mail_accounts WHERE status<>'disconnected' AND owner_user_id=$1", [ctx.userId])),
  ]);
  const { overridden: _o, ...limits } = l;
  return { limits, usage: { accounts: own?.c ?? 0, aiActions: usage.aiActions, seats: usage.seats, indexBytes: usage.indexBytes } };
}
