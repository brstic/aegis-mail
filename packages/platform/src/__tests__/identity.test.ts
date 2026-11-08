import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Secret, TOTP } from "otpauth";
import { acceptInvite, assertContentFree, beginTotpEnrollment, confirmEmail, confirmTotp, type Ctx, drainJobs, invite, listDevOutbox, listInvites, type Platform, requestPasswordReset, resendVerification, resetPassword, resolveSession, sanitizeMailText, seedDemo, DEMO_LOGIN, DEMO_ADMIN, signIn, signUp, sweepExpired, type TransactionalMail, enqueue } from "../index";
import { markVerified, nextTotpStep, testPlatform, user } from "./harness";

const pw = "correct-horse-battery";
const NEW_PW = "a-new-long-password-123";
const linkIn = (text: string, path: string) => { const m = new RegExp(`/${path}/([A-Za-z0-9_-]+)`).exec(text); if (!m) throw new Error(`no ${path} link`); return m[1]!; };

/** Records instead of sending, as a real relay would be. Mail reaches it only through the worker. */
function capture() {
  const sent: TransactionalMail[] = [];
  return { sent, mailer: { kind: "smtp" as const, async send(m: TransactionalMail) { sent.push(m); } }, last: () => sent.at(-1)! };
}

describe("email verification", () => {
  let p: Platform, drop: () => Promise<void>, logs: string[];
  const box = capture();
  beforeAll(async () => { ({ p, drop, logs } = await testPlatform({ mailer: box.mailer })); });
  afterAll(() => drop());
  const newUser = async (email: string) => { const s = await signUp(p, { email, password: pw, name: "N", workspaceKind: "personal" }); await drainJobs(p); return s; };

  it("signup creates an unverified user who can sign in, and sends a link through the worker", async () => {
    const s = await signUp(p, { email: "New@Example.org", password: pw, name: "N", workspaceKind: "personal" });
    expect(s.verificationQueued).toBe(true);
    expect((await resolveSession(p, s.token))?.emailVerified).toBe(false);
    expect(box.sent.filter(m => m.to === "new@example.org")).toHaveLength(0);
    await drainJobs(p);
    expect(box.last().to).toBe("new@example.org");
    expect(box.last().text).toContain("/verify-email/");
    await expect(signIn(p, { email: "new@example.org", password: pw })).resolves.toBeDefined();
  });

  it("the link verifies once, and only once", async () => {
    const s = await newUser("once@example.org");
    const token = linkIn(box.last().text, "verify-email");
    await confirmEmail(p, token);
    expect((await resolveSession(p, s.token))?.emailVerified).toBe(true);
    await expect(confirmEmail(p, token)).rejects.toMatchObject({ code: "token_invalid" });
  });

  it("no plaintext token anywhere: database, job payloads or logs", async () => {
    await newUser("atrest@example.org");
    const token = linkIn(box.last().text, "verify-email");
    const rows = await p.db.withSystem(async t => ({ tokens: await t.query<any>("SELECT * FROM email_tokens"), jobs: await t.query<any>("SELECT * FROM jobs"), mail: await t.query<any>("SELECT * FROM outbound_mail") }));
    const dump = JSON.stringify(rows) + rows.mail.map(m => m.content_enc?.toString("latin1") ?? "").join("");
    expect(dump).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
    expect(rows.tokens.every(k => /^[0-9a-f]{64}$/.test(k.token_hash))).toBe(true);
    // Hand it to the relay and the rendered mail is gone.
    expect(rows.mail.filter(m => m.state === "sent").every(m => m.content_enc === null)).toBe(true);
    for (const j of rows.jobs.filter(j => j.kind === "mail.send")) expect(Object.keys(j.payload)).toEqual(["mailId"]);
  });

  it("while queued, the mail is sealed and the job holds only an id", async () => {
    const s = await signUp(p, { email: "queued@example.org", password: pw, name: "Q", workspaceKind: "personal" });
    const q = await p.db.withSystem(async t => ({ mail: await t.one<any>("SELECT content_enc FROM outbound_mail WHERE state='queued' ORDER BY created_at DESC LIMIT 1"), job: await t.one<any>("SELECT payload FROM jobs WHERE state='queued' AND kind='mail.send' ORDER BY created_at DESC LIMIT 1") }));
    expect(q.mail.content_enc.toString("latin1")).not.toContain("verify-email");
    expect(q.mail.content_enc.toString("latin1")).not.toContain("queued@example.org");
    expect(Object.keys(q.job.payload)).toEqual(["mailId"]);
    await drainJobs(p);
    expect(s.userId).toBeTruthy();
  });

  it("job payloads can't carry a token even if someone tries", () => {
    expect(() => assertContentFree({ token: "abc" })).toThrow(/not allowed/);
    expect(() => assertContentFree({ mailId: "x".repeat(200) })).toThrow(/too long/);
    expect(() => assertContentFree({ mailId: "00000000-0000-4000-8000-000000000000" })).not.toThrow();
  });

  it("an expired link doesn't work, and sweeping removes it", async () => {
    await newUser("exp@example.org");
    const token = linkIn(box.last().text, "verify-email");
    await p.db.withSystem(t => t.query("UPDATE email_tokens SET expires_at=now() - interval '2 days' WHERE email='exp@example.org'"));
    await expect(confirmEmail(p, token)).rejects.toMatchObject({ code: "token_invalid" });
    await sweepExpired(p);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM email_tokens WHERE email='exp@example.org'"))).toEqual([]);
  });

  it("a made-up token fails exactly like a used one", async () => {
    const a = await confirmEmail(p, "made-up-token-value-xxxx").catch(e => e);
    expect(a).toMatchObject({ status: 400, code: "token_invalid" });
  });

  it("resending replaces the old link, and is rate limited", async () => {
    const s = await newUser("resend@example.org");
    const first = linkIn(box.last().text, "verify-email");
    const ctx = { tenantId: s.tenantId, userId: s.userId };
    await resendVerification(p, ctx);
    await drainJobs(p);
    const second = linkIn(box.last().text, "verify-email");
    expect(second).not.toBe(first);
    await expect(confirmEmail(p, first)).rejects.toMatchObject({ code: "token_invalid" });
    for (let i = 0; i < 4; i++) await resendVerification(p, ctx);
    await expect(resendVerification(p, ctx)).rejects.toMatchObject({ status: 429 });
  });

  it("verifying is recorded, with no address in the audit log", async () => {
    const s = await newUser("audited@example.org");
    await confirmEmail(p, linkIn(box.last().text, "verify-email"));
    const a = await p.db.withSystem(t => t.query<any>("SELECT * FROM audit_events WHERE event='auth.email_verified' AND actor_user_id=$1", [s.userId]));
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a)).not.toContain("audited@example.org");
  });
});

