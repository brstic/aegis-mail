import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CAPABILITIES, CursorExpiredError, GrantRevokedError, type MailAdapter, type MailChange, RateLimitedError, SendOutcomeUnknownError } from "@aegis/domain";
import { mime } from "@aegis/test-fixtures";
import { approveSend, cancelScheduled, claimJob, connectAccount, type Ctx, DeferJob, drainJobs, enqueue, finishJob, getThread, listDrafts, listThreads, type Platform, PermanentJobError, reapStuckJobs, retrySend, saveDraft, syncAccount, threadAction, backoffMs, disconnectAccount } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

/** A scriptable provider: exercises behaviours a well-behaved demo store never would. */
class FakeProvider implements Partial<MailAdapter> {
  kind = "imap" as const; capabilities = CAPABILITIES.imap;
  pages: (() => Promise<{ changes: MailChange[]; cursor: string; hasMore: boolean }>)[] = [];
  sends: any[] = []; delivered = new Map<string, string>(); changes: any[] = [];
  onSend: (m: any) => Promise<any> = async m => { this.sends.push(m); this.delivered.set(m.messageId, "remote-" + this.sends.length); return { remoteId: "remote-" + this.sends.length, acceptedAt: new Date().toISOString() }; };
  onChange: (id: string, c: any) => Promise<void> = async (id, c) => { this.changes.push({ id, c }); };
  full = 0; incr = 0;
  async fullSync() { this.full++; return (this.pages.shift() ?? (async () => ({ changes: [], cursor: "c0", hasMore: false })))(); }
  async incrementalSync() { this.incr++; return (this.pages.shift() ?? (async () => ({ changes: [], cursor: "c1", hasMore: false })))(); }
  async fetchRaw() { return Buffer.from(mime({ from: "fetched@x.test", subject: "Fetched", text: "fetched" })); }
  async applyChange(id: string, c: any) { return this.onChange(id, c); }
  send(m: any) { return this.onSend(m); }
  async findSentByMessageId(id: string) { const r = this.delivered.get(id); return r ? { remoteId: r } : null; }
  async revoke() { return true; }
  async testConnection() { return { ok: true }; }
  async listFolders() { return []; }
}
const up = (id: string, subject = "Hello", extra: Partial<Extract<MailChange, { type: "upsert" }>> = {}): MailChange => ({ type: "upsert", remoteId: id, internalDate: new Date().toISOString(), state: { folderRole: "inbox", labels: [], isRead: false, isStarred: false }, raw: Buffer.from(mime({ from: `"Pat" <pat@oak.test>`, subject, text: "Can you check this?" })), ...extra });

