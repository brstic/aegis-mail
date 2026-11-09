import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITIES, UnsupportedOperationError, type MailAdapter, type MailChange } from "@aegis/domain";
import { mime } from "@aegis/test-fixtures";
import { closeAnalysisPool, connectAccount, type Ctx, drainJobs, type Platform, publicAccounts, syncAccount } from "../index";
import { testPlatform, user } from "./harness";

/** A provider that hands over mail a page at a time, can fail partway, and has one message it will never give up. */
class PagedProvider {
  kind = "imap" as const; capabilities = CAPABILITIES.imap;
  pages: Array<() => { changes: MailChange[]; cursor: string; hasMore: boolean }> = [];
  fetchError: Error = new UnsupportedOperationError("no second fetch");
  async fullSync() { return (this.pages.shift() ?? (() => ({ changes: [], cursor: "{}", hasMore: false })))(); }
  async incrementalSync() { return this.fullSync(); }
  async fetchRaw(): Promise<Uint8Array> { throw this.fetchError; }
  async applyChange() { return undefined; }
  async send() { return { acceptedAt: new Date().toISOString() }; }
  async findSentByMessageId() { return null; }
  async revoke() { return false; }
  async testConnection() { return { ok: true }; }
  async listFolders() { return []; }
}
let n = 0;
const up = (withRaw = true): MailChange => {
  const id = `m${++n}`;
  return { type: "upsert", remoteId: id, internalDate: new Date().toISOString(), state: { folderRole: "inbox", labels: [], isRead: false, isStarred: false }, ...(withRaw ? { raw: Buffer.from(mime({ from: `"P" <p${n}@oak.example>`, subject: `Note ${n}`, text: "Hello." })) } : {}) };
};

describe("first sync: progress, and one bad message", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string, fake: PagedProvider;
  const state = () => p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT messages_synced, phase, last_error_code, consecutive_failures FROM sync_states WHERE account_id=$1", [acct]));
  beforeAll(async () => {
    fake = new PagedProvider();
    ({ p, drop } = await testPlatform({ adapterFactory: () => fake as unknown as MailAdapter }));
    ctx = await user(p, "progress@example.org");
    acct = await connectAccount(p, ctx, { kind: "imap", email: "progress@example.org", displayName: "P", credential: { kind: "password" } });
    await drainJobs(p);
  });
  afterAll(async () => { await closeAnalysisPool(); await drop(); });

  it("the count moves page by page, and a run that fails keeps what it did", async () => {
    fake.pages.push(() => ({ changes: [up(), up(), { type: "state", remoteId: "m1", state: { isRead: true } }], cursor: "{\"a\":1}", hasMore: true }));
    fake.pages.push(() => { throw new Error("connection dropped"); });
    await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toThrow("connection dropped");
    // Two messages arrived. The read-flag change isn't a message.
    expect(await state()).toMatchObject({ messages_synced: 2, consecutive_failures: 1 });
    expect((await publicAccounts(p, ctx))[0]!.sync.messagesSynced).toBe(2);
  });

  it("a message the provider can't hand over is recorded as unread-by-us, and the mailbox moves on", async () => {
    fake.pages.push(() => ({ changes: [up(), up(false), up()], cursor: "{\"a\":2}", hasMore: false }));
    await syncAccount(p, ctx.tenantId, acct);
    expect(await state()).toMatchObject({ messages_synced: 5, last_error_code: null, consecutive_failures: 0 });
    const rows = await p.db.withWorker(ctx.tenantId, t => t.query<any>("SELECT state, failure_code, risk_label FROM messages WHERE account_id=$1 ORDER BY provider_message_id", [acct]));
    expect(rows.filter(r => r.state === "classified")).toHaveLength(4);
    expect(rows.filter(r => r.state === "failed")).toEqual([{ state: "failed", failure_code: "unfetchable", risk_label: "unknown_unscannable" }]);
  });

  it("a connection problem while fetching is still retried, not written off", async () => {
    fake.fetchError = Object.assign(new Error("timed out"), { problem: "timeout" });
    fake.pages.push(() => ({ changes: [up(false)], cursor: "{\"a\":3}", hasMore: false }));
    await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toThrow("timed out");
    expect((await state()).last_error_code).toBe("timeout");
  });

  it("a password the server keeps refusing asks for a reconnect instead of retrying for ever", async () => {
    const refuse = () => { throw Object.assign(new Error("login refused"), { problem: "auth_failed" }); };
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE sync_states SET consecutive_failures=0 WHERE account_id=$1", [acct]));
    for (let i = 0; i < 2; i++) { fake.pages.push(refuse); await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toThrow("login refused"); }
    expect((await publicAccounts(p, ctx))[0]!.status).toBe("active");
    fake.pages.push(refuse);
    await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toMatchObject({ code: "auth_failed" });
    expect((await publicAccounts(p, ctx))[0]!.status).toBe("reconnect_required");
  });
});
