import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITIES, CursorExpiredError, type MailAdapter, type MailChange } from "@aegis/domain";
import { mime } from "@aegis/test-fixtures";
import { approveSend, closeAnalysisPool, connectAccount, type Ctx, decideQuarantine, drainJobs, listThreads, type Platform, saveDraft, syncAccount, threadAction } from "../index";
import { testPlatform, user } from "./harness";

/**
 * Real-server behaviour found running against Dovecot and Postfix (dovecot.live.test.ts), kept here where CI has neither.
 * An IMAP id contains the folder and UID, so unlike the demo store a move gives a message a new id.
 */
class ImapLikeProvider {
  kind = "imap" as const; capabilities = CAPABILITIES.imap;
  pages: Array<() => { changes: MailChange[]; cursor: string; hasMore: boolean }> = [];
  applied: Array<{ id: string; change: unknown }> = [];
  moved: string | undefined;
  sendResult: { acceptedAt: string; rejectedRecipients?: string[] } = { acceptedAt: new Date().toISOString() };
  async fullSync() { return (this.pages.shift() ?? (() => ({ changes: [], cursor: "{}", hasMore: false })))(); }
  async incrementalSync() { return this.fullSync(); }
  async fetchRaw(): Promise<Uint8Array> { throw new Error("raw comes with the change"); }
  async applyChange(id: string, change: unknown) { this.applied.push({ id, change }); const remoteId = this.moved; this.moved = undefined; return remoteId ? { remoteId } : undefined; }
  isRemoteIdCurrent(id: string, cursor: string) { return id.startsWith(JSON.parse(cursor).generation ?? ""); }
  async send() { return this.sendResult; }
  async findSentByMessageId() { return null; }
  async revoke() { return false; }
  async testConnection() { return { ok: true }; }
  async listFolders() { return []; }
}

const up = (remoteId: string, raw: Buffer, folderRole: "inbox" | "spam" | "archive" | "trash" = "inbox"): MailChange =>
  ({ type: "upsert", remoteId, internalDate: new Date().toISOString(), state: { folderRole, labels: [], isRead: false, isStarred: false }, raw });
const page = (changes: MailChange[], cursor = "{}") => () => ({ changes, cursor, hasMore: false });
const SCAM = { from: `"Harbor Supply Billing" <billing@harb0r-supply.test>`, replyTo: "harbor.ar@gmail.com", auth: "fail" as const, subject: "URGENT updated bank details", text: "Our bank account has changed. Wire the payment today to our new account or your service stops. Verify at http://harb0r-supply.test/login", messageId: "<scam@harb0r-supply.test>" };