describe("invitations need a verified, matching address", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx;
  const box = capture();
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ mailer: box.mailer, config: { demoMode: false, appOrigin: "https://app.example", webauthnRpId: "app.example" } }));
    owner = await user(p, "owner@example.org", { kind: "organization" });
    await markVerified(p, owner.userId);
  });
  afterAll(() => drop());

  it("sends the invitation by email and doesn't show the link outside demo mode", async () => {
    const r = await invite(p, owner, { email: "Invited@Example.org", role: "member" });
    expect(r).toEqual({ sent: true });
    expect(JSON.stringify(r)).not.toContain("/invite/");
    await drainJobs(p);
    expect(box.last().to).toBe("invited@example.org");
    expect(box.last().text).toContain("https://app.example/invite/");
    expect(await listInvites(p, owner)).toHaveLength(1);
  });

  it("an unverified account with the right address can't accept, and a verified one can", async () => {
    await invite(p, owner, { email: "pending@example.org", role: "member" });
    await drainJobs(p);
    const token = linkIn(box.last().text, "invite");
    const s = await signUp(p, { email: "pending@example.org", password: pw, name: "P", workspaceKind: "personal" });
    await expect(acceptInvite(p, s.userId, "pending@example.org", token)).rejects.toMatchObject({ status: 403, code: "email_unverified" });
    await drainJobs(p);
    await confirmEmail(p, linkIn(box.last().text, "verify-email"));
    await expect(acceptInvite(p, s.userId, "pending@example.org", token)).resolves.toMatchObject({ tenantId: owner.tenantId });
  });

  it("the address that counts is the database's, not whatever the caller passes", async () => {
    await invite(p, owner, { email: "target@example.org", role: "member" });
    await drainJobs(p);
    const token = linkIn(box.last().text, "invite");
    const other = await signUp(p, { email: "other@example.org", password: pw, name: "O", workspaceKind: "personal" });
    await markVerified(p, other.userId);
    await expect(acceptInvite(p, other.userId, "target@example.org", token)).rejects.toMatchObject({ status: 403 });
    await expect(acceptInvite(p, other.userId, "other@example.org", token)).rejects.toMatchObject({ status: 403 });
  });

  it("an unverified inviter can't send mail to strangers", async () => {
    const o = await user(p, "spam@example.org", { kind: "organization" });
    await expect(invite(p, o, { email: "stranger@example.org", role: "member" })).rejects.toMatchObject({ code: "email_unverified" });
  });

  it("repeat invitations to one address are limited", async () => {
    for (let i = 0; i < 5; i++) await invite(p, owner, { email: "bomb@example.org", role: "member" });
    await expect(invite(p, owner, { email: "bomb@example.org", role: "member" })).rejects.toMatchObject({ status: 429 });
    await drainJobs(p);
  });

  it("a workspace name can't smuggle a link into the mail", async () => {
    await p.db.withUser(owner, t => t.query("UPDATE organizations SET name=$2 WHERE id=$1", [owner.tenantId, "Payroll\r\nVisit https://evil.example/login or www.evil.example now evil.example"]));
    await invite(p, owner, { email: "smuggle@example.org", role: "member" });
    await drainJobs(p);
    const m = box.last();
    expect(m.text).not.toContain("evil.example");
    expect(m.subject).not.toMatch(/Payroll/);
    expect(m.text).toContain('"Payroll Visit or now"');
    expect(sanitizeMailText("Fernhill Studio (demo)")).toBe("Fernhill Studio (demo)");
    expect(sanitizeMailText("‮gnp.exe")).not.toContain("‮");
  });
});

