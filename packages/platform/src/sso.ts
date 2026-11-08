import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import * as oauth from "oauth4webapi";
import type { Tx } from "@aegis/db";
import { randomToken } from "@aegis/cryptography";
import { checkHttpsHost, HostBlockedError, type PinnedHost } from "@aegis/mail-adapters/ssrf";
import { audit } from "./audit";
import { limitsFor, seatAvailable, type Limit } from "./limits";
import { createSession, createWorkspace, rateLimit, signupAllowed, ssoEnforcedFor, verifyUserTotp } from "./auth";
import { AppError, badRequest, conflict, type Ctx, notFound, type Platform, type SocialClient } from "./context";
import { neutralizeUnverifiedAccount } from "./identity";
import { errorCode } from "./log";
import { openWithKey, sealWithKey } from "./mailer";
import { requireRole } from "./org";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (e: string) => e.trim().toLowerCase();
export const FLOW_MINUTES = 10;

export const SSO_MESSAGES: Record<string, string> = {
  sso_state_invalid: "That sign-in attempt expired or didn't start in this browser. Try again.",
  sso_denied: "Your identity provider didn't complete the sign-in, so you weren't signed in.",
  sso_token_invalid: "We couldn't verify the response from your identity provider, so you weren't signed in.",
  sso_email_unverified: "Your identity provider didn't confirm this email address, so you weren't signed in. An administrator may need to change what it sends.",
  sso_domain_mismatch: "That identity provider can't sign people in with this email domain.",
  signup_closed: "This server takes new accounts by invitation. Ask someone who runs a workspace here to invite your address.",
  sso_account_exists: "An account with this email already exists. Sign in with your password or passkey instead. We don't link accounts by email here, because that could let someone else take yours.",
  sso_not_provisioned: "You don't have access to this organization yet. Ask an administrator to add you.",
  sso_seat_limit: "This organization has reached its member limit, so you can't be added yet. Ask an administrator to free a place, or the server admin to raise the limit. Nothing about your account changed.",
  sso_not_available: "Single sign-on isn't set up for that email domain.",
  sso_required: "Your organization requires single sign-on for this email address.",
  sso_no_email: "The identity provider didn't share an email address, so you weren't signed in.",
  rate_limited: "Too many attempts. Try again in a few minutes.",
};
/** Codes only come from this table, so nothing from the query string is ever shown. */
export const ssoErrorMessage = (code: string | undefined | null) => (code && Object.hasOwn(SSO_MESSAGES, code) ? SSO_MESSAGES[code]! : null);
export const refuse = (code: keyof typeof SSO_MESSAGES & string, status = 400) => new AppError(status, code, SSO_MESSAGES[code]!);

/** Same rule as the sign-in pages: same-site paths into the app or an invitation, so this can't become an open redirect. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== "string") return null;
  return /^\/(app(\/|$)|invite\/)[^\\]*$/.test(next) && !next.startsWith("//") ? next : null;
}

// ---------- Talking to identity providers ----------
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const loopbackAllowed = (p: Platform, url: URL) => p.config.ssoAllowLoopback === true && url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);

/**
 * HTTPS to an address already vetted and pinned, with no redirects followed. Issuer URLs are typed in by tenant admins, so
 * this is a server-side request to a place a customer chose. `tls` is a test seam for a private trust anchor.
 */
export function pinnedRequest(url: URL, pinned: PinnedHost, init: RequestInit = {}, tls: { ca?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    headers.host = url.host;
    const body = init.body == null ? undefined : String(init.body);
    if (body) headers["content-length"] = String(Buffer.byteLength(body));
    const req = httpsRequest({
      host: pinned.ip, port: pinned.port, path: `${url.pathname}${url.search}`, method: init.method ?? "GET", headers,
      servername: pinned.servername, minVersion: "TLSv1.2", signal: init.signal ?? AbortSignal.timeout(10_000), ...tls,
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > 1_000_000) { req.destroy(new Error("response too large")); return; } chunks.push(c); });
      res.on("error", reject);
      res.on("end", () => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") out.set(k, v);
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: out }));
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function idpFetch(p: Platform): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (loopbackAllowed(p, url)) return (p.fetch ?? fetch)(url, init);
    if (url.protocol !== "https:") throw new HostBlockedError("invalid_host");
    const pinned = await checkHttpsHost(url.hostname, Number(url.port || 443));
    return pinnedRequest(url, pinned, init);
  }) as typeof fetch;
}

