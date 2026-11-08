import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvite, changeRole, type Ctx, getThread, invite, listThreads, type Platform, privacyCenter, securityOverview, auditLog, shareIncident, revokeIncident, listIncidents, grantMailbox, revokeMailboxGrant, ADMIN_CONTENT_ENDPOINTS, signUp, summarizeThread } from "../index";
import { deliver, demoAccount, testPlatform, user, markVerified } from "./harness";

const SECRET = "ZEBRA-CONFIDENTIAL-PAYROLL-77";
describe("story 4: tenant admins can't read employees' mail", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx & { token: string }, employee: Ctx, msg: any, acct: string;

  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    owner = await user(p, "owner@acme.example", { kind: "organization" });
    const { acceptUrl } = await invite(p, owner, { email: "emp@acme.example", role: "member" });
    const e = await signUp(p, { email: "emp@acme.example", password: "correct-horse-battery", name: "Emp", workspaceKind: "personal" });
    await markVerified(p, e.userId);
    await acceptInvite(p, e.userId, "emp@acme.example", acceptUrl!.split("/").pop()!);
    employee = { tenantId: owner.tenantId, userId: e.userId };
    acct = await demoAccount(p, employee, "emp@acme.example");
    msg = await deliver(p, employee, acct, { from: `"Priya" <priya@oak.test>`, subject: `Subject ${SECRET}`, text: `Body ${SECRET}. Can you review the numbers?` });
  });
  afterAll(() => drop());

  it("the employee can read their own mail", async () => {
    const t = await getThread(p, employee, msg.thread_id);
    expect(t.messages[0]!.text).toContain(SECRET);
  });

  it("an owner gets no threads and a 404 on a known ID", async () => {
    expect((await listThreads(p, owner, { view: "inbox", limit: 50 })).items).toEqual([]);
    await expect(getThread(p, owner, msg.thread_id)).rejects.toMatchObject({ status: 404 });
  });

  it("a security admin gets the same", async () => {
    await changeRole(p, owner, employee.userId, "member");
    const { acceptUrl } = await invite(p, owner, { email: "sec@acme.example", role: "security_admin" });
    const s = await signUp(p, { email: "sec@acme.example", password: "correct-horse-battery", name: "Sec", workspaceKind: "personal" });
    await markVerified(p, s.userId);
    await acceptInvite(p, s.userId, "sec@acme.example", acceptUrl!.split("/").pop()!);
    const sec = { tenantId: owner.tenantId, userId: s.userId };
    await expect(getThread(p, sec, msg.thread_id)).rejects.toMatchObject({ status: 404 });
    expect((await listThreads(p, sec, { view: "quarantine", limit: 50 })).items).toEqual([]);
    await expect(summarizeThread(p, sec, msg.thread_id)).rejects.toMatchObject({ status: 404 });
  });

  it("at the database layer, the admin's role sees zero rows on every mail table, even with raw SQL", async () => {
    for (const table of ["messages", "message_contents", "message_search", "message_embeddings", "threads", "attachments", "security_analyses", "contacts", "drafts", "tasks", "quarantine_items", "priority_decisions", "demo_mailbox", "ai_artifacts"]) {
      const r = await p.db.withUser(owner, t => t.query(`SELECT * FROM ${table}`));
      expect(r, `table ${table}`).toEqual([]);
    }
    const a = await p.db.withUser(owner, t => t.query("SELECT * FROM mail_accounts"));
    expect(a).toEqual([]);
  });

  it("the app role can't read credentials or users' secrets at all", async () => {
    await expect(p.db.withUser(employee, t => t.query("SELECT * FROM credential_envelopes"))).rejects.toThrow(/permission denied/);
    await expect(p.db.withUser(owner, t => t.query("SELECT password_hash FROM users"))).rejects.toThrow(/permission denied/);
    await expect(p.db.withUser(owner, t => t.query("SELECT totp_secret_enc FROM users"))).rejects.toThrow(/permission denied/);
  });

  it("Security Center shows counts with no sender, subject or message identity", async () => {
    const o = await securityOverview(p, owner);
    const s = JSON.stringify(o);
    expect(s).not.toContain(SECRET);
    expect(s).not.toContain("priya");
    expect(s).not.toContain(msg.id);
    expect(o.byLabel.length).toBeGreaterThan(0);
  });

  it("a plain member sees colleagues' names to share with, not their addresses", async () => {
    const { listMembers } = await import("../org");
    const m = await listMembers(p, employee);
    expect(m.length).toBeGreaterThan(1);
    expect(m[0]).not.toHaveProperty("email");
    expect((await listMembers(p, owner))[0]).toHaveProperty("email");
  });

  it("coverage reports counts only", async () => {
    const o = await securityOverview(p, owner);
    expect(o.coverage).toEqual([{ status: "active", count: 1 }]);
    expect(await p.db.withUser(employee, t => t.query("SELECT * FROM app.mailbox_coverage()"))).toEqual([]);
  });

  it("a member can't see Security Center aggregates, in code or at the database", async () => {
    await expect(securityOverview(p, employee)).rejects.toMatchObject({ status: 403 });
    expect(await p.db.withUser(employee, t => t.query("SELECT * FROM security_telemetry_daily"))).toEqual([]);
  });

  it("the audit log contains no content", async () => {
    const l = await auditLog(p, owner);
    expect(JSON.stringify(l)).not.toContain(SECRET);
    expect(JSON.stringify(l)).not.toContain("priya");
  });

  it("no route or code path exposes content to administrators", () => {
    expect(ADMIN_CONTENT_ENDPOINTS).toEqual([]);
    const root = join(__dirname, "../../../../apps/web/src/server/routes");
    const walk = (d: string): string[] => { try { return readdirSync(d).flatMap(f => { const x = join(d, f); return statSync(x).isDirectory() ? walk(x) : [x]; }); } catch { return []; } };
    expect(walk(root).some(x => x.endsWith("org.ts"))).toBe(true);
    for (const f of walk(root).filter(x => x.endsWith("org.ts"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/getThread|listThreads|message_contents|envelope_enc/);
    }
  });

  describe("voluntary incident sharing", () => {
    let sec: Ctx, shareId: string;
    beforeAll(async () => {
      const { acceptUrl } = await invite(p, owner, { email: "analyst@acme.example", role: "security_admin" });
      const s = await signUp(p, { email: "analyst@acme.example", password: "correct-horse-battery", name: "Ana", workspaceKind: "personal" });
      await markVerified(p, s.userId);
      await acceptInvite(p, s.userId, "analyst@acme.example", acceptUrl!.split("/").pop()!);
      sec = { tenantId: owner.tenantId, userId: s.userId };
    });
    it("an admin can't create a share of someone else's message", async () => {
      await expect(shareIncident(p, owner, { messageId: msg.id, analystUserId: sec.userId, redact: true, hours: 1 })).rejects.toMatchObject({ status: 404 });
    });
    it("a redacted share reveals reason codes but no body or subject", async () => {
      const r = await shareIncident(p, employee, { messageId: msg.id, analystUserId: sec.userId, redact: true, hours: 1 });
      shareId = r.id;
      const list = await listIncidents(p, sec);
      expect(list).toHaveLength(1);
      expect(JSON.stringify(list[0]!.snapshot)).not.toContain(SECRET);
    });
    it("other admins can't see it, only the named analyst", async () => {
      expect(await listIncidents(p, owner)).toEqual([]);
    });
    it("revoking removes the analyst's access immediately", async () => {
      await revokeIncident(p, employee, shareId);
      expect(await listIncidents(p, sec)).toEqual([]);
    });
    it("an expired share disappears on its own", async () => {
      const r = await shareIncident(p, employee, { messageId: msg.id, analystUserId: sec.userId, redact: false, hours: 1 });
      expect((await listIncidents(p, sec))[0]!.snapshot.text).toContain(SECRET);
      await p.db.withSystem(t => t.query("UPDATE incident_shares SET expires_at=now() - interval '1 minute' WHERE id=$1", [r.id]));
      expect(await listIncidents(p, sec)).toEqual([]);
    });
    it("the analyst still can't open the mailbox itself", async () => {
      await expect(getThread(p, sec, msg.thread_id)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("delegation requires the owner", () => {
    it("an admin can't grant themselves a mailbox", async () => {
      await expect(grantMailbox(p, owner, acct, owner.userId)).rejects.toMatchObject({ status: 404 });
      // The same attempt through raw SQL must fail at the database, not just the service.
      await expect(p.db.withUser(owner, t => t.query("INSERT INTO mailbox_grants(account_id,tenant_id,grantee_user_id,granted_by) VALUES ($1,$2,$3,$3)", [acct, owner.tenantId, owner.userId]))).rejects.toThrow(/row-level security/);
      await expect(p.db.withUser(owner, t => t.query("SELECT app.replace_credential($1,'password','x')", [acct]))).rejects.toThrow(/not the mailbox owner/);
    });
    it("an owner-issued grant works and can be revoked", async () => {
      await grantMailbox(p, employee, acct, owner.userId);
      expect((await getThread(p, owner, msg.thread_id)).messages[0]!.text).toContain(SECRET);
      await revokeMailboxGrant(p, employee, acct, owner.userId);
      await expect(getThread(p, owner, msg.thread_id)).rejects.toMatchObject({ status: 404 });
    });
  });

  it("Privacy Center states the real mode and doesn't claim zero knowledge", async () => {
    const pc = await privacyCenter(p, employee);
    expect(pc.mode.id).toBe("managed");
    expect(pc.mode.plain).toMatch(/isn't zero-knowledge/);
    expect(pc.model.hosted).toBe(false);
    expect(pc.review.certifications).toEqual([]);
    expect(pc.keys.warning).toMatch(/Not for production/);
  });
});
