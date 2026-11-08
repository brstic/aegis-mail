import { AppError, errorCode, rateLimit, resolveSession, type Ctx, type SessionInfo } from "@aegis/platform";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { platform } from "./platform";

export const COOKIE = "aegis_session";

export interface RouteArgs<B = any, Q = any> { ctx: Ctx; session: SessionInfo; params: Record<string, string>; body: B; query: Q; req: Request }
export interface RouteDef {
  m: "GET" | "POST" | "PATCH" | "DELETE";
  p: string;
  /** Default true. Public routes must opt out explicitly. */
  auth?: boolean;
  /** Webhooks authenticate by their own means and have no browser Origin. */
  skipOrigin?: boolean;
  /** Bytes. Defaults to 1 MB. */
  maxBody?: number;
  body?: z.ZodType;
  query?: z.ZodType;
  h: (a: RouteArgs) => Promise<unknown>;
}

function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean), b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) out[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}

/** App Router handlers have no default body limit, and some of these routes are unauthenticated. */
export async function readLimited(req: Request, limit: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > limit) throw new AppError(413, "too_large", "That request is too large.");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new AppError(413, "too_large", "That request is too large."); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

const UUID_PARAM = /^(id|threadId|messageId|accountId)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setSessionCookie(token: string, expires: Date) {
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires });
}
export async function clearSessionCookie() { (await cookies()).delete(COOKIE); }

/**
 * For rate limiting only. Next sets x-forwarded-for from the socket when absent, but a client can supply its own unless a
 * trusted proxy overwrites it, so per-client limits are best effort and a higher per-email ceiling backs them up.
 */
export async function clientKey(): Promise<string | undefined> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",").at(-1)?.trim() || undefined;
}

export async function currentSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? resolveSession(platform(), token) : null;
}

export function dispatcher(routes: RouteDef[]) {
  return async function handle(req: Request, ctxArg: { params: Promise<{ path: string[] }> }) {
    const started = Date.now();
    const p = platform();
    const path = `/${(await ctxArg.params).path.join("/")}`;
    let routeName = "unmatched";
    try {
      const candidates = routes.filter(r => match(r.p, path));
      const route = candidates.find(r => r.m === req.method);
      if (!route) return json({ error: { code: candidates.length ? "method_not_allowed" : "not_found", message: "Not found" } }, candidates.length ? 405 : 404);
      routeName = route.p;
      const params = match(route.p, path)!;
      // Malformed IDs get the same answer as a missing row, and never reach a uuid cast.
      for (const [k, v] of Object.entries(params)) if (UUID_PARAM.test(k) && !UUID.test(v)) throw new AppError(404, "not_found", "Not found");

      // CSRF: state-changing browser requests must come from our own origin. SameSite=Lax is a second layer.
      if (req.method !== "GET" && !route.skipOrigin) {
        const origin = req.headers.get("origin");
        const expected = new URL(p.config.appOrigin).origin;
        const host = (await headers()).get("host");
        const sameHost = !!origin && !!host && new URL(origin).host === host;
        if (origin !== expected && !sameHost) throw new AppError(403, "bad_origin", "This request didn't come from the app.");
      }
      let session: SessionInfo | null = null;
      if (route.auth !== false) {
        session = await currentSession();
        if (!session) throw new AppError(401, "unauthenticated", "Sign in to continue.");
        // Per-session ceiling on writes, so a stuck client or stolen session can't hammer providers through us.
        if (req.method !== "GET") await rateLimit(p, `api:${session.sessionId}`, 600, 60);
      }
      let body: unknown;
      if (route.body) {
        const text = await readLimited(req, route.maxBody ?? 1_000_000);
        let raw: unknown;
        try { raw = JSON.parse(text); } catch { throw new AppError(400, "bad_json", "Couldn't read that request."); }
        const r = route.body.safeParse(raw);
        if (!r.success) throw new AppError(400, "invalid", r.error.issues[0]?.message ?? "That doesn't look right.");
        body = r.data;
      }
      let query: unknown;
      if (route.query) {
        const r = route.query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
        if (!r.success) throw new AppError(400, "invalid", r.error.issues[0]?.message ?? "That doesn't look right.");
        query = r.data;
      }
      const ctx = session ? { tenantId: session.tenantId, userId: session.userId, sessionId: session.sessionId } : (undefined as unknown as Ctx);
      const out = await route.h({ ctx, session: session as SessionInfo, params, body, query, req });
      if (out instanceof Response) return out;
      return json(out ?? { ok: true }, 200);
    } catch (e) {
      if (e instanceof AppError) {
        if (e.status === 403 || e.status === 404) p.log.info("http.denied", { route: routeName, status: e.status, errorCode: e.code });
        return json({ error: { code: e.code, message: e.message } }, e.status);
      }
      // RLS refused a write that the service layer didn't catch first. That's a permissions answer, not a server error.
      if ((e as { code?: string })?.code === "42501") return json({ error: { code: "read_only_access", message: "You don't have permission to change this." } }, 403);
      // Internal detail stays in the logs, by name only.
      p.log.error("http.error", { route: routeName, errorCode: errorCode(e), latencyMs: Date.now() - started });
      return json({ error: { code: "internal", message: "Something went wrong on our side. Your data wasn't changed." } }, 500);
    }
  };
}

function json(v: unknown, status: number) {
  return NextResponse.json(v, { status, headers: { "Cache-Control": "no-store" } });
}
