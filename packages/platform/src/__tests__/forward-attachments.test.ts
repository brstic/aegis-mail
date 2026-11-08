import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDraftAttachment, approveSend, auditLog, copyAttachmentsToDraft, type Ctx, drainJobs, getThread, grantMailbox, listDrafts, MAX_DRAFT_ATTACHMENT_BYTES, type Platform, removeDraftAttachment, saveDraft, sealMessage, signIn, updatePrefs } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";
import { webClient, type WebClient } from "./web-harness";

const PDF = "%PDF-1.4 synthetic forwarded report body";
const SEAL = { ciphertext: Buffer.alloc(64, 7).toString("base64"), meta: { alg: "AES-GCM" as const, kdf: "PBKDF2-SHA256" as const, iterations: 600_000, salt: "c2FsdA==", iv: "aXY=", v: 1 as const } };

describe("forwarding the original's attachments", () => {
  let p: Platform, drop: () => Promise<void>, owner: Ctx & { token: string }, mate: Ctx & { token: string }, stranger: Ctx & { token: string }, acct: string, mateAcct: string;
  const blank = (c: Ctx, accountId: string) => saveDraft(p, c, { accountId, to: ["x@y.test"], cc: [], bcc: [], subject: "Fwd", text: "see attached", aiGenerated: false });
  const withFile = async (c: Ctx, accountId: string, input: Record<string, unknown> = {}, filename = "report.pdf", content: string | Buffer = PDF) => {
    const m = await deliver(p, c, accountId, { from: `"Priya" <priya@oak.test>`, subject: "Report", text: "Report attached.", attachments: [{ filename, contentType: "application/pdf", content }], ...input });
    const t = await getThread(p, c, m.thread_id);
    const message = t.messages.find(x => x.id === m.id)!;
    return { ...m, attachments: message.attachments };
  };
  const copy = (c: Ctx, draft: string, messageId: string, ids: string[]) => copyAttachmentsToDraft(p, c, draft, { messageId, attachmentIds: ids });

  beforeAll(async () => {
    ({ p, drop } = await testPlatform());
    owner = await user(p, "own@fwd.test", { kind: "organization" });
    const u = await user(p, "mate@fwd.test");
    await p.db.withSystem(t => t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [owner.tenantId, u.userId]));
    mate = { ...u, tenantId: owner.tenantId };
    stranger = await user(p, "stranger@fwd.test");
    acct = await demoAccount(p, owner, "own@fwd.test");
    mateAcct = await demoAccount(p, mate, "mate@fwd.test");
  });
  afterAll(() => drop());

  it("copies the real bytes into the draft, and they reach the provider", async () => {
    const m = await withFile(owner, acct);
    expect(m.risk_label).toBe("safe");
    const d = await blank(owner, acct);
    const r = await copy(owner, d.id, m.id, [m.attachments[0]!.id]);
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]).toMatchObject({ filename: "report.pdf", contentType: "application/pdf", size: PDF.length, sourceAttachmentId: m.attachments[0]!.id });
    expect(r.attachments[0]).not.toHaveProperty("data");
    expect(r.attachments[0]).not.toHaveProperty("source");
    await approveSend(p, owner, d.id, { expectedFrom: "own@fwd.test", idempotencyKey: "fwd-copy-bytes-0001", acknowledgedRisk: false });
    await drainJobs(p);
    const sent = await p.db.withWorker(owner.tenantId, t => t.one<{ raw: Buffer }>("SELECT raw FROM demo_mailbox WHERE account_id=$1 AND folder_role='sent' ORDER BY internal_date DESC LIMIT 1", [acct]));
    expect(sent!.raw.toString()).toContain("report.pdf");
    expect(sent!.raw.toString()).toContain(Buffer.from(PDF).toString("base64"));
  });

  it("a repeat doesn't duplicate a file, and removing one leaves the rest", async () => {
    const m = await deliver(p, owner, acct, { from: "a@oak.test", subject: "Two", text: "Two files.", attachments: [{ filename: "a.pdf", contentType: "application/pdf", content: "%PDF a" }, { filename: "b.pdf", contentType: "application/pdf", content: "%PDF b" }] });
    const [a, b] = (await getThread(p, owner, m.thread_id)).messages[0]!.attachments;
    const d = await blank(owner, acct);
    await copy(owner, d.id, m.id, [a!.id]);
    expect((await copy(owner, d.id, m.id, [a!.id, b!.id])).attachments.map(f => f.filename)).toEqual(["a.pdf", "b.pdf"]);
    expect((await copy(owner, d.id, m.id, [a!.id])).attachments).toHaveLength(2);
    const added = (await listDrafts(p, owner)).find(x => x.id === d.id)!.attachments;
    const left = await removeDraftAttachment(p, owner, d.id, added.find(f => f.filename === "a.pdf")!.id);
    expect(left.attachments.map(f => f.filename)).toEqual(["b.pdf"]);
    expect((await copy(owner, d.id, m.id, [a!.id])).attachments.map(f => f.filename).sort()).toEqual(["a.pdf", "b.pdf"]);
  });

  it("cleans a hostile filename and content type, which came from the sender", async () => {
    const m = await withFile(owner, acct, {}, "..\\evil\r\nX-Injected: 1.pdf");
    await p.db.withWorker(owner.tenantId, async t => {
      const meta = await p.envelope.sealJson({ tenantId: owner.tenantId, keyClass: "body", table: "attachments", recordId: m.attachments[0]!.id }, { filename: "../evil\r\nX-Injected: 1.pdf", contentType: "text/html\r\nX-Injected: 1", disposition: "attachment" });
      await t.query("UPDATE attachments SET meta_enc=$2 WHERE id=$1", [m.attachments[0]!.id, meta]);
    });
    const d = await blank(owner, acct);
    const r = await copy(owner, d.id, m.id, [m.attachments[0]!.id]);
    expect(r.attachments[0]!.filename).not.toMatch(/[\r\n/\\]/);
    expect(r.attachments[0]!.contentType).toBe("application/octet-stream");
  });

  describe("verdicts", () => {
    it.each(["suspicious", "high_risk", "malicious"])("refuses a message rated %s, and records that it did", async label => {
      const m = await withFile(owner, acct);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE messages SET risk_label=$2 WHERE id=$1", [m.id, label]));
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 403, code: "attachments_refused" });
      expect((await listDrafts(p, owner)).find(x => x.id === d.id)!.attachments).toEqual([]);
      const denied = await p.db.withSystem(t => t.one<any>("SELECT meta FROM audit_events WHERE event='access.denied' AND target_id=$1", [m.id]));
      expect(denied.meta).toEqual({ reason: "flagged_message", kind: "forward_attachments" });
    });
    it("refuses a message the pipeline really flagged", async () => {
      const m = await withFile(owner, acct, { from: `"PayPal" <x@paypa1.test>`, auth: "fail", subject: "Verify", text: "Verify your password now at https://paypa1.test/login" });
      expect(["suspicious", "high_risk", "malicious"]).toContain(m.risk_label);
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ code: "attachments_refused" });
    });
    it.each(["infected", "unscannable", "error"])("refuses a file the scanner reported as %s, on an otherwise fine message", async scan => {
      const m = await withFile(owner, acct);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE attachments SET scan_status=$2 WHERE id=$1", [m.attachments[0]!.id, scan]));
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 403, code: "attachments_refused" });
    });
    it.each(["clean", "not_scanned"])("allows %s", async scan => {
      const m = await withFile(owner, acct);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE attachments SET scan_status=$2 WHERE id=$1", [m.attachments[0]!.id, scan]));
      const d = await blank(owner, acct);
      expect((await copy(owner, d.id, m.id, [m.attachments[0]!.id])).attachments).toHaveLength(1);
    });
    it("one flagged file refuses the whole request, not just that file", async () => {
      const m = await deliver(p, owner, acct, { from: "a@oak.test", subject: "Mixed", text: "Two files.", attachments: [{ filename: "ok.pdf", contentType: "application/pdf", content: "%PDF ok" }, { filename: "bad.pdf", contentType: "application/pdf", content: "%PDF bad" }] });
      const [ok, bad] = (await getThread(p, owner, m.thread_id)).messages[0]!.attachments;
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE attachments SET scan_status='infected' WHERE id=$1", [bad!.id]));
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [ok!.id, bad!.id])).rejects.toMatchObject({ code: "attachments_refused" });
      expect((await copy(owner, d.id, m.id, [ok!.id])).attachments).toHaveLength(1);
    });
    it("an unverified message's files are the person's call, because the composer starts them off", async () => {
      const m = await withFile(owner, acct);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE messages SET risk_label='unknown_unscannable' WHERE id=$1", [m.id]));
      const d = await blank(owner, acct);
      expect((await copy(owner, d.id, m.id, [m.attachments[0]!.id])).attachments).toHaveLength(1);
    });
    it("refuses mail held in quarantine", async () => {
      const m = await withFile(owner, acct);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE messages SET held=true WHERE id=$1", [m.id]));
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ code: "attachments_refused" });
    });
    it("a message flagged after the copy can't take its file out of the door", async () => {
      const m = await withFile(owner, acct);
      const d = await blank(owner, acct);
      const r = await copy(owner, d.id, m.id, [m.attachments[0]!.id]);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE messages SET risk_label='malicious' WHERE id=$1", [m.id]));
      await expect(approveSend(p, owner, d.id, { expectedFrom: "own@fwd.test", idempotencyKey: "fwd-late-flag-0001", acknowledgedRisk: false })).rejects.toMatchObject({ status: 403, code: "attachments_refused" });
      await removeDraftAttachment(p, owner, d.id, r.attachments[0]!.id);
      await expect(approveSend(p, owner, d.id, { expectedFrom: "own@fwd.test", idempotencyKey: "fwd-late-flag-0002", acknowledgedRisk: false })).resolves.toMatchObject({ duplicate: false });
    });
  });

  describe("what the caller can reach", () => {
    it("someone who can't read the message gets a 404, and so does someone from another tenant", async () => {
      const m = await withFile(owner, acct);
      const mine = await blank(mate, mateAcct);
      await expect(copy(mate, mine.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 404 });
      const a = await demoAccount(p, stranger, "stranger@fwd.test");
      const theirs = await blank(stranger, a);
      await expect(copy(stranger, theirs.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 404 });
    });
    it("a file from a different message can't be claimed through one you can read", async () => {
      const yours = await withFile(mate, mateAcct);
      const hidden = await withFile(owner, acct);
      const d = await blank(mate, mateAcct);
      await expect(copy(mate, d.id, yours.id, [hidden.attachments[0]!.id])).rejects.toMatchObject({ status: 404 });
      await expect(copy(mate, d.id, yours.id, [yours.attachments[0]!.id, hidden.attachments[0]!.id])).rejects.toMatchObject({ status: 404 });
    });
    it("someone else's draft is a 404", async () => {
      const m = await withFile(mate, mateAcct);
      const hers = await blank(owner, acct);
      await expect(copy(mate, hers.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 404 });
    });
    it("a grantee who can read a mailbox can forward its files from their own account, and only that", async () => {
      const m = await withFile(owner, acct);
      await grantMailbox(p, owner, acct, mate.userId);
      const d = await blank(mate, mateAcct);
      expect((await copy(mate, d.id, m.id, [m.attachments[0]!.id])).attachments).toHaveLength(1);
      // Reading doesn't imply sending, so a draft on the shared mailbox itself can't even exist.
      await expect(blank(mate, acct)).rejects.toMatchObject({ status: 403 });
    });
    it("losing the right to send from the draft's account stops the copy", async () => {
      const m = await withFile(owner, acct);
      await grantMailbox(p, owner, acct, mate.userId, { canSend: true });
      const d = await blank(mate, acct);
      await grantMailbox(p, owner, acct, mate.userId, { canSend: false });
      await expect(copy(mate, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 403, code: "read_only_access" });
    });
    it("a draft already sending can't change", async () => {
      const m = await withFile(owner, acct);
      const d = await blank(owner, acct);
      await approveSend(p, owner, d.id, { expectedFrom: "own@fwd.test", idempotencyKey: "fwd-locked-000001", acknowledgedRisk: false });
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ code: "draft_locked" });
      await drainJobs(p);
    });
  });

  describe("the 3 MB limit", () => {
    const big = (mb: number) => Buffer.alloc(Math.floor(mb * 1024 * 1024), "a");
    it("refuses a set over the limit with a message that says so", async () => {
      const m = await deliver(p, owner, acct, { from: "a@oak.test", subject: "Big set", text: "Big.", attachments: [{ filename: "one.bin", contentType: "application/octet-stream", content: big(2) }, { filename: "two.bin", contentType: "application/octet-stream", content: big(2) }] });
      const [a, b] = (await getThread(p, owner, m.thread_id)).messages[0]!.attachments;
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [a!.id, b!.id])).rejects.toMatchObject({ status: 413, code: "attachments_too_large", message: "Attachments on one message can total at most 3 MB." });
      // Either alone fits, and then the other doesn't.
      expect((await copy(owner, d.id, m.id, [a!.id])).attachments).toHaveLength(1);
      await expect(copy(owner, d.id, m.id, [b!.id])).rejects.toMatchObject({ code: "attachments_too_large" });
    });
    it("counts files already on the draft", async () => {
      const m = await withFile(owner, acct, {}, "two.bin", big(2));
      const d = await blank(owner, acct);
      await addDraftAttachment(p, owner, d.id, { filename: "mine.bin", dataBase64: big(1.5).toString("base64") });
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ code: "attachments_too_large" });
    });
    it("two requests at once can't both squeeze past it", async () => {
      const m = await deliver(p, owner, acct, { from: "a@oak.test", subject: "Race", text: "Race.", attachments: [{ filename: "one.bin", contentType: "application/octet-stream", content: big(2) }, { filename: "two.bin", contentType: "application/octet-stream", content: big(2) }] });
      const [a, b] = (await getThread(p, owner, m.thread_id)).messages[0]!.attachments;
      const d = await blank(owner, acct);
      const results = await Promise.allSettled([copy(owner, d.id, m.id, [a!.id]), copy(owner, d.id, m.id, [b!.id])]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      const stored = (await listDrafts(p, owner)).find(x => x.id === d.id)!.attachments;
      expect(stored.reduce((s, f) => s + f.size, 0)).toBeLessThanOrEqual(MAX_DRAFT_ATTACHMENT_BYTES);
    });
    it("a file too large to have been stored says why", async () => {
      const m = await withFile(owner, acct);
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE attachments SET blob_enc=NULL WHERE id=$1", [m.attachments[0]!.id]));
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ status: 400, code: "attachment_unavailable" });
    });
  });

  describe("other things that hold a draft", () => {
    it("an autosave landing beside a copy doesn't lose the file", async () => {
      const m = await withFile(owner, acct);
      const d = await blank(owner, acct);
      const saves = Array.from({ length: 6 }, (_, i) => saveDraft(p, owner, { id: d.id, accountId: acct, to: ["x@y.test"], cc: [], bcc: [], subject: "Fwd", text: `typing ${i}`, aiGenerated: false }));
      await Promise.all([...saves, copy(owner, d.id, m.id, [m.attachments[0]!.id])]);
      expect((await listDrafts(p, owner)).find(x => x.id === d.id)!.attachments).toHaveLength(1);
    });
    it("a sealed message has no files left to copy", async () => {
      const m = await withFile(owner, acct);
      await sealMessage(p, owner, m.id, SEAL);
      const d = await blank(owner, acct);
      await expect(copy(owner, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ code: "attachment_unavailable" });
    });
    it("nor does a mailbox that doesn't keep attachments", async () => {
      const c = await user(p, "nofiles@fwd.test");
      const a = await demoAccount(p, c, "nofiles@fwd.test");
      await updatePrefs(p, c, { storeAttachments: false });
      const m = await withFile(c, a);
      expect(m.attachments[0]!.stored).toBe(false);
      const d = await blank(c, a);
      await expect(copy(c, d.id, m.id, [m.attachments[0]!.id])).rejects.toMatchObject({ code: "attachment_unavailable" });
    });
    it("audit rows name no file", async () => {
      const m = await withFile(owner, acct, {}, "secret-merger-plan.pdf");
      const d = await blank(owner, acct);
      await copy(owner, d.id, m.id, [m.attachments[0]!.id]);
      const { rows } = await auditLog(p, owner, 100);
      expect(rows.some(r => r.meta?.kind === "forward_attachments")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("merger");
    });
  });

  describe("through the route", () => {
    let client: WebClient, token: string;
    beforeAll(async () => {
      client = await webClient(p, ["mail"]);
      token = (await signIn(p, { email: "own@fwd.test", password: "correct-horse-battery" })).token!;
    });
    it("copies, and refuses with the same status the service gives", async () => {
      const m = await withFile(owner, acct);
      const d = await blank(owner, acct);
      const ok = await client.call("POST", `/drafts/${d.id}/attachments/from-message`, { token, body: { messageId: m.id, attachmentIds: [m.attachments[0]!.id] } });
      expect(ok.status).toBe(200);
      expect(ok.json.attachments[0].filename).toBe("report.pdf");
      expect(JSON.stringify(ok.json)).not.toContain(Buffer.from(PDF).toString("base64"));
      await p.db.withWorker(owner.tenantId, t => t.query("UPDATE messages SET risk_label='suspicious' WHERE id=$1", [m.id]));
      const no = await client.call("POST", `/drafts/${d.id}/attachments/from-message`, { token, body: { messageId: m.id, attachmentIds: [m.attachments[0]!.id] } });
      expect(no.status).toBe(403);
      expect(no.json.error.code).toBe("attachments_refused");
    });
    it("needs a session, an origin and well-formed IDs", async () => {
      const d = await blank(owner, acct);
      const body = { messageId: "00000000-0000-4000-8000-000000000000", attachmentIds: ["00000000-0000-4000-8000-000000000001"] };
      expect((await client.call("POST", `/drafts/${d.id}/attachments/from-message`, { body })).status).toBe(401);
      expect((await client.call("POST", `/drafts/${d.id}/attachments/from-message`, { token, body, origin: "https://evil.test" })).status).toBe(403);
      expect((await client.call("POST", `/drafts/${d.id}/attachments/from-message`, { token, body: { messageId: "nope", attachmentIds: [] } })).status).toBe(400);
      expect((await client.call("POST", `/drafts/${d.id}/attachments/from-message`, { token, body })).status).toBe(404);
    });
    it("the search status route answers for the signed-in user", async () => {
      const r = await client.call("GET", "/search/semantic", { token });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ available: false, reason: "deployment" });
    });
    it("the threads route passes the flag through", async () => {
      const r = await client.call("GET", "/threads?q=report&semantic=true&limit=5", { token });
      expect(r.status).toBe(200);
      expect(r.json.semantic).toEqual({ status: "unavailable" });
    });
  });
});
