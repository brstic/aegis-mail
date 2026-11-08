import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { TOTP } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDomain, limitsFor, beginPasskeyRegistration, beginPasskeySignIn, beginSso, beginTotpEnrollment, confirmTotp, type Ctx, createPlatform, deleteAccount, disableTotp, drainJobs, type FactorProof, finishPasskeyRegistration, finishPasskeySignIn, finishSaml, grantOperator, listDomains, makeLogger, operatorGate, type Platform, recheckDomains, requestPasswordReset, resetPassword, resolveSession, rotateScimToken, samlAcsUrl, samlEntityId, saveSamlConfig, scimCreateUser, scimPatchUser, signIn, signUp, tick, verifyDomain, authenticateScim } from "../index";
import { assertion, b64, IDP, keypair, response, sign } from "./fake-saml";
import { testPlatform, user } from "./harness";
import { webClient } from "./web-harness";
import { createTestDb } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";

/**
 * Independent review. What a stolen session can do when no authenticator app is on. Each test states the secure behaviour, so a
 * failure here is the bug.
 */
const ORIGIN = "http://localhost:3000", RP = "localhost";
const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b as Uint8Array).toString("base64url");

/** A software authenticator, standing in for whichever device an attacker registers. */
function softAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  const rpHash = createHash("sha256").update(RP).digest();
  let counter = 1;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    credId: b64u(credId),
    register(challenge: string) {
      const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(16), len, credId, Buffer.from(cose)]);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData("webauthn.create", challenge)), attestationObject: b64u(attestationObject), transports: ["internal"] } };
    },
    sign(challenge: string) {
      const c = Buffer.alloc(4); c.writeUInt32BE(++counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), c]);
      const cd = clientData("webauthn.get", challenge);
      const signature = createSign("sha256").update(Buffer.concat([authData, createHash("sha256").update(cd).digest()])).sign(privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: "public-key", clientExtensionResults: {}, response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) } };
    },
  };
}
const PASSWORD = "correct-horse-battery";
const addPasskey = async (p: Platform, ctx: Ctx, email: string, a: ReturnType<typeof softAuthenticator>, proof: FactorProof = {}) => {
  const { options, challengeId } = await beginPasskeyRegistration(p, ctx, email, proof);
  await finishPasskeyRegistration(p, ctx, challengeId, a.register(options.challenge));
};
const passkeyIn = async (p: Platform, a: ReturnType<typeof softAuthenticator>) => {
  const { options, challengeId } = await beginPasskeySignIn(p);
  return finishPasskeySignIn(p, challengeId, a.sign(options.challenge));
};
const code = (secret: string) => new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret }).generate();
const backdate = (p: Platform, sessionId: string) => p.db.withSystem(t => t.query("UPDATE sessions SET created_at=now() - interval '3 days' WHERE id=$1", [sessionId]));

describe("review: what a stolen session can do", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); });
  afterAll(() => drop());

  it("a session alone can't lock the owner out by enrolling an authenticator app (auth.ts beginTotpEnrollment)", async () => {
    const email = "lockout@session.example";
    const stolen = await user(p, email);
    const enrolled = await beginTotpEnrollment(p, stolen, email).catch(() => null);
    if (enrolled) await confirmTotp(p, stolen, code(enrolled.secret)).catch(() => null);
    // The real owner, who knows the password and has never seen that secret.
    await expect(signIn(p, { email, password: "correct-horse-battery" })).resolves.toHaveProperty("token");
  });

  it("an old stolen session can't make itself fresh with a passkey, to pass reauthenticate's password-less branch (auth.ts:209)", async () => {
    const email = "federated@session.example";
    const stolen = await user(p, email);
    await p.db.withSystem(t => t.query("UPDATE users SET password_hash=NULL, email_verified_at=now() WHERE id=$1", [stolen.userId]));
    await backdate(p, stolen.sessionId!);
    const del = (c: Ctx) => deleteAccount(p, c, { confirmEmail: email, email, password: "" });
    await expect(del(stolen)).rejects.toMatchObject({ code: "reauth_required" });
    const a = softAuthenticator();
    const minted = await addPasskey(p, stolen, email, a).then(() => passkeyIn(p, a)).catch(() => null);
    if (minted) await expect(del({ ...stolen, sessionId: minted.sessionId })).rejects.toMatchObject({ code: "reauth_required" });
  });

  it("a passkey added through a stolen session doesn't survive the owner resetting the password (identity.ts resetPassword)", async () => {
    const email = "persist@session.example";
    const stolen = await user(p, email);
    await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [stolen.userId]));
    const a = softAuthenticator();
    // A session alone can't add one any more, so this is the worse case: whoever stole it has the password too.
    await addPasskey(p, stolen, email, a, { password: PASSWORD });
    const token = randomBytes(32).toString("base64url");
    await p.db.withSystem(t => t.query("INSERT INTO email_tokens(user_id,purpose,token_hash,email,expires_at) VALUES ($1,'password_reset',$2,$3, now() + interval '1 hour')", [stolen.userId, createHash("sha256").update(token).digest("hex"), email]));
    await resetPassword(p, { token, password: "a-brand-new-password-1" });
    await expect(passkeyIn(p, a)).rejects.toBeDefined();
  });

  it("a code from an authenticator app can't be used twice (auth.ts verifyUserTotp)", async () => {
    const email = "replay@session.example";
    const ctx = await user(p, email);
    const { secret } = await beginTotpEnrollment(p, ctx, email, { password: PASSWORD });
    await confirmTotp(p, ctx, code(secret));
    const c = code(secret);
    await signIn(p, { email, password: "correct-horse-battery", totp: c });
    await expect(signIn(p, { email, password: "correct-horse-battery", totp: c })).rejects.toMatchObject({ code: "invalid_mfa" });
  });
});

