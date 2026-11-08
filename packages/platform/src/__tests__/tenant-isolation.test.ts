import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveSend, auditLog, type Ctx, decideQuarantine, getAttachment, getThread, listThreads, type Platform, recordFeedback, saveDraft, threadAction, updateAccount } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

describe("cross-tenant and IDOR", () => {
  let p: Platform, drop: () => Promise<void>, a: Ctx, b: Ctx, acctA: string, acctB: string, msgA: any;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    a = await user(p, "a@one.example"); b = await user(p, "b@two.example");
    acctA = await demoAccount(p, a, "a@one.example"); acctB = await demoAccount(p, b, "b@two.example");
    msgA = await deliver(p, a, acctA, { from: "x@y.test", subject: "Secret A", text: "secret a", attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: "%PDF-1.4" }] });
    await deliver(p, b, acctB, { from: "x@y.test", subject: "Secret B", text: "secret b" });
  });
  afterAll(() => drop());

  it("listing shows only your own tenant", async () => {
    const r = await listThreads(p, a, { view: "inbox", limit: 50 });
    expect(r.items.map(i => i.subject)).toEqual(["Secret A"]);
  });
  it("foreign IDs are hard-denied as not found", async () => {
    await expect(getThread(p, b, msgA.thread_id)).rejects.toMatchObject({ status: 404 });
    await expect(threadAction(p, b, msgA.thread_id, { action: "archive" })).rejects.toMatchObject({ status: 404 });
    await expect(recordFeedback(p, b, msgA.id, "important")).rejects.toMatchObject({ status: 404 });
    await expect(decideQuarantine(p, b, msgA.id, "release")).rejects.toMatchObject({ status: 404 });
    await expect(updateAccount(p, b, acctA, { displayName: "hack" })).rejects.toMatchObject({ status: 404 });
  });
  it("foreign attachments are denied", async () => {
    const id = (await getThread(p, a, msgA.thread_id)).messages[0]!.attachments[0]!.id;
    await expect(getAttachment(p, b, id)).rejects.toMatchObject({ status: 404 });
    expect((await getAttachment(p, a, id)).filename).toBe("a.pdf");
  });
  it("a user can't forge tenant context to read another tenant", async () => {
    const forged = { tenantId: a.tenantId, userId: b.userId };
    await expect(getThread(p, forged, msgA.thread_id)).rejects.toMatchObject({ status: 404 });
    expect(await p.db.withUser(forged, t => t.query("SELECT * FROM messages"))).toEqual([]);
  });
  it("search can't cross tenants", async () => {
    // Both tenants hold a message matching "secret"; each finds only its own.
    expect((await listThreads(p, b, { view: "inbox", q: "secret", limit: 10 })).items.map(i => i.subject)).toEqual(["Secret B"]);
    expect((await listThreads(p, a, { view: "inbox", q: "secret", limit: 10 })).items.map(i => i.subject)).toEqual(["Secret A"]);
  });
  it("writes into another tenant are refused by RLS", async () => {
    await expect(p.db.withUser(b, t => t.query("INSERT INTO threads(tenant_id,account_id) VALUES ($1,$2)", [a.tenantId, acctA]))).rejects.toThrow(/row-level security/);
    await expect(p.db.withUser(b, t => t.query("UPDATE messages SET is_read=true WHERE id=$1 RETURNING id", [msgA.id]))).resolves.toEqual([]);
  });
  it("drafts can't target a foreign account, and sends can't use one", async () => {
    await expect(saveDraft(p, b, { accountId: acctA, to: ["x@y.test"], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false })).rejects.toMatchObject({ status: 404 });
    const d = await saveDraft(p, a, { accountId: acctA, to: ["x@y.test"], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false });
    await expect(approveSend(p, b, d.id, { expectedFrom: "a@one.example", idempotencyKey: "k".repeat(20), acknowledgedRisk: false })).rejects.toMatchObject({ status: 404 });
  });
  it("audit logs don't cross tenants", async () => {
    const log = await auditLog(p, b);
    expect(JSON.stringify(log.rows)).not.toContain(acctA);
  });
  it("worker context is constrained to one tenant", async () => {
    expect(await p.db.withWorker(b.tenantId, t => t.query("SELECT id FROM messages WHERE account_id=$1", [acctA]))).toEqual([]);
  });
  it("every tenant-owned table has RLS forced", async () => {
    const rows = await p.db.withSystem(t => t.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
       WHERE n.nspname='public' AND c.relkind='r' AND a.attname='tenant_id' AND a.attnum>0`));
    const exempt = new Set(["jobs", "audit_events_placeholder", "tenant_keys_placeholder", "oauth_flows"]);
    for (const r of rows) if (!exempt.has(r.relname)) expect(r.relforcerowsecurity, r.relname).toBe(true);
  });
});

describe("withSystem is not a path to mail", () => {
  it("no service reads mail tables through the system context", () => {
    const dir = join(__dirname, "..");
    const files = readdirSync(dir).filter(f => f.endsWith(".ts") && statSync(join(dir, f)).isFile());
    const mailTables = /\b(FROM|JOIN|UPDATE|INTO)\s+(messages|message_contents|message_search|message_embeddings|attachments|threads|contacts|drafts|tasks|credential_envelopes|security_analyses)\b/i;
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      // Balanced-paren scan of each withSystem(...) call body.
      for (let i = src.indexOf("withSystem("); i >= 0; i = src.indexOf("withSystem(", i + 1)) {
        let depth = 0, j = i + "withSystem".length;
        do { if (src[j] === "(") depth++; else if (src[j] === ")") depth--; j++; } while (depth > 0 && j < src.length);
        const body = src.slice(i, j);
        expect(mailTables.test(body), `${f}: ${body.slice(0, 160)}`).toBe(false);
      }
    }
  });
});
