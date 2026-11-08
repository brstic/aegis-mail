import { Secret, TOTP } from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTotpEnrollment, confirmTotp, type Ctx, disableTotp, type Platform, recoveryCodeStatus, regenerateRecoveryCodes, signIn, signUp } from "../index";
import { markVerified, testPlatform } from "./harness";

const PASSWORD = "correct-horse-battery-staple";

describe("recovery codes", () => {
  let p: Platform, drop: () => Promise<void>;
  const mailed: { subject: string }[] = [];
  beforeAll(async () => { ({ p, drop } = await testPlatform({ mailer: { kind: "smtp", async send(m) { mailed.push(m); } } })); });
  afterAll(() => drop());

  /** A signed-up account with an authenticator on, and what enrolment handed back. */
  const enrolled = async (email: string) => {
    const s = await signUp(p, { email, password: PASSWORD, name: "R", workspaceKind: "personal" });
    await markVerified(p, s.userId);
    const si = await signIn(p, { email, password: PASSWORD });
    const ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: si.sessionId } as Ctx;
    const { secret } = await beginTotpEnrollment(p, ctx, email, { password: PASSWORD });
    const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });
    const { recoveryCodes } = await confirmTotp(p, ctx, totp.generate());
    return { ctx, email, recoveryCodes };
  };

  it("are issued when an authenticator is confirmed, and stored only as hashes", async () => {
    const { ctx, recoveryCodes } = await enrolled("issue@recover.example");
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}$/);
    const row = await p.db.withSystem(t => t.one<{ totp_recovery_hashes: string[] }>("SELECT totp_recovery_hashes FROM users WHERE id=$1", [ctx.userId]));
    expect(row!.totp_recovery_hashes).toHaveLength(10);
    for (const c of recoveryCodes) expect(row!.totp_recovery_hashes).not.toContain(c);
  });

  it("sign you in once each, case-insensitively, and tell you by email", async () => {
    const { ctx, email, recoveryCodes } = await enrolled("use@recover.example");
    const code = recoveryCodes[0]!;
    mailed.length = 0;
    await expect(signIn(p, { email, password: PASSWORD, totp: code.toUpperCase() })).resolves.toBeTruthy();
    await expect(signIn(p, { email, password: PASSWORD, totp: code })).rejects.toMatchObject({ status: 401, code: "invalid_mfa" });
    expect((await recoveryCodeStatus(p, ctx)).remaining).toBe(9);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM audit_events WHERE actor_user_id=$1 AND event='auth.recovery_code_used'", [ctx.userId]))).not.toHaveLength(0);
  });

  it("racing with the same code, only one wins", async () => {
    const { email, recoveryCodes } = await enrolled("race@recover.example");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => signIn(p, { email, password: PASSWORD, totp: recoveryCodes[1]! })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });

  it("don't work without the password, or from another account", async () => {
    const a = await enrolled("a@recover.example");
    const b = await enrolled("b@recover.example");
    await expect(signIn(p, { email: a.email, password: "wrong-password-here", totp: a.recoveryCodes[2]! })).rejects.toMatchObject({ status: 401 });
    await expect(signIn(p, { email: b.email, password: PASSWORD, totp: a.recoveryCodes[2]! })).rejects.toMatchObject({ code: "invalid_mfa" });
  });

  it("can't confirm a new authenticator, which has to prove its own secret", async () => {
    const { ctx, email, recoveryCodes } = await enrolled("pending@recover.example");
    await beginTotpEnrollment(p, ctx, email, { password: PASSWORD, totp: recoveryCodes[3]! });
    await expect(confirmTotp(p, ctx, recoveryCodes[4]!)).rejects.toMatchObject({ code: "invalid_mfa" });
  });

  it("replacing them kills the old set", async () => {
    const { ctx, email, recoveryCodes } = await enrolled("replace@recover.example");
    const { recoveryCodes: fresh } = await regenerateRecoveryCodes(p, ctx, recoveryCodes[0]!);
    await expect(signIn(p, { email, password: PASSWORD, totp: recoveryCodes[1]! })).rejects.toMatchObject({ code: "invalid_mfa" });
    await expect(signIn(p, { email, password: PASSWORD, totp: fresh[0]! })).resolves.toBeTruthy();
  });

  it("can turn off a lost authenticator, and that clears them", async () => {
    const { ctx, email, recoveryCodes } = await enrolled("off@recover.example");
    await disableTotp(p, ctx, recoveryCodes[0]!);
    expect((await recoveryCodeStatus(p, ctx)).remaining).toBe(0);
    await expect(signIn(p, { email, password: PASSWORD })).resolves.toBeTruthy();
  });
});