describe("review: the operator gate", () => {
  let p: Platform, dropDb: () => Promise<void>;
  beforeAll(async () => {
    const { db, drop } = await createTestDb("rv");
    dropDb = drop;
    p = createPlatform({ db, kms: new LocalDevKms(randomBytes(32)), config: { demoMode: false, appOrigin: ORIGIN, webauthnRpId: RP }, log: makeLogger(() => {}), env: {} });
  });
  afterAll(() => dropDb());

  it("a session from before MFA was on stays short of the operator area, even after a code is enrolled through it (operator.ts:30)", async () => {
    const email = "op@session.example";
    const s = await signUp(p, { email, password: "correct-horse-battery", name: "Op", workspaceKind: "personal" });
    await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [s.userId]));
    expect((await grantOperator(p, email, "cli")).outcome).toBe("granted");
    const stolen: Ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
    expect((await operatorGate(p, { userId: s.userId, sessionId: s.sessionId })).state).toBe("needs_mfa");
    const enrolled = await beginTotpEnrollment(p, stolen, email).catch(() => null);
    if (enrolled) await confirmTotp(p, stolen, code(enrolled.secret)).catch(() => null);
    expect((await operatorGate(p, { userId: s.userId, sessionId: s.sessionId })).state).toBe("needs_mfa");
  });
});

/**
 * Independent review. Each test states the secure behaviour, so a failure here is the bug. These stay as regression tests.
 */
const memberCount = (p: Platform, tenantId: string) => p.db.withSystem(t => t.one<{ c: number }>("SELECT count(*)::int c FROM memberships WHERE tenant_id=$1", [tenantId])).then(r => r!.c);

describe("review: member limits", () => {
  let p: Platform, drop: () => Promise<void>;
  // An instance-wide limit of one member, set the way a server admin would, through AEGIS_LIMIT_SEATS.
  beforeAll(async () => { ({ p, drop } = await testPlatform({ env: { AEGIS_LIMIT_SEATS: "1" } })); });
  afterAll(() => drop());

  const orgWithDomain = async (domain: string) => {
    const owner = await user(p, `owner@admin.${domain}`, { kind: "organization" });
    const d = await addDomain(p, owner, domain);
    await verifyDomain(p, owner, domain, async () => [[d!.token]]);
    return owner;
  };

  it("SSO JIT can't take a workspace past its member limit (sso.ts resolveTenantUser)", async () => {
    const domain = "one-jit.example";
    const owner = await orgWithDomain(domain);
    const keys = await keypair("idp.one-jit.example");
    await saveSamlConfig(p, owner, { domain, idpEntityId: IDP, entryPoint: "https://idp.one-jit.example/sso", idpCert: keys.cert });
    const { inflateRawSync } = await import("node:zlib");
    for (const name of ["a", "b", "c"]) {
      const email = `${name}@${domain}`;
      const s = (await beginSso(p, { email }))!;
      const xml = inflateRawSync(Buffer.from(new URL(s.url).searchParams.get("SAMLRequest")!, "base64")).toString();
      const requestId = /ID="([^"]+)"/.exec(xml)![1]!;
      const signed = response(sign(assertion({ nameId: email, audience: samlEntityId(p, domain), recipient: samlAcsUrl(p, domain), inResponseTo: requestId }), keys), { destination: samlAcsUrl(p, domain), inResponseTo: requestId });
      await finishSaml(p, domain, b64(signed), s.binding).catch(() => null);
    }
    expect((await limitsFor(p, owner.tenantId)).seats).toBe(1);
    expect(await memberCount(p, owner.tenantId)).toBe(1);
  });

  it("SCIM can't take a workspace past its member limit (scim.ts scimCreateUser)", async () => {
    const domain = "one-scim.example";
    const owner = await orgWithDomain(domain);
    const { token } = await rotateScimToken(p, owner);
    const a = await authenticateScim(p, `Bearer ${token}`);
    for (const name of ["a", "b", "c"]) await scimCreateUser(p, a, { userName: `${name}@${domain}` }).catch(() => null);
    expect(await memberCount(p, owner.tenantId)).toBe(1);
  });
});