function httpOptions(p: Platform, url: string | undefined) {
  const insecure = !!url && loopbackAllowed(p, new URL(url));
  return {
    [oauth.customFetch]: idpFetch(p),
    signal: () => AbortSignal.timeout(10_000),
    ...(insecure ? { [oauth.allowInsecureRequests]: true } : {}),
  };
}

function assertIssuerUrl(p: Platform, raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest("issuer_invalid", "Enter the issuer as a full https:// URL."); }
  if (u.username || u.password || u.search || u.hash) throw badRequest("issuer_invalid", "The issuer URL can't include credentials, a query or a fragment.");
  if (u.protocol !== "https:" && !loopbackAllowed(p, u)) throw badRequest("issuer_invalid", "The issuer must use https://.");
  return u;
}

/** Fetches the discovery document and checks the endpoints we'd send a browser or a secret to. */
async function discover(p: Platform, issuer: string): Promise<oauth.AuthorizationServer> {
  const url = assertIssuerUrl(p, issuer);
  const res = await oauth.discoveryRequest(url, { algorithm: "oidc", ...httpOptions(p, issuer) });
  const as = await oauth.processDiscoveryResponse(url, res);
  for (const e of [as.authorization_endpoint, as.token_endpoint, as.jwks_uri]) {
    if (!e) throw new Error("incomplete discovery document");
    assertIssuerUrl(p, new URL(e).origin);
  }
  return as;
}

// ---------- The two kinds of sign-in ----------
export interface TenantTarget { kind: "tenant"; protocol: "oidc" | "saml"; configId: string; tenantId: string; domain: string; issuer: string; clientId: string; secretEnc: Buffer; samlEntryPoint: string; samlIdpCert: string; jitEnabled: boolean; jitRole: string }
interface SocialTarget { kind: "google" | "microsoft"; client: SocialClient }
type Target = TenantTarget | SocialTarget;

const GOOGLE_AS = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
} satisfies oauth.AuthorizationServer;
const MICROSOFT_AS = {
  issuer: "https://login.microsoftonline.com/common/v2.0",
  authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
} satisfies oauth.AuthorizationServer;

/**
 * Microsoft's "common" endpoint has no single issuer: each token's iss names its own tenant. Without this hook no token
 * validates; with it, iss must match the tid in the same token, as Microsoft documents. The symbol is the library's own.
 */
function withMicrosoftIssuer(as: oauth.AuthorizationServer, template: string): oauth.AuthorizationServer {
  const expected = (oauth as unknown as { _expectedIssuer: symbol })._expectedIssuer;
  return Object.assign({ ...as }, {
    [expected]: (result: { claims: { tid?: unknown } }) => {
      const tid = result.claims.tid;
      return typeof tid === "string" && /^[0-9a-f-]{36}$/i.test(tid) ? template.replace("{tid}", tid) : "invalid-tid";
    },
  });
}

async function serverFor(p: Platform, t: Target): Promise<oauth.AuthorizationServer> {
  if (t.kind === "tenant") return discover(p, t.issuer);
  const base = t.client.issuer ? await discover(p, t.client.issuer) : t.kind === "google" ? GOOGLE_AS : MICROSOFT_AS;
  if (t.kind !== "microsoft") return base;
  if (t.client.issuer && !t.client.issuerTemplate) return base;
  return withMicrosoftIssuer(base, t.client.issuerTemplate ?? "https://login.microsoftonline.com/{tid}/v2.0");
}

const callbackUrl = (p: Platform) => `${p.config.appOrigin}/api/v1/auth/sso/callback`;

// ---------- Starting ----------
/**
 * The verifier and nonce are sealed under a key derived from a value that only goes into this browser's cookie, never to the
 * identity provider or into a URL. So a stolen callback URL or database row can't finish the sign-in, and an attacker can't
 * trick a victim's browser into finishing an attempt the attacker started (login CSRF).
 */
export function flowKey(binding: string, stateHash: string) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(binding), Buffer.from(stateHash), "aegis-sso-flow", 32));
}

