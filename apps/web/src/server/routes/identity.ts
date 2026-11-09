import * as P from "@aegis/platform";
import { AppError } from "@aegis/platform";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { platform } from "../platform";
import { clientKey, readLimited, secureCookies, setSessionCookie, type RouteDef } from "../router";
import { ua } from "./auth";

/** Holds a value the browser that started a sign-in must present to finish it. See flowKey in sso.ts. */
const FLOW_COOKIE = "aegis_sso_flow";
const redirectTo = (path: string) => NextResponse.redirect(new URL(path, platform().config.appOrigin), { status: 302, headers: { "Cache-Control": "no-store" } });
/** After a POST, so the browser follows with a GET. */
const seeOther = (path: string) => NextResponse.redirect(new URL(path, platform().config.appOrigin), { status: 303, headers: { "Cache-Control": "no-store" } });
const signInError = (code: string) => redirectTo(`/sign-in?error=${encodeURIComponent(code)}`);

/** A SAML response arrives as a cross-site POST, which a Lax cookie wouldn't come with. The value is useless without its flow row. */
async function setFlowCookie(binding: string, protocol?: string) {
  const saml = protocol === "saml";
  (await cookies()).set(FLOW_COOKIE, binding, { httpOnly: true, sameSite: saml ? "none" : "lax", secure: saml || secureCookies(), path: "/api/v1/auth", maxAge: 600 });
}

const Token = z.string().min(16).max(128);
const Sso = z.object({
  domain: z.string().min(3).max(253),
  issuer: z.string().url().max(500),
  clientId: z.string().min(1).max(300),
  clientSecret: z.string().min(1).max(2000).optional(),
  jitEnabled: z.boolean().optional(),
  jitRole: z.enum(["member", "workspace_manager", "security_admin"]).optional(),
  enabled: z.boolean().optional(),
});

