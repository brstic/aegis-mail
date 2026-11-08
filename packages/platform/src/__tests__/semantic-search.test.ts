import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createTestDb, Db, ensureLogin } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { applyChange, assertContentFree, backfillEmbeddings, type Ctx, createPlatform, deleteAccount, disconnectAccount, drainJobs, embedMessage, enqueue, fuseRanks, grantMailbox, listThreads, LocalEmbeddingProvider, makeLogger, msgCtx, type Platform, retentionSweep, revokeMailboxGrant, rotateTenantKeys, sealMessage, semanticSearchStatus, signUp, updatePolicy, updatePrefs, vectorBytes, connectAccount, IsolationTimeoutError, SEMANTIC_MIN_SIMILARITY } from "../index";
import { FakeEmbeddings } from "./fake-embeddings";
import { runAssistant } from "../assistant";
import { deliver, demoAccount, testPlatform, user } from "./harness";

const BANK = { from: `"Harbor Supply" <billing@harbor.test>`, subject: "Vendor banking change", text: "Please change the bank account details for our supplier invoices from next month." };
const LUNCH = { from: `"Sam" <sam@friends.test>`, subject: "Tacos on Wednesday", text: "Shall we get tacos with the team after standup?" };
const QUERY = "supplier bank account change";
const vectorCount = (p: Platform, ctx: Ctx, accountId: string) => p.db.withWorker(ctx.tenantId, t => t.one<{ c: number }>("SELECT count(*)::int c FROM message_embeddings WHERE account_id=$1", [accountId])).then(r => r!.c);
const search = (p: Platform, ctx: Ctx, q = QUERY, extra: Partial<Parameters<typeof listThreads>[2]> = {}) => listThreads(p, ctx, { view: "inbox", q, limit: 20, semantic: true, ...extra });
const seal = { ciphertext: randomBytes(64).toString("base64"), meta: { alg: "AES-GCM" as const, kdf: "PBKDF2-SHA256" as const, iterations: 600_000, salt: "c2FsdA==", iv: "aXY=", v: 1 as const } };

