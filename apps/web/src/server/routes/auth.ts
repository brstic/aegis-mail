import { canReauthWithPassword, suspendedWorkspaces, metricsText, publicSignInOptions, rateLimit, demoSession, disableTotp, removePasskey, beginPasskeyRegistration, beginPasskeySignIn, beginTotpEnrollment, confirmTotp, recoveryCodeStatus, regenerateRecoveryCodes, DEMO_ADMIN, DEMO_LOGIN, DEMO_OPERATOR, finishPasskeyRegistration, finishPasskeySignIn, listPasskeys, listSessions, AppError, revokeSession, signIn, signOut, signUp, switchWorkspace, seedDemo, simulateIncoming, drainJobs } from "@aegis/platform";
import { SignInBody, SignUpBody, PRODUCT_NAME, PRODUCT_NAME_IS_CODENAME } from "@aegis/domain";
import { z } from "zod";
import { platform } from "../platform";
import { clearSessionCookie, clientKey, setSessionCookie, type RouteDef } from "../router";

export const ua = (r: Request) => summarizeUa(r.headers.get("user-agent") ?? "");
/** Coarse device description only. No full UA or IP stored. */
function summarizeUa(s: string) {
  const b = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "Browser";
  const o = /Mac OS X/.test(s) ? "Mac" : /Windows/.test(s) ? "Windows" : /Android/.test(s) ? "Android" : /iPhone|iPad/.test(s) ? "iOS" : /Linux/.test(s) ? "Linux" : "";
  return o ? `${b} on ${o}` : b;
}

/** Adding a way in. The password is left out by people signing in through an identity provider, who need a recent sign-in instead. */
const SecondFactorCode = z.string().regex(/^(\d{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5})$/);
const FactorProofBody = z.object({ password: z.string().max(256).optional(), code: SecondFactorCode.optional() });

