import { randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDevKms } from "@aegis/cryptography";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertContentFree, assertContentFreeEntry, assertDeletionSinkAllowed, connectionFor, createPlatform, DeletionLogBrokenError, type DeletionEntry, deletionLogTick, deletionSinkFromEnv, disconnectAccount, drainJobs, entryId, FileDeletionSink, GENESIS_HASH, type LogLine, makeLogger, type Platform, recordErasure, shipDeletionLog, sweepExpired, tick, verifyLogText } from "../index";
import { demoAccount, testPlatform, user } from "./harness";

const T = "11111111-1111-4111-8111-111111111111", U = "22222222-2222-4222-8222-222222222222", A = "33333333-3333-4333-8333-333333333333", M = "44444444-4444-4444-8444-444444444444";
const entry = (over: Partial<DeletionEntry> = {}): DeletionEntry => {
  const fact = { kind: "mailbox" as const, tenantId: T, accountId: A, ...over };
  return { id: entryId(fact), kind: fact.kind, tenantId: fact.tenantId ?? null, userId: over.userId ?? null, accountId: fact.accountId ?? null, messageId: over.messageId ?? null, at: "2026-11-07T00:00:00.000Z", ...over };
};
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as LogLine);

describe("what an entry can hold", () => {
  it("only ids, a kind and a time", () => {
    expect(() => assertContentFreeEntry({ ...entry() })).not.toThrow();
    for (const field of ["email", "name", "subject", "body", "displayName", "meta"]) expect(() => assertContentFreeEntry({ ...entry(), [field]: "x" }), field).toThrow(/not allowed/);
  });
  it("an allowed field can't smuggle a value that isn't an id", () => {
    expect(() => assertContentFreeEntry({ ...entry(), tenantId: "someone@example.org" })).toThrow(/isn't a uuid/);
    expect(() => assertContentFreeEntry({ ...entry(), userId: { name: "x" } })).toThrow(/isn't a uuid/);
    expect(() => assertContentFreeEntry({ ...entry(), id: "Quarterly results" })).toThrow(/uuid id/);
    expect(() => assertContentFreeEntry({ ...entry(), kind: "Quarterly results" })).toThrow(/unknown kind/);
    expect(() => assertContentFreeEntry({ ...entry(), at: "Quarterly results" })).toThrow(/ISO time/);
  });
  it("an error names the field, never the value", () => {
    expect(() => assertContentFreeEntry({ ...entry(), tenantId: "someone@example.org" })).not.toThrow(/someone/);
  });
  it("each kind has to name what a replay needs", () => {
    expect(() => assertContentFreeEntry({ ...entry({ kind: "mailbox", accountId: null }) })).toThrow(/needs accountId/);
    expect(() => assertContentFreeEntry({ ...entry({ kind: "account", tenantId: null, accountId: null }) })).toThrow(/needs userId/);
  });
  it("the same fact always gets the same id", () => {
    expect(entryId({ kind: "account", userId: U })).toBe(entryId({ kind: "account", userId: U, tenantId: null }));
    expect(entryId({ kind: "account", userId: U })).not.toBe(entryId({ kind: "account", userId: A }));
    expect(entryId({ kind: "search_off", tenantId: T, userId: U })).not.toBe(entryId({ kind: "vectors_off", tenantId: T, userId: U }));
  });
  it("the job that ships it carries no payload, which the queue's own rule would catch if it did", () => {
    expect(() => assertContentFree({})).not.toThrow();
    expect(() => assertContentFree({ email: "x" })).toThrow(/not allowed/);
  });
});

describe("the hash chain", () => {
  let dir: string, path: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "aegis-chain-"));
    path = join(dir, "log");
    await new FileDeletionSink(path).append(Array.from({ length: 5 }, (_, i) => entry({ accountId: `33333333-3333-4333-8333-33333333333${i}` })));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const text = () => readFileSync(path, "utf8");
  const codes = (t: string) => verifyLogText(t).problems.map(p => p.code);

  it("verifies, from the genesis hash", () => {
    const v = verifyLogText(text());
    expect(v.problems).toEqual([]);
    expect(v.entries).toHaveLength(5);
    expect(v.entries[0]!.prev).toBe(GENESIS_HASH);
    expect(v.head.seq).toBe(5);
    expect(verifyLogText("").problems).toEqual([]);
  });
  it("catches a changed field, a removed line, a reordered line and a cut start", () => {
    const ls = text().trimEnd().split("\n");
    const changed = [...ls]; changed[2] = changed[2]!.replace(T, U);
    expect(codes(`${changed.join("\n")}\n`)).toContain("hash_mismatch");
    expect(codes(`${ls.filter((_, i) => i !== 2).join("\n")}\n`)).toEqual(["seq_gap", "prev_mismatch"]);
    const swapped = [...ls]; [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(codes(`${swapped.join("\n")}\n`)).toContain("prev_mismatch");
    expect(codes(`${ls.slice(1).join("\n")}\n`)).toContain("seq_gap");
  });
  it("reports one break once, not on every line after it", () => {
    const ls = text().trimEnd().split("\n");
    expect(verifyLogText(`${ls.filter((_, i) => i !== 1).join("\n")}\n`).problems.map(p => p.line)).toEqual([2, 2]);
  });
  it("catches garbage and a line with no end", () => {
    expect(codes(`not json\n${text()}`)).toContain("malformed");
    expect(codes(text().slice(0, -5))).toEqual(["torn_tail"]);
  });
  it("whole lines cut from the end look clean: a file can't show that, which is why the head has witnesses", () => {
    const ls = text().trimEnd().split("\n");
    expect(verifyLogText(`${ls.slice(0, 3).join("\n")}\n`).problems).toEqual([]);
  });
});

describe("the file sink", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "aegis-sink-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const fresh = (name: string) => join(dir, name);

  it("appends JSONL, creates the file private, and returns a receipt per entry", async () => {
    const path = fresh("a");
    const r = await new FileDeletionSink(path).append([entry()]);
    expect(r).toEqual([{ seq: 1, hash: lines(path)[0]!.hash }]);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
  it("a replay is idempotent: an id it holds gets its first receipt, across instances and within a batch", async () => {
    const path = fresh("b");
    const first = await new FileDeletionSink(path).append([entry()]);
    const second = await new FileDeletionSink(path).append([entry(), entry({ accountId: M }), entry({ accountId: M })]);
    expect(second[0]).toEqual(first[0]);
    expect(second[1]).toEqual(second[2]);
    expect(lines(path)).toHaveLength(2);
    expect(verifyLogText(readFileSync(path, "utf8")).problems).toEqual([]);
  });
  it("two instances take turns on one chain, each seeing the other's appends", async () => {
    const path = fresh("c");
    const a = new FileDeletionSink(path), b = new FileDeletionSink(path);
    await a.append([entry({ accountId: T })]);
    await b.append([entry({ accountId: U })]);
    await a.append([entry({ accountId: A })]);
    expect(lines(path).map(l => l.seq)).toEqual([1, 2, 3]);
    expect(verifyLogText(readFileSync(path, "utf8")).problems).toEqual([]);
  });
  it("a write that never finished is dropped and the entry goes again, because it was never acknowledged", async () => {
    const path = fresh("d");
    await new FileDeletionSink(path).append([entry({ accountId: T })]);
    appendFileSync(path, '{"v":1,"seq":2,"id":"half a li');
    const warnings: string[] = [];
    const s = new FileDeletionSink(path, makeLogger(l => warnings.push(l)));
    await s.append([entry({ accountId: U })]);
    expect(lines(path).map(l => l.seq)).toEqual([1, 2]);
    expect(verifyLogText(readFileSync(path, "utf8")).problems).toEqual([]);
    expect(warnings.join()).toContain("deletion_log.torn_tail_removed");
  });
  it("refuses to extend a broken chain", async () => {
    const path = fresh("e");
    await new FileDeletionSink(path).append([entry({ accountId: T }), entry({ accountId: U })]);
    writeFileSync(path, readFileSync(path, "utf8").replace(T, U));
    await expect(new FileDeletionSink(path).append([entry({ accountId: A })])).rejects.toBeInstanceOf(DeletionLogBrokenError);
  });
  it("notices its file getting shorter or vanishing under it", async () => {
    const path = fresh("f");
    const s = new FileDeletionSink(path);
    await s.append([entry({ accountId: T }), entry({ accountId: U })]);
    writeFileSync(path, `${readFileSync(path, "utf8").trimEnd().split("\n")[0]}\n`);
    await expect(s.append([entry({ accountId: A })])).rejects.toMatchObject({ code: "deletion_log_truncated" });
    rmSync(path);
    await expect(s.head()).rejects.toMatchObject({ code: "deletion_log_truncated" });
  });
  it("refuses an entry with anything extra, before writing it", async () => {
    const path = fresh("g");
    await expect(new FileDeletionSink(path).append([{ ...entry(), email: "x@example.org" } as DeletionEntry])).rejects.toThrow(/not allowed/);
    expect(() => statSync(path)).toThrow();
  });
});

describe("configuration, like the other things production can't go without", () => {
  const prod = { NODE_ENV: "production", DEMO_MODE: "false" };
  it("a production worker with no sink refuses to boot, naming the setting", () => {
    const productionSafe = { id: "aws-kms:test", productionSafe: true, wrap: async () => Buffer.alloc(0), unwrap: async () => Buffer.alloc(0) };
    expect(() => createPlatform({ processRole: "worker", databaseUrl: "postgres://x@localhost/none", kms: productionSafe as never, env: prod, mailer: null, embeddings: null })).toThrow(/AEGIS_DELETION_LOG_PATH is required in production/);
  });
  it("the same rule as a function, and only for the process that ships", () => {
    expect(() => assertDeletionSinkAllowed(null, "worker", prod)).toThrow(/AEGIS_DELETION_LOG_PATH/);
    expect(() => assertDeletionSinkAllowed(null, "web", prod)).not.toThrow();
    expect(() => assertDeletionSinkAllowed(null, "worker", { NODE_ENV: "production", DEMO_MODE: "true" })).not.toThrow();
    expect(() => assertDeletionSinkAllowed(null, "worker", { NODE_ENV: "development" })).not.toThrow();
    expect(() => assertDeletionSinkAllowed({ kind: "file", append: async () => [], head: async () => ({ seq: 0, hash: GENESIS_HASH }) }, "worker", prod)).not.toThrow();
  });
  it("a bad path is an error at boot, not a job that fails later", () => {
    expect(deletionSinkFromEnv({})).toBeNull();
    expect(() => deletionSinkFromEnv({ AEGIS_DELETION_LOG_PATH: "relative/log.jsonl" })).toThrow(/absolute/);
    expect(() => deletionSinkFromEnv({ AEGIS_DELETION_LOG_PATH: "/no/such/directory/log.jsonl" })).toThrow(/can't be written/);
    expect(deletionSinkFromEnv({ AEGIS_DELETION_LOG_PATH: join(tmpdir(), "log.jsonl") })?.kind).toBe("file");
  });
  it("the restore login has its own connection setting, with no fallback to an owner connection in production", () => {
    expect(() => connectionFor("restore", prod)).toThrow(/DATABASE_URL_RESTORE is required in production/);
    expect(connectionFor("restore", { ...prod, DATABASE_URL_RESTORE: "postgres://op@db/aegis" })).toBe("postgres://op@db/aegis");
    expect(new URL(connectionFor("restore", { DATABASE_URL: "postgres://owner@localhost:5432/aegis_dev" })).username).toBe("aegis_restore_login");
  });
});

describe("shipping", () => {
  let p: Platform, drop: () => Promise<void>, dir: string, path: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "aegis-ship-"));
    path = join(dir, "log");
    ({ p, drop } = await testPlatform({ deletionSink: new FileDeletionSink(path) }));
  });
  afterAll(async () => { await drop(); rmSync(dir, { recursive: true, force: true }); });

  it("a rolled-back erasure leaves no entry, because the row commits with it", async () => {
    const c = await user(p, "rollback@fernhill.example");
    const acct = await demoAccount(p, c, "rollback@fernhill.example");
    await expect(p.db.withUser(c, async t => {
      await recordErasure(t, { kind: "mailbox", tenantId: c.tenantId, accountId: acct });
      throw new Error("the erasure failed");
    })).rejects.toThrow(/erasure failed/);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM deletion_outbox WHERE account_id=$1", [acct]))).toEqual([]);
  });

  it("without a sink, rows wait: the job does nothing and tick doesn't claim otherwise", async () => {
    const noSink = createPlatform({ db: p.db, kms: new LocalDevKms(randomBytes(32)), config: p.config, log: makeLogger(() => {}), env: {}, deletionSink: null });
    const c = await user(p, "nosink@fernhill.example");
    await p.db.withUser(c, t => recordErasure(t, { kind: "search_off", tenantId: c.tenantId, userId: c.userId }));
    expect(await shipDeletionLog(noSink)).toBe(0);
    expect((await p.db.withSystem(t => t.one<any>("SELECT shipped_at FROM deletion_outbox WHERE user_id=$1", [c.userId])))!.shipped_at).toBeNull();
    await p.db.withSystem(t => t.query("DELETE FROM service_heartbeats WHERE component='deletion_log'"));
    await tick(noSink);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM service_heartbeats WHERE component='deletion_log'"))).toEqual([]);
    await tick(p);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM service_heartbeats WHERE component='deletion_log'"))).toHaveLength(1);
    await drainJobs(p);
  });

  it("logs the head, as a witness kept apart from the file", async () => {
    const logged: string[] = [];
    const q = createPlatform({ db: p.db, kms: new LocalDevKms(randomBytes(32)), config: p.config, log: makeLogger(l => logged.push(l)), env: {}, deletionSink: p.deletionSink });
    const c = await user(p, "head@fernhill.example");
    await disconnectAccount(p, c, await demoAccount(p, c, "head@fernhill.example"), { deleteData: true });
    await drainJobs(q);
    const line = JSON.parse(logged.find(l => l.includes("deletion_log.shipped"))!);
    const all = lines(path);
    expect(line.chainSeq).toBe(all[all.length - 1]!.seq);
    expect(line.chainHash).toBe(all[all.length - 1]!.hash);
  });

  it("a log shorter than the database knows it shipped stops shipping, and nothing is lost: the rows wait", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "aegis-ship2-"));
    const q = createPlatform({ db: p.db, kms: p.kms, config: p.config, log: makeLogger(() => {}), env: {}, deletionSink: new FileDeletionSink(join(dir2, "empty")) });
    const c = await user(p, "cut@fernhill.example");
    await p.db.withUser(c, t => recordErasure(t, { kind: "search_off", tenantId: c.tenantId, userId: c.userId }));
    await expect(shipDeletionLog(q)).rejects.toMatchObject({ code: "deletion_log_truncated" });
    expect((await p.db.withSystem(t => t.one<any>("SELECT shipped_at FROM deletion_outbox WHERE user_id=$1", [c.userId])))!.shipped_at).toBeNull();
    await shipDeletionLog(p);
    rmSync(dir2, { recursive: true, force: true });
  });

  it("one shipper at a time: a second one waits instead of forking the chain", async () => {
    const c = await user(p, "lock@fernhill.example");
    await p.db.withUser(c, t => recordErasure(t, { kind: "search_off", tenantId: c.tenantId, userId: c.userId }));
    await p.db.withSystem(async t => {
      await t.query("SELECT pg_advisory_xact_lock(727003)");
      await expect(shipDeletionLog(p)).rejects.toMatchObject({ name: "DeferJob" });
    });
    expect(await shipDeletionLog(p)).toBeGreaterThan(0);
  });

  it("shipped rows are pruned after a while, keeping the newest so the log can still be checked against it", async () => {
    await shipDeletionLog(p);
    await p.db.withSystem(t => t.query("UPDATE deletion_outbox SET shipped_at=now() - interval '60 days'"));
    const newest = (await p.db.withSystem(t => t.one<{ m: number }>("SELECT max(sink_seq) m FROM deletion_outbox")))!.m;
    await sweepExpired(p);
    expect(await p.db.withSystem(t => t.query<any>("SELECT sink_seq FROM deletion_outbox"))).toEqual([{ sink_seq: newest }]);
    await p.db.withSystem(t => t.query("UPDATE deletion_outbox SET shipped_at=now()"));
  });

  it("the outbox has no column that could hold content", async () => {
    const cols = await p.db.withSystem(t => t.query<{ column_name: string; data_type: string }>("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='deletion_outbox' ORDER BY 1"));
    expect(cols.filter(c => c.data_type === "text").map(c => c.column_name)).toEqual(["kind", "sink_hash"]);
    expect(cols.map(c => c.column_name).sort()).toEqual(["account_id", "erased_at", "id", "kind", "message_id", "shipped_at", "sink_hash", "sink_seq", "tenant_id", "user_id"]);
    await expect(p.db.withSystem(t => t.query("INSERT INTO deletion_outbox(id,kind,user_id) VALUES (gen_random_uuid(),'Quarterly results',gen_random_uuid())"))).rejects.toThrow(/check constraint/);
    await expect(p.db.withSystem(t => t.query("INSERT INTO deletion_outbox(id,kind) VALUES (gen_random_uuid(),'account')"))).rejects.toThrow(/check constraint/);
  });

  it("a log that's fallen an hour behind warns, and stops its heartbeat so health stops saying it's fine", async () => {
    const logged: string[] = [];
    await shipDeletionLog(p);
    const c = await user(p, "behind@fernhill.example");
    await p.db.withUser(c, t => recordErasure(t, { kind: "search_off", tenantId: c.tenantId, userId: c.userId }));
    await p.db.withSystem(t => t.query("DELETE FROM service_heartbeats WHERE component='deletion_log'"));
    const later = createPlatform({ db: p.db, kms: p.kms, config: p.config, log: makeLogger(l => logged.push(l)), env: {}, deletionSink: p.deletionSink, now: () => new Date(Date.now() + 2 * 3600_000) });
    await deletionLogTick(later);
    expect(logged.join()).toContain("deletion_log.backlog");
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM service_heartbeats WHERE component='deletion_log'"))).toEqual([]);
    await drainJobs(p);
    await deletionLogTick(later);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM service_heartbeats WHERE component='deletion_log'"))).toHaveLength(1);
  });
});