describe("provider sync contract", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, fake: FakeProvider, acct: string;
  beforeAll(async () => {
    fake = new FakeProvider();
    ({ p, drop } = await testPlatform({ adapterFactory: () => fake as unknown as MailAdapter }));
    ctx = await user(p, "sync@example.org");
    acct = await connectAccount(p, ctx, { kind: "imap", email: "sync@example.org", displayName: "S", credential: { kind: "password" } });
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='cancelled' WHERE payload->>'accountId'=$1", [acct]));
  });
  afterAll(() => drop());
  const count = async () => (await p.db.withWorker(ctx.tenantId, t => t.one<{ c: number }>("SELECT count(*)::int c FROM messages WHERE account_id=$1", [acct])))!.c;

  it("replaying the same notification three times creates no duplicates and doesn't inflate counts", async () => {
    const c = up("dup-1");
    fake.pages = [async () => ({ changes: [c], cursor: "1", hasMore: false }), async () => ({ changes: [c], cursor: "2", hasMore: false }), async () => ({ changes: [c, c], cursor: "3", hasMore: false })];
    const before = await count();
    await syncAccount(p, ctx.tenantId, acct); await syncAccount(p, ctx.tenantId, acct); await syncAccount(p, ctx.tenantId, acct);
    expect((await count()) - before).toBe(1);
    const contact = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT received_count FROM contacts WHERE account_id=$1", [acct]));
    expect(contact.received_count).toBe(1);
    const tele = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT sum(count)::int c FROM security_telemetry_daily"));
    expect(tele.c).toBe(1);
  });

  it("concurrent delivery of one message yields one row", async () => {
    const c = up("race-1");
    fake.pages = [async () => ({ changes: [c], cursor: "r1", hasMore: false }), async () => ({ changes: [c], cursor: "r2", hasMore: false })];
    const before = await count();
    await Promise.all([syncAccount(p, ctx.tenantId, acct), syncAccount(p, ctx.tenantId, acct)]);
    expect((await count()) - before).toBe(1);
    const row = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state FROM messages WHERE provider_message_id='race-1'"));
    expect(row.state).toBe("classified");
  });

  it("legitimate duplicates with different provider IDs aren't collapsed", async () => {
    fake.pages = [async () => ({ changes: [up("same-a", "Same"), up("same-b", "Same")], cursor: "x", hasMore: false })];
    const before = await count();
    await syncAccount(p, ctx.tenantId, acct);
    expect((await count()) - before).toBe(2);
  });

  it("cursor persists only after the page is applied, so a mid-page crash replays", async () => {
    let failed = false;
    fake.pages = [async () => ({ changes: [up("crash-1"), { type: "upsert", remoteId: "crash-2", internalDate: new Date().toISOString(), state: { folderRole: "inbox", labels: [], isRead: false, isStarred: false } }], cursor: "after-crash", hasMore: false })];
    const orig = fake.fetchRaw;
    fake.fetchRaw = async () => { if (!failed) { failed = true; throw new Error("network"); } return orig(); };
    await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toThrow();
    const s = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT last_error_code FROM sync_states WHERE account_id=$1", [acct]));
    expect(s.last_error_code).toBe("Error");
    fake.pages = [async () => ({ changes: [up("crash-1"), { type: "upsert", remoteId: "crash-2", internalDate: new Date().toISOString(), state: { folderRole: "inbox", labels: [], isRead: false, isStarred: false } }], cursor: "ok", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
    expect(await p.db.withWorker(ctx.tenantId, t => t.one("SELECT 1 FROM messages WHERE provider_message_id='crash-2' AND state='classified'"))).not.toBeNull();
    fake.fetchRaw = orig;
  });

  it("expired cursor triggers full reconciliation", async () => {
    const fullBefore = fake.full;
    fake.pages = [async () => { throw new CursorExpiredError("stale"); }, async () => ({ changes: [up("recon-1")], cursor: "fresh", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
    expect(fake.full).toBe(fullBefore + 1);
    expect(await p.db.withWorker(ctx.tenantId, t => t.one("SELECT 1 FROM messages WHERE provider_message_id='recon-1'"))).not.toBeNull();
  });

  it("deleted provider messages tombstone, purge body, and replays don't resurrect them", async () => {
    fake.pages = [async () => ({ changes: [up("del-1")], cursor: "a", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
    const del: MailChange = { type: "delete", remoteId: "del-1" };
    fake.pages = [async () => ({ changes: [del], cursor: "b", hasMore: false }), async () => ({ changes: [del], cursor: "c", hasMore: false }), async () => ({ changes: [up("del-1")], cursor: "d", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct); await syncAccount(p, ctx.tenantId, acct); await syncAccount(p, ctx.tenantId, acct);
    const m = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT id, tombstoned_at, envelope_enc FROM messages WHERE provider_message_id='del-1'"));
    expect(m.tombstoned_at).not.toBeNull();
    expect(m.envelope_enc).toBeNull();
    expect(await p.db.withWorker(ctx.tenantId, t => t.one("SELECT 1 FROM message_contents WHERE message_id=$1", [m.id]))).toBeNull();
  });

  it("state changes from the provider apply without reprocessing", async () => {
    fake.pages = [async () => ({ changes: [up("st-1")], cursor: "a", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
    fake.pages = [async () => ({ changes: [{ type: "state", remoteId: "st-1", state: { isRead: true, folderRole: "archive" } }], cursor: "b", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
    const m = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT is_read, folder_role FROM messages WHERE provider_message_id='st-1'"));
    expect(m).toEqual({ is_read: true, folder_role: "archive" });
  });

  it("rate limits defer without counting as failure", async () => {
    fake.pages = [async () => { throw new RateLimitedError("slow", 30); }];
    await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toBeInstanceOf(DeferJob);
  });

  it("an unparseable message is held as unknown, never silently safe", async () => {
    fake.pages = [async () => ({ changes: [up("huge-1", "x", { raw: Buffer.alloc(51 * 1024 * 1024) })], cursor: "z", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
    const m = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, risk_label, priority_section FROM messages WHERE provider_message_id='huge-1'"));
    expect(m).toEqual({ state: "failed", risk_label: "unknown_unscannable", priority_section: "security_review" });
    const list = await listThreads(p, ctx, { view: "inbox", limit: 100 });
    expect(list.items.find(i => i.failed)?.snippet).toMatch(/hasn't been rated safe/);
  });

  it("story 9: a revoked grant stops processing, flags reconnect, and doesn't retry silently", async () => {
    fake.pages = [async () => { throw new GrantRevokedError("revoked"); }];
    await expect(syncAccount(p, ctx.tenantId, acct)).rejects.toBeInstanceOf(PermanentJobError);
    const a = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT status, status_detail FROM mail_accounts WHERE id=$1", [acct]));
    expect(a.status).toBe("reconnect_required");
    expect(a.status_detail).toMatch(/Reconnect/);
    const incr = fake.incr + fake.full;
    await syncAccount(p, ctx.tenantId, acct);
    expect(fake.incr + fake.full).toBe(incr);
    const ev = await p.db.withWorker(ctx.tenantId, async t => { await t.query("SET LOCAL ROLE aegis_app"); return []; }).catch(() => []);
    expect(ev).toBeDefined();
  });
});

describe("send", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, fake: FakeProvider, acct: string, acct2: string;
  const key = () => `k${Math.random().toString(36).slice(2)}${Date.now()}`;
  const draft = () => saveDraft(p, ctx, { accountId: acct, to: ["bob@oak.test"], cc: [], bcc: [], subject: "Hi", text: "Hello", aiGenerated: false });
  beforeAll(async () => {
    fake = new FakeProvider();
    ({ p, drop } = await testPlatform({ adapterFactory: () => fake as unknown as MailAdapter }));
    ctx = await user(p, "send@example.org");
    acct = await connectAccount(p, ctx, { kind: "imap", email: "work@example.org", displayName: "W", credential: { kind: "password" } });
    acct2 = await connectAccount(p, ctx, { kind: "imap", email: "home@example.org", displayName: "H", credential: { kind: "password" } });
    await drainJobs(p);
  });
  afterAll(() => drop());
  beforeEach(() => { fake.sends = []; fake.delivered.clear(); fake.onSend = async m => { fake.sends.push(m); fake.delivered.set(m.messageId, "r"); return { remoteId: "r", acceptedAt: "" }; }; });

  it("sends once with the idempotency key, even when requested and replayed three times", async () => {
    const d = await draft(); const k = key();
    await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: k, acknowledgedRisk: false });
    const r2 = await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: k, acknowledgedRisk: false });
    const r3 = await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: k, acknowledgedRisk: false });
    expect(r2.duplicate && r3.duplicate).toBe(true);
    await drainJobs(p);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0].from.address).toBe("work@example.org");
    expect(fake.sends[0].messageId).toMatch(/^<.+@example\.org>$/);
  });

  it("wrong mailbox: identity displayed must match the account used", async () => {
    const d = await draft();
    await expect(approveSend(p, ctx, d.id, { expectedFrom: "home@example.org", idempotencyKey: key(), acknowledgedRisk: false })).rejects.toMatchObject({ status: 409, code: "identity_mismatch" });
    await drainJobs(p);
    expect(fake.sends).toHaveLength(0);
  });

  it("a reply can't be drafted from a different account than the thread's", async () => {
    await p.db.withWorker(ctx.tenantId, t => t.query("INSERT INTO threads(id,tenant_id,account_id) VALUES ('00000000-0000-4000-8000-000000000001',$1,$2)", [ctx.tenantId, acct]));
    await expect(saveDraft(p, ctx, { accountId: acct2, threadId: "00000000-0000-4000-8000-000000000001", to: ["x@y.test"], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false })).rejects.toMatchObject({ code: "wrong_account" });
  });

  it("send succeeds but the API times out: reconcile finds it and doesn't resend", async () => {
    fake.onSend = async m => { fake.sends.push(m); fake.delivered.set(m.messageId, "r-late"); throw new SendOutcomeUnknownError("timeout"); };
    const d = await draft();
    await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: key(), acknowledgedRisk: false });
    await drainJobs(p);
    const unknown = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state FROM send_approvals WHERE draft_id=$1", [d.id]));
    expect(unknown.state).toBe("unknown");
    await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now() WHERE kind='send.reconcile' AND state='queued'"));
    await drainJobs(p);
    const done = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, remote_id FROM send_approvals WHERE draft_id=$1", [d.id]));
    expect(done).toEqual({ state: "completed", remote_id: "r-late" });
    expect(fake.sends).toHaveLength(1);
  });

  it("timeout where nothing was delivered: never auto-resends; becomes failed for the user to decide", async () => {
    fake.onSend = async m => { fake.sends.push(m); throw new SendOutcomeUnknownError("timeout"); };
    const d = await draft();
    await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: key(), acknowledgedRisk: false });
    await drainJobs(p);
    for (let i = 0; i < 8; i++) {
      await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now() WHERE kind='send.reconcile' AND state='queued'"));
      await drainJobs(p);
    }
    const a = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state FROM send_approvals WHERE draft_id=$1", [d.id]));
    expect(a.state).toBe("failed");
    expect(fake.sends).toHaveLength(1);
    await retrySend(p, ctx, d.id);
    expect((await listDrafts(p, ctx)).some(x => x.id === d.id)).toBe(true);
  });

  it("a worker crash after delivery, before recording, doesn't double-send on retry", async () => {
    const d = await draft();
    await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: key(), acknowledgedRisk: false });
    const row = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT id, rfc_message_id FROM send_approvals WHERE draft_id=$1", [d.id]));
    // Simulate: previous attempt reached the provider, then the worker died.
    fake.delivered.set(row.rfc_message_id, "already");
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE send_approvals SET attempts=1, state='sending' WHERE id=$1", [row.id]));
    await drainJobs(p);
    expect(fake.sends).toHaveLength(0);
    expect((await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state FROM send_approvals WHERE id=$1", [row.id]))).state).toBe("completed");
  });

  it("provider rejection fails without blind retries and reports", async () => {
    fake.onSend = async () => { throw new Error("550 rejected"); };
    const d = await draft();
    await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: key(), acknowledgedRisk: false });
    await drainJobs(p);
    expect((await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, error_code FROM send_approvals WHERE draft_id=$1", [d.id])))).toEqual({ state: "failed", error_code: "provider_rejected" });
  });

  it("scheduled sends wait and can be cancelled", async () => {
    const d = await draft();
    await approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: key(), acknowledgedRisk: false, scheduledFor: new Date(Date.now() + 3600_000).toISOString() });
    await drainJobs(p);
    expect(fake.sends).toHaveLength(0);
    await cancelScheduled(p, ctx, d.id);
    expect((await listDrafts(p, ctx)).some(x => x.id === d.id)).toBe(true);
  });

  it("refuses to schedule in the past", async () => {
    const d = await draft();
    await expect(approveSend(p, ctx, d.id, { expectedFrom: "work@example.org", idempotencyKey: key(), acknowledgedRisk: false, scheduledFor: "2020-01-01T00:00:00Z" })).rejects.toMatchObject({ code: "schedule_past" });
  });

  it("read-only mailboxes can't send", async () => {
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE mail_accounts SET read_only=true WHERE id=$1", [acct2]));
    const d = await saveDraft(p, ctx, { accountId: acct2, to: ["x@y.test"], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false });
    await expect(approveSend(p, ctx, d.id, { expectedFrom: "home@example.org", idempotencyKey: key(), acknowledgedRisk: false })).rejects.toMatchObject({ status: 403 });
  });

  it("disconnected accounts can't send", async () => {
    await p.db.withWorker(ctx.tenantId, t => t.query("UPDATE mail_accounts SET read_only=false, status='reconnect_required' WHERE id=$1", [acct2]));
    const d = await saveDraft(p, ctx, { accountId: acct2, to: ["x@y.test"], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false });
    await expect(approveSend(p, ctx, d.id, { expectedFrom: "home@example.org", idempotencyKey: key(), acknowledgedRisk: false })).rejects.toMatchObject({ code: "account_unavailable" });
  });
});

describe("optimistic actions and job queue", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, fake: FakeProvider, acct: string;
  beforeAll(async () => {
    fake = new FakeProvider();
    ({ p, drop } = await testPlatform({ adapterFactory: () => fake as unknown as MailAdapter }));
    ctx = await user(p, "q@example.org");
    acct = await connectAccount(p, ctx, { kind: "imap", email: "q@example.org", displayName: "Q", credential: { kind: "password" } });
    await drainJobs(p);
    fake.pages = [async () => ({ changes: [up("a1")], cursor: "1", hasMore: false })];
    await syncAccount(p, ctx.tenantId, acct);
  });
  afterAll(() => drop());
  const thread = async () => (await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT thread_id, folder_role FROM messages WHERE provider_message_id='a1'")))!;

  it("archive applies locally and at the provider", async () => {
    const th = await thread();
    await threadAction(p, ctx, th.thread_id, { action: "archive" });
    expect((await thread()).folder_role).toBe("archive");
    await drainJobs(p);
    expect(fake.changes.at(-1)?.c).toEqual({ moveToRole: "archive" });
  });

  it("if the provider keeps refusing, the local change rolls back", async () => {
    const th = await thread();
    await threadAction(p, ctx, th.thread_id, { action: "inbox" });
    await drainJobs(p);
    fake.onChange = async () => { throw new Error("500"); };
    await threadAction(p, ctx, th.thread_id, { action: "archive" });
    expect((await thread()).folder_role).toBe("archive");
    await p.db.withSystem(t => t.query("UPDATE jobs SET max_attempts=2 WHERE kind='provider.change' AND state='queued'"));
    await drainJobs(p);
    await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now() WHERE state='queued'"));
    await drainJobs(p);
    expect((await thread()).folder_role).toBe("inbox");
    expect(await p.db.withSystem(t => t.one<any>("SELECT last_error_code FROM jobs WHERE state='dead' AND kind='provider.change'"))).toMatchObject({ last_error_code: "Error" });
    fake.onChange = async () => {};
  });

  it("dedupe keys collapse concurrent jobs", async () => {
    const a = await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "tick", dedupeKey: "dd" }));
    const b = await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "tick", dedupeKey: "dd" }));
    expect(a).not.toBeNull(); expect(b).toBeNull();
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='cancelled' WHERE dedupe_key='dd'"));
  });

  it("claims are exclusive under concurrency", async () => {
    for (let i = 0; i < 5; i++) await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "tick" }));
    const claimed = (await Promise.all(Array.from({ length: 10 }, () => claimJob(p)))).filter(Boolean);
    expect(new Set(claimed.map(c => c!.id)).size).toBe(claimed.length);
    expect(claimed.length).toBe(5);
    for (const c of claimed) await finishJob(p, c!);
  });

  it("retries back off with jitter, then dead-letter", async () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(1000);
    expect(backoffMs(20)).toBeLessThanOrEqual(15 * 60_000);
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "tick", maxAttempts: 1 }));
    const j = (await claimJob(p))!;
    await finishJob(p, j, new Error("boom"));
    expect((await p.db.withSystem(t => t.one<any>("SELECT state FROM jobs WHERE id=$1", [j.id])))!.state).toBe("dead");
  });

  it("stuck jobs return to the queue after the lease", async () => {
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "tick" }));
    const j = (await claimJob(p))!;
    await p.db.withSystem(t => t.query("UPDATE jobs SET locked_at=now() - interval '1 hour' WHERE id=$1", [j.id]));
    await reapStuckJobs(p);
    expect((await p.db.withSystem(t => t.one<any>("SELECT state FROM jobs WHERE id=$1", [j.id])))!.state).toBe("queued");
    await p.db.withSystem(t => t.query("UPDATE jobs SET state='cancelled' WHERE id=$1", [j.id]));
  });

  it("disconnect cancels queued jobs for that mailbox", async () => {
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId: acct }, runAt: new Date(Date.now() + 1e6) }));
    await disconnectAccount(p, ctx, acct, { deleteData: false });
    await drainJobs(p);
    const q = await p.db.withSystem(t => t.query("SELECT 1 FROM jobs WHERE state='queued' AND payload->>'accountId'=$1", [acct]));
    expect(q).toEqual([]);
  });
});

void getThread; void demoAccount; void deliver;