describe("password reset", () => {
  let p: Platform, drop: () => Promise<void>, logs: string[];
  const box = capture();
  beforeAll(async () => { ({ p, drop, logs } = await testPlatform({ mailer: box.mailer })); });
  afterAll(() => drop());
  const reset = async (email: string) => { const r = await requestPasswordReset(p, email); await r.done; await drainJobs(p); return linkIn(box.last().text, "reset-password"); };

  it("changes the password, revokes every session, and works once", async () => {
    const s = await user(p, "r1@example.org");
    await markVerified(p, s.userId);
    const token = await reset("r1@example.org");
    await resetPassword(p, { token, password: NEW_PW });
    expect(await resolveSession(p, s.token)).toBeNull();
    await expect(signIn(p, { email: "r1@example.org", password: pw })).rejects.toMatchObject({ status: 401 });
    await expect(signIn(p, { email: "r1@example.org", password: NEW_PW })).resolves.toBeDefined();
    await expect(resetPassword(p, { token, password: "yet-another-password-1" })).rejects.toMatchObject({ code: "token_invalid" });
  });

  it("doesn't reveal whether an account exists: same answer, and no mail for strangers", async () => {
    const known = await user(p, "known@example.org");
    await drainJobs(p);
    const before = box.sent.length;
    const a = await requestPasswordReset(p, "known@example.org");
    const b = await requestPasswordReset(p, "nobody-here@example.org");
    expect(a.ok).toBe(b.ok);
    expect(Object.keys(a)).toEqual(Object.keys(b));
    await a.done; await b.done; await drainJobs(p);
    expect(box.sent.length).toBe(before + 1);
    expect(box.last().to).toBe("known@example.org");
    expect(known.userId).toBeTruthy();
  });

  it("answers before any address-dependent work finishes, so timing can't tell them apart", async () => {
    let open!: () => void;
    const gate = new Promise<void>(r => { open = r; });
    const real = p.db.withSystem.bind(p.db);
    const spy = vi.spyOn(p.db, "withSystem").mockImplementation((async (fn: never) => { await gate; return real(fn); }) as never);
    // Every database call is held shut, and it still answers. With no client key, nothing is awaited before the answer.
    const r = await requestPasswordReset(p, "known@example.org");
    expect(r.ok).toBe(true);
    spy.mockRestore();
    open();
    await r.done;
  });

  it("is limited per address, silently, and per client out loud", async () => {
    await user(p, "bomb@example.org");
    await drainJobs(p);
    const before = box.sent.length;
    for (let i = 0; i < 8; i++) await (await requestPasswordReset(p, "bomb@example.org")).done;
    await drainJobs(p);
    expect(box.sent.length).toBe(before + 5);
    for (let i = 0; i < 20; i++) await requestPasswordReset(p, `c${i}@example.org`, "one-client");
    await expect(requestPasswordReset(p, "c@example.org", "one-client")).rejects.toMatchObject({ status: 429 });
  });

  it("is blocked while TOTP is on, unless a current code is given, and a wrong code doesn't spend the link", async () => {
    const s = await user(p, "totp@example.org");
    await markVerified(p, s.userId);
    const { secret } = await beginTotpEnrollment(p, s, "totp@example.org", { password: pw });
    const code = () => new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate();
    await confirmTotp(p, s, code());
    const token = await reset("totp@example.org");
    await expect(resetPassword(p, { token, password: NEW_PW })).rejects.toMatchObject({ status: 401, code: "mfa_required" });
    await expect(resetPassword(p, { token, password: NEW_PW, totp: "000000" })).rejects.toMatchObject({ status: 401, code: "invalid_mfa" });
    await expect(signIn(p, { email: "totp@example.org", password: pw, totp: code() })).resolves.toBeDefined();
    await nextTotpStep(p, s.userId);
    await resetPassword(p, { token, password: NEW_PW, totp: code() });
    await nextTotpStep(p, s.userId);
    await expect(signIn(p, { email: "totp@example.org", password: NEW_PW, totp: code() })).resolves.toBeDefined();
  });

  it("guessing codes through reset is rate limited", async () => {
    const s = await user(p, "guess@example.org");
    await markVerified(p, s.userId);
    const { secret } = await beginTotpEnrollment(p, s, "guess@example.org", { password: pw });
    await confirmTotp(p, s, new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate());
    const token = await reset("guess@example.org");
    for (let i = 0; i < 10; i++) await resetPassword(p, { token, password: NEW_PW, totp: "000000" }).catch(() => {});
    await expect(resetPassword(p, { token, password: NEW_PW, totp: "000000" })).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a short password without spending the link", async () => {
    await user(p, "short@example.org");
    const token = await reset("short@example.org");
    await expect(resetPassword(p, { token, password: "short" })).rejects.toMatchObject({ code: "weak_password" });
    await resetPassword(p, { token, password: NEW_PW });
  });

  it("a verify link can't reset a password, and a reset link can't verify", async () => {
    await signUp(p, { email: "cross@example.org", password: pw, name: "C", workspaceKind: "personal" });
    await drainJobs(p);
    const verify = linkIn(box.last().text, "verify-email");
    await expect(resetPassword(p, { token: verify, password: NEW_PW })).rejects.toMatchObject({ code: "token_invalid" });
    const r = await reset("cross@example.org");
    await expect(confirmEmail(p, r)).rejects.toMatchObject({ code: "token_invalid" });
  });

  it("an expired link doesn't work", async () => {
    await user(p, "late@example.org");
    const token = await reset("late@example.org");
    await p.db.withSystem(t => t.query("UPDATE email_tokens SET expires_at=now() - interval '1 minute' WHERE email='late@example.org'"));
    await expect(resetPassword(p, { token, password: NEW_PW })).rejects.toMatchObject({ code: "token_invalid" });
  });

  it("pre-hijacking: the address's owner resets, and what a squatter added goes", async () => {
    const squatter = await signUp(p, { email: "owner-of-address@example.org", password: "squatter-password-123", name: "S", workspaceKind: "personal" });
    await p.db.withSystem(async t => {
      await t.query("INSERT INTO identities(user_id,provider,subject) VALUES ($1,'google','squatter-sub')", [squatter.userId]);
      await t.query("INSERT INTO passkeys(user_id,credential_id,public_key) VALUES ($1,'squatter-cred',$2)", [squatter.userId, Buffer.from("x")]);
    });
    const token = await reset("owner-of-address@example.org");
    await resetPassword(p, { token, password: NEW_PW });
    expect(await resolveSession(p, squatter.token)).toBeNull();
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM identities WHERE user_id=$1", [squatter.userId]))).toEqual([]);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM passkeys WHERE user_id=$1", [squatter.userId]))).toEqual([]);
    expect((await p.db.withSystem(t => t.one<any>("SELECT email_verified_at FROM users WHERE id=$1", [squatter.userId]))).email_verified_at).toBeTruthy();
  });

  it("keeps tokens out of the logs and the audit trail", async () => {
    await user(p, "logs@example.org");
    const token = await reset("logs@example.org");
    await resetPassword(p, { token, password: NEW_PW });
    expect(logs.join("\n")).not.toContain(token);
    const a = await p.db.withSystem(t => t.query<any>("SELECT * FROM audit_events WHERE event='auth.password_reset'"));
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).not.toContain("logs@example.org");
    expect(JSON.stringify(a)).not.toContain(token);
  });
});