export const identityRoutes: RouteDef[] = [
  // ---------- Address verification and password reset ----------
  { m: "POST", p: "/auth/verify/resend", h: async ({ ctx }) => P.resendVerification(platform(), ctx) },
  { m: "POST", p: "/auth/verify/confirm", auth: false, body: z.object({ token: Token }), h: async ({ body }) => { await P.confirmEmail(platform(), body.token, await clientKey()); return { ok: true }; } },
  { m: "POST", p: "/auth/password/forgot", auth: false, body: z.object({ email: z.string().email().max(254) }), h: async ({ body }) => { await P.requestPasswordReset(platform(), body.email, await clientKey()); return { ok: true }; } },
  { m: "POST", p: "/auth/password/reset", auth: false, body: z.object({ token: Token, password: z.string().min(12).max(256), totp: z.string().regex(/^(\d{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5})$/).optional() }), h: async ({ body }) => { await P.resetPassword(platform(), body, await clientKey()); return { ok: true }; } },

  // ---------- Federated sign-in ----------
  { m: "GET", p: "/auth/sso/start", auth: false, query: z.object({ email: z.string().max(254).optional(), next: z.string().max(500).optional() }), h: async ({ query }) => {
    try {
      const s = query.email ? await P.beginSso(platform(), { email: query.email, next: query.next }, await clientKey()) : null;
      if (!s) return signInError("sso_not_available");
      await setFlowCookie(s.binding, s.protocol);
      return NextResponse.redirect(s.url, { status: 302, headers: { "Cache-Control": "no-store" } });
    } catch (e) { if (e instanceof AppError) return signInError(e.code); throw e; }
  } },
  { m: "GET", p: "/auth/social/:provider/start", auth: false, query: z.object({ next: z.string().max(500).optional() }), h: async ({ params, query }) => {
    try {
      const s = await P.beginSocial(platform(), params.provider!, query.next, await clientKey());
      await setFlowCookie(s.binding);
      return NextResponse.redirect(s.url, { status: 302, headers: { "Cache-Control": "no-store" } });
    } catch (e) { if (e instanceof AppError && e.status === 429) return signInError(e.code); throw e; }
  } },
  { m: "GET", p: "/auth/sso/callback", auth: false, h: async ({ req }) => {
    const jar = await cookies();
    const binding = jar.get(FLOW_COOKIE)?.value;
    jar.delete({ name: FLOW_COOKIE, path: "/api/v1/auth" });
    try {
      const r = await P.finishSso(platform(), new URL(req.url).searchParams, binding, ua(req), await clientKey());
      if (r.kind === "mfa") return redirectTo(`/sign-in?mfa_ticket=${encodeURIComponent(r.ticket)}${r.next ? `&next=${encodeURIComponent(r.next)}` : ""}`);
      await setSessionCookie(r.token, r.expiresAt);
      return redirectTo(r.next ?? "/app");
    } catch (e) { if (e instanceof AppError) return signInError(e.code); throw e; }
  } },
  // The identity provider's page posts this form, so it has that page's Origin. A browser cookie and a single-use request ID protect it instead.
  { m: "POST", p: "/auth/saml/:domain/acs", auth: false, skipOrigin: true, h: async ({ req, params }) => {
    const jar = await cookies();
    const binding = jar.get(FLOW_COOKIE)?.value;
    jar.delete({ name: FLOW_COOKIE, path: "/api/v1/auth" });
    try {
      const form = new URLSearchParams(await readLimited(req, 1_000_000));
      const r = await P.finishSaml(platform(), params.domain!, form.get("SAMLResponse") ?? "", binding, ua(req), await clientKey());
      if (r.kind === "mfa") return seeOther(`/sign-in?mfa_ticket=${encodeURIComponent(r.ticket)}${r.next ? `&next=${encodeURIComponent(r.next)}` : ""}`);
      await setSessionCookie(r.token, r.expiresAt);
      return seeOther(r.next ?? "/app");
    } catch (e) { if (e instanceof AppError) return seeOther(`/sign-in?error=${encodeURIComponent(e.code)}`); throw e; }
  } },
  { m: "POST", p: "/auth/sso/mfa", auth: false, body: z.object({ ticket: Token, code: z.string().regex(/^(\d{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5})$/) }), h: async ({ body, req }) => {
    const s = await P.finishSsoMfa(platform(), body, ua(req));
    await setSessionCookie(s.token, s.expiresAt);
    return { ok: true };
  } },

  // ---------- Organization SSO and SCIM settings ----------
  { m: "GET", p: "/org/sso", h: async ({ ctx }) => P.ssoOverview(platform(), ctx) },
  { m: "POST", p: "/org/sso", body: Sso, h: async ({ ctx, body }) => P.saveSsoConfig(platform(), ctx, body) },
  { m: "POST", p: "/org/sso/saml", body: z.object({ domain: z.string().min(3).max(253), idpEntityId: z.string().min(1).max(500), entryPoint: z.string().url().max(1000), idpCert: z.string().min(16).max(20_000), jitEnabled: z.boolean().optional(), jitRole: Sso.shape.jitRole, enabled: z.boolean().optional() }), h: async ({ ctx, body }) => P.saveSamlConfig(platform(), ctx, body) },
  { m: "POST", p: "/org/sso/:id/enforce", body: z.object({ enforced: z.boolean() }), h: async ({ ctx, params, body }) => { await P.setSsoEnforced(platform(), ctx, params.id!, body.enforced); return { ok: true }; } },
  { m: "DELETE", p: "/org/sso/:id", h: async ({ ctx, params }) => { await P.removeSsoConfig(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/org/scim/token", h: async ({ ctx }) => P.rotateScimToken(platform(), ctx) },
  { m: "DELETE", p: "/org/scim/token", h: async ({ ctx }) => { await P.revokeScimToken(platform(), ctx); return { ok: true }; } },

  // ---------- Notifications ----------
  { m: "GET", p: "/notifications", h: async ({ ctx }) => P.listNotifications(platform(), ctx) },
  { m: "POST", p: "/notifications/read-all", h: async ({ ctx }) => { await P.markAllNotificationsRead(platform(), ctx); return { ok: true }; } },
  { m: "POST", p: "/notifications/:id/read", h: async ({ ctx, params }) => { await P.markNotificationRead(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/tasks/:id/remind", body: z.object({ remindAt: z.string().datetime().nullable() }), h: async ({ ctx, params, body }) => { await P.setTaskReminder(platform(), ctx, params.id!, body.remindAt ? new Date(body.remindAt) : null); return { ok: true }; } },
];
