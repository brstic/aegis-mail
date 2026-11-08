import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, Db, ensureLogin } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { approveSend, connectAccount, type Ctx, createPlatform, deleteAccount, deletionLogTick, disconnectAccount, drainJobs, FileDeletionSink, reapplyDeletions, recordErasure, sweepExpired, getFocus, getThread, listThreads, makeLogger, type Platform, recordFeedback, resolveSession, saveDraft, signIn, signUp, suggestDraft, updatePrefs, threadAction, createAutomation, decideQuarantine } from "../index";
import { mime } from "@aegis/test-fixtures";

/**
 * Runs the app as production does: web and worker on separate non-superuser logins sharing only a KMS.
 * Most other suites use an owner connection for convenience. This one proves the boundary holds, and that the
 * product still functions inside it.
 */
describe("process boundary with real login roles", () => {
  let adminDrop: () => Promise<void>, web: Platform, worker: Platform, webDb: Db, workerDb: Db, adminDb: Db, ctx: Ctx, acct: string, adminUrl: string;

  beforeAll(async () => {
    const t = await createTestDb("bound"); adminDb = t.db; adminDrop = t.drop; adminUrl = t.url;
    await ensureLogin(t.url, "aegis_web_login", "aegis_web_conn");
    await ensureLogin(t.url, "aegis_worker_login", "aegis_worker_conn");
    const as = (login: string) => { const u = new URL(t.url); u.username = login; return u.toString(); };
    webDb = new Db(as("aegis_web_login"), 5, { keyRole: "aegis_app" });
    workerDb = new Db(as("aegis_worker_login"), 5, { keyRole: "aegis_worker" });
    const kms = new LocalDevKms(randomBytes(32));
    const shared = { kms, config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {} };
    web = createPlatform({ db: webDb, ...shared });
    worker = createPlatform({ db: workerDb, ...shared });
    const s = await signUp(web, { email: "b@fernhill.example", password: "correct-horse-battery", name: "Bea", workspaceKind: "organization" });
    ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
    acct = await connectAccount(web, ctx, { kind: "demo", email: "b@fernhill.example", displayName: "B", credential: { kind: "demo" } });
    await drainJobs(worker);
  });
  afterAll(async () => { await webDb.close(); await workerDb.close(); await adminDrop(); });

  const inject = async (input: Parameters<typeof mime>[0]) => {
    await webDb.withUser(ctx, t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,$3,now(),$4)", [acct, ctx.tenantId, `b-${Math.random()}`, Buffer.from(mime(input))]));
    await webDb.withSystem(t => t.query("INSERT INTO jobs(tenant_id,kind,payload) VALUES ($1,'sync.account',$2)", [ctx.tenantId, JSON.stringify({ accountId: acct })]));
    await drainJobs(worker);
  };

  it("the full product works: ingest in worker, read and act in web", async () => {
    await inject({ from: `"Priya" <priya@oak.test>`, subject: "Budget", text: "Can you confirm by November 11?" });
    await inject({ from: `"PayPal" <x@paypa1.test>`, auth: "fail", subject: "Verify", text: "Verify your password https://paypa1.test/login" });
    const s = await signIn(web, { email: "b@fernhill.example", password: "correct-horse-battery" });
    expect((await resolveSession(web, s.token))?.email).toBe("b@fernhill.example");
    const f = await getFocus(web, ctx);
    const safe = f.sections.find(x => x.key === "needs_attention")!.items[0]!;
    // Blocked mail isn't in Focus. It's in the quarantine view.
    expect(f.sections.flatMap(x => x.items).some(i => i.subject === "Verify")).toBe(false);
    const risky = (await listThreads(web, ctx, { view: "quarantine", limit: 10 })).items[0]!;
    expect(safe.subject).toBe("Budget");
    expect(risky.subject).toBe("Verify");
    expect((await getThread(web, ctx, safe.id)).messages[0]!.text).toContain("November 11");
    await threadAction(web, ctx, safe.id, { action: "star" });
    await recordFeedback(web, ctx, safe.messageId, "important");
    await updatePrefs(web, ctx, { density: "compact" });
    await createAutomation(web, ctx, { name: "x", enabled: true, definition: { trigger: "message.classified", match: "all", conditions: [{ type: "is_bulk", value: true }], actions: [{ type: "star" }] } });
    const d = await suggestDraft(web, ctx, safe.id, { kind: "acknowledge", ownerName: "Bea" });
    await approveSend(web, ctx, d.draftId, { expectedFrom: "b@fernhill.example", idempotencyKey: "boundary-key-0001", acknowledgedRisk: false });
    await drainJobs(worker);
    expect((await listThreads(web, ctx, { view: "sent", limit: 5 })).items.length).toBeGreaterThan(0);
    await decideQuarantine(web, ctx, risky.messageId, "release").catch(() => {});
    await saveDraft(web, ctx, { accountId: acct, to: ["x@y.test"], cc: [], bcc: [], subject: "s", text: "t", aiGenerated: false });
  });

  it("web can't become the worker context", async () => {
    await expect(webDb.withUser(ctx, async t => { await t.query("SET LOCAL ROLE aegis_worker"); return t.query("SELECT * FROM messages"); })).rejects.toThrow(/permission denied to set role/);
    await expect(webDb.withWorker(ctx.tenantId, t => t.query("SELECT 1"))).rejects.toThrow(/permission denied to set role/);
  });
  it("worker can't become the web context", async () => {
    await expect(workerDb.withUser(ctx, t => t.query("SELECT 1"))).rejects.toThrow(/permission denied to set role/);
  });
  it("neither login can read mail tables directly, outside a context", async () => {
    for (const db of [webDb, workerDb]) {
      for (const table of ["messages", "message_contents", "message_search", "message_embeddings", "credential_envelopes", "threads", "drafts", "tenant_keys"]) {
        await expect(db.withSystem(t => t.query(`SELECT * FROM ${table}`)), table).rejects.toThrow(/permission denied/);
      }
    }
  });
  it("the web process can't read credentials, in any context it can reach", async () => {
    await expect(webDb.withUser(ctx, t => t.query("SELECT * FROM credential_envelopes"))).rejects.toThrow(/permission denied/);
    await expect(webDb.withSystem(t => t.query("SELECT * FROM credential_envelopes"))).rejects.toThrow(/permission denied/);
  });
  it("the worker's system surface is only the queue", async () => {
    await expect(workerDb.withSystem(t => t.query("SELECT * FROM users"))).rejects.toThrow(/permission denied/);
    await expect(workerDb.withSystem(t => t.query("SELECT * FROM sessions"))).rejects.toThrow(/permission denied/);
    await expect(workerDb.withWorker(ctx.tenantId, t => t.query("SELECT password_hash FROM users"))).rejects.toThrow(/permission denied/);
  });
  it("a request context can't enqueue work for another tenant", async () => {
    await expect(webDb.withUser(ctx, t => t.query("INSERT INTO jobs(tenant_id,kind) VALUES ('00000000-0000-4000-8000-000000000009','tick')"))).rejects.toThrow(/row-level security/);
  });
  it("definer functions aren't callable outside their context", async () => {
    await expect(workerDb.withSystem(t => t.query("SELECT * FROM webhook_account_lookup('gmail','x')"))).rejects.toThrow(/permission denied/);
    await expect(webDb.withSystem(t => t.query("SELECT * FROM scheduler_accounts()"))).rejects.toThrow(/permission denied/);
    await expect(workerDb.withWorker(ctx.tenantId, t => t.query("SELECT app.replace_credential($1,'x','x')", [acct]))).rejects.toThrow(/permission denied/);
  });
  it("disconnect and delete work across the boundary, and the credential goes with it", async () => {
    await disconnectAccount(web, ctx, acct, { deleteData: true });
    await drainJobs(worker);
    expect(await adminDb.withSystem(t => t.query("SELECT 1 FROM credential_envelopes WHERE account_id=$1", [acct]))).toEqual([]);
    expect(await adminDb.withSystem(t => t.query("SELECT 1 FROM messages WHERE account_id=$1", [acct]))).toEqual([]);
  });
  it("the deletion log holds across the boundary: web writes rows, the worker login ships them, and the restore login replays them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aegis-boundary-log-"));
    const logPath = join(dir, "deletions.log");
    const u = new URL(adminUrl); u.username = "aegis_restore_login";
    await ensureLogin(adminUrl, "aegis_restore_login", "aegis_restore_conn");
    const restoreDb = new Db(u.toString(), 3, { keyRole: "aegis_worker" });
    try {
      const shipping = createPlatform({ db: workerDb, kms: web.kms, config: web.config, log: makeLogger(() => {}), env: {}, deletionSink: new FileDeletionSink(logPath) });
      const s = await signUp(web, { email: "logged@example.org", password: "correct-horse-battery", name: "Logged", workspaceKind: "personal" });
      const c = { tenantId: s.tenantId, userId: s.userId };
      const box = await connectAccount(web, c, { kind: "demo", email: "logged@example.org", displayName: "L", credential: { kind: "demo" } });
      const second = await connectAccount(web, c, { kind: "demo", email: "logged-2@example.org", displayName: "L2", credential: { kind: "demo" } });
      await updatePrefs(web, c, { serverSearchEnabled: false });
      await updatePrefs(web, c, { serverSearchEnabled: true });
      await disconnectAccount(web, c, box, { deleteData: true });
      await disconnectAccount(web, c, second, { deleteData: false });
      await deleteAccount(web, c, { confirmEmail: "logged@example.org", email: "logged@example.org", password: "correct-horse-battery" });

      // The worker's job, its tick and its sweep all run on the worker login, and only that surface.
      await drainJobs(shipping);
      await deletionLogTick(shipping);
      await sweepExpired(shipping);
      await drainJobs(shipping);
      const kinds = readFileSync(logPath, "utf8").trim().split("\n").map(l => JSON.parse(l).kind);
      expect(new Set(kinds)).toEqual(new Set(["search_off", "mailbox", "credential", "account", "tenant_shred"]));

      const report = await reapplyDeletions(restoreDb, logPath);
      expect(report.chain.ok).toBe(true);
      // The live database already has all of this, so nothing is left to do, and that's safe to find out.
      expect(report.applied.account).toBe(0);
      expect(report.applied.mailbox).toBe(0);
    } finally {
      await restoreDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("nothing but the shipper and the restore login can read the outbox, and a request context can only record its own erasures", async () => {
    await expect(webDb.withSystem(t => t.query("SELECT * FROM deletion_outbox"))).rejects.toThrow(/permission denied/);
    await expect(webDb.withUser(ctx, t => t.query("SELECT * FROM deletion_outbox"))).rejects.toThrow(/permission denied/);
    await expect(workerDb.withWorker(ctx.tenantId, t => t.query("SELECT * FROM deletion_outbox"))).rejects.toThrow(/permission denied/);
    const forge = (db: Db, kind: string, cols: string, vals: unknown[]) => db.withSystem(t => t.query(`INSERT INTO deletion_outbox(id,kind,${cols}) VALUES (gen_random_uuid(),$1,${vals.map((_, i) => `$${i + 2}`).join(",")})`, [kind, ...vals]));
    await expect(forge(webDb, "tenant_shred", "tenant_id", [ctx.tenantId])).rejects.toThrow(/row-level security/);
    const other = "00000000-0000-4000-8000-000000000009";
    await expect(webDb.withUser(ctx, t => t.query("INSERT INTO deletion_outbox(id,kind,tenant_id) VALUES (gen_random_uuid(),'tenant_shred',$1)", [ctx.tenantId]))).rejects.toThrow(/row-level security/);
    await expect(webDb.withUser(ctx, t => t.query("INSERT INTO deletion_outbox(id,kind,tenant_id,user_id) VALUES (gen_random_uuid(),'search_off',$1,$2)", [ctx.tenantId, other]))).rejects.toThrow(/row-level security/);
    await expect(webDb.withUser(ctx, t => t.query("INSERT INTO deletion_outbox(id,kind,tenant_id,account_id) VALUES (gen_random_uuid(),'mailbox',$1,$2)", [ctx.tenantId, other]))).rejects.toThrow(/row-level security/);
    await expect(workerDb.withWorker(ctx.tenantId, t => t.query("INSERT INTO deletion_outbox(id,kind,tenant_id) VALUES (gen_random_uuid(),'tenant_shred',$1)", [other]))).rejects.toThrow(/row-level security/);
    // The shipper can't change what a row says, only mark it.
    await expect(workerDb.withSystem(t => t.query("UPDATE deletion_outbox SET user_id=$1", [other]))).rejects.toThrow(/permission denied/);
  });
  it("recording in a request context survives another tenant's queued job and its own earlier row, neither of which it can see", async () => {
    const other = await signUp(web, { email: "other-tenant@example.org", password: "correct-horse-battery", name: "Other", workspaceKind: "personal" });
    const otherCtx = { tenantId: other.tenantId, userId: other.userId };
    await drainJobs(worker);
    await webDb.withUser(ctx, t => recordErasure(t, { kind: "search_off", tenantId: ctx.tenantId, userId: ctx.userId }));
    const queued = (t: string) => adminDb.withSystem(q => q.query("SELECT 1 FROM jobs WHERE kind='deletion.ship' AND state='queued' AND tenant_id=$1", [t]));
    expect(await queued(ctx.tenantId)).toHaveLength(1);
    await webDb.withUser(otherCtx, t => recordErasure(t, { kind: "search_off", tenantId: otherCtx.tenantId, userId: otherCtx.userId }));
    expect(await queued(otherCtx.tenantId)).toEqual([]);
    await webDb.withUser(ctx, t => recordErasure(t, { kind: "search_off", tenantId: ctx.tenantId, userId: ctx.userId }));
    expect(await adminDb.withSystem(t => t.query("SELECT 1 FROM deletion_outbox WHERE user_id=$1", [ctx.userId]))).toHaveLength(1);
    await drainJobs(worker);
  });
  it("account deletion and crypto-shred work across the boundary", async () => {
    const s = await signUp(web, { email: "gone@example.org", password: "correct-horse-battery", name: "Gone", workspaceKind: "personal" });
    const c = { tenantId: s.tenantId, userId: s.userId };
    await connectAccount(web, c, { kind: "demo", email: "gone@example.org", displayName: "G", credential: { kind: "demo" } });
    await drainJobs(worker);
    await deleteAccount(web, c, { confirmEmail: "gone@example.org", email: "gone@example.org", password: "correct-horse-battery" });
    await drainJobs(worker);
    expect(await adminDb.withSystem(t => t.query("SELECT 1 FROM tenant_keys WHERE tenant_id=$1", [c.tenantId]))).toEqual([]);
  });
});