describe("with no mailer configured, in production", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ env: { NODE_ENV: "production", DEMO_MODE: "true" } as never, config: { demoMode: false, appOrigin: "https://app.example", webauthnRpId: "app.example" }, mailer: null }));
    owner = await user(p, "owner@prod.example", { kind: "organization" });
    await markVerified(p, owner.userId);
  });
  afterAll(() => drop());
  it("sign-up still works, and says verification wasn't sent", async () => {
    const s = await signUp(p, { email: "s@prod.example", password: pw, name: "S", workspaceKind: "personal" });
    expect(s.verificationQueued).toBe(false);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM outbound_mail"))).toEqual([]);
  });
  it("resend, reset and invitations fail honestly, and identically for every address", async () => {
    await expect(resendVerification(p, owner)).resolves.toMatchObject({ alreadyVerified: true });
    const s = await signUp(p, { email: "t@prod.example", password: pw, name: "T", workspaceKind: "personal" });
    await expect(resendVerification(p, { tenantId: s.tenantId, userId: s.userId })).rejects.toMatchObject({ status: 503, code: "mail_unavailable" });
    await expect(requestPasswordReset(p, "owner@prod.example")).rejects.toMatchObject({ status: 503, code: "mail_unavailable" });
    await expect(requestPasswordReset(p, "nobody@prod.example")).rejects.toMatchObject({ status: 503, code: "mail_unavailable" });
    await expect(invite(p, owner, { email: "x@prod.example", role: "member" })).rejects.toMatchObject({ status: 503, code: "mail_unavailable" });
    expect(await listInvites(p, owner)).toEqual([]);
  });
});