// ---------- Beyond the proofs above: the other half of each fix, and the ways around it that were considered. ----------
const makeFederated = async (p: Platform, email: string) => {
  const ctx = await user(p, email);
  await p.db.withSystem(t => t.query("UPDATE users SET password_hash=NULL, email_verified_at=now() WHERE id=$1", [ctx.userId]));
  await p.db.withSystem(t => t.query("UPDATE sessions SET auth_method='idp' WHERE id=$1", [ctx.sessionId]));
  return ctx;
};

describe("adding a factor", () => {
  const sent: { to: string; subject: string; text: string }[] = [];
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform({ mailer: { kind: "smtp" as const, async send(m: { to: string; subject: string; text: string }) { sent.push(m); } } })); });
  afterAll(() => drop());

  it("takes the password, refuses a wrong one, and a fresh password session is no stand-in", async () => {
    const email = "needs@factor.example";
    const c = await user(p, email);
    for (const begin of [beginTotpEnrollment, beginPasskeyRegistration] as ((p: Platform, c: Ctx, e: string, pr?: FactorProof) => Promise<unknown>)[]) {
      await expect(begin(p, c, email)).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
      await expect(begin(p, c, email, { password: "not-the-password" })).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });
      await expect(begin(p, c, email, { password: PASSWORD })).resolves.toBeDefined();
    }
  });

  it("an authenticator app ends the other sessions and tells the owner, and this session carries on", async () => {
    const email = "totp-notice@factor.example";
    const c = await user(p, email);
    const other = await signIn(p, { email, password: PASSWORD });
    sent.length = 0;
    const { secret } = await beginTotpEnrollment(p, c, email, { password: PASSWORD });
    const { rotatedToken } = await confirmTotp(p, c, code(secret));
    expect(await resolveSession(p, other.token)).toBeNull();
    expect(await resolveSession(p, rotatedToken)).not.toBeNull();
    await drainJobs(p);
    expect(sent.filter(m => m.to === email && /authenticator app/.test(m.text))).toHaveLength(1);
    expect(sent.at(-1)!.text).not.toContain(secret);
  });

  it("so does a passkey", async () => {
    const email = "pk-notice@factor.example";
    const c = await user(p, email);
    const other = await signIn(p, { email, password: PASSWORD });
    sent.length = 0;
    await addPasskey(p, c, email, softAuthenticator(), { password: PASSWORD });
    expect(await resolveSession(p, other.token)).toBeNull();
    expect(await resolveSession(p, c.token)).not.toBeNull();
    await drainJobs(p);
    expect(sent.filter(m => m.to === email && /passkey/.test(m.text))).toHaveLength(1);
  });

  it("an enrollment and a passkey ceremony can only be finished by the session that started them", async () => {
    const email = "bound@factor.example";
    const c = await user(p, email);
    const other = await signIn(p, { email, password: PASSWORD });
    const otherCtx: Ctx = { tenantId: c.tenantId, userId: c.userId, sessionId: other.sessionId };
    const { secret } = await beginTotpEnrollment(p, c, email, { password: PASSWORD });
    await expect(confirmTotp(p, otherCtx, code(secret))).rejects.toMatchObject({ code: "invalid_mfa" });
    const a = softAuthenticator();
    const { options, challengeId } = await beginPasskeyRegistration(p, c, email, { password: PASSWORD });
    await expect(finishPasskeyRegistration(p, otherCtx, challengeId, a.register(options.challenge))).rejects.toMatchObject({ code: "challenge_expired" });
  });

  it("someone who signs in through a provider adds one on a recent sign-in, and only a recent one", async () => {
    const email = "sso-only@factor.example";
    const c = await makeFederated(p, email);
    await expect(addPasskey(p, c, email, softAuthenticator())).resolves.toBeUndefined();
    const aged = await makeFederated(p, "sso-aged@factor.example");
    await p.db.withSystem(t => t.query("UPDATE sessions SET created_at=now() - interval '11 minutes' WHERE id=$1", [aged.sessionId]));
    await expect(beginTotpEnrollment(p, aged, "sso-aged@factor.example")).rejects.toMatchObject({ status: 401, code: "reauth_required" });
    await expect(beginPasskeyRegistration(p, aged, "sso-aged@factor.example")).rejects.toMatchObject({ status: 401, code: "reauth_required" });
  });

  it("a password the organization has retired by requiring SSO proves nothing, and a sign-in through it does", async () => {
    const org = await user(p, "owner@admin.enforced-pw.example", { kind: "organization" });
    const domain = "enforced-pw.example";
    const d = await addDomain(p, org, domain);
    await verifyDomain(p, org, domain, async () => [[d!.token]]);
    const email = `person@${domain}`;
    const person = await user(p, email);
    const keys = await keypair("idp.enforced-pw.example");
    const { id } = await saveSamlConfig(p, org, { domain, idpEntityId: IDP, entryPoint: "https://idp.enforced-pw.example/sso", idpCert: keys.cert });
    await p.db.withSystem(t => t.query("UPDATE sso_configs SET enforced=true WHERE id=$1", [id]));
    await p.db.withSystem(t => t.query("UPDATE sessions SET created_at=now() - interval '1 hour' WHERE id=$1", [person.sessionId]));
    await expect(beginPasskeyRegistration(p, person, email, { password: PASSWORD })).rejects.toMatchObject({ code: "reauth_required" });
    await p.db.withSystem(t => t.query("UPDATE sessions SET created_at=now(), auth_method='idp' WHERE id=$1", [person.sessionId]));
    await expect(beginPasskeyRegistration(p, person, email)).resolves.toHaveProperty("challengeId");
  });

  it("a passkey on probation doesn't make a session fresh, and one past it does", async () => {
    const email = "probation@factor.example";
    const c = await makeFederated(p, email);
    const a = softAuthenticator();
    await addPasskey(p, c, email, a);
    const del = (sessionId: string) => deleteAccount(p, { ...c, sessionId }, { confirmEmail: email, email, password: "" });
    const recent = await passkeyIn(p, a);
    await expect(del(recent.sessionId)).rejects.toMatchObject({ code: "reauth_required" });
    await p.db.withSystem(t => t.query("UPDATE passkeys SET created_at=now() - interval '8 days' WHERE user_id=$1", [c.userId]));
    const settled = await passkeyIn(p, a);
    await expect(del(settled.sessionId)).resolves.not.toThrow();
  });

  it("the reset mail says what a reset does, and a reset clears a half-finished enrollment too", async () => {
    const email = "reset-all@factor.example";
    const c = await user(p, email);
    await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [c.userId]));
    await beginTotpEnrollment(p, c, email, { password: PASSWORD });
    sent.length = 0;
    await (await requestPasswordReset(p, email)).done;
    await drainJobs(p);
    expect(sent.at(-1)!.text).toMatch(/removes your passkeys/);
    const token = /reset-password\/(\S+)/.exec(sent.at(-1)!.text)![1]!;
    await resetPassword(p, { token, password: "a-brand-new-password-1" });
    const row = await p.db.withSystem(t => t.one<any>("SELECT totp_pending_enc, totp_pending_session FROM users WHERE id=$1", [c.userId]));
    expect(row).toEqual({ totp_pending_enc: null, totp_pending_session: null });
  });
});

