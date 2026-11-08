import { createServer as createTlsServer } from "node:https";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import { addDomain, beginPasskeySignIn, beginSocial, beginSso, type Ctx, finishSso, finishSsoMfa, invite, makeLogger, pinnedRequest, type Platform, publicSignInOptions, removeSsoConfig, requestPasswordReset, resolveSession, saveSsoConfig, setSsoEnforced, signIn, signUp, ssoErrorMessage, ssoOverview, verifyDomain, beginTotpEnrollment, confirmTotp, rotateScimToken, authenticateScim, scimCreateUser, scimPatchUser, changeRole, acceptInvite } from "../index";
import { checkHttpsHost } from "@aegis/mail-adapters/ssrf";
import { fakeOidc, type TokenOverrides } from "./fake-oidc";
import { markVerified, testPlatform, user } from "./harness";

const CONFIG = { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost", ssoAllowLoopback: true };
const pw = "correct-horse-battery";

async function verifiedDomain(p: Platform, ctx: Ctx, domain: string) {
  const d = await addDomain(p, ctx, domain);
  await verifyDomain(p, ctx, domain, async () => [[d!.token]]);
}

describe("OIDC SSO against a fake provider with real signed JWTs", () => {
  let p: Platform, drop: () => Promise<void>, logs: string[], idp: Awaited<ReturnType<typeof fakeOidc>>, attackerIdp: Awaited<ReturnType<typeof fakeOidc>>, owner: Ctx, attacker: Ctx, configId: string;
  const secret = "s3cret-client-value-do-not-log";

  beforeAll(async () => {
    ({ p, drop, logs } = await testPlatform({ config: CONFIG }));
    idp = await fakeOidc({ clientId: "corp-client", clientSecret: secret });
    attackerIdp = await fakeOidc({ clientId: "evil-client", clientSecret: "evil-secret" });
    owner = await user(p, "owner@admin.corp.example", { kind: "organization" });
    await verifiedDomain(p, owner, "corp.example");
    configId = (await saveSsoConfig(p, owner, { domain: "corp.example", issuer: idp.issuer, clientId: "corp-client", clientSecret: secret })).id;
    attacker = await user(p, "mallory@evil.example", { kind: "organization" });
    await verifiedDomain(p, attacker, "evil.example");
    await saveSsoConfig(p, attacker, { domain: "evil.example", issuer: attackerIdp.issuer, clientId: "evil-client", clientSecret: "evil-secret" });
  });
  afterAll(async () => { await idp.close(); await attackerIdp.close(); await drop(); });

  /** One full round trip through the real platform code, with the browser's cookie. */
  const signInVia = async (email: string, overrides: TokenOverrides = {}, provider = idp) => {
    const s = (await beginSso(p, { email }))!;
    return finishSso(p, provider.approve(s.url, { email, ...overrides }), s.binding);
  };
  const users = (email: string) => p.db.withSystem(t => t.query<any>("SELECT * FROM users WHERE lower(email)=$1", [email]));

  describe("the good path", () => {
    it("creates a verified member through JIT, with a session in the tenant", async () => {
      const r = await signInVia("new.person@corp.example", { name: "New Person" });
      expect(r.kind).toBe("session");
      if (r.kind !== "session") return;
      const s = (await resolveSession(p, r.token))!;
      expect(s).toMatchObject({ email: "new.person@corp.example", tenantId: owner.tenantId, role: "member", emailVerified: true, name: "New Person" });
    });
    it("sends a real PKCE verifier, a nonce and state, and authenticates the client", async () => {
      const s = (await beginSso(p, { email: "pkce@corp.example" }))!;
      const u = new URL(s.url);
      expect(u.searchParams.get("code_challenge_method")).toBe("S256");
      expect(u.searchParams.get("nonce")!.length).toBeGreaterThan(20);
      expect(u.searchParams.get("state")!.length).toBeGreaterThan(20);
      expect(u.searchParams.get("login_hint")).toBe("pkce@corp.example");
      await finishSso(p, idp.approve(s.url, { email: "pkce@corp.example" }), s.binding);
      expect(idp.seen.verifiers.at(-1)!.length).toBeGreaterThanOrEqual(43);
      expect(idp.seen.authMethods.at(-1)).toBe("basic");
    });
    it("signs the same person back in by identity, with no second account", async () => {
      await signInVia("again@corp.example", { sub: "again-sub" });
      const r = await signInVia("again@corp.example", { sub: "again-sub" });
      expect(r.kind).toBe("session");
      expect(await users("again@corp.example")).toHaveLength(1);
    });
    it("honors a configurable JIT role, and never owner", async () => {
      await saveSsoConfig(p, owner, { domain: "corp.example", issuer: idp.issuer, clientId: "corp-client", jitRole: "workspace_manager" });
      const r = await signInVia("mgr@corp.example");
      if (r.kind !== "session") throw new Error("expected a session");
      expect((await resolveSession(p, r.token))!.role).toBe("workspace_manager");
      await expect(saveSsoConfig(p, owner, { domain: "corp.example", issuer: idp.issuer, clientId: "corp-client", jitRole: "owner" })).rejects.toMatchObject({ code: "role_invalid" });
      await saveSsoConfig(p, owner, { domain: "corp.example", issuer: idp.issuer, clientId: "corp-client", jitRole: "member" });
    });
    it("only allows a safe next path", async () => {
      const s = (await beginSso(p, { email: "next@corp.example", next: "https://evil.example/phish" }))!;
      const r = await finishSso(p, idp.approve(s.url, { email: "next@corp.example" }), s.binding);
      expect(r.next).toBeNull();
      const s2 = (await beginSso(p, { email: "next@corp.example", next: "/app/inbox" }))!;
      expect((await finishSso(p, idp.approve(s2.url, { email: "next@corp.example" }), s2.binding)).next).toBe("/app/inbox");
    });
  });

  describe("a bad ID token gets nobody signed in", () => {
    const refused = async (email: string, overrides: TokenOverrides, code = "sso_token_invalid") => {
      await expect(signInVia(email, overrides)).rejects.toMatchObject({ code });
      expect(await users(email)).toHaveLength(0);
    };
    it("forged nonce", () => refused("nonce@corp.example", { nonce: "attacker-chosen-nonce" }));
    it("missing nonce", () => refused("nonce2@corp.example", { nonce: null }));
    it("wrong audience", () => refused("aud@corp.example", { aud: "some-other-client" }));
    it("wrong issuer", () => refused("iss@corp.example", { iss: "https://accounts.evil.example" }));
    it("expired", () => refused("exp@corp.example", { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 1200 }));
    it("signed by a key the provider doesn't publish", () => refused("forged@corp.example", { signWith: "other" }));
    it("HS256 signed with the client secret", () => refused("hs@corp.example", { signWith: "hs256" }));
    it("alg none", () => refused("none@corp.example", { signWith: "none" }));
    it("unverified email", () => refused("unv@corp.example", { email_verified: false }, "sso_email_unverified"));
    it("email_verified as a string isn't true", () => refused("str@corp.example", { email_verified: "true" }, "sso_email_unverified"));
    it("email_verified missing", () => refused("miss@corp.example", { email_verified: null }, "sso_email_unverified"));
    it("no email at all", async () => {
      const s = (await beginSso(p, { email: "noemail@corp.example" }))!;
      await expect(finishSso(p, idp.approve(s.url, { email: null }), s.binding)).rejects.toMatchObject({ code: "sso_no_email" });
    });
    it("records a content-free refusal in the audit log", async () => {
      const a = await p.db.withSystem(t => t.query<any>("SELECT meta FROM audit_events WHERE event='auth.sso_refused' AND tenant_id=$1", [owner.tenantId]));
      expect(a.length).toBeGreaterThan(5);
      expect(JSON.stringify(a)).not.toMatch(/@corp\.example/);
    });
    it("errors the provider returns are refused, not trusted", async () => {
      const s = (await beginSso(p, { email: "denied@corp.example" }))!;
      const state = new URL(s.url).searchParams.get("state")!;
      await expect(finishSso(p, new URLSearchParams({ state, error: "access_denied" }), s.binding)).rejects.toMatchObject({ code: "sso_denied" });
    });
    it("a code the provider never issued fails at the token endpoint", async () => {
      const s = (await beginSso(p, { email: "badcode@corp.example" }))!;
      const state = new URL(s.url).searchParams.get("state")!;
      await expect(finishSso(p, new URLSearchParams({ state, code: "made-up" }), s.binding)).rejects.toMatchObject({ code: "sso_token_invalid" });
    });
  });

  describe("state", () => {
    it("can't be reused, even after a success", async () => {
      const s = (await beginSso(p, { email: "reuse@corp.example" }))!;
      const params = idp.approve(s.url, { email: "reuse@corp.example" });
      await finishSso(p, params, s.binding);
      await expect(finishSso(p, params, s.binding)).rejects.toMatchObject({ code: "sso_state_invalid" });
      const again = idp.approve(s.url, { email: "reuse@corp.example" });
      await expect(finishSso(p, again, s.binding)).rejects.toMatchObject({ code: "sso_state_invalid" });
    });
    it("is refused from a browser that didn't start it: login CSRF", async () => {
      const s = (await beginSso(p, { email: "csrf@corp.example" }))!;
      const params = idp.approve(s.url, { email: "csrf@corp.example" });
      await expect(finishSso(p, params, undefined)).rejects.toMatchObject({ code: "sso_state_invalid" });
      // The attempt is burnt, so the right browser can't be raced into finishing it later.
      await expect(finishSso(p, params, s.binding)).rejects.toMatchObject({ code: "sso_state_invalid" });
      const s2 = (await beginSso(p, { email: "csrf2@corp.example" }))!;
      await expect(finishSso(p, idp.approve(s2.url, { email: "csrf2@corp.example" }), "the-attackers-own-cookie")).rejects.toMatchObject({ code: "sso_state_invalid" });
      expect(await users("csrf@corp.example")).toHaveLength(0);
    });
    it("made up or missing state", async () => {
      await expect(finishSso(p, new URLSearchParams({ state: "nope", code: "x" }), "b")).rejects.toMatchObject({ code: "sso_state_invalid" });
      await expect(finishSso(p, new URLSearchParams({ code: "x" }), "b")).rejects.toMatchObject({ code: "sso_state_invalid" });
    });
    it("expires", async () => {
      const s = (await beginSso(p, { email: "late@corp.example" }))!;
      await p.db.withSystem(t => t.query("UPDATE sso_flows SET expires_at=now() - interval '1 minute'"));
      await expect(finishSso(p, idp.approve(s.url, { email: "late@corp.example" }), s.binding)).rejects.toMatchObject({ code: "sso_state_invalid" });
    });
    it("doesn't store the verifier or nonce in readable form", async () => {
      const s = (await beginSso(p, { email: "atrest@corp.example" }))!;
      const u = new URL(s.url);
      const rows = await p.db.withSystem(t => t.query<any>("SELECT * FROM sso_flows"));
      const dump = JSON.stringify(rows) + rows.map(r => r.secret_enc.toString("latin1")).join("");
      expect(dump).not.toContain(u.searchParams.get("nonce"));
      expect(dump).not.toContain(u.searchParams.get("state"));
      expect(dump).not.toContain(s.binding);
    });
  });

  describe("cross-tenant domains", () => {
    it("a provider can't sign in an address on another tenant's domain", async () => {
      const s = (await beginSso(p, { email: "someone@evil.example" }))!;
      await expect(finishSso(p, attackerIdp.approve(s.url, { email: "victim@corp.example" }), s.binding)).rejects.toMatchObject({ code: "sso_domain_mismatch" });
      expect(await users("victim@corp.example")).toHaveLength(0);
    });
    it("a subdomain isn't the domain", async () => {
      expect(await beginSso(p, { email: "x@sub.corp.example" })).toBeNull();
      const s = (await beginSso(p, { email: "x@corp.example" }))!;
      await expect(finishSso(p, idp.approve(s.url, { email: "x@sub.corp.example" }), s.binding)).rejects.toMatchObject({ code: "sso_domain_mismatch" });
    });
    it("a second tenant can't configure a domain already taken", async () => {
      const t2 = await user(p, "two@second.example", { kind: "organization" });
      await verifiedDomain(p, t2, "corp.example");
      await expect(saveSsoConfig(p, t2, { domain: "corp.example", issuer: attackerIdp.issuer, clientId: "evil-client", clientSecret: "x" })).rejects.toMatchObject({ code: "domain_claimed" });
    });
    it("a tenant can't configure a domain it hasn't verified", async () => {
      const d = await user(p, "d@unverified.example", { kind: "organization" });
      await addDomain(p, d, "unverified.example");
      await expect(saveSsoConfig(p, d, { domain: "unverified.example", issuer: attackerIdp.issuer, clientId: "c", clientSecret: "x" })).rejects.toMatchObject({ code: "domain_unverified" });
      await expect(saveSsoConfig(p, d, { domain: "never-added.example", issuer: attackerIdp.issuer, clientId: "c", clientSecret: "x" })).rejects.toMatchObject({ code: "domain_unverified" });
      expect(await beginSso(p, { email: "x@unverified.example" })).toBeNull();
    });
    it("if the domain stops being verified, sign-in in flight stops too", async () => {
      const o = await user(p, "o@lapse.example", { kind: "organization" });
      await verifiedDomain(p, o, "lapse.example");
      await saveSsoConfig(p, o, { domain: "lapse.example", issuer: idp.issuer, clientId: "corp-client", clientSecret: secret });
      const s = (await beginSso(p, { email: "a@lapse.example" }))!;
      await p.db.withUser(o, t => t.query("UPDATE verified_domains SET verified_at=NULL WHERE domain='lapse.example'"));
      await expect(finishSso(p, idp.approve(s.url, { email: "a@lapse.example" }), s.binding)).rejects.toMatchObject({ code: "sso_not_available" });
      expect(await beginSso(p, { email: "a@lapse.example" })).toBeNull();
    });
    it("the same subject from another tenant's provider is a different identity", async () => {
      await signInVia("alice@corp.example", { sub: "shared-sub" });
      const r = await signInVia("mallory2@evil.example", { sub: "shared-sub" }, attackerIdp);
      if (r.kind !== "session") throw new Error("expected a session");
      expect((await resolveSession(p, r.token))!.email).toBe("mallory2@evil.example");
    });
  });

  describe("account takeover", () => {
    const password = async (email: string) => (await users(email))[0]?.password_hash;
    it("an attacker's provider claiming a verified victim's address is refused", async () => {
      const v = await signUp(p, { email: "victim2@corp.example", password: pw, name: "V", workspaceKind: "personal" });
      await markVerified(p, v.userId);
      const s = (await beginSso(p, { email: "m@evil.example" }))!;
      await expect(finishSso(p, attackerIdp.approve(s.url, { email: "victim2@corp.example", sub: "evil" }), s.binding)).rejects.toMatchObject({ code: "sso_domain_mismatch" });
      expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE user_id=$1", [v.userId]))).toHaveLength(0);
      expect(await signIn(p, { email: "victim2@corp.example", password: pw })).toBeDefined();
    });
    it("the domain's own provider can't link with an unverified claim", async () => {
      const v = await signUp(p, { email: "victim3@corp.example", password: pw, name: "V", workspaceKind: "personal" });
      await expect(signInVia("victim3@corp.example", { email_verified: false })).rejects.toMatchObject({ code: "sso_email_unverified" });
      expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE user_id=$1", [v.userId]))).toHaveLength(0);
    });
    it("the domain's verified provider with a verified claim links, and a proven account keeps its password", async () => {
      const v = await signUp(p, { email: "linked@corp.example", password: pw, name: "L", workspaceKind: "personal" });
      await markVerified(p, v.userId);
      const r = await signInVia("linked@corp.example", { sub: "linked-sub" });
      if (r.kind !== "session") throw new Error("expected a session");
      expect(r.userId).toBe(v.userId);
      expect(await password("linked@corp.example")).toBeTruthy();
    });
    it("pre-hijacking: a squatter who signed up first and never verified loses every way in", async () => {
      const squatter = await signUp(p, { email: "ceo@corp.example", password: "squatter-password-123", name: "Squatter", workspaceKind: "personal" });
      const r = await signInVia("ceo@corp.example", { sub: "real-ceo" });
      if (r.kind !== "session") throw new Error("expected a session");
      expect(r.userId).toBe(squatter.userId);
      expect(await password("ceo@corp.example")).toBeNull();
      expect(await resolveSession(p, squatter.token)).toBeNull();
      await expect(signIn(p, { email: "ceo@corp.example", password: "squatter-password-123" })).rejects.toMatchObject({ status: 401 });
      expect((await users("ceo@corp.example"))[0].email_verified_at).toBeTruthy();
    });
    it("with JIT off, nobody new gets in, and an existing member still can", async () => {
      await saveSsoConfig(p, owner, { domain: "corp.example", issuer: idp.issuer, clientId: "corp-client", jitEnabled: false });
      await expect(signInVia("nojit@corp.example")).rejects.toMatchObject({ code: "sso_not_provisioned" });
      expect(await users("nojit@corp.example")).toHaveLength(0);
      expect((await signInVia("again@corp.example", { sub: "again-sub" })).kind).toBe("session");
      await saveSsoConfig(p, owner, { domain: "corp.example", issuer: idp.issuer, clientId: "corp-client", jitEnabled: true });
    });
    it("someone switched off through SCIM can't come back through JIT", async () => {
      const r = await signInVia("leaver@corp.example");
      if (r.kind !== "session") throw new Error("expected a session");
      const { token } = await rotateScimToken(p, owner);
      const a = await authenticateScim(p, `Bearer ${token}`);
      await scimPatchUser(p, a, r.userId, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] });
      await expect(signInVia("leaver@corp.example")).rejects.toMatchObject({ code: "sso_not_provisioned" });
    });
    it("an account with an authenticator app also needs its code", async () => {
      const r = await signInVia("mfa@corp.example", { sub: "mfa-sub" });
      if (r.kind !== "session") throw new Error("expected a session");
      // No password on this account: the sign-in a moment ago is what lets it add a factor.
      const ctx = { tenantId: r.tenantId, userId: r.userId, sessionId: r.sessionId };
      const { secret: totpSecret } = await beginTotpEnrollment(p, ctx, "mfa@corp.example");
      const code = () => new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(totpSecret) }).generate();
      await confirmTotp(p, ctx, code());
      const second = await signInVia("mfa@corp.example", { sub: "mfa-sub" });
      expect(second.kind).toBe("mfa");
      if (second.kind !== "mfa") return;
      await expect(finishSsoMfa(p, { ticket: second.ticket, code: "000000" })).rejects.toMatchObject({ code: "invalid_mfa" });
      await expect(finishSsoMfa(p, { ticket: "made-up-ticket-value", code: code() })).rejects.toMatchObject({ code: "sso_state_invalid" });
      const s = await finishSsoMfa(p, { ticket: second.ticket, code: code() });
      expect((await resolveSession(p, s.token))?.email).toBe("mfa@corp.example");
      await expect(finishSsoMfa(p, { ticket: second.ticket, code: code() })).rejects.toMatchObject({ code: "sso_state_invalid" });
    });
  });

  describe("discovery doesn't reveal accounts", () => {
    it("answers the same for registered and unregistered addresses", async () => {
      const known = await beginSso(p, { email: "owner@admin.corp.example" });
      const stranger = await beginSso(p, { email: "nobody@admin.corp.example" });
      expect(known).toBeNull();
      expect(stranger).toBeNull();
      const a = new URL((await beginSso(p, { email: "alice@corp.example" }))!.url);
      const b = new URL((await beginSso(p, { email: "nobody-at-all@corp.example" }))!.url);
      for (const u of [a, b]) for (const k of ["state", "nonce", "code_challenge", "login_hint"]) u.searchParams.delete(k);
      expect(a.toString()).toBe(b.toString());
    });
    it("malformed addresses are just unavailable", async () => {
      for (const email of ["", "nope", "@corp.example", "a@", "a b@corp.example"]) expect(await beginSso(p, { email })).toBeNull();
    });
    it("is rate limited per client", async () => {
      for (let i = 0; i < 60; i++) await beginSso(p, { email: "x@nowhere.example" }, "client-a");
      await expect(beginSso(p, { email: "x@nowhere.example" }, "client-a")).rejects.toMatchObject({ status: 429 });
    });
    it("shows only known error codes, never reflected text", () => {
      expect(ssoErrorMessage("<script>alert(1)</script>")).toBeNull();
      expect(ssoErrorMessage("__proto__")).toBeNull();
      expect(ssoErrorMessage("sso_required")).toBeTruthy();
    });
  });

  describe("enforced SSO", () => {
    let member: { email: string };
    beforeAll(async () => {
      member = { email: "enforced@locked.example" };
      const o = await user(p, "o@lockedowner.example", { kind: "organization" });
      await verifiedDomain(p, o, "locked.example");
      (member as any).ctx = o;
      const { id } = await saveSsoConfig(p, o, { domain: "locked.example", issuer: idp.issuer, clientId: "corp-client", clientSecret: secret });
      (member as any).id = id;
      await signUp(p, { email: member.email, password: pw, name: "E", workspaceKind: "personal" });
    });
    it("can't be turned on until a sign-in has worked", async () => {
      await expect(setSsoEnforced(p, (member as any).ctx, (member as any).id, true)).rejects.toMatchObject({ code: "sso_untested" });
      await expect(signIn(p, { email: member.email, password: pw })).resolves.toBeDefined();
    });
    it("then refuses password sign-in, sign-up, reset and social for that domain", async () => {
      const s = (await beginSso(p, { email: "first@locked.example" }))!;
      await finishSso(p, idp.approve(s.url, { email: "first@locked.example" }), s.binding);
      await setSsoEnforced(p, (member as any).ctx, (member as any).id, true);
      await expect(signIn(p, { email: member.email, password: pw })).rejects.toMatchObject({ code: "sso_required", status: 403 });
      await expect(signIn(p, { email: "never-registered@locked.example", password: pw })).rejects.toMatchObject({ code: "sso_required", status: 403 });
      await expect(signUp(p, { email: "new@locked.example", password: pw, name: "N", workspaceKind: "personal" })).rejects.toMatchObject({ code: "sso_required" });
      const before = (await p.db.withSystem(t => t.one<any>("SELECT count(*)::int c FROM outbound_mail WHERE kind='password_reset'")))!.c;
      await (await requestPasswordReset(p, member.email)).done;
      expect((await p.db.withSystem(t => t.one<any>("SELECT count(*)::int c FROM outbound_mail WHERE kind='password_reset'")))!.c).toBe(before);
    });
    it("doesn't touch other domains", async () => {
      await expect(signIn(p, { email: "owner@admin.corp.example", password: pw })).resolves.toBeDefined();
    });
    it("changing the provider switches enforcement off, so a wrong issuer can't lock people out", async () => {
      await saveSsoConfig(p, (member as any).ctx, { domain: "locked.example", issuer: attackerIdp.issuer, clientId: "other" });
      await expect(signIn(p, { email: member.email, password: pw })).resolves.toBeDefined();
    });
  });

  describe("configuration", () => {
    it("is owner only, because whoever runs the provider can sign in as anyone on the domain", async () => {
      const { acceptUrl } = await invite(p, owner, { email: "sec@corp.example", role: "security_admin" });
      const s = await signUp(p, { email: "sec@corp.example", password: pw, name: "Sec", workspaceKind: "personal" }).catch(() => null);
      if (!s) throw new Error("signup failed");
      await markVerified(p, s.userId);
      await acceptInvite(p, s.userId, "sec@corp.example", acceptUrl!.split("/").pop()!);
      const sec = { tenantId: owner.tenantId, userId: s.userId };
      await expect(ssoOverview(p, sec)).rejects.toMatchObject({ status: 403 });
      await expect(saveSsoConfig(p, sec, { domain: "corp.example", issuer: attackerIdp.issuer, clientId: "x", clientSecret: "y" })).rejects.toMatchObject({ status: 403 });
      await expect(setSsoEnforced(p, sec, configId, true)).rejects.toMatchObject({ status: 403 });
      await expect(removeSsoConfig(p, sec, configId)).rejects.toMatchObject({ status: 403 });
      await expect(rotateScimToken(p, sec)).rejects.toMatchObject({ status: 403 });
      await expect(p.db.withUser(sec, t => t.query("SELECT * FROM sso_configs"))).resolves.toEqual([]);
      await expect(changeRole(p, sec, s.userId, "owner")).rejects.toMatchObject({ status: 403 });
    });
    it("never returns the secret, and stores it sealed", async () => {
      const o = await ssoOverview(p, owner);
      expect(JSON.stringify(o)).not.toContain(secret);
      const row = await p.db.withSystem(t => t.one<any>("SELECT client_secret_enc FROM sso_configs WHERE id=$1", [configId]));
      expect(row.client_secret_enc.toString("latin1")).not.toContain(secret);
    });
    it("doesn't log the secret, codes or tokens", () => {
      expect(logs.join("\n")).not.toContain(secret);
      expect(logs.join("\n")).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
      expect(logs.join("\n")).not.toContain("@corp.example");
    });
    it("is another tenant's business: a config can't be read, changed or removed across tenants", async () => {
      await expect(setSsoEnforced(p, attacker, configId, false)).rejects.toMatchObject({ status: 404 });
      await expect(removeSsoConfig(p, attacker, configId)).rejects.toMatchObject({ status: 404 });
      expect(JSON.stringify(await ssoOverview(p, attacker))).not.toContain("corp.example");
    });
    it("removing it stops sign-in", async () => {
      const o = await user(p, "o@gone.example", { kind: "organization" });
      await verifiedDomain(p, o, "gone.example");
      const { id } = await saveSsoConfig(p, o, { domain: "gone.example", issuer: idp.issuer, clientId: "corp-client", clientSecret: secret });
      const s = (await beginSso(p, { email: "a@gone.example" }))!;
      await finishSso(p, idp.approve(s.url, { email: "a@gone.example" }), s.binding);
      await removeSsoConfig(p, o, id);
      expect(await beginSso(p, { email: "a@gone.example" })).toBeNull();
      expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE provider LIKE $1", [`sso:${id}:%`]))).toHaveLength(0);
    });
    it("a personal workspace can't have it", async () => {
      const u = await user(p, "solo@solo.example");
      await verifiedDomain(p, u, "solo.example");
      await expect(saveSsoConfig(p, u, { domain: "solo.example", issuer: idp.issuer, clientId: "c", clientSecret: "x" })).rejects.toMatchObject({ code: "organization_only" });
    });
  });

  it("reports what exists to the sign-in pages", async () => {
    expect(await publicSignInOptions(p)).toEqual({ sso: true, google: false, microsoft: false });
  });
});