export interface SsoStart { url: string; binding: string; protocol?: "oidc" | "saml" }

async function startFlow(p: Platform, target: Target, opts: { next?: string | null; loginHint?: string }): Promise<SsoStart> {
  const as = await serverFor(p, target);
  const state = randomToken(32), nonce = oauth.generateRandomNonce(), verifier = oauth.generateRandomCodeVerifier();
  const binding = randomBytes(32).toString("base64url");
  const stateHash = sha(state);
  const secret = sealWithKey(flowKey(binding, stateHash), Buffer.from(JSON.stringify({ verifier, nonce })), stateHash);
  await p.db.withSystem(t => t.query("INSERT INTO sso_flows(state_hash,kind,config_id,secret_enc,next,expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6::int * interval '1 minute'))",
    [stateHash, target.kind, target.kind === "tenant" ? target.configId : null, secret, safeNextPath(opts.next), FLOW_MINUTES]));
  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set("client_id", target.kind === "tenant" ? target.clientId : target.client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl(p));
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint);
  return { url: url.toString(), binding };
}

export async function loadTenantTarget(t: Tx, configId: string): Promise<TenantTarget | null> {
  const c = await t.one<any>("SELECT tenant_id, domain, protocol, issuer, client_id, client_secret_enc, saml_entry_point, saml_idp_cert, jit_enabled, jit_role FROM sso_flow_config($1)", [configId]);
  return c ? { kind: "tenant", protocol: c.protocol, configId, tenantId: c.tenant_id, domain: c.domain, issuer: c.issuer, clientId: c.client_id, secretEnc: c.client_secret_enc, samlEntryPoint: c.saml_entry_point, samlIdpCert: c.saml_idp_cert, jitEnabled: c.jit_enabled, jitRole: c.jit_role } : null;
}

/**
 * Discovery by domain. The answer depends only on the domain, never on whether the address has an account. That a domain
 * uses SSO is observable to anyone by design, since the next step is a redirect to its provider; who is registered isn't.
 */
export async function beginSso(p: Platform, input: { email: string; next?: string | null }, clientKey?: string): Promise<SsoStart | null> {
  if (clientKey) await rateLimit(p, `sso-start:${sha(clientKey)}`, 60, 300);
  const email = norm(input.email);
  const domain = email.split("@")[1];
  if (!domain || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const target = await p.db.withSystem(async t => {
    const d = await t.one<{ config_id: string }>("SELECT config_id FROM sso_discover($1)", [domain]);
    return d ? loadTenantTarget(t, d.config_id) : null;
  });
  if (!target) return null;
  if (target.protocol === "saml") return (await import("./saml")).beginSamlFlow(p, target, { next: input.next });
  return startFlow(p, target, { next: input.next, loginHint: email }).catch(e => {
    p.log.warn("auth.sso_start_failed", { errorCode: errorCode(e) });
    throw refuse("sso_token_invalid");
  });
}

export function socialProviders(p: Platform) {
  return { google: !!p.config.social?.google, microsoft: !!p.config.social?.microsoft };
}

export async function beginSocial(p: Platform, provider: string, next?: string | null, clientKey?: string): Promise<SsoStart> {
  if (clientKey) await rateLimit(p, `sso-start:${sha(clientKey)}`, 60, 300);
  if (provider !== "google" && provider !== "microsoft") throw notFound();
  const client = p.config.social?.[provider];
  if (!client) throw notFound();
  return startFlow(p, { kind: provider, client }, { next });
}

// ---------- Finishing ----------
export interface Claims { sub: string; email?: string; emailVerified: boolean; name?: string; tid?: string }

function readClaims(kind: Target["kind"], c: oauth.IDToken): Claims {
  const raw = c as Record<string, unknown>;
  // Entra's email claim isn't verified, and it doesn't send email_verified. xms_edov is its signal that the domain owner vouches.
  const verified = kind === "microsoft" ? raw.email_verified === true || raw.xms_edov === true || raw.xms_edov === "1" || raw.xms_edov === "true" : raw.email_verified === true;
  return { sub: c.sub, email: typeof raw.email === "string" ? norm(raw.email) : undefined, emailVerified: verified, name: typeof raw.name === "string" ? raw.name : undefined, tid: typeof raw.tid === "string" ? raw.tid : undefined };
}

async function exchangeCode(p: Platform, target: Target, params: URLSearchParams, state: string, verifier: string, nonce: string): Promise<oauth.IDToken> {
  const as = await serverFor(p, target);
  const clientId = target.kind === "tenant" ? target.clientId : target.client.clientId;
  const secret = target.kind === "tenant"
    ? (await p.envelope.open({ tenantId: target.tenantId, keyClass: "credential", table: "sso_configs", recordId: target.configId }, target.secretEnc)).toString("utf8")
    : target.client.clientSecret;
  const client: oauth.Client = { client_id: clientId };
  const methods = as.token_endpoint_auth_methods_supported;
  const auth = !methods || methods.includes("client_secret_basic") ? oauth.ClientSecretBasic(secret) : oauth.ClientSecretPost(secret);
  const opts = httpOptions(p, as.token_endpoint);
  const callback = oauth.validateAuthResponse(as, client, params, state);
  const res = await oauth.authorizationCodeGrantRequest(as, client, auth, callback, callbackUrl(p), verifier, opts);
  const result = await oauth.processAuthorizationCodeResponse(as, client, res, { expectedNonce: nonce, requireIdToken: true });
  // Checks iss, aud, exp, iat and nonce above. The signature is optional in the spec for a direct TLS response, but not here.
  await oauth.validateApplicationLevelSignature(as, res, httpOptions(p, as.jwks_uri));
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims) throw new Error("no id token");
  return claims;
}