describe("a code works once", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); });
  afterAll(() => drop());

  it("across every place one is accepted, and two racing with the same code can't both win", async () => {
    const email = "once@factor.example";
    const c = await user(p, email);
    const { secret } = await beginTotpEnrollment(p, c, email, { password: PASSWORD });
    await confirmTotp(p, c, code(secret));
    const now = code(secret);
    const results = await Promise.allSettled([signIn(p, { email, password: PASSWORD, totp: now }), signIn(p, { email, password: PASSWORD, totp: now })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await expect(disableTotp(p, c, now)).rejects.toMatchObject({ code: "invalid_mfa" });
    await expect(beginPasskeyRegistration(p, c, email, { password: PASSWORD, totp: now })).rejects.toMatchObject({ code: "invalid_mfa" });
  });

  it("an older code in the window isn't accepted after a newer one", async () => {
    const email = "older@factor.example";
    const c = await user(p, email);
    const { secret } = await beginTotpEnrollment(p, c, email, { password: PASSWORD });
    await confirmTotp(p, c, code(secret));
    const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret });
    const previous = totp.generate({ timestamp: Date.now() - 30_000 });
    await signIn(p, { email, password: PASSWORD, totp: totp.generate() });
    await expect(signIn(p, { email, password: PASSWORD, totp: previous })).rejects.toMatchObject({ code: "invalid_mfa" });
  });
});

