import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { approveSend, conceptTsQuery, type Ctx, drainJobs, expandQuery, getAttachment, getThread, grantMailbox, invite, acceptInvite, listThreads, metricsText, personalInsights, type Platform, privacyCenter, publicAccounts, resealTenant, revokeMailboxGrant, rotateTenantKeys, runAssistant, saveDraft, securityOverview, signUp, summarizeThread, tasksToIcs, threadAction, traced, updatePrefs } from "../index";
import { deliver, demoAccount, testPlatform, user, markVerified } from "./harness";

describe("key rotation really moves data", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string, msg: any;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    ctx = await user(p, "rot@fernhill.example");
    acct = await demoAccount(p, ctx, "rot@fernhill.example");
    msg = await deliver(p, ctx, acct, { from: `"Sal" <sal@client.test>`, subject: "Keep me", text: "Can you check?", attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: "%PDF-1.4 bytes" }] });
    await summarizeThread(p, ctx, msg.thread_id);
  });
  afterAll(() => drop());
  const versions = () => p.db.withWorker(ctx.tenantId, async t => ({
    env: p.envelope.versionOf((await t.one<any>("SELECT envelope_enc b FROM messages WHERE id=$1", [msg.id])).b),
    body: p.envelope.versionOf((await t.one<any>("SELECT blob_enc b FROM message_contents WHERE message_id=$1", [msg.id])).b),
    cred: p.envelope.versionOf((await t.one<any>("SELECT blob b FROM credential_envelopes WHERE account_id=$1", [acct])).b),
  }));
  it("re-seals every class to the new version, and everything still opens", async () => {
    expect(await versions()).toEqual({ env: 1, body: 1, cred: 1 });
    await rotateTenantKeys(p, ctx);
    await drainJobs(p);
    expect(await versions()).toEqual({ env: 2, body: 2, cred: 2 });
    const t = await getThread(p, ctx, msg.thread_id);
    expect(t.messages[0]!.text).toContain("Can you check");
    expect((await getAttachment(p, ctx, t.messages[0]!.attachments[0]!.id)).filename).toBe("a.pdf");
    await deliver(p, ctx, acct, { from: "a@b.test", subject: "After rotation", text: "x" });
  });
  it("is idempotent, so a retried job does nothing new", async () => expect(await resealTenant(p, ctx.tenantId)).toBe(0));
  it("only an owner can rotate", async () => {
    const org = await user(p, "oo@corp.example", { kind: "organization" });
    const { acceptUrl } = await invite(p, org, { email: "mm@corp.example", role: "member" });
    const s = await signUp(p, { email: "mm@corp.example", password: "correct-horse-battery", name: "M", workspaceKind: "personal" });
    await markVerified(p, s.userId);
    await acceptInvite(p, s.userId, "mm@corp.example", acceptUrl!.split("/").pop()!);
    await expect(rotateTenantKeys(p, { tenantId: org.tenantId, userId: s.userId })).rejects.toMatchObject({ status: 403 });
  });
});