const cleanName = (raw: string | undefined, email: string) => (raw ?? "").replace(/[\p{Cc}]/gu, " ").trim().slice(0, 100) || email.split("@")[0]!;

interface Resolved { userId: string; tenantId: string; totpEnabled: boolean }

/**
 * Who this is. A known identity signs in. Otherwise the account-linking rule:
 * an existing account is only ever linked by email when the identity provider's domain is verified by that tenant and the
 * provider says the address is verified. Everything else is refused, because signing in through someone's identity
 * provider would otherwise hand their account to whoever controls that provider.
 */
async function resolveTenantUser(t: Tx, target: TenantTarget, claims: Claims, provider: string, seats: Limit): Promise<Resolved> {
  if (!claims.email) throw refuse("sso_no_email");
  if (!claims.emailVerified) throw refuse("sso_email_unverified");
  if (claims.email.split("@")[1] !== target.domain.toLowerCase()) throw refuse("sso_domain_mismatch");
  const linked = await t.one<{ id: string; totp_enabled: boolean }>("SELECT u.id, u.totp_enabled FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 AND u.deleted_at IS NULL", [provider, claims.sub]);
  let userId = linked?.id, totpEnabled = linked?.totp_enabled ?? false;
  if (!userId) {
    const existing = await t.one<{ id: string; email_verified_at: Date | null; totp_enabled: boolean }>("SELECT id, email_verified_at, totp_enabled FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [claims.email]);
    if (existing) {
      // Never proven by whoever registered it, and now proven by the domain's owner: see neutralizeUnverifiedAccount.
      if (!existing.email_verified_at) { await neutralizeUnverifiedAccount(t, existing.id); totpEnabled = false; }
      else totpEnabled = existing.totp_enabled;
      userId = existing.id;
    } else {
      if (!target.jitEnabled) throw refuse("sso_not_provisioned");
      userId = (await t.one<{ id: string }>("INSERT INTO users(email,name,email_verified_at) VALUES ($1,$2,now()) RETURNING id", [claims.email, cleanName(claims.name, claims.email)]))!.id;
    }
    await t.query("INSERT INTO identities(user_id,provider,subject) VALUES ($1,$2,$3)", [userId, provider, claims.sub]);
  }
  const member = await t.one("SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2", [target.tenantId, userId]);
  if (!member) {
    // Switched off through SCIM: the identity provider may still authenticate them, but that doesn't bring them back.
    const off = await t.one("SELECT 1 FROM scim_users WHERE tenant_id=$1 AND user_id=$2 AND active=false", [target.tenantId, userId]);
    if (off || !target.jitEnabled) throw refuse("sso_not_provisioned");
    if (!(await seatAvailable(t, target.tenantId, seats, claims.email))) throw refuse("sso_seat_limit", 403);
    await t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [target.tenantId, userId, target.jitRole]);
    await audit(t, { tenantId: target.tenantId, actor: userId, event: "member.joined", meta: { role: target.jitRole, outcome: "jit" } });
  }
  return { userId, tenantId: target.tenantId, totpEnabled };
}