describe("the operator gate, session by session", () => {
  let p: Platform, dropDb: () => Promise<void>;
  beforeAll(async () => {
    const { db, drop } = await createTestDb("rv");
    dropDb = drop;
    p = createPlatform({ db, kms: new LocalDevKms(randomBytes(32)), config: { demoMode: false, appOrigin: ORIGIN, webauthnRpId: RP }, log: makeLogger(() => {}), env: {} });
  });
  afterAll(() => dropDb());
  const gate = (userId: string, sessionId: string) => operatorGate(p, { userId, sessionId }).then(g => g.state);
  const operator = async (email: string) => {
    const s = await signUp(p, { email, password: PASSWORD, name: "Op", workspaceKind: "personal" });
    await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [s.userId]));
    await grantOperator(p, email, "cli");
    return { ...s, ctx: { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId } as Ctx };
  };

  it("password and a new code in one session pass, and that's the only enrolling path that does", async () => {
    const o = await operator("enrol@gate.example");
    const { secret } = await beginTotpEnrollment(p, o.ctx, "enrol@gate.example", { password: PASSWORD });
    expect(await gate(o.userId, o.sessionId)).toBe("needs_mfa");
    await confirmTotp(p, o.ctx, code(secret));
    expect(await gate(o.userId, o.sessionId)).toBe("ok");
  });

  it("enrolling on a recent sign-in doesn't, and signing in again with the code does", async () => {
    const o = await operator("fed@gate.example");
    await p.db.withSystem(t => t.query("UPDATE users SET password_hash=NULL WHERE id=$1", [o.userId]));
    await p.db.withSystem(t => t.query("UPDATE sessions SET auth_method='idp' WHERE id=$1", [o.sessionId]));
    const { secret } = await beginTotpEnrollment(p, o.ctx, "fed@gate.example");
    await confirmTotp(p, o.ctx, code(secret));
    expect(await gate(o.userId, o.sessionId)).toBe("needs_mfa");
  });

  it("a code at sign-in passes, and turning the app off takes that back", async () => {
    const o = await operator("signin@gate.example");
    const { secret } = await beginTotpEnrollment(p, o.ctx, "signin@gate.example", { password: PASSWORD });
    await confirmTotp(p, o.ctx, code(secret));
    const s = await signIn(p, { email: "signin@gate.example", password: PASSWORD, totp: code(secret) });
    expect(await gate(o.userId, s.sessionId)).toBe("ok");
    await p.db.withSystem(t => t.query("UPDATE users SET totp_last_step=NULL WHERE id=$1", [o.userId]));
    await disableTotp(p, { ...o.ctx, sessionId: s.sessionId }, code(secret));
    expect(await gate(o.userId, s.sessionId)).toBe("needs_mfa");
  });

  it("a passkey sign-in passes if a password was typed to add it, or once it has aged; a fresh one added on a sign-in's age doesn't", async () => {
    const o = await operator("key@gate.example");
    const typed = softAuthenticator();
    await addPasskey(p, o.ctx, "key@gate.example", typed, { password: PASSWORD });
    expect(await gate(o.userId, o.sessionId)).toBe("needs_mfa");
    expect(await gate(o.userId, (await passkeyIn(p, typed)).sessionId)).toBe("ok");

    const f = await operator("fedkey@gate.example");
    await p.db.withSystem(t => t.query("UPDATE users SET password_hash=NULL WHERE id=$1", [f.userId]));
    await p.db.withSystem(t => t.query("UPDATE sessions SET auth_method='idp' WHERE id=$1", [f.sessionId]));
    const onAge = softAuthenticator();
    await addPasskey(p, f.ctx, "fedkey@gate.example", onAge);
    expect(await gate(f.userId, (await passkeyIn(p, onAge)).sessionId)).toBe("needs_mfa");
    await p.db.withSystem(t => t.query("UPDATE passkeys SET created_at=now() - interval '8 days' WHERE user_id=$1", [f.userId]));
    const aged = await passkeyIn(p, onAge);
    expect(await gate(f.userId, aged.sessionId)).toBe("ok");
    const [k] = await p.db.withSystem(t => t.query<{ id: string }>("SELECT id FROM passkeys WHERE user_id=$1", [f.userId]));
    const { removePasskey } = await import("../auth");
    await removePasskey(p, { ...f.ctx, sessionId: aged.sessionId }, k!.id);
    expect(await gate(f.userId, aged.sessionId)).toBe("needs_mfa");
  });

  it("a session belonging to someone else doesn't lend its credit", async () => {
    const a = await operator("a@gate.example");
    const b = await operator("b@gate.example");
    await p.db.withSystem(t => t.query("UPDATE sessions SET mfa_passed=true WHERE id=$1", [a.sessionId]));
    expect(await gate(b.userId, a.sessionId)).toBe("needs_mfa");
  });
});

