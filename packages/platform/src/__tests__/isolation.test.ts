import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Ctx, IsolatedPool, IsolationCrashError, IsolationTimeoutError, listThreads, type Platform } from "../index";
import { closeAnalysisPool } from "../ingest";
import { deliver, demoAccount, testPlatform, user } from "./harness";

const script = new URL("./fixtures/hostile-thread.mjs", import.meta.url);

describe("killable analysis threads", () => {
  it("a hung thread is killed at the limit, and the pool keeps working", async () => {
    const pool = new IsolatedPool(script, { size: 1 });
    const t = Date.now();
    await expect(pool.run({ op: "hang" }, 400)).rejects.toBeInstanceOf(IsolationTimeoutError);
    expect(Date.now() - t).toBeLessThan(5000);
    await expect(pool.run({ op: "echo", v: 7 })).resolves.toEqual({ ok: true, v: 7 });
    await pool.close();
  });
  it("a memory bomb kills the thread, not this process", async () => {
    const pool = new IsolatedPool(script, { size: 1, resourceLimits: { maxOldGenerationSizeMb: 32 } });
    await expect(pool.run({ op: "oom" }, 20_000)).rejects.toBeInstanceOf(IsolationCrashError);
    await expect(pool.run({ op: "echo", v: 1 })).resolves.toEqual({ ok: true, v: 1 });
    await pool.close();
  }, 30_000);
  it("a crash rejects only that task", async () => {
    const pool = new IsolatedPool(script, { size: 2 });
    const [a, b] = await Promise.allSettled([pool.run({ op: "throw" }, 20_000), pool.run({ op: "echo", v: 2 }, 20_000)]);
    expect(a.status).toBe("rejected");
    expect(b).toMatchObject({ status: "fulfilled", value: { v: 2 } });
    await pool.close();
  });
  it("a hung thread doesn't delay others on the pool", async () => {
    const pool = new IsolatedPool(script, { size: 2 });
    // Warm both threads, so the timing below measures contention rather than thread start-up.
    await Promise.all([pool.run({ op: "echo", v: 0 }, 20_000), pool.run({ op: "echo", v: 0 }, 20_000)]);
    const hang = pool.run({ op: "hang" }, 1500).catch(e => e);
    const t = Date.now();
    await expect(pool.run({ op: "echo", v: 3 }, 1400)).resolves.toMatchObject({ v: 3 });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await hang).toBeInstanceOf(IsolationTimeoutError);
    await pool.close();
  });
});

describe("in the pipeline", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  beforeAll(async () => { ({ p, drop } = await testPlatform()); ctx = await user(p, "iso@fernhill.example"); acct = await demoAccount(p, ctx, "iso@fernhill.example"); });
  afterAll(async () => { await closeAnalysisPool(); vi.unstubAllEnvs(); await drop(); });

  it("real mail goes through the thread, with attachments intact", async () => {
    const m = await deliver(p, ctx, acct, { from: `"Sal" <sal@client.test>`, subject: "Via thread", text: "Can you check?", attachments: [{ filename: "a.pdf.exe", contentType: "application/octet-stream", content: "MZ" }] });
    expect(m.risk_label).toBe("malicious");
  });
  it("analysis that exceeds its time limit is marked unknown, not safe, and sync moves on", async () => {
    await closeAnalysisPool();
    vi.stubEnv("AEGIS_ANALYSIS_TIMEOUT_MS", "1");
    await p.db.withWorker(ctx.tenantId, t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,'slow',now(),$3)", [acct, ctx.tenantId, Buffer.from("From: a@b.test\r\nSubject: Slow\r\n\r\nbody\r\n")]));
    const { syncAccount } = await import("../ingest");
    await syncAccount(p, ctx.tenantId, acct);
    await closeAnalysisPool();
    vi.unstubAllEnvs();
    const row = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT state, risk_label, failure_code FROM messages WHERE provider_message_id='slow'"));
    expect(row).toEqual({ state: "failed", risk_label: "unknown_unscannable", failure_code: "IsolationTimeoutError" });
    const after = await deliver(p, ctx, acct, { from: "ok@b.test", subject: "After slow", text: "fine" });
    expect(after.state ?? "classified").toBeTruthy();
    expect((await listThreads(p, ctx, { view: "inbox", q: "subject:after", limit: 5 })).items).toHaveLength(1);
  });
});
