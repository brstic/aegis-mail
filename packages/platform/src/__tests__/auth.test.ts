import { TOTP, Secret } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removePasskey, disableTotp, beginPasskeySignIn, beginTotpEnrollment, confirmTotp, invite, acceptInvite, listSessions, type Platform, rateLimit, resolveSession, revokeSession, signIn, signOut, signUp, switchWorkspace, rotateSession } from "../index";
import { createHash } from "node:crypto";
import { testPlatform, markVerified, nextTotpStep } from "./harness";

describe("product auth", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); });
  afterAll(() => drop());
  const su = (email: string) => signUp(p, { email, password: "correct-horse-battery", name: "N", workspaceKind: "personal" });

  it("stores only a password hash and only a token hash", async () => {
    const s = await su("h@example.org");
    const u = await p.db.withSystem(t => t.one<any>("SELECT password_hash FROM users WHERE id=$1", [s.userId]));
    expect(u.password_hash).toMatch(/^\$argon2id\$/);
    const row = await p.db.withSystem(t => t.one<any>("SELECT token_hash FROM sessions WHERE id=$1", [s.sessionId]));
    expect(row.token_hash).toBe(createHash("sha256").update(s.token).digest("hex"));
    expect(row.token_hash).not.toBe(s.token);
  });
  it("rejects short passwords", async () => {
    await expect(signUp(p, { email: "w@example.org", password: "short", name: "N", workspaceKind: "personal" })).rejects.toMatchObject({ code: "weak_password" });
  });
  it("gives the same answer for a wrong password and an unknown user, and doesn't reveal existence through timing by much", async () => {
    await su("known@example.org");
    const t1 = Date.now();
    const a = await signIn(p, { email: "known@example.org", password: "wrong-wrong-wrong" }).catch(e => e);
    const known = Date.now() - t1;
    const t2 = Date.now();
    const b = await signIn(p, { email: "nobody@example.org", password: "wrong-wrong-wrong" }).catch(e => e);
    const unknown = Date.now() - t2;
    expect(a.code).toBe("invalid_credentials"); expect(b.code).toBe(a.code); expect(b.message).toBe(a.message);
    // Both paths do an Argon2 verify. Generous bound for CI noise; a skipped hash would differ by 10x or more.
    expect(unknown).toBeGreaterThan(known / 5);
  });
  it("signs in, resolves, and revokes", async () => {
    await su("flow@example.org");
    const s = await signIn(p, { email: "FLOW@example.org ", password: "correct-horse-battery" });
    const r = await resolveSession(p, s.token);
    expect(r?.email).toBe("flow@example.org");
    await signOut(p, s.sessionId);
    expect(await resolveSession(p, s.token)).toBeNull();
  });
  it("expired and garbage sessions resolve to nothing", async () => {
    const s = await su("exp@example.org");
    await p.db.withSystem(t => t.query("UPDATE sessions SET expires_at=now() - interval '1 second' WHERE id=$1", [s.sessionId]));
    expect(await resolveSession(p, s.token)).toBeNull();
    expect(await resolveSession(p, "garbage")).toBeNull();
    expect(await resolveSession(p, undefined)).toBeNull();
  });
  it("idle sessions time out", async () => {
    const s = await su("idle@example.org");
    await p.db.withSystem(t => t.query("UPDATE sessions SET last_seen_at=now() - interval '25 hours' WHERE id=$1", [s.sessionId]));
    expect(await resolveSession(p, s.token)).toBeNull();
  });
  it("rate limits repeated attempts", async () => {
    for (let i = 0; i < 3; i++) await rateLimit(p, "t:k", 3, 60);
    await expect(rateLimit(p, "t:k", 3, 60)).rejects.toMatchObject({ status: 429 });
    await su("rl@example.org");
    let last: any;
    for (let i = 0; i < 12; i++) last = await signIn(p, { email: "rl@example.org", password: "bad-bad-bad-bad" }).catch(e => e);
    expect(last.code).toBe("rate_limited");
  });
  it("TOTP: enroll, require on sign-in, reject wrong codes, rotate session", async () => {
    const s = await su("mfa@example.org");
    const ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
    const { secret } = await beginTotpEnrollment(p, ctx, "mfa@example.org", { password: "correct-horse-battery" });
    const code = () => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();
    await expect(confirmTotp(p, ctx, "000000")).rejects.toMatchObject({ code: "invalid_mfa" });
    const { rotatedToken } = await confirmTotp(p, ctx, code());
    expect(await resolveSession(p, s.token)).toBeNull();
    expect(await resolveSession(p, rotatedToken)).not.toBeNull();
    await expect(signIn(p, { email: "mfa@example.org", password: "correct-horse-battery" })).rejects.toMatchObject({ code: "mfa_required" });
    await expect(signIn(p, { email: "mfa@example.org", password: "correct-horse-battery", totp: "000000" })).rejects.toMatchObject({ code: "invalid_mfa" });
    await expect(signIn(p, { email: "mfa@example.org", password: "correct-horse-battery", totp: code() })).resolves.toHaveProperty("token");
    const stored = await p.db.withSystem(t => t.one<any>("SELECT totp_secret_enc FROM users WHERE id=$1", [s.userId]));
    expect(stored.totp_secret_enc.toString("latin1")).not.toContain(secret);
  });
  it("a hijacked session can't strip or replace MFA without a current code", async () => {
    const s = await su("keep@example.org");
    let ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
    const password = "correct-horse-battery";
    const { secret } = await beginTotpEnrollment(p, ctx, "keep@example.org", { password });
    const code = (sec: string) => new TOTP({ secret: Secret.fromBase32(sec), digits: 6, period: 30 }).generate();
    await confirmTotp(p, ctx, code(secret));
    await expect(beginTotpEnrollment(p, ctx, "keep@example.org")).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(beginTotpEnrollment(p, ctx, "keep@example.org", { password })).rejects.toMatchObject({ code: "invalid_mfa" });
    await expect(beginTotpEnrollment(p, ctx, "keep@example.org", { password, totp: "000000" })).rejects.toMatchObject({ code: "invalid_mfa" });
    await expect(disableTotp(p, ctx, "000000")).rejects.toMatchObject({ code: "invalid_mfa" });
    // Starting a move leaves the old factor working until the new one is proven.
    const moved = await beginTotpEnrollment(p, ctx, "keep@example.org", { password, totp: code(secret) });
    await nextTotpStep(p, s.userId);
    await expect(signIn(p, { email: "keep@example.org", password: "correct-horse-battery", totp: code(secret) })).resolves.toHaveProperty("token");
    await expect(confirmTotp(p, ctx, code(secret))).rejects.toMatchObject({ code: "invalid_mfa" });
    await confirmTotp(p, ctx, code(moved.secret));
    await expect(signIn(p, { email: "keep@example.org", password: "correct-horse-battery", totp: code(secret) })).rejects.toMatchObject({ code: "invalid_mfa" });
    await disableTotp(p, ctx, code(moved.secret));
    await expect(signIn(p, { email: "keep@example.org", password: "correct-horse-battery" })).resolves.toHaveProperty("token");
  });
  it("passkeys can only be removed by their owner", async () => {
    const a = await su("pk-a@example.org"), b = await su("pk-b@example.org");
    const k = await p.db.withSystem(t => t.one<any>("INSERT INTO passkeys(user_id,credential_id,public_key) VALUES ($1,'cred-1','x') RETURNING id", [a.userId]));
    await expect(removePasskey(p, { tenantId: b.tenantId, userId: b.userId }, k.id)).rejects.toMatchObject({ status: 404 });
    await removePasskey(p, { tenantId: a.tenantId, userId: a.userId }, k.id);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM passkeys WHERE id=$1", [k.id]))).toEqual([]);
  });
  it("passkey challenges are server-bound and single-use", async () => {
    const { challengeId } = await beginPasskeySignIn(p);
    const c = await p.db.withSystem(t => t.one<any>("SELECT challenge FROM auth_challenges WHERE id=$1", [challengeId]));
    expect(c.challenge.length).toBeGreaterThan(16);
    const { finishPasskeySignIn } = await import("../auth");
    await expect(finishPasskeySignIn(p, challengeId, { id: "nope" })).rejects.toBeDefined();
    await expect(finishPasskeySignIn(p, challengeId, { id: "nope" })).rejects.toMatchObject({ code: "challenge_expired" });
  });
  it("session list and revoke are limited to the owner", async () => {
    const a = await su("sa@example.org"); const b = await su("sb@example.org");
    const list = await listSessions(p, a.userId, a.sessionId);
    expect(list.find(x => x.current)).toBeTruthy();
    await revokeSession(p, { tenantId: b.tenantId, userId: b.userId }, a.sessionId);
    expect(await resolveSession(p, a.token)).not.toBeNull();
    await revokeSession(p, { tenantId: a.tenantId, userId: a.userId }, a.sessionId);
    expect(await resolveSession(p, a.token)).toBeNull();
  });
  it("can't switch into a workspace you aren't in", async () => {
    const a = await su("w1@example.org"); const b = await su("w2@example.org");
    const s = (await resolveSession(p, a.token))!;
    await expect(switchWorkspace(p, s, b.tenantId)).rejects.toMatchObject({ status: 404 });
  });
  it("invite links only work for the invited address", async () => {
    const owner = await signUp(p, { email: "own@example.org", password: "correct-horse-battery", name: "O", workspaceKind: "organization" });
    const ctx = { tenantId: owner.tenantId, userId: owner.userId };
    const { acceptUrl } = await invite(p, ctx, { email: "right@example.org", role: "member" });
    const token = acceptUrl!.split("/").pop()!;
    const wrong = await su("wrong@example.org");
    await expect(acceptInvite(p, wrong.userId, "wrong@example.org", token)).rejects.toMatchObject({ status: 403 });
    const right = await su("right@example.org");
    await expect(acceptInvite(p, right.userId, "right@example.org", token)).rejects.toMatchObject({ status: 403, code: "email_unverified" });
    await markVerified(p, right.userId);
    await expect(acceptInvite(p, right.userId, "right@example.org", token)).resolves.toMatchObject({ tenantId: owner.tenantId });
    await expect(acceptInvite(p, right.userId, "right@example.org", token)).rejects.toMatchObject({ status: 404 });
  });
  it("rotation invalidates the old token", async () => {
    const s = await su("rot@example.org");
    const n = await rotateSession(p, s.sessionId);
    expect(await resolveSession(p, s.token)).toBeNull();
    expect(await resolveSession(p, n)).not.toBeNull();
  });
});