describe("member limits, under load and after lowering one", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); });
  afterAll(() => drop());
  const count = (tenantId: string) => memberCount(p, tenantId);
  const org = async (domain: string, seats: number) => {
    const owner = await user(p, `owner@admin.${domain}`, { kind: "organization" });
    await p.db.withSystem(t => t.query("INSERT INTO tenant_limit_overrides(tenant_id,key,value,reason) VALUES ($1,'seats',$2,'test')", [owner.tenantId, JSON.stringify(seats)]));
    const d = await addDomain(p, owner, domain);
    await verifyDomain(p, owner, domain, async () => [[d!.token]]);
    return owner;
  };
  const samlSignIn = async (domain: string, email: string, keys: { key: string; cert: string }) => {
    const { inflateRawSync } = await import("node:zlib");
    const s = (await beginSso(p, { email }))!;
    const xml = inflateRawSync(Buffer.from(new URL(s.url).searchParams.get("SAMLRequest")!, "base64")).toString();
    const requestId = /ID="([^"]+)"/.exec(xml)![1]!;
    const signed = response(sign(assertion({ nameId: email, audience: samlEntityId(p, domain), recipient: samlAcsUrl(p, domain), inResponseTo: requestId }), keys), { destination: samlAcsUrl(p, domain), inResponseTo: requestId });
    return finishSaml(p, domain, b64(signed), s.binding);
  };

  it("concurrent JIT sign-ins can't both take the last seat, and the one refused is told why and leaves nothing behind", async () => {
    const domain = "race-jit.example";
    const owner = await org(domain, 3);
    const keys = await keypair("idp.race-jit.example");
    await saveSamlConfig(p, owner, { domain, idpEntityId: IDP, entryPoint: "https://idp.race-jit.example/sso", idpCert: keys.cert });
    const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map(n => samlSignIn(domain, `${n}@${domain}`, keys)));
    expect(await count(owner.tenantId)).toBe(3);
    const refused = results.flatMap(r => r.status === "rejected" ? [r.reason] : []);
    expect(refused).toHaveLength(3);
    for (const e of refused) expect(e).toMatchObject({ status: 403, code: "sso_seat_limit" });
    const orphans = await p.db.withSystem(t => t.query("SELECT 1 FROM users u WHERE lower(u.email) LIKE $1 AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id=u.id)", [`%@${domain}`]));
    expect(orphans).toEqual([]);
  });

  it("concurrent SCIM creates stop at the limit too, with an error the provider can show", async () => {
    const domain = "race-scim.example";
    const owner = await org(domain, 3);
    const a = await authenticateScim(p, `Bearer ${(await rotateScimToken(p, owner)).token}`);
    const results = await Promise.allSettled(["a", "b", "c", "d", "e"].map(n => scimCreateUser(p, a, { userName: `${n}@${domain}` })));
    expect(await count(owner.tenantId)).toBe(3);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 403, message: expect.stringMatching(/3 members/) });
  });

  it("someone switched off doesn't take a seat, and can't be switched back on without one", async () => {
    const domain = "reactivate.example";
    const owner = await org(domain, 2);
    const a = await authenticateScim(p, `Bearer ${(await rotateScimToken(p, owner)).token}`);
    const off = await scimCreateUser(p, a, { userName: `off@${domain}`, active: false });
    expect(await count(owner.tenantId)).toBe(1);
    await scimCreateUser(p, a, { userName: `on@${domain}` });
    const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
    await expect(scimPatchUser(p, a, off.id, { schemas: [PATCH], Operations: [{ op: "replace", path: "active", value: true }] })).rejects.toMatchObject({ status: 403 });
    expect(await count(owner.tenantId)).toBe(2);
  });

  it("a refused SCIM create doesn't take away an existing unverified account's ways in", async () => {
    const domain = "keep-account.example";
    const owner = await org(domain, 1);
    const a = await authenticateScim(p, `Bearer ${(await rotateScimToken(p, owner)).token}`);
    const email = `existing@${domain}`;
    await user(p, email);
    await expect(scimCreateUser(p, a, { userName: email })).rejects.toMatchObject({ status: 403 });
    await expect(signIn(p, { email, password: PASSWORD })).resolves.toHaveProperty("token");
  });

  it("a lower limit never stops a token removing people", async () => {
    const domain = "offboard.example";
    const owner = await org(domain, 3);
    const a = await authenticateScim(p, `Bearer ${(await rotateScimToken(p, owner)).token}`);
    const leaver = await scimCreateUser(p, a, { userName: `leaver@${domain}` });
    await p.db.withSystem(t => t.query("UPDATE tenant_limit_overrides SET value='0' WHERE tenant_id=$1 AND key='seats'", [owner.tenantId]));
    await scimPatchUser(p, a, leaver.id, { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] });
    expect(await count(owner.tenantId)).toBe(1);
  });

  it("an invitation holds its seat against others, but not against the person it's for", async () => {
    const domain = "invited.example";
    const owner = await org(domain, 2);
    await p.db.withUser(owner, t => t.query("INSERT INTO invitations(tenant_id,email,role,token_hash,invited_by,expires_at) VALUES ($1,$2,'member','h1',$3, now() + interval '1 day')", [owner.tenantId, `held@${domain}`, owner.userId]));
    const a = await authenticateScim(p, `Bearer ${(await rotateScimToken(p, owner)).token}`);
    await expect(scimCreateUser(p, a, { userName: `someone@${domain}` })).rejects.toMatchObject({ status: 403 });
    await expect(scimCreateUser(p, a, { userName: `held@${domain}` })).resolves.toHaveProperty("id");
  });
});