describe("demo mode", () => {
  let p: Platform, drop: () => Promise<void>;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); await seedDemo(p); });
  afterAll(() => drop());
  it("seeded demo users are verified", async () => {
    const rows = await p.db.withSystem(t => t.query<any>("SELECT email_verified_at FROM users WHERE lower(email) IN ($1,$2)", [DEMO_LOGIN.email, DEMO_ADMIN.email]));
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.email_verified_at)).toBe(true);
  });
  it("records mail for the dev page instead of sending, sealed, and still shows the invitation link", async () => {
    const o = await user(p, "o@demo.example", { kind: "organization" });
    const r = await invite(p, o, { email: "x@demo.example", role: "member" });
    expect(r.acceptUrl).toContain("/invite/");
    await drainJobs(p);
    const mail = await listDevOutbox(p);
    expect(mail.some(m => m.to === "x@demo.example" && m.text.includes(r.acceptUrl!))).toBe(true);
    const raw = await p.db.withSystem(t => t.query<any>("SELECT content_enc FROM dev_outbox"));
    expect(raw.map(x => x.content_enc.toString("latin1")).join("")).not.toContain("/invite/");
  });
  it("the dev outbox doesn't exist outside demo mode", async () => {
    const { p: q, drop: d } = await testPlatform({ config: { demoMode: false, appOrigin: "https://app.example", webauthnRpId: "app.example" } });
    await expect(listDevOutbox(q)).rejects.toMatchObject({ status: 404 });
    await d();
  });
});
void enqueue;