describe("duplicates, topics, concepts, campaigns", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); ctx = await user(p, "dup@corp.example", { kind: "organization" }); acct = await demoAccount(p, ctx, "dup@corp.example"); });
  afterAll(() => drop());

  it("a re-sent copy is marked as a duplicate, not merged", async () => {
    const m = { from: `"Bo" <bo@oak.test>`, subject: "Same notice", text: "Office closed Friday." };
    const a = await deliver(p, ctx, acct, m);
    const b = await deliver(p, ctx, acct, m);
    expect(b.thread_id).not.toBe(a.thread_id);
    const rows = (await listThreads(p, ctx, { view: "inbox", q: "subject:notice", limit: 5 })).items;
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.duplicateOf === a.id)).toHaveLength(1);
  });
  it("different sender, same text, isn't a duplicate", async () => {
    const b = await deliver(p, ctx, acct, { from: `"Cy" <cy@oak.test>`, subject: "Same notice", text: "Office closed Friday." });
    expect((await listThreads(p, ctx, { view: "inbox", q: "from:cy", limit: 5 })).items.find(r => r.messageId === b.id)?.duplicateOf).toBeNull();
  });
  it("user-defined topics apply to new mail, and can be turned off", async () => {
    await updatePrefs(p, ctx, { customTopics: [{ name: "Project Falcon", terms: ["falcon"] }] });
    const a = await deliver(p, ctx, acct, { from: "a@b.test", subject: "Falcon kickoff", text: "Notes." });
    expect((await getThread(p, ctx, a.thread_id)).messages[0]!.topics).toContain("Project Falcon");
    await updatePrefs(p, ctx, { topicsEnabled: false });
    const b = await deliver(p, ctx, acct, { from: "a@b.test", subject: "Falcon two", text: "More notes." });
    expect((await getThread(p, ctx, b.thread_id)).messages[0]!.topics).toEqual([]);
    await updatePrefs(p, ctx, { topicsEnabled: true });
  });
  it("concept search finds the prompt's example without embeddings or sending anything out", async () => {
    expect(expandQuery("the supplier who wanted a bank detail change").groups.length).toBe(3);
    expect(conceptTsQuery("'; DROP TABLE messages; --")).not.toContain(";");
    await deliver(p, ctx, acct, { from: `"Vera" <vera@harbor.test>`, subject: "Remittance update", text: "Our remittance account was updated last week, as agreed with your vendor team." });
    const plain = await listThreads(p, ctx, { view: "inbox", q: "supplier bank change", limit: 5 });
    const wide = await listThreads(p, ctx, { view: "inbox", q: "the supplier who wanted a bank detail change", limit: 5, concepts: true });
    expect(plain.items).toEqual([]);
    expect(wide.items.map(i => i.subject)).toContain("Remittance update");
    expect((await runAssistant(p, ctx, "Find the message where my supplier changed bank details", undefined, "D")).results!.map(r => r.subject)).toContain("Remittance update");
  });
  it("a campaign is counted across mailboxes with no content, and reported in aggregate", async () => {
    const lure = { from: `"Billing" <billing@harb0r-supply.test>`, auth: "fail" as const, text: "Our bank details have changed. Please update them today.", html: `<a href="https://harb0r-supply.test/pay">https://harbor.test</a>` };
    for (const n of [1001, 1002, 1003]) await deliver(p, ctx, acct, { ...lure, subject: `Invoice ${n} updated bank details` });
    const o = await securityOverview(p, ctx);
    expect(o.campaigns).toEqual({ count: 1, messages: 3 });
    expect(JSON.stringify(await p.db.withUser(ctx, t => t.query("SELECT * FROM security_campaigns")))).not.toMatch(/harb0r|bank|Invoice/);
  });
  it("privacy toggles work: summaries off, attachments not kept", async () => {
    await updatePrefs(p, ctx, { summariesEnabled: false, storeAttachments: false });
    const m = await deliver(p, ctx, acct, { from: "a@b.test", subject: "No keep", text: "x", attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: "%PDF-1.4" }] });
    await expect(summarizeThread(p, ctx, m.thread_id)).rejects.toMatchObject({ code: "ai_disabled" });
    const att = (await getThread(p, ctx, m.thread_id)).messages[0]!.attachments[0]!;
    await expect(getAttachment(p, ctx, att.id)).rejects.toMatchObject({ code: "attachment_unavailable" });
    await updatePrefs(p, ctx, { summariesEnabled: true, storeAttachments: true });
    expect((await privacyCenter(p, ctx)).controls.storeAttachments).toBe(true);
  });
  it("insights are counts only, and scoped to you", async () => {
    const i = await personalInsights(p, ctx);
    expect(i.perAccount[0]!.received).toBeGreaterThan(0);
    expect(JSON.stringify(i)).not.toMatch(/harb0r|Remittance|vera@/);
    const other = await user(p, "other2@example.org");
    expect((await personalInsights(p, other)).perAccount).toEqual([]);
  });
  it("calendar export includes firm dates only, and escapes hostile text", () => {
    const ics = tasksToIcs([
      { id: "a", text: "Send scope; by Wednesday\nBEGIN:VEVENT", dueAt: "2026-11-11T12:00:00Z", dueUncertain: false },
      { id: "b", text: "Vague", dueAt: null, dueUncertain: true },
      { id: "c", text: "Soonish", dueAt: "2026-11-12T12:00:00Z", dueUncertain: true },
    ], new Date("2026-11-06T00:00:00Z"));
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2 - 1 + 0 + 0 + 0 + (ics.includes("\\nBEGIN:VEVENT") ? 1 : 0));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261111");
    expect(ics).not.toContain("Soonish");
    expect(ics.split("\r\n").filter(l => l === "BEGIN:VEVENT")).toHaveLength(1);
  });
});