describe("an issuer is a server-side request to somewhere a customer chose", () => {
  let p: Platform, drop: () => Promise<void>, o: Ctx, idp: Awaited<ReturnType<typeof fakeOidc>>;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" } }));
    idp = await fakeOidc({ clientId: "c", clientSecret: "s" });
    o = await user(p, "o@ssrf.example", { kind: "organization" });
    await verifiedDomain(p, o, "ssrf.example");
  });
  afterAll(async () => { await idp.close(); await drop(); });
  it.each(["http://169.254.169.254/latest", "https://169.254.169.254/", "https://127.0.0.1/", "https://localhost/", "https://10.0.0.1/", "https://[::1]/", "https://user:pass@login.example.com/", "https://login.example.com/?x=1", "ftp://login.example.com/", "javascript:alert(1)"])("refuses %s", async issuer => {
    await expect(saveSsoConfig(p, o, { domain: "ssrf.example", issuer, clientId: "c", clientSecret: "s" })).rejects.toMatchObject({ status: 400 });
  });
  it("without the test seam, a loopback provider is refused too", async () => {
    await expect(saveSsoConfig(p, o, { domain: "ssrf.example", issuer: idp.issuer, clientId: "c", clientSecret: "s" })).rejects.toMatchObject({ code: "issuer_invalid" });
    expect(idp.seen.tokenRequests).toBe(0);
  });
  it("the guard refuses a name that resolves to a private address", async () => {
    await expect(checkHttpsHost("idp.example.com", 443, { resolver: async () => [{ address: "10.1.2.3" }] })).rejects.toMatchObject({ reason: "reserved_address" });
    await expect(checkHttpsHost("idp.example.com", 443, { resolver: async () => [{ address: "8.8.8.8" }, { address: "127.0.0.1" }] })).rejects.toMatchObject({ reason: "reserved_address" });
    await expect(checkHttpsHost("idp.example.com", 22, { resolver: async () => [{ address: "8.8.8.8" }] })).rejects.toMatchObject({ reason: "port_not_allowed" });
    await expect(checkHttpsHost("idp.example.com", 443, { resolver: async () => [{ address: "8.8.8.8" }] })).resolves.toMatchObject({ ip: "8.8.8.8", servername: "idp.example.com" });
  });
  it("connects to the pinned address, and checks the certificate against the name", async () => {
    const pems = await generate([{ name: "commonName", value: "idp.example.com" }], { algorithm: "sha256", keySize: 2048, extensions: [{ name: "basicConstraints", cA: true, critical: true }, { name: "subjectAltName", altNames: [{ type: 2, value: "idp.example.com" }] }] } as never);
    const server = createTlsServer({ key: pems.private, cert: pems.cert }, (req, res) => { res.writeHead(200, { "content-type": "application/json", "x-host": req.headers.host ?? "" }); res.end('{"ok":true}'); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const pin = (name: string) => ({ ip: "127.0.0.1", family: 4 as const, port, hostname: name, servername: name });
    const r = await pinnedRequest(new URL(`https://idp.example.com:${port}/x`), pin("idp.example.com"), {}, { ca: pems.cert });
    expect(await r.json()).toEqual({ ok: true });
    await expect(pinnedRequest(new URL(`https://other.example.com:${port}/x`), pin("other.example.com"), {}, { ca: pems.cert })).rejects.toThrow(/altnames|does not match/i);
    await expect(pinnedRequest(new URL(`https://idp.example.com:${port}/x`), pin("idp.example.com"))).rejects.toThrow();
    server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
  });
});