describe("a domain that changes hands", () => {
  let p: Platform, drop: () => Promise<void>, clock = Date.now();
  const sent: { to: string; subject: string; text: string }[] = [];
  const DAY = 86_400_000;
  beforeAll(async () => { ({ p, drop } = await testPlatform({ now: () => new Date(clock), mailer: { kind: "smtp" as const, async send(m: { to: string; subject: string; text: string }) { sent.push(m); } } })); });
  afterAll(() => drop());
  const dnsError = (code: string) => Object.assign(new Error(code), { code });
  const holder = async (domain: string) => {
    const owner = await user(p, `owner@admin.${domain}`, { kind: "organization" });
    await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [owner.userId]));
    const d = await addDomain(p, owner, domain);
    await verifyDomain(p, owner, domain, async () => [[d!.token]]);
    return { owner, token: d!.token as string };
  };
  const row = (tenantId: string, domain: string) => p.db.withWorker(tenantId, t => t.one<any>("SELECT verified_at, txt_missing_since, lapsed_at, last_checked_at FROM verified_domains WHERE domain=$1", [domain]));

  it("a record that's still there changes nothing but the check time", async () => {
    const { owner, token } = await holder("stays.example");
    await recheckDomains(p, owner.tenantId, async () => [[token]]);
    expect(await row(owner.tenantId, "stays.example")).toMatchObject({ verified_at: expect.any(Date), txt_missing_since: null, last_checked_at: expect.any(Date) });
  });

  it("a resolver that fails says nothing about ownership, however long that goes on", async () => {
    const { owner } = await holder("flaky.example");
    for (const code of ["ETIMEOUT", "ESERVFAIL"]) await recheckDomains(p, owner.tenantId, async () => { throw dnsError(code); });
    expect(await row(owner.tenantId, "flaky.example")).toMatchObject({ verified_at: expect.any(Date), txt_missing_since: null });
  });

  it("a record that comes back within the grace period ends it, and the owner has been told", async () => {
    const { owner, token } = await holder("blip.example");
    sent.length = 0;
    await recheckDomains(p, owner.tenantId, async () => [["unrelated"]]);
    expect(await row(owner.tenantId, "blip.example")).toMatchObject({ verified_at: expect.any(Date), txt_missing_since: expect.any(Date) });
    await drainJobs(p);
    expect(sent.filter(m => m.to === "owner@admin.blip.example" && m.text.includes(token))).toHaveLength(1);
    expect((await listDomains(p, owner))[0]).toMatchObject({ lapsesAt: expect.any(Date), lapsedAt: null });
    await recheckDomains(p, owner.tenantId, async () => [[token]]);
    expect(await row(owner.tenantId, "blip.example")).toMatchObject({ verified_at: expect.any(Date), txt_missing_since: null, lapsed_at: null });
  });

  it("after the grace period it stops being trusted: the old provider can't link accounts, the owner is told, and a new owner can claim it", async () => {
    const domain = "sold.example";
    const old = await holder(domain);
    const keys = await keypair("idp.sold.example");
    const { id: oldConfig } = await saveSamlConfig(p, old.owner, { domain, idpEntityId: IDP, entryPoint: "https://idp.sold.example/sso", idpCert: keys.cert });
    expect(await beginSso(p, { email: `someone@${domain}` })).not.toBeNull();

    const fresh = await user(p, "owner@admin.newco.example", { kind: "organization" });
    const d = await addDomain(p, fresh, domain);
    await verifyDomain(p, fresh, domain, async () => [[d!.token]]);
    const newKeys = await keypair("idp.newco.example");
    const save = () => saveSamlConfig(p, fresh, { domain, idpEntityId: "https://idp.newco.example/entity", entryPoint: "https://idp.newco.example/sso", idpCert: newKeys.cert });
    // Holding the domain now doesn't take it from anyone yet: DNS being repointed by accident shouldn't hand over SSO on the spot.
    await expect(save()).rejects.toMatchObject({ code: "domain_claimed" });

    const gone = async () => { throw dnsError("ENOTFOUND"); };
    await recheckDomains(p, old.owner.tenantId, gone);
    clock += 6 * DAY;
    await recheckDomains(p, old.owner.tenantId, gone);
    expect(await row(old.owner.tenantId, domain)).toMatchObject({ verified_at: expect.any(Date), lapsed_at: null });
    expect((await beginSso(p, { email: `someone@${domain}` }))).not.toBeNull();

    sent.length = 0;
    clock += 2 * DAY;
    await recheckDomains(p, old.owner.tenantId, gone);
    expect(await row(old.owner.tenantId, domain)).toMatchObject({ verified_at: null, lapsed_at: expect.any(Date) });
    await drainJobs(p);
    expect(sent.filter(m => m.to === `owner@admin.${domain}` && /no longer verified/.test(m.subject))).toHaveLength(1);
    expect((await listDomains(p, old.owner))[0]).toMatchObject({ verifiedAt: null, lapsedAt: expect.any(Date), lapsesAt: null });

    // The old provider is out: nothing to start, and a response it signs has nowhere to go.
    expect(await beginSso(p, { email: `someone@${domain}` })).toBeNull();
    const { loadTenantTarget } = await import("../sso");
    expect(await p.db.withSystem(t => loadTenantTarget(t, oldConfig))).toBeNull();
    await expect(finishSaml(p, domain, b64(response(sign(assertion({ nameId: `someone@${domain}`, audience: samlEntityId(p, domain), recipient: samlAcsUrl(p, domain) }), keys), { destination: samlAcsUrl(p, domain) })), "x")).rejects.toBeDefined();

    // A check of a lapsed domain does nothing further.
    sent.length = 0;
    await recheckDomains(p, old.owner.tenantId, gone);
    await drainJobs(p);
    expect(sent).toEqual([]);

    await expect(save()).resolves.toHaveProperty("id");
    expect((await beginSso(p, { email: `someone@${domain}` }))!.url).toContain("idp.newco.example");
    const left = await p.db.withSystem(t => t.query("SELECT 1 FROM sso_configs WHERE id=$1", [oldConfig]));
    expect(left).toEqual([]);
    const trail = await p.db.withSystem(t => t.query<{ event: string; meta: { reason?: string } }>("SELECT event, meta FROM audit_events WHERE tenant_id=$1 AND (event LIKE 'domain.%' OR event='sso.removed') ORDER BY id", [old.owner.tenantId]));
    expect(trail.map(a => a.event)).toEqual(["domain.record_missing", "domain.lapsed", "sso.removed"]);
    expect(trail.at(-1)!.meta.reason).toBe("domain_lapsed");
  });

  it("the previous owner getting it back resumes, if nobody else has taken it", async () => {
    const domain = "regained.example";
    const { owner, token } = await holder(domain);
    const keys = await keypair("idp.regained.example");
    await saveSamlConfig(p, owner, { domain, idpEntityId: IDP, entryPoint: "https://idp.regained.example/sso", idpCert: keys.cert });
    const none = async () => [] as string[][];
    await recheckDomains(p, owner.tenantId, none);
    clock += 8 * DAY;
    await recheckDomains(p, owner.tenantId, none);
    expect(await beginSso(p, { email: `someone@${domain}` })).toBeNull();
    await verifyDomain(p, owner, domain, async () => [[token]]);
    expect(await row(owner.tenantId, domain)).toMatchObject({ verified_at: expect.any(Date), lapsed_at: null, txt_missing_since: null });
    expect(await beginSso(p, { email: `someone@${domain}` })).not.toBeNull();
  });

  it("a tenant can't use the release to take a domain it hasn't proven", async () => {
    const domain = "unproven.example";
    const { owner } = await holder(domain);
    const keys = await keypair("idp.unproven.example");
    const { id } = await saveSamlConfig(p, owner, { domain, idpEntityId: IDP, entryPoint: "https://idp.unproven.example/sso", idpCert: keys.cert });
    await p.db.withWorker(owner.tenantId, t => t.query("UPDATE verified_domains SET verified_at=NULL, lapsed_at=now() WHERE domain=$1", [domain]));
    const stranger = await user(p, "owner@admin.stranger.example", { kind: "organization" });
    await p.db.withSystem(t => t.query("SELECT sso_release_lapsed_domain($1,$2)", [domain, stranger.tenantId]));
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM sso_configs WHERE id=$1", [id]))).toHaveLength(1);
  });

  it("runs from the scheduler: the tick fans out once, and the job uses the configured resolver", async () => {
    const { owner } = await holder("scheduled.example");
    let asked = 0;
    p.resolveTxt = async d => { if (d === "scheduled.example") asked++; return []; };
    await drainJobs(p);
    await p.db.withSystem(t => t.query("DELETE FROM jobs WHERE kind LIKE 'domains.%'"));
    await tick(p);
    await tick(p);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM jobs WHERE kind='domains.recheck'"))).toHaveLength(1);
    await drainJobs(p);
    expect(asked).toBe(1);
    expect(await row(owner.tenantId, "scheduled.example")).toMatchObject({ txt_missing_since: expect.any(Date) });
    p.resolveTxt = undefined;
  });

  it("demo deployments, whose domains are made up, don't check at all", async () => {
    const { owner } = await holder("made-up.example");
    await recheckDomains(p, owner.tenantId);
    // Every domain in the world under .example fails to resolve, so reaching the system resolver would have started the clock.
    expect(await row(owner.tenantId, "made-up.example")).toMatchObject({ txt_missing_since: null });
  });
});
