import { X509Certificate, createHash, randomBytes, randomUUID } from "node:crypto";
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { audit } from "./audit";
import { rateLimit } from "./auth";
import { badRequest, type Ctx, type Platform } from "./context";
import { errorCode } from "./log";
import { openWithKey, sealWithKey } from "./mailer";
import { requireRole } from "./org";
import { completeSignIn, flowKey, FLOW_MINUTES, JIT_ROLES, loadTenantTarget, refuse, safeNextPath, type Claims, type SsoResult, type SsoStart, type TenantTarget, upsertConfig } from "./sso";

/**
 * SAML 2.0 service provider, through @node-saml/node-saml. SP-initiated only: every accepted response must answer a request
 * this browser started, and each request can be answered once. So IdP-initiated sign-in, replay and login CSRF are all
 * refused by the same check. Signed assertions are required; the library handles XML signatures, and wrapping is tested.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const samlEntityId = (p: Platform, domain: string) => `${p.config.appOrigin}/api/v1/auth/saml/${domain}`;
export const samlAcsUrl = (p: Platform, domain: string) => `${samlEntityId(p, domain)}/acs`;

function client(p: Platform, t: TenantTarget, cacheProvider: CacheProvider) {
  return new SAML({
    callbackUrl: samlAcsUrl(p, t.domain), issuer: samlEntityId(p, t.domain), audience: samlEntityId(p, t.domain),
    entryPoint: t.samlEntryPoint, idpIssuer: t.issuer, idpCert: t.samlIdpCert,
    wantAssertionsSigned: true, wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always, cacheProvider, requestIdExpirationPeriodMs: FLOW_MINUTES * 60_000,
    acceptedClockSkewMs: 30_000, disableRequestedAuthnContext: true,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  });
}

const item = (value: string): CacheItem => ({ value, createdAt: Date.now() });

/** The request ID goes to the provider; only its hash is kept. The row is sealed under the browser's cookie, as for OIDC. */
export async function beginSamlFlow(p: Platform, target: TenantTarget, opts: { next?: string | null }): Promise<SsoStart> {
  const binding = randomBytes(32).toString("base64url");
  const store: CacheProvider = {
    async saveAsync(key, value) {
      const hash = sha(key);
      const enc = sealWithKey(flowKey(binding, hash), Buffer.from(JSON.stringify({ value })), hash);
      await p.db.withSystem(t => t.query("INSERT INTO sso_flows(state_hash,kind,config_id,secret_enc,next,expires_at) VALUES ($1,'saml',$2,$3,$4, now() + ($5::int * interval '1 minute'))", [hash, target.configId, enc, safeNextPath(opts.next), FLOW_MINUTES]));
      return item(value);
    },
    getAsync: async () => null,
    removeAsync: async () => null,
  };
  const url = await client(p, target, store).getAuthorizeUrlAsync("", undefined, {});
  return { url, binding, protocol: "saml" };
}