describe("Continue with Google and Microsoft", () => {
  let p: Platform, drop: () => Promise<void>, google: Awaited<ReturnType<typeof fakeOidc>>, ms: Awaited<ReturnType<typeof fakeOidc>>;
  const tid = "11111111-2222-4333-8444-555555555555";
  beforeAll(async () => {
    google = await fakeOidc({ clientId: "g", clientSecret: "gs" });
    ms = await fakeOidc({ clientId: "m", clientSecret: "ms", kid: "m1" });
    ({ p, drop } = await testPlatform({ config: { ...CONFIG, social: { google: { clientId: "g", clientSecret: "gs", issuer: google.issuer }, microsoft: { clientId: "m", clientSecret: "ms", issuer: ms.issuer, issuerTemplate: "https://login.microsoftonline.test/{tid}/v2.0" } } } }));
  });
  afterAll(async () => { await google.close(); await ms.close(); await drop(); });
  const viaGoogle = async (overrides: TokenOverrides) => {
    const s = await beginSocial(p, "google");
    return finishSso(p, google.approve(s.url, overrides), s.binding);
  };
  const viaMs = async (overrides: TokenOverrides) => {
    const s = await beginSocial(p, "microsoft");
    return finishSso(p, ms.approve(s.url, overrides), s.binding);
  };
  const msIss = `https://login.microsoftonline.test/${tid}/v2.0`;

  it("creates a verified account with its own personal workspace, separate from any mailbox", async () => {
    const r = await viaGoogle({ email: "new@gmail.test", sub: "g-1", name: "New" });
    if (r.kind !== "session") throw new Error("expected a session");
    const s = (await resolveSession(p, r.token))!;
    expect(s).toMatchObject({ email: "new@gmail.test", emailVerified: true });
    expect(s.workspaces[0]!.kind).toBe("personal");
    const accounts = await p.db.withUser({ tenantId: s.tenantId, userId: s.userId }, t => t.query("SELECT 1 FROM mail_accounts"));
    expect(accounts).toHaveLength(0);
    const grants = await p.db.withUser({ tenantId: s.tenantId, userId: s.userId }, t => t.query("SELECT 1 FROM oauth_grants"));
    expect(grants).toHaveLength(0);
  });
  it("asks only for identity scopes, never mail", async () => {
    const s = await beginSocial(p, "google");
    expect(new URL(s.url).searchParams.get("scope")).toBe("openid email profile");
  });
  it("returns the same account on the next sign-in, by identity", async () => {
    const r = await viaGoogle({ email: "new@gmail.test", sub: "g-1" });
    if (r.kind !== "session") throw new Error("expected a session");
    expect((await resolveSession(p, r.token))!.email).toBe("new@gmail.test");
  });
  it("never links to an existing account by email, even a verified claim: takeover attempt", async () => {
    const v = await signUp(p, { email: "victim@gmail.test", password: pw, name: "V", workspaceKind: "personal" });
    await markVerified(p, v.userId);
    await expect(viaGoogle({ email: "victim@gmail.test", sub: "attacker-sub" })).rejects.toMatchObject({ code: "sso_account_exists" });
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE user_id=$1", [v.userId]))).toHaveLength(0);
  });
  it("refuses to create an account from an unverified address", async () => {
    await expect(viaGoogle({ email: "unv@gmail.test", sub: "g-2", email_verified: false })).rejects.toMatchObject({ code: "sso_email_unverified" });
    await expect(viaGoogle({ email: "unv@gmail.test", sub: "g-2", email_verified: null })).rejects.toMatchObject({ code: "sso_email_unverified" });
  });
  it("Microsoft: iss has to name the tid in the same token", async () => {
    await expect(viaMs({ iss: msIss, extra: { tid: "99999999-2222-4333-8444-555555555555", xms_edov: true }, email: "a@contoso.test" })).rejects.toMatchObject({ code: "sso_token_invalid" });
    await expect(viaMs({ iss: msIss, email: "a@contoso.test", extra: { xms_edov: true } })).rejects.toMatchObject({ code: "sso_token_invalid" });
  });
  it("Microsoft: a plain email claim isn't verified, because Entra doesn't verify it", async () => {
    await expect(viaMs({ iss: msIss, email_verified: null, extra: { tid }, email: "a@contoso.test", sub: "m-1" })).rejects.toMatchObject({ code: "sso_email_unverified" });
    const r = await viaMs({ iss: msIss, email_verified: null, extra: { tid, xms_edov: true }, email: "a@contoso.test", sub: "m-1" });
    expect(r.kind).toBe("session");
    const row = await p.db.withSystem(t => t.one<any>("SELECT subject FROM identities WHERE provider='microsoft'"));
    expect(row.subject).toBe(`${tid}:m-1`);
  });
  it("is off until configured", async () => {
    const { p: q, drop: d } = await testPlatform({ config: CONFIG });
    await expect(beginSocial(q, "google")).rejects.toMatchObject({ status: 404 });
    await expect(beginSocial(q, "microsoft")).rejects.toMatchObject({ status: 404 });
    await expect(beginSocial(q, "yahoo")).rejects.toMatchObject({ status: 404 });
    expect(await publicSignInOptions(q)).toEqual({ sso: false, google: false, microsoft: false });
    await d();
  });
  it("configFromEnv reads its own settings, not the mailbox client", async () => {
    const { configFromEnv } = await import("../context");
    expect(configFromEnv({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" } as never).social?.google).toBeUndefined();
    expect(configFromEnv({ SIGNIN_GOOGLE_CLIENT_ID: "x", SIGNIN_GOOGLE_CLIENT_SECRET: "y" } as never).social?.google?.clientId).toBe("x");
    expect(configFromEnv({} as never).ssoAllowLoopback).toBeUndefined();
    expect(configFromEnv({ AEGIS_TEST_SSO_LOOPBACK: "true" } as never).ssoAllowLoopback).toBeUndefined();
    expect(configFromEnv({ AEGIS_TEST_SSO_LOOPBACK: "true", DEMO_MODE: "true" } as never).ssoAllowLoopback).toBe(true);
  });
});
void beginPasskeySignIn; void makeLogger; void scimCreateUser;
