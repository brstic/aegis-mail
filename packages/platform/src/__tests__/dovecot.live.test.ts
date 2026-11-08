import { readFileSync } from "node:fs";
import { ImapFlow } from "@aegis/mail-adapters/test-imap-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter, type AdapterCredential, type HostGuard } from "@aegis/mail-adapters";
import { ClamdScanner } from "@aegis/security-engine";
import { approveSend, closeAnalysisPool, connectAccount, type Ctx, decideQuarantine, drainJobs, getFocus, getThread, listThreads, type Platform, saveDraft, syncAccount, threadAction } from "../index";
import { testPlatform, user } from "./harness";

/**
 * The whole platform path over a real server: connect, sync, classify, store encrypted, read back, write back, send.
 * Skipped unless IMAP_TEST_HOST is set: see infra/local/live-servers.sh. Uses real Postgres, real Dovecot and Postfix, and
 * real clamd when CLAMD_TEST_HOST is set too. The only test seam is the adapter factory, which passes the local CA and a
 * loopback host guard that production never has.
 */
const env = process.env;
const host = env.IMAP_TEST_HOST;
const imapPort = Number(env.IMAP_TEST_PORT);
const servername = env.IMAP_TEST_SERVERNAME ?? "localhost";
const password = env.IMAP_TEST_PASS ?? "";
const ca = env.IMAP_TEST_CA_FILE ? readFileSync(env.IMAP_TEST_CA_FILE) : undefined;
const email = "platformtest@example.net";
const guard: HostGuard = { checkHost: async (_h, port) => ({ ip: host as string, family: 4, port, hostname: servername, servername }) };
const EICAR = `X5O!P%@AP[4\\PZX54(P^)7CC)7}$${"EICAR"}-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;

async function server<T>(fn: (c: ImapFlow) => Promise<T>, who = email): Promise<T> {
  const c = new ImapFlow({ host: host as string, port: imapPort, secure: true, servername, auth: { user: who, pass: password }, tls: { ca }, logger: false, disableAutoIdle: true });
  c.on("error", () => undefined);
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}
let serial = 0;
const rfc822 = (o: { from?: string; subject: string; body: string; id?: string; extra?: string; auth?: "pass" | "fail" }) => {
  const id = o.id ?? `<plat-${Date.now()}-${++serial}@example.org>`;
  const auth = o.auth === "fail" ? "Authentication-Results: mx.example.net; spf=fail; dkim=fail; dmarc=fail\r\n" : "";
  return { id, raw: Buffer.from(`${auth}From: ${o.from ?? "Dana Reyes <dana@acme-corp.example>"}\r\nTo: ${email}\r\nSubject: ${o.subject}\r\nMessage-ID: ${id}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\n${o.extra ?? "Content-Type: text/plain; charset=utf-8\r\n"}\r\n${o.body}`) };
};
async function deliver(o: Parameters<typeof rfc822>[0], folder = "INBOX") {
  const m = rfc822(o);
  const res = await server(c => c.append(folder, m.raw, [], new Date()));
  if (!res) throw new Error("APPEND refused");
  return { ...m, remoteId: `${folder}:${res.uidValidity}:${res.uid}`, uid: res.uid as number };
}
const inFolder = (folder: string) => server(async c => {
  await c.mailboxOpen(folder);
  const rows = await c.fetchAll("1:*", { uid: true, flags: true, envelope: true }, {}).catch(() => []);
  return rows.map(r => ({ uid: r.uid, flags: [...(r.flags ?? [])], subject: r.envelope?.subject }));
});

const PHISH = { from: `"Harbor Supply Billing" <billing@harb0r-supply.example>`, auth: "fail" as const, subject: "URGENT updated bank details", body: `Our bank account has changed. Wire the payment today to the new account or your service stops. Verify at http://harb0r-supply.example/login\r\n` };

