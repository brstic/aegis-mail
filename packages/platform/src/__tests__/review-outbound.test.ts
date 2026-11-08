import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveSend, connectAccount, type Ctx, drainJobs, type DraftBody, executeSend, listNotifications, type Platform, saveDraft, updatePolicy } from "../index";
import { testPlatform, user } from "./harness";

/**
 * Independent review. outboundBlockDomains is checked once, in approveSend. Each test states the secure behaviour, so a failure
 * here is the bug.
 */
describe("review: outbound block list", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  const sends: { to: string[]; bcc: string[] }[] = [];
  const adapter: any = {
    capabilities: {}, kind: "imap",
    send: async (m: any) => { sends.push({ to: m.to.map((a: any) => a.address), bcc: m.bcc.map((a: any) => a.address) }); return { remoteId: `r${sends.length}`, acceptedAt: new Date().toISOString() }; },
    findSentByMessageId: async () => null,
  };
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ adapterFactory: () => adapter }));
    ctx = await user(p, "sender@outbound.example", { kind: "organization" });
    acct = await connectAccount(p, ctx, { kind: "imap", email: "sender@outbound.example", displayName: "S", credential: { kind: "password" } });
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='cancelled' WHERE payload->>'accountId'=$1", [acct]));
  });
  afterAll(() => drop());

  const draft = async (to: string) => (await saveDraft(p, ctx, { accountId: acct, to: [to], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false })).id;

  it("a send some recipients refused tells the person who sent it, without the content", async () => {
    await updatePolicy(p, ctx, { outboundBlockDomains: [] } as never);
    const realSend = adapter.send;
    adapter.send = async () => ({ remoteId: "partial", acceptedAt: new Date().toISOString(), rejectedRecipients: ["gone@partial.example"] });
    try {
      const id = (await saveDraft(p, ctx, { accountId: acct, to: ["a@partial.example", "gone@partial.example"], cc: [], bcc: [], subject: "PARTIALSECRET", text: "t", aiGenerated: false })).id;
      const { approvalId } = await approveSend(p, ctx, id, { expectedFrom: "sender@outbound.example", idempotencyKey: "review-partial-00001", acknowledgedRisk: false });
      await executeSend(p, ctx.tenantId, approvalId);
    } finally { adapter.send = realSend; }
    const { items } = await listNotifications(p, ctx);
    const n = items.filter((i: { kind: string }) => i.kind === "send_partial");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ severity: "critical", href: "/app/sent" });
    expect(JSON.stringify(n)).not.toContain("PARTIALSECRET");
    expect(JSON.stringify(n)).not.toContain("gone@partial.example");
  });

  it("a send scheduled before a domain was blocked doesn't go out after (send.ts executeSend)", async () => {
    await updatePolicy(p, ctx, { outboundBlockDomains: [] } as never);
    const id = await draft("partner@later-blocked.example");
    const { approvalId } = await approveSend(p, ctx, id, { expectedFrom: "sender@outbound.example", idempotencyKey: "review-scheduled-0001", scheduledFor: new Date(Date.now() + 3_600_000).toISOString(), acknowledgedRisk: false });
    await updatePolicy(p, ctx, { outboundBlockDomains: ["later-blocked.example"] } as never);
    // What the worker does when the job comes due.
    await expect(executeSend(p, ctx.tenantId, approvalId)).rejects.toMatchObject({ name: "PermanentJobError" });
    expect(sends.flatMap(s => s.to)).not.toContain("partner@later-blocked.example");
    const row = await p.db.withWorker(ctx.tenantId, t => t.one<{ error_code: string }>("SELECT error_code FROM send_approvals WHERE id=$1", [approvalId]));
    expect(row?.error_code).toBe("outbound_blocked");
  });

  it("editing the draft while it's being approved can't add a blocked recipient (send.ts approveSend reads without a lock)", async () => {
    await updatePolicy(p, ctx, { outboundBlockDomains: ["blocked-now.example"] } as never);
    const id = await draft("fine@allowed.example");
    // Deterministic stand-in for two concurrent requests: autosave lands after approveSend has read the draft and before it locks state.
    const open = p.envelope.openJson.bind(p.envelope);
    let raced = false;
    (p.envelope as any).openJson = async (c: any, enc: Buffer) => {
      const out = await open(c, enc);
      if (!raced && c.table === "drafts" && c.recordId === id) {
        raced = true;
        await saveDraft(p, ctx, { id, accountId: acct, to: ["fine@allowed.example"], cc: [], bcc: ["exfil@blocked-now.example"], subject: "s", text: "t", aiGenerated: false });
      }
      return out as DraftBody as never;
    };
    await expect(approveSend(p, ctx, id, { expectedFrom: "sender@outbound.example", idempotencyKey: "review-toctou-0000001", acknowledgedRisk: false }).finally(() => { (p.envelope as any).openJson = open; })).rejects.toMatchObject({ status: 409, code: "draft_changed" });
    await drainJobs(p);
    expect(sends.flatMap(s => s.bcc)).not.toContain("exfil@blocked-now.example");
    // Sending again checks the edited draft, so the change can't slip through on the retry either.
    await expect(approveSend(p, ctx, id, { expectedFrom: "sender@outbound.example", idempotencyKey: "review-toctou-0000002", acknowledgedRisk: false })).rejects.toMatchObject({ status: 403, code: "outbound_blocked" });
  });
});
