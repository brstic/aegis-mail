import * as P from "@aegis/platform";
import { AppError, rateLimit, type OperatorCtx } from "@aegis/platform";
import { z } from "zod";
import { platform } from "../platform";
import { currentSession, readLimited, type RouteArgs, type RouteDef } from "../router";

/**
 * The operator console's API. The people running the service, not tenant admins. There's deliberately nothing here that reaches
 * message content: no mail tables, no thread reads, no sealed data, no acting as a user. A static test holds this file to that.
 *
 * Every route declares auth: false and checks for itself, so a non-operator gets the same 404 as a path that doesn't exist, signed in
 * or not. Bodies and queries are parsed only after that check, so bad input from a non-operator can't show a route exists either.
 */
function route<B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined>(
  m: RouteDef["m"], path: string,
  opts: { body?: B; query?: Q },
  h: (a: { op: OperatorCtx; params: Record<string, string>; body: B extends z.ZodType ? z.infer<B> : undefined; query: Q extends z.ZodType ? z.infer<Q> : undefined }) => Promise<unknown>,
): RouteDef {
  return {
    m, p: `/operator${path}`, auth: false,
    h: async (a: RouteArgs) => {
      const session = await currentSession();
      const p = platform();
      const op = await P.requireOperator(p, session);
      if (m !== "GET") await rateLimit(p, `operator:${session!.sessionId}`, 120, 60);
      let body: unknown;
      if (opts.body) {
        let raw: unknown;
        try { raw = JSON.parse(await readLimited(a.req, 16_000)); } catch { throw new AppError(400, "bad_json", "Couldn't read that request."); }
        const r = opts.body.safeParse(raw);
        if (!r.success) throw new AppError(400, "invalid", r.error.issues[0]?.message ?? "That doesn't look right.");
        body = r.data;
      }
      let query: unknown;
      if (opts.query) {
        const r = opts.query.safeParse(Object.fromEntries(new URL(a.req.url).searchParams));
        if (!r.success) throw new AppError(400, "invalid", r.error.issues[0]?.message ?? "That doesn't look right.");
        query = r.data;
      }
      return h({ op, params: a.params, body: body as never, query: query as never });
    },
  };
}

const Reason = z.string().trim().min(3, "Give a reason of at least a few words.").max(500);
const LimitKey = z.enum(P.LIMIT_KEYS);

export const operatorRoutes: RouteDef[] = [
  route("GET", "/overview", {}, ({ op }) => P.operatorOverview(platform(), op)),
  route("GET", "/tenants", { query: z.object({ search: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }) }, ({ op, query }) => P.operatorTenants(platform(), op, query)),
  route("GET", "/tenants/:id", {}, ({ op, params }) => P.operatorTenant(platform(), op, params.id!)),
  route("POST", "/tenants/:id/owner-contact", { body: z.object({ reason: Reason }) }, ({ op, params, body }) => P.operatorOwnerContact(platform(), op, params.id!, body.reason)),
  route("POST", "/tenants/:id/overrides", { body: z.object({ key: LimitKey, value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), reason: Reason, expiresAt: z.string().datetime().nullable().optional() }) }, async ({ op, params, body }) => { await P.operatorSetOverride(platform(), op, params.id!, body); return { ok: true }; }),
  route("POST", "/tenants/:id/overrides/clear", { body: z.object({ key: LimitKey, reason: Reason }) }, async ({ op, params, body }) => { await P.operatorClearOverride(platform(), op, params.id!, body.key, body.reason); return { ok: true }; }),
  route("POST", "/tenants/:id/suspend", { body: z.object({ reason: Reason }) }, async ({ op, params, body }) => { await P.operatorSuspend(platform(), op, params.id!, body.reason); return { ok: true }; }),
  route("POST", "/tenants/:id/unsuspend", { body: z.object({ reason: Reason }) }, async ({ op, params, body }) => { await P.operatorUnsuspend(platform(), op, params.id!, body.reason); return { ok: true }; }),
  route("GET", "/jobs", { query: z.object({ state: z.enum(["dead", "queued", "running"]).default("dead") }) }, ({ op, query }) => P.operatorJobs(platform(), op, query.state)),
  route("POST", "/jobs/:id/retry", {}, async ({ op, params }) => { await P.operatorRetryJob(platform(), op, params.id!); return { ok: true }; }),
  route("GET", "/health", {}, ({ op }) => P.operatorHealth(platform(), op)),
  route("GET", "/audit", { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100), before: z.coerce.number().int().positive().optional() }) }, ({ op, query }) => P.operatorAudit(platform(), op, query)),
];