async function resolveSocialUser(p: Platform, t: Tx, provider: "google" | "microsoft", claims: Claims): Promise<Resolved> {
  const subject = provider === "microsoft" && claims.tid ? `${claims.tid}:${claims.sub}` : claims.sub;
  const linked = await t.one<{ id: string; email: string; totp_enabled: boolean }>("SELECT u.id, u.email, u.totp_enabled FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2 AND u.deleted_at IS NULL", [provider, subject]);
  if (linked) {
    if (await ssoEnforcedFor(t, linked.email)) throw refuse("sso_required", 403);
    const m = await t.one<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1", [linked.id]);
    return { userId: linked.id, tenantId: m?.tenant_id ?? await createWorkspace(t, linked.id, "personal", "Personal workspace"), totpEnabled: linked.totp_enabled };
  }
  if (!claims.email) throw refuse("sso_no_email");
  if (!claims.emailVerified) throw refuse("sso_email_unverified");
  if (await ssoEnforcedFor(t, claims.email)) throw refuse("sso_required", 403);
  // No tenant has verified Google's or Microsoft's domain, so the linking rule can't be met: an existing account is never linked by email.
  if (await t.one("SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [claims.email])) throw refuse("sso_account_exists", 409);
  if (!(await signupAllowed(p, t, claims.email))) throw refuse("signup_closed", 403);
  const u = await t.one<{ id: string }>("INSERT INTO users(email,name,email_verified_at) VALUES ($1,$2,now()) RETURNING id", [claims.email, cleanName(claims.name, claims.email)]);
  await t.query("INSERT INTO identities(user_id,provider,subject) VALUES ($1,$2,$3)", [u!.id, provider, subject]);
  return { userId: u!.id, tenantId: await createWorkspace(t, u!.id, "personal", "Personal workspace"), totpEnabled: false };
}

export type SsoResult = { kind: "session"; token: string; sessionId: string; expiresAt: Date; next: string | null; userId: string; tenantId: string } | { kind: "mfa"; ticket: string; next: string | null };

export async function finishSso(p: Platform, params: URLSearchParams, binding: string | undefined, ua?: string, clientKey?: string): Promise<SsoResult> {
  if (clientKey) await rateLimit(p, `sso-finish:${sha(clientKey)}`, 60, 300);
  const state = params.get("state");
  if (!state) throw refuse("sso_state_invalid");
  const stateHash = sha(state);
  // Its own transaction: however this attempt ends, the state can't be used again.
  const flow = await p.db.withSystem(t => t.one<{ kind: Target["kind"]; config_id: string | null; secret_enc: Buffer; next: string | null }>("DELETE FROM sso_flows WHERE state_hash=$1 AND kind<>'saml' AND expires_at>now() RETURNING kind, config_id, secret_enc, next", [stateHash]));
  if (!flow) throw refuse("sso_state_invalid");
  let secret: { verifier: string; nonce: string };
  try { secret = JSON.parse(openWithKey(flowKey(binding ?? "", stateHash), flow.secret_enc, stateHash).toString("utf8")); }
  catch { throw refuse("sso_state_invalid"); }
  const target: Target | null = flow.kind === "tenant"
    ? await p.db.withSystem(t => loadTenantTarget(t, flow.config_id!))
    : p.config.social?.[flow.kind as "google"] ? { kind: flow.kind as "google", client: p.config.social[flow.kind as "google"]! } : null;
  if (!target || (target.kind === "tenant" && target.protocol !== "oidc")) throw refuse("sso_not_available");
  const tenantForAudit = target.kind === "tenant" ? target.tenantId : null;
  const refused = async (code: string) => { await p.db.withSystem(t => audit(t, { tenantId: tenantForAudit, event: "auth.sso_refused", meta: { code, provider: target.kind } })); };
  if (params.get("error")) { await refused("sso_denied"); throw refuse("sso_denied"); }
  let claims: Claims;
  try {
    claims = readClaims(target.kind, await exchangeCode(p, target, params, state, secret.verifier, secret.nonce));
  } catch (e) {
    // The library's errors can carry the provider's response, so only the code is kept.
    p.log.warn("auth.sso_token_rejected", { errorCode: errorCode(e), provider: target.kind });
    await refused("sso_token_invalid");
    throw refuse("sso_token_invalid");
  }
  const provider = target.kind === "tenant" ? `sso:${target.configId}:${sha(target.issuer).slice(0, 16)}` : target.kind;
  return completeSignIn(p, target, claims, provider, flow.next, ua);
}

/** Everything after the provider's answer has been verified, for every protocol. */
export async function completeSignIn(p: Platform, target: TenantTarget | SocialTarget, claims: Claims, provider: string, next: string | null, ua?: string): Promise<SsoResult> {
  const tenantForAudit = target.kind === "tenant" ? target.tenantId : null;
  // Read first, so the transaction below doesn't wait on a second connection while it holds the seat lock.
  const seats = target.kind === "tenant" ? (await limitsFor(p, target.tenantId)).seats : null;
  try {
    return await p.db.withSystem(async t => {
      const who = target.kind === "tenant" ? await resolveTenantUser(t, target, claims, provider, seats) : await resolveSocialUser(p, t, target.kind, claims);
      if (target.kind === "tenant") await t.query("SELECT sso_mark_success($1)", [target.configId]);
      // An account with an authenticator app on needs its code here too, so taking over a federated login isn't enough.
      if (who.totpEnabled) {
        const ticket = randomToken(32);
        await t.query("INSERT INTO auth_challenges(user_id,purpose,challenge,expires_at) VALUES ($1,$2,$3, now() + interval '5 minutes')", [who.userId, `sso_mfa:${who.tenantId}`, sha(ticket)]);
        return { kind: "mfa" as const, ticket, next };
      }
      // We can't see whether the provider asked for a second factor, so this doesn't claim one.
      const s = await createSession(p, t, who.userId, who.tenantId, { method: "idp", mfaPassed: false }, ua);
      await audit(t, { tenantId: who.tenantId, actor: who.userId, event: "auth.login", meta: { outcome: target.kind === "tenant" ? `sso_${target.protocol}` : target.kind } });
      return { kind: "session" as const, token: s.token, sessionId: s.sessionId, expiresAt: s.expiresAt, next, userId: who.userId, tenantId: who.tenantId };
    });
  } catch (e) {
    if (e instanceof AppError) await p.db.withSystem(t => audit(t, { tenantId: tenantForAudit, event: "auth.sso_refused", meta: { code: e.code, provider: target.kind } }));
    throw e;
  }
}

/** Second step for an account with an authenticator app. The ticket is single use and short lived; codes are rate limited per user. */
export async function finishSsoMfa(p: Platform, input: { ticket: string; code: string }, ua?: string) {
  const hash = sha(input.ticket);
  const c = await p.db.withSystem(t => t.one<{ id: string; user_id: string; purpose: string; totp_secret_enc: Buffer | null }>(
    "SELECT c.id, c.user_id, c.purpose, u.totp_secret_enc FROM auth_challenges c JOIN users u ON u.id=c.user_id WHERE c.challenge=$1 AND c.purpose LIKE 'sso_mfa:%' AND c.expires_at>now() AND u.deleted_at IS NULL", [hash]));
  if (!c) throw refuse("sso_state_invalid");
  await rateLimit(p, `totp-verify:${c.user_id}`, 10, 900);
  if (!(await verifyUserTotp(p, c.user_id, c.totp_secret_enc, input.code))) throw new AppError(401, "invalid_mfa", "That code isn't right. Check the time on your device and try again.");
  const tenantId = c.purpose.slice("sso_mfa:".length);
  return p.db.withSystem(async t => {
    const gone = await t.one("DELETE FROM auth_challenges WHERE id=$1 RETURNING id", [c.id]);
    if (!gone) throw refuse("sso_state_invalid");
    const s = await createSession(p, t, c.user_id, tenantId, { method: "idp", mfaPassed: true }, ua);
    await audit(t, { tenantId, actor: c.user_id, event: "auth.login", meta: { outcome: "sso_mfa" } });
    return s;
  });
}

// ---------- The admin side ----------
export const JIT_ROLES = new Set(["member", "workspace_manager", "security_admin"]);

export async function ssoOverview(p: Platform, ctx: Ctx) {
  await requireRole(p, ctx, "manageSso");
  return p.db.withUser(ctx, async t => {
    const org = await t.one<{ kind: string }>("SELECT kind FROM organizations WHERE id=$1", [ctx.tenantId]);
    const domains = await t.query<{ domain: string }>("SELECT domain FROM verified_domains WHERE verified_at IS NOT NULL ORDER BY domain");
    const configs = await t.query<any>("SELECT id, domain, protocol, issuer, client_id \"clientId\", saml_entry_point \"samlEntryPoint\", enabled, enforced, jit_enabled \"jitEnabled\", jit_role \"jitRole\", last_success_at \"lastSuccessAt\" FROM sso_configs ORDER BY domain");
    const token = await t.one<any>("SELECT created_at \"createdAt\", last_used_at \"lastUsedAt\" FROM scim_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1");
    const managed = await t.one<{ c: number }>("SELECT count(*)::int c FROM scim_users WHERE active");
    return { organization: org?.kind === "organization", domains: domains.map(d => d.domain), configs, callbackUrl: callbackUrl(p), samlBaseUrl: `${p.config.appOrigin}/api/v1/auth/saml`, scim: { baseUrl: `${p.config.appOrigin}/api/v1/scim/v2`, token, managed: managed?.c ?? 0 } };
  });
}

/** The secret is sealed under the tenant's credential key and never returned. Leaving it out on an edit keeps the current one. */
export async function saveSsoConfig(p: Platform, ctx: Ctx, input: { domain: string; issuer: string; clientId: string; clientSecret?: string; jitEnabled?: boolean; jitRole?: string; enabled?: boolean }) {
  await requireRole(p, ctx, "manageSso");
  await rateLimit(p, `sso-config:${ctx.tenantId}`, 30, 3600);
  const domain = norm(input.domain);
  const jitRole = input.jitRole ?? "member";
  if (!JIT_ROLES.has(jitRole)) throw badRequest("role_invalid", "Choose a role other than owner.");
  const existing = await p.db.withUser(ctx, async t => {
    const org = await t.one<{ kind: string }>("SELECT kind FROM organizations WHERE id=$1", [ctx.tenantId]);
    if (org?.kind !== "organization") throw badRequest("organization_only", "Single sign-on is only available for organization workspaces.");
    const ok = await t.one("SELECT 1 FROM verified_domains WHERE domain=$1 AND verified_at IS NOT NULL", [domain]);
    if (!ok) throw badRequest("domain_unverified", "Verify this domain on the Domains page first.");
    return t.one<{ id: string; client_secret_enc: Buffer | null }>("SELECT id, client_secret_enc FROM sso_configs WHERE domain=$1", [domain]);
  });
  if (!existing?.client_secret_enc && !input.clientSecret) throw badRequest("secret_required", "Enter the client secret.");
  assertIssuerUrl(p, input.issuer);
  // Refuse a configuration that can't work, now rather than when someone tries to sign in.
  await discover(p, input.issuer).catch(e => {
    p.log.info("sso.discovery_failed", { errorCode: errorCode(e) });
    throw badRequest("issuer_unreachable", "We couldn't read a valid OpenID Connect discovery document from that issuer.");
  });
  const id = existing?.id ?? randomUUID();
  const enc = input.clientSecret ? await p.envelope.seal({ tenantId: ctx.tenantId, keyClass: "credential", table: "sso_configs", recordId: id }, input.clientSecret) : existing!.client_secret_enc;
  await upsertConfig(p, ctx, { id, domain, protocol: "oidc", issuer: input.issuer, clientId: input.clientId, secretEnc: enc, entryPoint: null, cert: null, enabled: input.enabled ?? true, jitEnabled: input.jitEnabled ?? true, jitRole });
  return { id };
}

/** Shared by both protocols. Changing who signs people in switches enforcement off, so a mistake can't lock everyone out. */
export async function upsertConfig(p: Platform, ctx: Ctx, c: { id: string; domain: string; protocol: "oidc" | "saml"; issuer: string; clientId: string | null; secretEnc: Buffer | null; entryPoint: string | null; cert: string | null; enabled: boolean; jitEnabled: boolean; jitRole: string }) {
  const claimed = () => conflict("domain_claimed", "Another organization has already set up single sign-on for this domain. If this domain has changed hands, that claim ends about a week after their DNS record is gone, and you can try again then.");
  // A previous holder whose proof has lapsed no longer has a claim. The caller has proven the domain by now: this does nothing otherwise.
  await p.db.withSystem(s => s.query("SELECT sso_release_lapsed_domain($1,$2)", [c.domain, ctx.tenantId]));
  await p.db.withUser(ctx, async t => {
    const taken = await p.db.withSystem(s => s.one<{ tenant_id: string }>("SELECT tenant_id FROM sso_discover($1)", [c.domain]));
    if (taken && taken.tenant_id !== ctx.tenantId) throw claimed();
    await t.query(
      `INSERT INTO sso_configs(id,tenant_id,domain,protocol,issuer,client_id,client_secret_enc,saml_entry_point,saml_idp_cert,enabled,jit_enabled,jit_role,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET protocol=$4, issuer=$5, client_id=$6, client_secret_enc=$7, saml_entry_point=$8, saml_idp_cert=$9, enabled=$10, jit_enabled=$11, jit_role=$12, updated_at=now(),
         last_success_at=CASE WHEN sso_configs.protocol=$4 AND sso_configs.issuer=$5 AND sso_configs.client_id IS NOT DISTINCT FROM $6 AND sso_configs.saml_idp_cert IS NOT DISTINCT FROM $9 THEN sso_configs.last_success_at END,
         enforced=CASE WHEN sso_configs.protocol=$4 AND sso_configs.issuer=$5 AND sso_configs.client_id IS NOT DISTINCT FROM $6 AND sso_configs.saml_idp_cert IS NOT DISTINCT FROM $9 THEN sso_configs.enforced ELSE false END`,
      [c.id, ctx.tenantId, c.domain, c.protocol, c.issuer, c.clientId, c.secretEnc, c.entryPoint, c.cert, c.enabled, c.jitEnabled, c.jitRole, ctx.userId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "sso.configured", targetType: "sso_config", targetId: c.id, meta: { role: c.jitRole, kind: c.protocol } });
  }).catch(e => {
    if ((e as { code?: string })?.code === "23505") throw claimed();
    throw e;
  });
}

/** Only after a real sign-in has worked: turning this on with a broken configuration would lock everyone out, owners included. */
export async function setSsoEnforced(p: Platform, ctx: Ctx, id: string, enforced: boolean) {
  await requireRole(p, ctx, "manageSso");
  await p.db.withUser(ctx, async t => {
    const c = await t.one<{ last_success_at: Date | null }>("SELECT last_success_at FROM sso_configs WHERE id=$1", [id]);
    if (!c) throw notFound();
    if (enforced && !c.last_success_at) throw conflict("sso_untested", "Sign in through your identity provider once before requiring it. Otherwise a mistake here could lock everyone out.");
    await t.query("UPDATE sso_configs SET enforced=$2, updated_at=now() WHERE id=$1", [id, enforced]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "sso.enforced", targetType: "sso_config", targetId: id, meta: { outcome: enforced ? "on" : "off" } });
  });
}

export async function removeSsoConfig(p: Platform, ctx: Ctx, id: string) {
  await requireRole(p, ctx, "manageSso");
  await p.db.withUser(ctx, async t => {
    const r = await t.query("DELETE FROM sso_configs WHERE id=$1 RETURNING id", [id]);
    if (!r.length) throw notFound();
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "sso.removed", targetType: "sso_config", targetId: id });
  });
  await p.db.withSystem(t => t.query("DELETE FROM identities WHERE provider LIKE $1 OR provider LIKE $2", [`sso:${id}:%`, `saml:${id}:%`]));
}

/** For the sign-in pages. Whether anyone has SSO at all, and which social providers this deployment has set up. */
export async function publicSignInOptions(p: Platform) {
  const any = await p.db.withSystem(t => t.one<{ v: boolean }>("SELECT sso_any_enabled() v"));
  return { sso: any?.v === true, ...socialProviders(p) };
}