/** Used up on first sight, in its own transaction, so two copies of a response racing each other can't both pass. */
function consumingStore(p: Platform, target: TenantTarget, binding: string | undefined, seen: { next: string | null }): CacheProvider {
  const memo = new Map<string, string | null>();
  return {
    saveAsync: async (_k, value) => item(value),
    async getAsync(key) {
      if (memo.has(key)) return memo.get(key)!;
      const hash = sha(key);
      const row = await p.db.withSystem(t => t.one<{ secret_enc: Buffer; next: string | null }>("DELETE FROM sso_flows WHERE state_hash=$1 AND kind='saml' AND config_id=$2 AND expires_at>now() RETURNING secret_enc, next", [hash, target.configId]));
      let value: string | null = null;
      if (row) {
        try { value = (JSON.parse(openWithKey(flowKey(binding ?? "", hash), row.secret_enc, hash).toString("utf8")) as { value: string }).value; seen.next = row.next; }
        catch { value = null; }
      }
      memo.set(key, value);
      return value;
    },
    removeAsync: async key => key,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const attr = (profile: Profile, name: string): unknown => {
  const v = (profile.attributes as Record<string, unknown> | undefined)?.[name] ?? profile[name];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * SAML has no standard way to say an address is verified, so the same rule as OIDC needs an explicit email_verified
 * attribute from the provider. Without it, nobody is signed in.
 */
function claimsOf(profile: Profile): Claims {
  const nameId = String(profile.nameID ?? "");
  const emailAttr = attr(profile, "email");
  const email = typeof emailAttr === "string" && EMAIL.test(emailAttr) ? emailAttr : EMAIL.test(nameId) ? nameId : undefined;
  const verified = attr(profile, "email_verified");
  const name = attr(profile, "displayName");
  return { sub: nameId, email: email?.trim().toLowerCase(), emailVerified: verified === true || verified === "true", name: typeof name === "string" ? name : undefined };
}

/**
 * The library checks the audience but not this, and the SAML profile requires it: a bearer assertion must name the ACS it
 * was issued for. Read from the signature-checked assertion the library hands back, not from the raw response.
 */
function recipientMatches(profile: Profile, acs: string) {
  const a = profile.getAssertion?.() as { Assertion?: { Subject?: { SubjectConfirmation?: { SubjectConfirmationData?: { $?: { Recipient?: string } }[] }[] }[] } } | undefined;
  const confirmations = a?.Assertion?.Subject?.[0]?.SubjectConfirmation ?? [];
  return confirmations.length > 0 && confirmations.every(c => c.SubjectConfirmationData?.[0]?.$?.Recipient === acs);
}

export async function finishSaml(p: Platform, domain: string, samlResponse: string, binding: string | undefined, ua?: string, clientKey?: string): Promise<SsoResult> {
  if (clientKey) await rateLimit(p, `sso-finish:${sha(clientKey)}`, 60, 300);
  const target = await p.db.withSystem(async t => {
    const d = await t.one<{ config_id: string; protocol: string }>("SELECT config_id, protocol FROM sso_discover($1)", [domain.trim().toLowerCase()]);
    return d?.protocol === "saml" ? loadTenantTarget(t, d.config_id) : null;
  });
  if (!target) throw refuse("sso_not_available");
  const seen = { next: null as string | null };
  let profile: Profile | null;
  try {
    ({ profile } = await client(p, target, consumingStore(p, target, binding, seen)).validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (e) {
    // The library's messages can quote the assertion, so only the error's name is kept.
    p.log.warn("auth.saml_rejected", { errorCode: errorCode(e), provider: "saml" });
    throw await refusedAudit(p, target, "sso_token_invalid");
  }
  if (!profile || !recipientMatches(profile, samlAcsUrl(p, target.domain))) throw await refusedAudit(p, target, "sso_token_invalid");
  return completeSignIn(p, target, claimsOf(profile), `saml:${target.configId}:${sha(target.issuer).slice(0, 16)}`, seen.next, ua);
}

async function refusedAudit(p: Platform, target: TenantTarget, code: string) {
  await p.db.withSystem(t => audit(t, { tenantId: target.tenantId, event: "auth.sso_refused", meta: { code, provider: "saml" } }));
  return refuse(code);
}

/** Never fetched by us: the entry point is only where browsers get sent, so it needs to be https and nothing else. */
function assertEntryPoint(p: Platform, raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw badRequest("entry_point_invalid", "Enter the sign-in URL as a full https:// URL."); }
  const localTest = p.config.ssoAllowLoopback === true && u.protocol === "http:" && u.hostname === "127.0.0.1";
  if ((u.protocol !== "https:" && !localTest) || u.username || u.password) throw badRequest("entry_point_invalid", "The sign-in URL must use https:// and can't include credentials.");
}

/** Accepts PEM or bare base64, and refuses anything that isn't a current X.509 certificate. Returns PEM. */
export function normalizeIdpCert(raw: string, now: Date) {
  const body = raw.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const pem = `-----BEGIN CERTIFICATE-----\n${(body.match(/.{1,64}/g) ?? []).join("\n")}\n-----END CERTIFICATE-----\n`;
  let cert: X509Certificate;
  try { cert = new X509Certificate(pem); } catch { throw badRequest("cert_invalid", "That isn't a valid X.509 certificate."); }
  if (new Date(cert.validTo).getTime() < now.getTime()) throw badRequest("cert_expired", "That certificate has expired. Download a current one from your identity provider.");
  return pem;
}

export async function saveSamlConfig(p: Platform, ctx: Ctx, input: { domain: string; idpEntityId: string; entryPoint: string; idpCert: string; jitEnabled?: boolean; jitRole?: string; enabled?: boolean }) {
  await requireRole(p, ctx, "manageSso");
  await rateLimit(p, `sso-config:${ctx.tenantId}`, 30, 3600);
  const domain = input.domain.trim().toLowerCase();
  const jitRole = input.jitRole ?? "member";
  if (!JIT_ROLES.has(jitRole)) throw badRequest("role_invalid", "Choose a role other than owner.");
  if (!input.idpEntityId.trim()) throw badRequest("issuer_invalid", "Enter the identity provider's entity ID.");
  assertEntryPoint(p, input.entryPoint);
  const cert = normalizeIdpCert(input.idpCert, p.now());
  const existing = await p.db.withUser(ctx, async t => {
    const org = await t.one<{ kind: string }>("SELECT kind FROM organizations WHERE id=$1", [ctx.tenantId]);
    if (org?.kind !== "organization") throw badRequest("organization_only", "Single sign-on is only available for organization workspaces.");
    if (!(await t.one("SELECT 1 FROM verified_domains WHERE domain=$1 AND verified_at IS NOT NULL", [domain]))) throw badRequest("domain_unverified", "Verify this domain on the Domains page first.");
    return t.one<{ id: string }>("SELECT id FROM sso_configs WHERE domain=$1", [domain]);
  });
  const id = existing?.id ?? randomUUID();
  await upsertConfig(p, ctx, { id, domain, protocol: "saml", issuer: input.idpEntityId.trim(), clientId: null, secretEnc: null, entryPoint: input.entryPoint, cert, enabled: input.enabled ?? true, jitEnabled: input.jitEnabled ?? true, jitRole });
  return { id };
}