describe("following messages whose provider id changes", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string, fake: ImapLikeProvider;
  const byRemote = (id: string) => p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT * FROM messages WHERE account_id=$1 AND provider_message_id=$2", [acct, id]));
  const sync = () => syncAccount(p, ctx.tenantId, acct);
  beforeAll(async () => {
    fake = new ImapLikeProvider();
    ({ p, drop } = await testPlatform({ adapterFactory: () => fake as unknown as MailAdapter }));
    ctx = await user(p, "moves@example.org");
    acct = await connectAccount(p, ctx, { kind: "imap", email: "moves@example.org", displayName: "M", credential: { kind: "password" } });
    await drainJobs(p);
  });
  afterAll(async () => { await closeAnalysisPool(); await drop(); });

  it("after our own move, sync sees the same message rather than a deletion and a stranger", async () => {
    const raw = Buffer.from(mime({ from: "Pat <pat@oak.test>", subject: "Archive me", text: "Hello", messageId: "<archive-me@oak.test>" }));
    fake.pages = [page([up("INBOX:1:1", raw)])];
    await sync();
    const before = await byRemote("INBOX:1:1");
    fake.moved = "Archive:1:1";
    await threadAction(p, ctx, before.thread_id, { action: "archive" });
    await drainJobs(p);
    expect(fake.applied.at(-1)).toMatchObject({ id: "INBOX:1:1", change: { moveToRole: "archive" } });
    fake.pages = [page([up("Archive:1:1", raw, "archive"), { type: "delete", remoteId: "INBOX:1:1" }])];
    await sync();
    const after = await byRemote("Archive:1:1");
    expect(after).toMatchObject({ id: before.id, thread_id: before.thread_id, folder_role: "archive", tombstoned_at: null });
    expect(await byRemote("INBOX:1:1")).toBeNull();
    const contact = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT received_count FROM contacts WHERE account_id=$1 AND sender_hash=$2", [acct, before.sender_hash]));
    expect(contact.received_count).toBe(1);
  });

  it("a quarantined message keeps its row and original folder through the move, and release returns it", async () => {
    const raw = Buffer.from(mime(SCAM));
    fake.pages = [page([up("INBOX:1:2", raw)])];
    await sync();
    const held = await byRemote("INBOX:1:2");
    expect(held.held).toBe(true);
    fake.moved = "Junk:1:9";
    await drainJobs(p);
    fake.pages = [page([{ type: "delete", remoteId: "INBOX:1:2" }, up("Junk:1:9", raw, "spam")])];
    await sync();
    expect((await listThreads(p, ctx, { view: "quarantine", limit: 10 })).items.map(i => i.messageId)).toEqual([held.id]);
    const q = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, original_folder_role, provider_moved FROM quarantine_items WHERE message_id=$1", [held.id]));
    expect(q).toEqual({ state: "held", original_folder_role: "inbox", provider_moved: true });
    expect((await decideQuarantine(p, ctx, held.id, "release")).restoredTo).toBe("inbox");
    fake.moved = "INBOX:1:10";
    await drainJobs(p);
    expect(fake.applied.at(-1)).toMatchObject({ id: "Junk:1:9", change: { moveToRole: "inbox" } });
    fake.pages = [page([{ type: "delete", remoteId: "Junk:1:9" }, up("INBOX:1:10", raw)])];
    await sync();
    expect(await byRemote("INBOX:1:10")).toMatchObject({ id: held.id, held: false, folder_role: "inbox" });
  });

  it("a move by another client is recognized from the delete and arrival in one page", async () => {
    const raw = Buffer.from(mime({ from: "Pat <pat@oak.test>", subject: "Moved elsewhere", text: "Hello", messageId: "<moved-elsewhere@oak.test>" }));
    fake.pages = [page([up("INBOX:1:3", raw)])];
    await sync();
    const before = await byRemote("INBOX:1:3");
    fake.pages = [page([{ type: "delete", remoteId: "INBOX:1:3" }, up("Trash:1:3", raw, "trash")])];
    await sync();
    expect(await byRemote("Trash:1:3")).toMatchObject({ id: before.id, thread_id: before.thread_id, folder_role: "trash", tombstoned_at: null });
  });

  it("the same Message-ID with different bytes is a new message: a verdict can't be inherited", async () => {
    const real = Buffer.from(mime({ from: "Pat <pat@oak.test>", subject: "Original", text: "Fine.", messageId: "<shared-id@oak.test>" }));
    const other = Buffer.from(mime({ ...SCAM, messageId: "<shared-id@oak.test>" }));
    fake.pages = [page([up("INBOX:1:4", real)])];
    await sync();
    const before = await byRemote("INBOX:1:4");
    fake.pages = [page([{ type: "delete", remoteId: "INBOX:1:4" }, up("INBOX:1:5", other)])];
    await sync();
    const after = await byRemote("INBOX:1:5");
    expect(after.id).not.toBe(before.id);
    expect(after.held).toBe(true);
    expect((await byRemote("INBOX:1:4")).tombstoned_at).not.toBeNull();
  });

  it("a delete with no matching arrival stays a delete", async () => {
    const raw = Buffer.from(mime({ from: "Pat <pat@oak.test>", subject: "Really gone", text: "Bye", messageId: "<really-gone@oak.test>" }));
    fake.pages = [page([up("INBOX:1:6", raw)])];
    await sync();
    fake.pages = [page([{ type: "delete", remoteId: "INBOX:1:6" }])];
    await sync();
    expect((await byRemote("INBOX:1:6")).tombstoned_at).not.toBeNull();
  });

  it("after a reconcile, ids from the expired generation are swept and the reissued copy stands alone", async () => {
    const raw = Buffer.from(mime({ from: "Pat <pat@oak.test>", subject: "Reissued", text: "Hello", messageId: "<reissued@oak.test>" }));
    fake.pages = [page([up("Old:1:1", raw)], JSON.stringify({ generation: "" }))];
    await sync();
    fake.pages = [
      () => { throw new CursorExpiredError("generation changed"); },
      page([up("New:2:1", raw)], JSON.stringify({ generation: "New:" })),
    ];
    await sync();
    expect((await byRemote("Old:1:1")).tombstoned_at).not.toBeNull();
    expect(await byRemote("New:2:1")).toMatchObject({ state: "classified", tombstoned_at: null });
    const s = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT phase FROM sync_states WHERE account_id=$1", [acct]));
    expect(s.phase).toBe("incremental");
    // Sweep everything so later tests in this file start clean: a page keeps the generation only for this test.
    fake.pages = [page([], JSON.stringify({ generation: "" }))];
    await sync();
  });

  it("a send the server partly refused completes, and says so", async () => {
    const { id } = await saveDraft(p, ctx, { accountId: acct, to: ["a@oak.test", "b@oak.test"], cc: [], bcc: [], subject: "x", text: "x", aiGenerated: false });
    fake.sendResult = { acceptedAt: new Date().toISOString(), rejectedRecipients: ["b@oak.test"] };
    await approveSend(p, ctx, id, { expectedFrom: "moves@example.org", idempotencyKey: `k-${id}`, acknowledgedRisk: false });
    await drainJobs(p);
    const a = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, error_code FROM send_approvals WHERE draft_id=$1", [id]));
    expect(a).toEqual({ state: "completed", error_code: "recipients_refused" });
    const e = await p.db.withSystem(t => t.one<any>("SELECT meta FROM audit_events WHERE event='send.completed' AND target_id=$1", [id]));
    expect(e.meta).toEqual({ outcome: "partial", count: 1 });
  });
});

describe("attachment scan status", () => {
  it("is recorded per attachment, so a clean file beside an infected one isn't shown as the same", async () => {
    const fake = new ImapLikeProvider();
    const { p, drop } = await testPlatform({
      adapterFactory: () => fake as unknown as MailAdapter,
      scanner: { id: "stub", maintained: true, scan: async a => ({ status: a.filename === "bad.bin" ? "infected" : "clean", engine: "stub" }) },
    });
    try {
      const ctx = await user(p, "scan@example.org");
      const acct = await connectAccount(p, ctx, { kind: "imap", email: "scan@example.org", displayName: "S", credential: { kind: "password" } });
      await drainJobs(p);
      const raw = Buffer.from(mime({ from: "Pat <pat@oak.test>", subject: "Two files", text: "See both.", attachments: [
        { filename: "good.bin", contentType: "application/octet-stream", content: "harmless" },
        { filename: "bad.bin", contentType: "application/octet-stream", content: "not harmless" },
      ] }));
      fake.pages = [page([up("INBOX:1:1", raw)])];
      await syncAccount(p, ctx.tenantId, acct);
      const rows = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT scan_status FROM attachments"));
      expect(rows.map(r => r.scan_status).sort()).toEqual(["clean", "infected"]);
    } finally { await closeAnalysisPool(); await drop(); }
  });
});