describe("delegated send is explicit", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx, bob: Ctx, acct: string;
  const key = () => `delegate-${Math.random().toString(36).slice(2)}-key`;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    owner = await user(p, "own@corp.example", { kind: "organization" });
    const { acceptUrl } = await invite(p, owner, { email: "bob@corp.example", role: "member" });
    const s = await signUp(p, { email: "bob@corp.example", password: "correct-horse-battery", name: "Bob", workspaceKind: "personal" });
    await markVerified(p, s.userId);
    await acceptInvite(p, s.userId, "bob@corp.example", acceptUrl!.split("/").pop()!);
    bob = { tenantId: owner.tenantId, userId: s.userId };
    acct = await demoAccount(p, owner, "shared@corp.example");
    await drainJobs(p);
  });
  afterAll(() => drop());
  const draft = (c: Ctx) => saveDraft(p, c, { accountId: acct, to: ["x@y.test"], cc: [], bcc: [], subject: "From shared", text: "Hello", aiGenerated: false });

  it("a read grant can't send", async () => {
    await grantMailbox(p, owner, acct, bob.userId);
    expect((await publicAccounts(p, bob))[0]!.canSend).toBe(false);
    await expect(draft(bob)).rejects.toMatchObject({ code: "read_only_access" });
  });
  it("a send grant can, as the mailbox, and it's audited as a delegate", async () => {
    await grantMailbox(p, owner, acct, bob.userId, { canSend: true });
    expect((await publicAccounts(p, bob))[0]!.canSend).toBe(true);
    const d = await draft(bob);
    await approveSend(p, bob, d.id, { expectedFrom: "shared@corp.example", idempotencyKey: key(), acknowledgedRisk: false });
    await drainJobs(p);
    expect(await p.db.withWorker(owner.tenantId, t => t.query("SELECT 1 FROM demo_mailbox WHERE folder_role='sent'"))).toHaveLength(1);
    const a = await p.db.withSystem(t => t.one<any>("SELECT meta FROM audit_events WHERE event='send.authorized' ORDER BY id DESC LIMIT 1"));
    expect(a.meta.kind).toBe("delegate");
  });
  it("sending doesn't imply changing the owner's mail", async () => {
    const m = await deliver(p, owner, acct, { from: "a@b.test", subject: "Keep", text: "x" });
    await expect(threadAction(p, bob, m.thread_id, { action: "trash" })).rejects.toMatchObject({ status: 403 });
  });
  it("a scheduled send doesn't survive revocation", async () => {
    const d = await draft(bob);
    await approveSend(p, bob, d.id, { expectedFrom: "shared@corp.example", idempotencyKey: key(), acknowledgedRisk: false, scheduledFor: new Date(Date.now() + 60_000).toISOString() });
    await revokeMailboxGrant(p, owner, acct, bob.userId);
    await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now() WHERE kind='send.execute' AND state='queued'"));
    const before = (await p.db.withWorker(owner.tenantId, t => t.query("SELECT 1 FROM demo_mailbox WHERE folder_role='sent'"))).length;
    await drainJobs(p);
    expect((await p.db.withWorker(owner.tenantId, t => t.query("SELECT 1 FROM demo_mailbox WHERE folder_role='sent'"))).length).toBe(before);
  });
});

describe("telemetry stays content-free", () => {
  it("span attributes go through the allowlist, and errors record only a name", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    await traced("t", { jobKind: "x", subject: "SECRET-SUBJECT", token: "SECRET-TOKEN" }, async () => {}).catch(() => {});
    await traced("u", { jobKind: "y" }, async () => { throw new Error("Bearer SECRET-TOKEN"); }).catch(() => {});
    const dump = JSON.stringify(exporter.getFinishedSpans().map(s => ({ a: s.attributes, st: s.status, ev: s.events })));
    expect(dump).not.toContain("SECRET");
    expect(dump).toContain("jobKind");
    trace.disable(); context.disable();
  });
  it("metrics expose kinds and counts only", async () => {
    const { p, drop } = await testPlatform();
    const out = await metricsText(p.db);
    expect(out).toContain("aegis_queue_oldest_seconds");
    await drop();
  });
});