describe.skipIf(!host)("platform over real Dovecot", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, account: string;
  const row = (remoteId: string) => p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT * FROM messages WHERE account_id=$1 AND provider_message_id=$2", [account, remoteId]));
  const sync = async () => { await syncAccount(p, ctx.tenantId, account); await drainJobs(p); };

  beforeAll(async () => {
    await server(async c => {
      for (const box of await c.list()) {
        if (!["INBOX", "Drafts", "Sent", "Junk", "Trash", "Archive", "All Mail"].includes(box.path)) { await c.mailboxDelete(box.path).catch(() => undefined); continue; }
        const lock = await c.getMailboxLock(box.path);
        try { await c.messageDelete("1:*"); } catch { /* empty */ } finally { lock.release(); }
      }
    });
    ({ p, drop } = await testPlatform({
      adapterFactory: (a, credential) => createAdapter(a.kind as "imap", { email: a.email, readOnly: a.read_only }, credential as AdapterCredential, { hostGuard: guard, ...(ca ? { ca } : {}) }),
      ...(env.CLAMD_TEST_HOST ? { scanner: new ClamdScanner(env.CLAMD_TEST_HOST, Number(env.CLAMD_TEST_PORT || 3310)) } : {}),
    }));
    ctx = await user(p, "platform-live@example.org");
    account = await connectAccount(p, ctx, {
      kind: "imap", email, displayName: "Platform Live",
      credential: { kind: "password", username: email, password, imap: { host: servername, port: imapPort, security: "tls" }, smtp: { host: servername, port: Number(env.SMTP_TEST_PORT), security: "tls" } },
    });
  });
  afterAll(async () => { await closeAnalysisPool(); await drop?.(); });

  it("connectAccount queues a sync, and the first drain over an empty mailbox reaches incremental", async () => {
    await drainJobs(p);
    const s = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT phase, last_success_at, last_error_code FROM sync_states WHERE account_id=$1", [account]));
    expect(s.phase).toBe("incremental");
    expect(s.last_error_code).toBeNull();
    expect(s.last_success_at).not.toBeNull();
  });

  let benign: Awaited<ReturnType<typeof deliver>>;
  it("a delivered message is classified, encrypted at rest, and reads back in Focus and the thread", async () => {
    benign = await deliver({ subject: "Contract review", body: "Can you review the attached contract and send me your comments by Friday? Thanks, Dana\r\n" });
    await sync();
    const m = await row(benign.remoteId);
    expect(m.state).toBe("classified");
    expect(m.risk_label).toBe("safe");
    expect(m.held).toBe(false);
    expect(m.envelope_enc).not.toBeNull();
    expect(Buffer.from(m.envelope_enc).toString("latin1")).not.toContain("Contract review");
    const inbox = await listThreads(p, ctx, { view: "inbox", limit: 20 });
    expect(inbox.items.map(i => i.messageId)).toContain(m.id);
    const thread = await getThread(p, ctx, m.thread_id);
    expect(thread.messages[0]?.subject ?? thread.subject).toBe("Contract review");
    expect(thread.messages[0]?.text).toContain("review the attached contract");
    const focus = await getFocus(p, ctx, {});
    expect(JSON.stringify(focus)).toContain(m.thread_id);
  });

  it("marking read in the app reaches the server, and the next sync doesn't undo it", async () => {
    const m = await row(benign.remoteId);
    await threadAction(p, ctx, m.thread_id, { action: "read" });
    await drainJobs(p);
    const [remote] = (await inFolder("INBOX")).filter(r => r.uid === benign.uid);
    expect(remote?.flags).toContain("\\Seen");
    await sync();
    expect((await row(benign.remoteId)).is_read).toBe(true);
  });

  it("a flag set by another client reaches the app", async () => {
    await server(async c => { await c.mailboxOpen("INBOX"); await c.messageFlagsAdd(String(benign.uid), ["\\Flagged"], { uid: true }); });
    await sync();
    expect((await row(benign.remoteId)).is_starred).toBe(true);
  });

  it("replaying sync creates no duplicates", async () => {
    const before = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT count(*)::int c FROM messages WHERE account_id=$1", [account]));
    await sync(); await sync();
    const after = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT count(*)::int c FROM messages WHERE account_id=$1", [account]));
    expect(after.c).toBe(before.c);
  });

  it("archiving in the app moves it on the server and keeps it one message, with its thread and state", async () => {
    const m = await row(benign.remoteId);
    await threadAction(p, ctx, m.thread_id, { action: "archive" });
    await drainJobs(p);
    expect((await inFolder("Archive")).map(r => r.subject)).toEqual(["Contract review"]);
    expect((await inFolder("INBOX")).map(r => r.subject)).not.toContain("Contract review");
    await sync(); await sync();
    const rows = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT id, thread_id, folder_role, tombstoned_at, is_read FROM messages WHERE account_id=$1 AND tombstoned_at IS NULL AND message_id_hash=$2", [account, m.message_id_hash]));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id: m.id, thread_id: m.thread_id, folder_role: "archive", is_read: true });
    const c = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT received_count FROM contacts WHERE account_id=$1 AND sender_hash=$2", [account, m.sender_hash]));
    expect(c.received_count).toBe(1);
  });

  it("a move by another client is followed: the same message, thread and counts, in its new folder", async () => {
    const m = await deliver({ subject: "Moved on my phone", body: "Filing this one myself.\r\n" });
    await sync();
    const before = await row(m.remoteId);
    const contact = async () => (await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT received_count FROM contacts WHERE account_id=$1 AND sender_hash=$2", [account, before.sender_hash]))).received_count;
    const count = await contact();
    await server(async c => { await c.mailboxOpen("INBOX"); await c.messageMove(String(m.uid), "Trash", { uid: true }); });
    await sync();
    const live = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT id, thread_id, folder_role FROM messages WHERE account_id=$1 AND message_id_hash=$2 AND tombstoned_at IS NULL", [account, before.message_id_hash]));
    expect(live).toEqual([{ id: before.id, thread_id: before.thread_id, folder_role: "trash" }]);
    expect(await contact()).toBe(count);
    expect((await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT count(*)::int c FROM message_contents WHERE message_id=$1", [before.id]))).c).toBe(1);
  });

  let phish: Awaited<ReturnType<typeof deliver>>, phishId: string;
  it("phishing is quarantined, moved to Junk on the server, and stays one held message", async () => {
    phish = await deliver(PHISH);
    await syncAccount(p, ctx.tenantId, account);
    const m = await row(phish.remoteId);
    phishId = m.id;
    await drainJobs(p);
    expect(m.held).toBe(true);
    expect(["suspicious", "high_risk", "malicious"]).toContain(m.risk_label);
    expect((await inFolder("Junk")).map(r => r.subject)).toEqual([PHISH.subject]);
    expect((await inFolder("INBOX")).map(r => r.subject)).not.toContain(PHISH.subject);
    await sync();
    const held = await listThreads(p, ctx, { view: "quarantine", limit: 20 });
    expect(held.items.map(i => i.messageId)).toEqual([phishId]);
    const q = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, original_folder_role, provider_moved FROM quarantine_items WHERE message_id=$1", [phishId]));
    expect(q).toEqual({ state: "held", original_folder_role: "inbox", provider_moved: true });
  });

  it("releasing it puts it back in the server's INBOX, and it isn't quarantined again", async () => {
    const r = await decideQuarantine(p, ctx, phishId, "release");
    expect(r.restoredTo).toBe("inbox");
    await drainJobs(p);
    expect((await inFolder("INBOX")).map(r => r.subject)).toContain(PHISH.subject);
    expect((await inFolder("Junk")).map(r => r.subject)).toEqual([]);
    await sync(); await sync();
    expect((await inFolder("INBOX")).map(r => r.subject)).toContain(PHISH.subject);
    const live = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT id, held, folder_role FROM messages WHERE account_id=$1 AND tombstoned_at IS NULL AND risk_label IN ('suspicious','high_risk','malicious')", [account]));
    expect(live).toEqual([{ id: phishId, held: false, folder_role: "inbox" }]);
  });

  it("an expunge on the server tombstones the message and purges its content", async () => {
    const m = await deliver({ subject: "Short lived", body: "Ordinary note.\r\n" });
    await sync();
    const before = await row(m.remoteId);
    await server(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete(String(m.uid), { uid: true }); });
    await sync();
    const after = await row(m.remoteId);
    expect(after.tombstoned_at).not.toBeNull();
    expect(after.envelope_enc).toBeNull();
    const content = await p.db.withWorker(ctx.tenantId, t => t.one("SELECT 1 FROM message_contents WHERE message_id=$1", [before.id]));
    expect(content).toBeNull();
  });

  it("UIDVALIDITY changing on a folder leaves no stale copies: one live row per message, and the new one works", async () => {
    await server(c => c.mailboxCreate("Volatile"));
    const old = await deliver({ subject: "Volatile note", body: "Old generation.\r\n", id: "<volatile@example.org>" }, "Volatile");
    await sync();
    expect((await row(old.remoteId)).state).toBe("classified");
    await server(async c => { await c.mailboxDelete("Volatile"); await c.mailboxCreate("Volatile"); });
    const again = await deliver({ subject: "Volatile note", body: "Old generation.\r\n", id: "<volatile@example.org>" }, "Volatile");
    await sync();
    expect((await row(old.remoteId)).tombstoned_at).not.toBeNull();
    const fresh = await row(again.remoteId);
    expect(fresh.state).toBe("classified");
    expect(fresh.tombstoned_at).toBeNull();
    const live = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT 1 FROM messages WHERE account_id=$1 AND provider_message_id LIKE 'Volatile:%' AND tombstoned_at IS NULL", [account]));
    expect(live.length).toBe(1);
    // Other folders kept working through the reconcile: nothing was duplicated there.
    const archive = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT 1 FROM messages WHERE account_id=$1 AND provider_message_id LIKE 'Archive:%' AND tombstoned_at IS NULL", [account]));
    expect(archive.length).toBe(1);
  });

  it("an unparseable-looking message can't stall the mailbox", async () => {
    const bad = await server(c => c.append("INBOX", Buffer.from("this is not really an email\r\n"), [], new Date()));
    const good = await deliver({ subject: "After the odd one", body: "Still flowing.\r\n" });
    await sync();
    expect((await row(`INBOX:${bad && bad.uidValidity}:${bad && bad.uid}`))).not.toBeNull();
    expect((await row(good.remoteId)).state).toBe("classified");
  });

  it("sends through real Postfix: the recipient gets it, and the draft completes", async () => {
    const { id } = await saveDraft(p, ctx, { accountId: account, to: ["smtprcpt@example.net"], cc: [], bcc: [], subject: `Live send ${Date.now()}`, text: "Sent by the platform.\n", aiGenerated: false });
    await approveSend(p, ctx, id, { expectedFrom: email, idempotencyKey: `live-${id}`, acknowledgedRisk: false });
    await drainJobs(p);
    const a = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, error_code, rfc_message_id FROM send_approvals WHERE draft_id=$1", [id]));
    expect(a).toMatchObject({ state: "completed", error_code: null });
    let found = false;
    for (let i = 0; i < 50 && !found; i++) {
      found = await server(async c => { await c.mailboxOpen("INBOX"); const u = await c.search({ header: { "message-id": a.rfc_message_id } }, { uid: true }); return !!u && u.length === 1; }, "smtprcpt@example.net");
      if (!found) await new Promise(r => setTimeout(r, 200));
    }
    expect(found).toBe(true);
  });

  it("a partly refused send completes but records the refusal", async () => {
    const { id } = await saveDraft(p, ctx, { accountId: account, to: ["smtprcpt@example.net", "nobody@example.net"], cc: [], bcc: [], subject: "Partly refused", text: "x\n", aiGenerated: false });
    await approveSend(p, ctx, id, { expectedFrom: email, idempotencyKey: `live-${id}`, acknowledgedRisk: false });
    await drainJobs(p);
    const a = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, error_code FROM send_approvals WHERE draft_id=$1", [id]));
    expect(a).toEqual({ state: "completed", error_code: "recipients_refused" });
  });

  it.skipIf(!env.CLAMD_TEST_HOST)("real clamd flags EICAR through the analysis thread, per attachment, and holds the mail", async () => {
    const boundary = "b0undary";
    const body = [`--${boundary}`, "Content-Type: text/plain", "", "See attached.", `--${boundary}`, "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="notes.bin"', "", "Harmless contents.", `--${boundary}`, "Content-Type: application/octet-stream", 'Content-Disposition: attachment; filename="report.bin"', "", EICAR, `--${boundary}--`, ""].join("\r\n");
    const m = await deliver({ subject: "Report attached", body, extra: `Content-Type: multipart/mixed; boundary="${boundary}"\r\n` });
    await syncAccount(p, ctx.tenantId, account);
    const r = await row(m.remoteId);
    await drainJobs(p);
    expect(r.held).toBe(true);
    expect(r.risk_label).toBe("malicious");
    const analysis = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT reason_codes, provenance FROM security_analyses WHERE message_id=$1", [r.id]));
    expect(analysis.reason_codes).toContain("ATT_MALWARE_SIGNATURE");
    expect(analysis.provenance).toEqual(expect.arrayContaining(["clamd:clean", "clamd:infected"]));
    const atts = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT scan_status FROM attachments WHERE message_id=$1", [r.id]));
    expect(atts.map(a => a.scan_status).sort()).toEqual(["clean", "infected"]);
  });
});