describe("semantic search with a deterministic model", () => {
  let p: Platform, drop: () => Promise<void>, fake: FakeEmbeddings;
  beforeAll(async () => { fake = new FakeEmbeddings(); ({ p, drop } = await testPlatform({ embeddings: fake })); });
  afterAll(() => drop());

  describe("off unless a deployment asks for it", () => {
    it("reads the environment variable, and nothing else turns it on", () => {
      const made = (env: NodeJS.ProcessEnv) => createPlatform({ db: p.db, kms: p.kms, config: p.config, log: p.log, env }).embeddings;
      expect(made({})).toBeNull();
      expect(made({ AEGIS_EMBEDDINGS: "off" })).toBeNull();
      expect(made({ AEGIS_EMBEDDINGS_MODEL_DIR: "/models" })).toBeNull();
      expect(made({ AEGIS_EMBEDDINGS: "local" })).toBeInstanceOf(LocalEmbeddingProvider);
    });
    it("stores nothing, queues nothing and says so", async () => {
      const off = await testPlatform();
      const ctx = await user(off.p, "off@sem.test");
      const acct = await demoAccount(off.p, ctx, "off@sem.test");
      await deliver(off.p, ctx, acct, BANK);
      expect(await vectorCount(off.p, ctx, acct)).toBe(0);
      expect(await off.p.db.withSystem(t => t.query("SELECT 1 FROM jobs WHERE kind LIKE 'embed.%'"))).toEqual([]);
      const r = await search(off.p, ctx);
      expect(r.semantic).toEqual({ status: "unavailable" });
      expect(r.items.map(i => i.subject)).toEqual(["Vendor banking change"]);
      expect(await semanticSearchStatus(off.p, ctx)).toMatchObject({ available: false, reason: "deployment", model: null });
      await off.drop();
    });
  });

  describe("indexing", () => {
    let ctx: Ctx & { token: string }, acct: string, bank: any;
    beforeAll(async () => {
      ctx = await user(p, "index@sem.test");
      acct = await demoAccount(p, ctx, "index@sem.test");
      bank = await deliver(p, ctx, acct, BANK);
      await deliver(p, ctx, acct, LUNCH);
    });

    it("the job carries IDs only, and what was embedded is the subject and body", async () => {
      const jobs = await p.db.withSystem(t => t.query<any>("SELECT payload, dedupe_key FROM jobs WHERE kind='embed.message' AND tenant_id=$1", [ctx.tenantId]));
      expect(jobs.length).toBe(2);
      for (const j of jobs) expect(Object.keys(j.payload).sort()).toEqual(["accountId", "messageId"]);
      expect(JSON.stringify(jobs)).not.toMatch(/banking|tacos|harbor/i);
      expect(() => assertContentFree({ text: "secret" })).toThrow(/not allowed/);
      expect(fake.calls.flat().some(t => t.includes("Vendor banking change") && t.includes("supplier invoices"))).toBe(true);
    });

    it("vectors at rest are ciphertext: no plaintext bytes, sealed per record and bound to their message", async () => {
      const [expected] = await fake.embed([`${BANK.subject}\n${BANK.text}`]);
      const rows = await p.db.withWorker(ctx.tenantId, t => t.query<{ message_id: string; model: string; vector_enc: Buffer }>("SELECT message_id, model, vector_enc FROM message_embeddings WHERE account_id=$1 ORDER BY message_id", [acct]));
      expect(rows).toHaveLength(2);
      const row = rows.find(r => r.message_id === bank.id)!;
      expect(row.model).toBe(fake.id);
      const plain = vectorBytes(expected!);
      expect(row.vector_enc.includes(plain)).toBe(false);
      // No run of even a few consecutive float components survives.
      expect(row.vector_enc.includes(plain.subarray(0, 16))).toBe(false);
      expect(row.vector_enc.toString("latin1")).not.toMatch(/banking|supplier/i);
      // Two copies of the same text would match if this were deterministic. Fresh key and nonce per seal mean they don't.
      const again = await p.envelope.seal(msgCtx(ctx.tenantId, bank.id, "message_embeddings"), plain);
      expect(again.equals(row.vector_enc)).toBe(false);
      await expect(p.envelope.open(msgCtx(ctx.tenantId, bank.id, "message_embeddings"), row.vector_enc)).resolves.toEqual(plain);
      // Copying one message's vector onto another's row can't work: AAD names the record.
      const other = rows.find(r => r.message_id !== bank.id)!;
      await expect(p.envelope.open(msgCtx(ctx.tenantId, other.message_id, "message_embeddings"), row.vector_enc)).rejects.toThrow(/authentication failed/);
      await expect(p.envelope.open(msgCtx(ctx.tenantId, bank.id, "message_contents"), row.vector_enc)).rejects.toThrow(/authentication failed/);
    });

    it("a damaged vector drops out of the ranking and doesn't take the search with it", async () => {
      const other = await deliver(p, ctx, acct, { from: "a@x.test", subject: "Supplier bank account note", text: "supplier bank account change" });
      await p.db.withWorker(ctx.tenantId, async t => { await t.query("UPDATE message_embeddings SET vector_enc = (SELECT vector_enc FROM message_embeddings WHERE message_id=$2) WHERE message_id=$1", [other.id, bank.id]); });
      const r = await search(p, ctx, "supplier invoices vendor");
      expect(r.semantic?.status).toBe("used");
      expect(r.items.some(i => i.messageId === bank.id)).toBe(true);
      expect(r.items.filter(i => i.match === "meaning").some(i => i.messageId === other.id)).toBe(false);
      await p.db.withWorker(ctx.tenantId, t => t.query("DELETE FROM message_embeddings WHERE message_id=$1", [other.id]));
    });

    it("the query never reaches a log line or a job", async () => {
      const logged: string[] = [];
      const q2 = createPlatform({ db: p.db, kms: p.kms, config: p.config, log: makeLogger(l => logged.push(l)), env: {}, embeddings: fake });
      await search(q2, ctx, "zanzibar-query-canary supplier");
      expect(logged.join("\n")).not.toContain("zanzibar");
      expect(logged.some(l => l.includes("search.semantic"))).toBe(true);
      expect(JSON.stringify(await p.db.withSystem(t => t.query("SELECT payload FROM jobs")))).not.toContain("zanzibar");
    });

    it("re-running a message's job is a no-op, so retries don't waste the model", async () => {
      const before = fake.calls.length;
      await embedMessage(p, ctx.tenantId, acct, bank.id);
      expect(fake.calls.length).toBe(before);
    });

    it("a mailbox's existing mail catches up through backfill, and a replaced model counts as missing", async () => {
      const c = await user(p, "back@sem.test");
      const a = await demoAccount(p, c, "back@sem.test");
      await deliver(p, c, a, BANK);
      await p.db.withWorker(c.tenantId, t => t.query("DELETE FROM message_embeddings WHERE account_id=$1", [a]));
      expect(await vectorCount(p, c, a)).toBe(0);
      expect(await backfillEmbeddings(p, c.tenantId, a)).toBe(1);
      await drainJobs(p);
      expect(await vectorCount(p, c, a)).toBe(1);
      expect(await backfillEmbeddings(p, c.tenantId, a)).toBe(0);
      await p.db.withWorker(c.tenantId, t => t.query("UPDATE message_embeddings SET model='some-older-model' WHERE account_id=$1", [a]));
      expect(await backfillEmbeddings(p, c.tenantId, a)).toBe(1);
      await drainJobs(p);
      expect((await p.db.withWorker(c.tenantId, t => t.one<any>("SELECT model FROM message_embeddings WHERE account_id=$1", [a]))).model).toBe(fake.id);
    });

    it("the scheduler keeps backfill going, for each mailbox, at most hourly", async () => {
      const { tick } = await import("../worker");
      const count = async () => (await p.db.withSystem(t => t.one<{ c: number }>("SELECT count(*)::int c FROM jobs WHERE kind='embed.backfill' AND payload->>'accountId'=$1", [acct])))!.c;
      await tick(p);
      expect(await count()).toBe(1);
      await drainJobs(p);
      await tick(p);
      await drainJobs(p);
      expect(await count()).toBe(1);
    });

    it("key rotation moves vectors onto the new key, and they keep working", async () => {
      const blob = async () => (await p.db.withWorker(ctx.tenantId, t => t.one<{ vector_enc: Buffer }>("SELECT vector_enc FROM message_embeddings WHERE message_id=$1", [bank.id])))!.vector_enc;
      const v1 = p.envelope.versionOf(await blob());
      await rotateTenantKeys(p, ctx);
      await drainJobs(p);
      expect(p.envelope.versionOf(await blob())).toBeGreaterThan(v1);
      expect((await search(p, ctx, "supplier invoices vendor")).items.some(i => i.messageId === bank.id)).toBe(true);
    });
  });

  describe("searching", () => {
    let ctx: Ctx & { token: string }, acct: string, second: string, bank: any, lunch: any;
    beforeAll(async () => {
      ctx = await user(p, "find@sem.test");
      acct = await demoAccount(p, ctx, "find@sem.test");
      second = await demoAccount(p, ctx, "find2@sem.test");
      bank = await deliver(p, ctx, acct, BANK);
      lunch = await deliver(p, ctx, acct, LUNCH);
    });

    it("finds by meaning, labels how each row got there, and leaves plain word search alone", async () => {
      const m = await deliver(p, ctx, acct, { from: "a@b.test", subject: "Ledger", text: "bank supplier account change invoices vendor" });
      const r = await search(p, ctx, "bank supplier invoices kumquatword");
      expect(r.semantic).toMatchObject({ status: "used", limit: 5000, capped: false });
      expect(r.items[0]!.match).toBe("meaning");
      expect(r.items.map(i => i.messageId)).toEqual(expect.arrayContaining([bank.id, m.id]));
      // Those words together, with that nonsense word, match nothing by words.
      expect((await listThreads(p, ctx, { view: "inbox", q: "bank supplier invoices kumquatword", limit: 20 })).items).toEqual([]);
      expect((await listThreads(p, ctx, { view: "inbox", q: "bank supplier invoices kumquatword", limit: 20 })).semantic).toBeUndefined();
    });
    it("keeps a floor, so an unrelated query finds nothing rather than the nearest thing", async () => {
      const r = await search(p, ctx, "zzz qqq xylophone");
      expect(r.semantic?.status).toBe("used");
      expect(r.items).toEqual([]);
      expect(SEMANTIC_MIN_SIMILARITY).toBeGreaterThan(0);
    });
    it("a thread appears once, and something matched both ways is marked both and ranks first", async () => {
      await deliver(p, ctx, acct, { from: "a@b.test", subject: "Supplier bank change one", text: "supplier bank account change", messageId: "<t1@b.test>" }, { thread: "same-thread" });
      await deliver(p, ctx, acct, { from: "a@b.test", subject: "Supplier bank change two", text: "supplier bank account change again", messageId: "<t2@b.test>" }, { thread: "same-thread" });
      const r = await search(p, ctx, "supplier bank account change");
      expect(new Set(r.items.map(i => i.id)).size).toBe(r.items.length);
      expect(r.items[0]!.match).toBe("both");
    });
    it("ranks by fusion, not by date", () => {
      const row = (id: string) => ({ id });
      expect(fuseRanks([row("words-only"), row("both")], [{ row: row("both"), similarity: 0.5 }, { row: row("meaning-only"), similarity: 0.4 }]).map(r => [r.id, r.match])).toEqual([["both", "both"], ["words-only", "words"], ["meaning-only", "meaning"]]);
    });
    it("every filter still applies to what meaning finds", async () => {
      const inSecond = await deliver(p, ctx, second, { from: `"Olga" <olga@else.test>`, subject: "Vendor banking change", text: "Please change the bank account details for our supplier invoices from next month." });
      const ids = async (q: string, extra = {}) => (await search(p, ctx, q, extra)).items.map(i => i.messageId);
      expect(await ids(QUERY)).toEqual(expect.arrayContaining([bank.id, inSecond.id]));
      expect(await ids(QUERY, { accountId: second })).not.toContain(bank.id);
      expect(await ids(`${QUERY} from:olga`)).not.toContain(bank.id);
      expect(await ids(`${QUERY} from:olga`)).toContain(inSecond.id);
      expect(await ids(`${QUERY} is:unread after:2099-01-01`)).toEqual([]);
      expect(await ids(`${QUERY} has:attachment`)).not.toContain(bank.id);
    });
    it("covers the same folders as word search, no narrower and no wider", async () => {
      const trash = await deliver(p, ctx, acct, { from: "t@t.test", subject: "Supplier bank account change trashed", text: QUERY }, { folder: "trash" });
      const words = (await listThreads(p, ctx, { view: "inbox", q: "trashed", limit: 5 })).items.map(i => i.messageId);
      const both = (await search(p, ctx, "nonsenseword supplier bank account change trashed")).items.filter(i => i.match === "meaning").map(i => i.messageId);
      expect(words).toContain(trash.id);
      expect(both).toContain(trash.id);
    });
    it("only operators means there's nothing to compare by meaning", async () => {
      const r = await search(p, ctx, "is:unread");
      expect(r.semantic).toEqual({ status: "not_applicable" });
      expect(r.items.length).toBeGreaterThan(0);
    });
    it("a later page is word results only, and never runs the model", async () => {
      const before = fake.calls.length;
      const r = await search(p, ctx, QUERY, { cursor: new Date().toISOString() });
      expect(fake.calls.length).toBe(before);
      expect(r.semantic).toBeUndefined();
    });
    it("a failing model leaves word results and reports that it failed", async () => {
      fake.fail = true;
      const r = await search(p, ctx, "vendor banking");
      fake.fail = false;
      expect(r.semantic).toEqual({ status: "failed" });
      expect(r.items.map(i => i.messageId)).toContain(bank.id);
    });
    it("rate limited searches fall back to word results", async () => {
      const c = await user(p, "busy@sem.test");
      await p.db.withSystem(t => t.query("INSERT INTO rate_limits(key,count,window_start) VALUES ($1,120,now())", [`semantic:${c.userId}`]));
      expect((await search(p, c, "anything")).semantic).toEqual({ status: "rate_limited" });
    });
    it("a mailbox with no vectors yet says so instead of implying nothing matched", async () => {
      const c = await user(p, "empty@sem.test");
      await demoAccount(p, c, "empty@sem.test");
      expect((await search(p, c, "anything")).semantic).toEqual({ status: "no_index" });
      expect(lunch.id).toBeTruthy();
    });
    it("status reports real coverage for the person asking", async () => {
      const s = await semanticSearchStatus(p, ctx);
      expect(s).toMatchObject({ available: true, reason: null, enabled: true, serverSearchEnabled: true, model: fake.id });
      expect(s.indexed).toBe(s.eligible);
      await p.db.withWorker(ctx.tenantId, t => t.query("DELETE FROM message_embeddings WHERE message_id=$1", [lunch.id]));
      expect((await semanticSearchStatus(p, ctx)).indexed).toBe(s.indexed - 1);
    });
  });

  describe("flagged and held mail stays searchable only the way it already was", () => {
    let ctx: Ctx & { token: string }, acct: string, held: any;
    const PHISH = { from: `"Harbor" <x@harb0r.test>`, auth: "fail" as const, subject: "Urgent supplier bank account change", text: "Verify your password at https://harb0r.test/login and change the supplier bank account now" };
    beforeAll(async () => {
      ctx = await user(p, "flag@sem.test");
      acct = await demoAccount(p, ctx, "flag@sem.test");
      held = await deliver(p, ctx, acct, PHISH);
    });
    it("this fixture really is held", () => expect(held.held).toBe(true));
    it("held mail doesn't appear in an ordinary semantic search", async () => {
      expect((await search(p, ctx)).items.map(i => i.messageId)).not.toContain(held.id);
      expect((await listThreads(p, ctx, { view: "inbox", q: "supplier", limit: 5 })).items.map(i => i.messageId)).not.toContain(held.id);
    });
    it("it does with is:flagged, exactly as word search does", async () => {
      const r = await search(p, ctx, `${QUERY} is:flagged`);
      expect(r.items.map(i => i.messageId)).toContain(held.id);
      expect(r.items.find(i => i.messageId === held.id)!.held).toBe(true);
    });
  });

  describe("privacy gates", () => {
    it("server search off: nothing is embedded and what's there goes now", async () => {
      const c = await user(p, "gate1@sem.test");
      const a = await demoAccount(p, c, "gate1@sem.test");
      await deliver(p, c, a, BANK);
      expect(await vectorCount(p, c, a)).toBe(1);
      await updatePrefs(p, c, { serverSearchEnabled: false });
      expect(await vectorCount(p, c, a)).toBe(0);
      const calls = fake.calls.length;
      await deliver(p, c, a, LUNCH);
      expect(fake.calls.length).toBe(calls);
      expect(await vectorCount(p, c, a)).toBe(0);
      expect(await backfillEmbeddings(p, c.tenantId, a)).toBe(0);
    });
    it("semantic search off for a person: same, with word search untouched, and on again rebuilds it", async () => {
      const c = await user(p, "gate2@sem.test");
      const a = await demoAccount(p, c, "gate2@sem.test");
      await deliver(p, c, a, BANK);
      await updatePrefs(p, c, { semanticSearchEnabled: false });
      expect(await vectorCount(p, c, a)).toBe(0);
      expect((await listThreads(p, c, { view: "inbox", q: "vendor", limit: 5 })).items).toHaveLength(1);
      await deliver(p, c, a, LUNCH);
      expect(await vectorCount(p, c, a)).toBe(0);
      expect(await semanticSearchStatus(p, c)).toMatchObject({ available: true, enabled: false });
      await updatePrefs(p, c, { semanticSearchEnabled: true });
      await drainJobs(p);
      expect(await vectorCount(p, c, a)).toBe(2);
    });
    it("turning it off while a message is being embedded can't leave a vector behind", async () => {
      const c = await user(p, "gate3@sem.test");
      const a = await demoAccount(p, c, "gate3@sem.test");
      fake.during = async () => { await updatePrefs(p, c, { semanticSearchEnabled: false }); };
      await deliver(p, c, a, BANK);
      expect(await vectorCount(p, c, a)).toBe(0);
    });
    it("sealing erases the vector, a later job or backfill can't recreate it, and a seal mid-embedding wins", async () => {
      const c = await user(p, "gate4@sem.test");
      const a = await demoAccount(p, c, "gate4@sem.test");
      const m = await deliver(p, c, a, BANK);
      expect(await vectorCount(p, c, a)).toBe(1);
      await sealMessage(p, c, m.id, seal);
      expect(await vectorCount(p, c, a)).toBe(0);
      const calls = fake.calls.length;
      await embedMessage(p, c.tenantId, a, m.id);
      expect(await backfillEmbeddings(p, c.tenantId, a)).toBe(0);
      expect(fake.calls.length).toBe(calls);
      expect((await search(p, c)).items).toEqual([]);

      const racing = await deliver(p, c, a, LUNCH);
      await p.db.withWorker(c.tenantId, t => t.query("DELETE FROM message_embeddings WHERE message_id=$1", [racing.id]));
      fake.during = async () => { await sealMessage(p, c, racing.id, seal); };
      await embedMessage(p, c.tenantId, a, racing.id);
      expect(await vectorCount(p, c, a)).toBe(0);
    });
    it("a client-sealed workspace is never indexed", async () => {
      const c = await user(p, "gate5@sem.test");
      const a = await demoAccount(p, c, "gate5@sem.test");
      await p.db.withSystem(t => t.query("UPDATE organizations SET privacy_mode='client_sealed' WHERE id=$1", [c.tenantId]));
      await deliver(p, c, a, BANK);
      expect(await vectorCount(p, c, a)).toBe(0);
      expect(await semanticSearchStatus(p, c)).toMatchObject({ available: false, reason: "privacy_mode" });
    });
    it("a message that failed analysis has nothing to embed", async () => {
      const c = await user(p, "gate6@sem.test");
      const a = await demoAccount(p, c, "gate6@sem.test");
      const m = await deliver(p, c, a, LUNCH);
      await p.db.withWorker(c.tenantId, t => t.query("UPDATE messages SET state='failed' WHERE id=$1", [m.id]));
      await p.db.withWorker(c.tenantId, t => t.query("DELETE FROM message_embeddings WHERE message_id=$1", [m.id]));
      expect(await backfillEmbeddings(p, c.tenantId, a)).toBe(0);
    });
  });

  describe("deletion", () => {
    it("a message deleted at the provider loses its vector", async () => {
      const c = await user(p, "del1@sem.test");
      const a = await demoAccount(p, c, "del1@sem.test");
      const m = await deliver(p, c, a, BANK);
      expect(await vectorCount(p, c, a)).toBe(1);
      const account = await p.db.withWorker(c.tenantId, t => t.one<any>("SELECT * FROM mail_accounts WHERE id=$1", [a]));
      await applyChange(p, account, { fetchRaw: async () => Buffer.alloc(0) }, { type: "delete", remoteId: m.remoteId });
      expect(await vectorCount(p, c, a)).toBe(0);
    });
    it("retention removes vectors with the mail", async () => {
      const c = await user(p, "del2@sem.test", { kind: "organization" });
      const a = await demoAccount(p, c, "del2@sem.test");
      await deliver(p, c, a, BANK, { hoursAgo: 24 * 40 });
      await deliver(p, c, a, LUNCH);
      expect(await vectorCount(p, c, a)).toBe(2);
      await updatePolicy(p, c, { retentionDays: 30 });
      await retentionSweep(p, c.tenantId);
      expect(await vectorCount(p, c, a)).toBe(1);
    });
    it("disconnect and delete erases vectors at once. Disconnect and keep leaves them, along with the mail they came from", async () => {
      const c = await user(p, "del3@sem.test");
      const gone = await demoAccount(p, c, "gone@sem.test");
      const kept = await demoAccount(p, c, "kept@sem.test");
      await deliver(p, c, gone, BANK);
      await deliver(p, c, kept, LUNCH);
      await disconnectAccount(p, c, gone, { deleteData: true });
      // Before the worker runs: the docs promise immediately.
      expect(await vectorCount(p, c, gone)).toBe(0);
      await disconnectAccount(p, c, kept, { deleteData: false });
      await drainJobs(p);
      expect(await vectorCount(p, c, kept)).toBe(1);
    });
    it("nothing new is embedded for a disconnected mailbox", async () => {
      const c = await user(p, "del4@sem.test");
      const a = await demoAccount(p, c, "del4@sem.test");
      const m = await deliver(p, c, a, BANK);
      await p.db.withWorker(c.tenantId, t => t.query("DELETE FROM message_embeddings WHERE message_id=$1", [m.id]));
      await disconnectAccount(p, c, a, { deleteData: false });
      await drainJobs(p);
      await embedMessage(p, c.tenantId, a, m.id);
      expect(await vectorCount(p, c, a)).toBe(0);
    });
    it("deleting an account removes vectors, and shredding destroys what could open any copy of them", async () => {
      const c = await user(p, "del5@sem.test");
      const a = await demoAccount(p, c, "del5@sem.test");
      const m = await deliver(p, c, a, BANK);
      const blob = (await p.db.withWorker(c.tenantId, t => t.one<{ vector_enc: Buffer }>("SELECT vector_enc FROM message_embeddings WHERE message_id=$1", [m.id])))!.vector_enc;
      await deleteAccount(p, c, { confirmEmail: "del5@sem.test", email: "del5@sem.test", password: "correct-horse-battery" });
      await drainJobs(p);
      expect(await p.db.withWorker(c.tenantId, t => t.query("SELECT 1 FROM message_embeddings WHERE tenant_id=$1", [c.tenantId]))).toEqual([]);
      expect(await p.db.withWorker(c.tenantId, t => t.query("SELECT 1 FROM tenant_keys WHERE tenant_id=$1", [c.tenantId]))).toEqual([]);
      // A backup taken earlier still has this blob. It no longer opens.
      p.envelope.forget(c.tenantId);
      await expect(p.envelope.open(msgCtx(c.tenantId, m.id, "message_embeddings"), blob)).rejects.toThrow();
    });
    it("shredding on its own clears a tenant's rows too", async () => {
      const c = await user(p, "del6@sem.test");
      const a = await demoAccount(p, c, "del6@sem.test");
      await deliver(p, c, a, BANK);
      await p.db.withSystem(t => enqueue(t, { tenantId: c.tenantId, kind: "tenant.shred" }));
      await drainJobs(p);
      expect(await vectorCount(p, c, a)).toBe(0);
    });
  });

  describe("who can match on what", () => {
    let owner: Ctx & { token: string }, mate: Ctx, stranger: Ctx & { token: string }, acct: string, m: any;
    beforeAll(async () => {
      owner = await user(p, "owner@sem.test", { kind: "organization" });
      const u = await user(p, "mate@sem.test");
      await p.db.withSystem(t => t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'member')", [owner.tenantId, u.userId]));
      mate = { tenantId: owner.tenantId, userId: u.userId };
      stranger = await user(p, "stranger@sem.test");
      acct = await demoAccount(p, owner, "owner@sem.test");
      m = await deliver(p, owner, acct, BANK);
    });
    it("a colleague with no grant matches nothing, and their role can't even see the rows", async () => {
      expect((await search(p, mate)).items).toEqual([]);
      expect((await search(p, mate)).semantic).toEqual({ status: "no_index" });
      expect(await p.db.withUser(mate, t => t.query("SELECT * FROM message_embeddings"))).toEqual([]);
    });
    it("an owner of the workspace is no exception: admins don't get mail", async () => {
      const admin = await user(p, "admin@sem.test");
      await p.db.withSystem(t => t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner')", [owner.tenantId, admin.userId]));
      const asAdmin = { tenantId: owner.tenantId, userId: admin.userId };
      expect((await search(p, asAdmin)).items).toEqual([]);
      expect(await p.db.withUser(asAdmin, t => t.query("SELECT 1 FROM message_embeddings"))).toEqual([]);
    });
    it("another tenant sees nothing, and pointing at this tenant's context from outside fails", async () => {
      expect((await search(p, stranger)).items).toEqual([]);
      expect(await p.db.withUser({ tenantId: owner.tenantId, userId: stranger.userId }, t => t.query("SELECT * FROM message_embeddings"))).toEqual([]);
      expect(await p.db.withWorker(stranger.tenantId, t => t.query("SELECT * FROM message_embeddings WHERE account_id=$1", [acct]))).toEqual([]);
    });
    it("a grant lets someone search that mailbox, and revoking it stops them matching at once", async () => {
      await grantMailbox(p, owner, acct, mate.userId);
      expect((await search(p, mate)).items.map(i => i.messageId)).toContain(m.id);
      await revokeMailboxGrant(p, owner, acct, mate.userId);
      expect((await search(p, mate)).items).toEqual([]);
    });
    it("a grantee can read vectors in order to search, but can't erase or forge them", async () => {
      await grantMailbox(p, owner, acct, mate.userId);
      expect(await p.db.withUser(mate, t => t.query("DELETE FROM message_embeddings RETURNING 1"))).toEqual([]);
      expect(await vectorCount(p, owner, acct)).toBe(1);
      await expect(p.db.withUser(mate, t => t.query("INSERT INTO message_embeddings(message_id,tenant_id,account_id,model,vector_enc) VALUES ($1,$2,$3,'x','x')", [m.id, owner.tenantId, acct]))).rejects.toThrow(/permission denied/);
      await expect(p.db.withUser(mate, t => t.query("UPDATE message_embeddings SET vector_enc='x'"))).rejects.toThrow(/permission denied/);
      await revokeMailboxGrant(p, owner, acct, mate.userId);
    });
    it("a vector can't be opened with another tenant's keys", async () => {
      const blob = (await p.db.withWorker(owner.tenantId, t => t.one<{ vector_enc: Buffer }>("SELECT vector_enc FROM message_embeddings WHERE message_id=$1", [m.id])))!.vector_enc;
      await expect(p.envelope.open(msgCtx(stranger.tenantId, m.id, "message_embeddings"), blob)).rejects.toThrow();
    });
  });
});

describe("semantic search with real login roles", () => {
  let adminDrop: () => Promise<void>, web: Platform, worker: Platform, webDb: Db, workerDb: Db, adminDb: Db, ctx: Ctx, acct: string;
  const fake = new FakeEmbeddings();
  beforeAll(async () => {
    const t = await createTestDb("sembound"); adminDb = t.db; adminDrop = t.drop;
    await ensureLogin(t.url, "aegis_web_login", "aegis_web_conn");
    await ensureLogin(t.url, "aegis_worker_login", "aegis_worker_conn");
    const as = (login: string) => { const u = new URL(t.url); u.username = login; return u.toString(); };
    webDb = new Db(as("aegis_web_login"), 5, { keyRole: "aegis_app" });
    workerDb = new Db(as("aegis_worker_login"), 5, { keyRole: "aegis_worker" });
    const shared = { kms: new LocalDevKms(randomBytes(32)), config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(() => {}), env: {}, embeddings: fake };
    web = createPlatform({ db: webDb, ...shared });
    worker = createPlatform({ db: workerDb, ...shared });
    const s = await signUp(web, { email: "b@sem.test", password: "correct-horse-battery", name: "Bea", workspaceKind: "personal" });
    ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
    acct = await connectAccount(web, ctx, { kind: "demo", email: "b@sem.test", displayName: "B", credential: { kind: "demo" } });
    await drainJobs(worker);
  });
  afterAll(async () => { await webDb.close(); await workerDb.close(); await adminDrop(); });

  it("the worker embeds, the web process searches and opts out, and neither has more than that", async () => {
    await webDb.withUser(ctx, t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,'r1',now(),$3)", [acct, ctx.tenantId, Buffer.from(`From: a@b.test\r\nSubject: ${BANK.subject}\r\nMessage-ID: <1@b.test>\r\nAuthentication-Results: x; spf=pass; dkim=pass; dmarc=pass\r\nContent-Type: text/plain\r\n\r\n${BANK.text}\r\n`)]));
    await webDb.withSystem(t => t.query("INSERT INTO jobs(tenant_id,kind,payload) VALUES ($1,'sync.account',$2)", [ctx.tenantId, JSON.stringify({ accountId: acct })]));
    await drainJobs(worker);
    const count = async () => (await adminDb.withSystem(t => t.one<{ c: number }>("SELECT count(*)::int c FROM message_embeddings")))!.c;
    expect(await count()).toBe(1);
    const r = await search(web, ctx, "supplier bank account change vendor");
    expect(r.semantic?.status).toBe("used");
    expect(r.items).toHaveLength(1);
    await updatePrefs(web, ctx, { semanticSearchEnabled: false });
    expect(await count()).toBe(0);
  });
  it("neither login reaches the table outside a context, and the web role can only read and delete inside one", async () => {
    for (const db of [webDb, workerDb]) await expect(db.withSystem(t => t.query("SELECT * FROM message_embeddings"))).rejects.toThrow(/permission denied/);
    await expect(webDb.withUser(ctx, t => t.query("INSERT INTO message_embeddings(message_id,tenant_id,account_id,model,vector_enc) SELECT id,tenant_id,account_id,'x','x' FROM messages"))).rejects.toThrow(/permission denied/);
    await expect(webDb.withUser(ctx, t => t.query("UPDATE message_embeddings SET model='x'"))).rejects.toThrow(/permission denied/);
    await webDb.withUser(ctx, t => t.query("SELECT * FROM message_embeddings"));
    await webDb.withUser(ctx, t => t.query("DELETE FROM message_embeddings WHERE false"));
  });
  it("the grants are exactly what the migration says, RLS is forced, and no other role has any", async () => {
    const rows = await adminDb.withSystem(t => t.query<{ rolname: string; p: string }>(`
      SELECT r.rolname, p FROM pg_roles r CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE r.rolname LIKE 'aegis\\_%' AND has_table_privilege(r.oid, 'message_embeddings', p) AND NOT r.rolsuper ORDER BY 1,2`));
    const by: Record<string, string[]> = {};
    for (const r of rows) (by[r.rolname] ??= []).push(r.p);
    // Login roles have no direct rights: they have to SET ROLE, and the role tests above prove they can only reach their own.
    expect(by).toEqual({ aegis_app: ["DELETE", "SELECT"], aegis_worker: ["DELETE", "INSERT", "SELECT", "UPDATE"] });
    const rls = await adminDb.withSystem(t => t.one<any>("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='message_embeddings'"));
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await adminDb.withSystem(t => t.query<any>("SELECT policyname, cmd, roles FROM pg_policies WHERE tablename='message_embeddings' ORDER BY 1"));
    expect(policies.map(x => [x.policyname, x.cmd])).toEqual([["app_delete", "DELETE"], ["app_read", "SELECT"], ["worker_tenant", "ALL"]]);
  });
});

describe("a model still loading", () => {
  it("doesn't hold up a search: the search gives up on time and the load carries on", async () => {
    const provider = new LocalEmbeddingProvider({ script: new URL("./fixtures/slow-load-embedding-thread.ts", import.meta.url) });
    const t0 = Date.now();
    await expect(provider.embed(["query"], { timeoutMs: 300 })).rejects.toBeInstanceOf(IsolationTimeoutError);
    expect(Date.now() - t0).toBeLessThan(2500);
    await provider.close();
  });
});

describe("a stuck model", () => {
  const stuck = () => new LocalEmbeddingProvider({ script: new URL("./fixtures/stuck-embedding-thread.ts", import.meta.url), embedTimeoutMs: 400 });
  it("is killed at its timeout, and the next call gets a fresh thread", async () => {
    const provider = stuck();
    await expect(provider.embed(["anything"])).rejects.toBeInstanceOf(IsolationTimeoutError);
    await expect(provider.embed(["anything else"])).rejects.toBeInstanceOf(IsolationTimeoutError);
    await provider.close();
  });
  it("can't hold up ingest, and a search still answers with word results", async () => {
    const provider = stuck();
    const { p, drop } = await testPlatform({ embeddings: provider });
    const c = await user(p, "stuck@sem.test");
    const a = await demoAccount(p, c, "stuck@sem.test");
    const t0 = Date.now();
    const m = await deliver(p, c, a, BANK);
    expect(m.risk_label).toBeTruthy();
    expect(await vectorCount(p, c, a)).toBe(0);
    const r = await search(p, c, "vendor banking", {});
    expect(r.semantic).toEqual({ status: "failed" });
    expect(r.items.map(i => i.messageId)).toEqual([m.id]);
    // One timeout per attempt at most, not a hang.
    expect(Date.now() - t0).toBeLessThan(20_000);
    await provider.close();
    await drop();
  });
});

describe("the assistant uses semantic search as a last resort", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ embeddings: new FakeEmbeddings() }));
    ctx = await user(p, "assist@semantic.example");
    acct = await demoAccount(p, ctx, "assist@semantic.example");
    await deliver(p, ctx, acct, { from: `"Vendor Ops" <ops@vendor.test>`, subject: "Beneficiary account update", text: "Please update the beneficiary account for our invoices." });
    await drainJobs(p);
  });
  afterAll(() => drop());
  it("finds by meaning when words find nothing, and says it can be wrong", async () => {
    const r = await runAssistant(p, ctx, "find beneficiary zzqxv", undefined, "Pat");
    expect(r.tool).toBe("search_messages");
    expect(r.text).toMatch(/close in meaning/);
    expect((r as { results?: unknown[] }).results).toHaveLength(1);
  });
  it("someone else's assistant can't find it", async () => {
    const other = await user(p, "other@semantic.example");
    const r = await runAssistant(p, other, "find beneficiary zzqxv", undefined, "Sam");
    expect((r as { results?: unknown[] }).results ?? []).toHaveLength(0);
  });
});