export const authRoutes: RouteDef[] = [
  { m: "GET", p: "/health", auth: false, h: async () => { await platform().db.withSystem(t => t.query("SELECT 1")); return { ok: true }; } },
  // Off unless a token is configured, since queue depth is operational detail.
  { m: "GET", p: "/metrics", auth: false, h: async ({ req }) => {
    const want = process.env.AEGIS_METRICS_TOKEN;
    if (!want || req.headers.get("authorization") !== `Bearer ${want}`) throw new AppError(404, "not_found", "Not found");
    return new Response(await metricsText(platform().db), { headers: { "Content-Type": "text/plain; version=0.0.4" } });
  } },
  { m: "GET", p: "/public/config", auth: false, h: async () => {
    const c = platform().config;
    return { signIn: await publicSignInOptions(platform()), signup: c.signup === "invite" && await platform().db.withSystem(t => t.one("SELECT 1 FROM users LIMIT 1")) ? "invite" : "open", mailAvailable: !!platform().mailer, demoMode: c.demoMode, product: PRODUCT_NAME, codename: PRODUCT_NAME_IS_CODENAME, googleConfigured: !!c.google, microsoftConfigured: !!c.microsoft, demoLogin: c.demoMode ? { email: DEMO_LOGIN.email, password: DEMO_LOGIN.password, adminEmail: DEMO_ADMIN.email } : null };
  } },
  { m: "POST", p: "/auth/signup", auth: false, body: SignUpBody, h: async ({ body, req }) => {
    const s = await signUp(platform(), body, ua(req), await clientKey());
    await setSessionCookie(s.token, s.expiresAt);
    return { ok: true, verificationQueued: s.verificationQueued };
  } },
  { m: "POST", p: "/auth/signin", auth: false, body: SignInBody, h: async ({ body, req }) => {
    const s = await signIn(platform(), body, ua(req), await clientKey());
    await setSessionCookie(s.token, s.expiresAt);
    return { ok: true };
  } },
  { m: "POST", p: "/auth/signout", h: async ({ session }) => { await signOut(platform(), session.sessionId); await clearSessionCookie(); return { ok: true }; } },
  { m: "GET", p: "/me", h: async ({ session }) => ({ suspendedWorkspaces: await suspendedWorkspaces(platform(), session.userId), id: session.userId, email: session.email, name: session.name, tenantId: session.tenantId, role: session.role, workspaces: session.workspaces, mfaEnabled: session.mfaEnabled, reauthWithPassword: await canReauthWithPassword(platform(), session.userId), emailVerified: session.emailVerified, mailAvailable: !!platform().mailer, demoMode: platform().config.demoMode }) },
  { m: "POST", p: "/me/workspace", body: z.object({ tenantId: z.string().uuid() }), h: async ({ session, body }) => { await switchWorkspace(platform(), session, body.tenantId); return { ok: true }; } },
  { m: "GET", p: "/auth/sessions", h: async ({ session }) => listSessions(platform(), session.userId, session.sessionId) },
  { m: "DELETE", p: "/auth/sessions/:id", h: async ({ ctx, params }) => { await revokeSession(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/auth/totp/begin", body: FactorProofBody, h: async ({ ctx, session, body }) => beginTotpEnrollment(platform(), ctx, session.email, { password: body.password, totp: body.code }) },
  { m: "POST", p: "/auth/totp/disable", body: z.object({ code: SecondFactorCode }), h: async ({ ctx, session, body }) => {
    const { rotatedToken } = await disableTotp(platform(), ctx, body.code);
    if (rotatedToken) await setSessionCookie(rotatedToken, session.expiresAt);
    return { ok: true };
  } },
  { m: "POST", p: "/auth/passkeys/:id/remove", body: z.object({ code: z.string().regex(/^\d{6}$/).optional() }), h: async ({ ctx, params, body }) => { await removePasskey(platform(), ctx, params.id!, body.code); return { ok: true }; } },
  { m: "POST", p: "/auth/totp/confirm", body: z.object({ code: z.string().regex(/^\d{6}$/) }), h: async ({ ctx, session, body }) => {
    const { rotatedToken, recoveryCodes } = await confirmTotp(platform(), ctx, body.code);
    if (rotatedToken) await setSessionCookie(rotatedToken, session.expiresAt);
    return { ok: true, recoveryCodes };
  } },
  { m: "GET", p: "/auth/totp/recovery-codes", h: async ({ ctx }) => recoveryCodeStatus(platform(), ctx) },
  { m: "POST", p: "/auth/totp/recovery-codes", body: z.object({ code: SecondFactorCode }), h: async ({ ctx, body }) => regenerateRecoveryCodes(platform(), ctx, body.code) },
  { m: "GET", p: "/auth/passkeys", h: async ({ session }) => listPasskeys(platform(), session.userId) },
  { m: "POST", p: "/auth/passkey/register/begin", body: FactorProofBody, h: async ({ ctx, session, body }) => beginPasskeyRegistration(platform(), ctx, session.email, { password: body.password, totp: body.code }) },
  { m: "POST", p: "/auth/passkey/register/finish", body: z.object({ challengeId: z.string().uuid(), response: z.any(), name: z.string().max(60).optional() }), h: async ({ ctx, body }) => { await finishPasskeyRegistration(platform(), ctx, body.challengeId, body.response, body.name); return { ok: true }; } },
  { m: "POST", p: "/auth/passkey/signin/begin", auth: false, h: async () => { const k = await clientKey(); if (k) await rateLimit(platform(), `passkey-begin:${k.slice(0, 64)}`, 60, 300); return beginPasskeySignIn(platform()); } },
  { m: "POST", p: "/auth/passkey/signin/finish", auth: false, body: z.object({ challengeId: z.string().uuid(), response: z.any() }), h: async ({ body, req }) => {
    const s = await finishPasskeySignIn(platform(), body.challengeId, body.response, ua(req));
    await setSessionCookie(s.token, s.expiresAt);
    return { ok: true };
  } },
  // Predictable demo login, only in DEMO_MODE. It's labelled everywhere it appears.
  { m: "POST", p: "/demo/signin", auth: false, body: z.object({ as: z.enum(["member", "admin", "operator"]).default("member") }), h: async ({ body, req }) => {
    const s = await demoSession(platform(), body.as === "operator" ? DEMO_OPERATOR.email : body.as === "admin" ? DEMO_ADMIN.email : DEMO_LOGIN.email, ua(req));
    await setSessionCookie(s.token, s.expiresAt);
    return { ok: true };
  } },
  { m: "POST", p: "/demo/simulate", body: z.object({ index: z.number().int().min(0).optional() }), h: async ({ ctx, body }) => simulateIncoming(platform(), ctx, body.index) },
];
void seedDemo; void drainJobs;
