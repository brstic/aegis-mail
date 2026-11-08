import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEMANTIC_DOCS, SEMANTIC_OFF_TOPIC, SEMANTIC_QUERIES } from "@aegis/test-fixtures";
import { type Ctx, embeddingText, EmbeddingUnavailableError, listThreads, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_REVISION, LocalEmbeddingProvider, type Platform, SEMANTIC_MIN_SIMILARITY, similarity } from "../index";
import { deliver, demoAccount, testPlatform, user } from "./harness";

/**
 * A real run of the real model. It downloads once (about 23 MB) into .cache/embeddings. Each test skips, with the reason on
 * screen, only if that download can't happen: anything else going wrong fails.
 */
describe("the real embedding model", () => {
  const provider = new LocalEmbeddingProvider();
  let unavailable: string | null = null, modelFetches: string[] = [];
  beforeAll(async () => {
    try { modelFetches = (await provider.load()).modelFetches ?? []; }
    catch (e) {
      // Only an unreachable download is a reason to skip. A model that's there and won't load is a failure.
      const reachable = await fetch(`https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/${LOCAL_EMBEDDING_REVISION}/config.json`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) }).then(() => true, () => false);
      if (reachable) throw e;
      unavailable = "the model couldn't be downloaded: huggingface.co isn't reachable from here";
      console.warn(`SKIPPING real-model tests: ${unavailable}`);
    }
  }, 300_000);
  afterAll(() => provider.close());
  const needModel = (ctx: { skip: (note?: string) => void }) => { if (unavailable) ctx.skip(unavailable); };

  it("finds the supplier's bank change with none of the query's words in it, above unrelated mail", async ctx => {
    needModel(ctx);
    const { p, drop } = await testPlatform({ embeddings: provider });
    const c: Ctx = await user(p, "real@sem.test");
    const a = await demoAccount(p, c, "real@sem.test");
    const bank = await deliver(p, c, a, { from: `"Accounts" <accounts@northwind.test>`, subject: "Quick update", text: "please update the beneficiary account for our invoices" });
    for (const m of [
      { subject: "Lunch on Friday", text: "Do you want to grab sushi after the offsite?" },
      { subject: "Quarterly roadmap", text: "Here are the slides for the product planning session next week." },
      { subject: "Your flight itinerary", text: "Your flight to Lisbon departs at 09:40 from gate 12." },
      { subject: "Five ways to sleep better", text: "Morning light, a cool room, and putting your phone away." },
    ]) await deliver(p, c, a, { from: `"Someone" <someone@elsewhere.test>`, ...m });
    const q = "the supplier who wanted a bank detail change";
    const body = "please update the beneficiary account for our invoices";
    // The point of the test: it shares no word with the query, beyond "the", which isn't what found it.
    for (const w of ["supplier", "wanted", "bank", "detail", "change", "who"]) expect(body.includes(w)).toBe(false);
    const words = await listThreads(p, c, { view: "inbox", q, limit: 20 });
    expect(words.items).toEqual([]);
    const r = await listThreads(p, c, { view: "inbox", q, limit: 20, semantic: true });
    expect(r.semantic?.status).toBe("used");
    expect(r.items[0]?.messageId).toBe(bank.id);
    expect(r.items[0]?.match).toBe("meaning");
    expect(r.items.every(i => !["Lunch on Friday", "Your flight itinerary", "Five ways to sleep better"].includes(i.subject))).toBe(true);
    await drop();
  }, 120_000);

  it("only ever asks the network for this model's files, and asks for nothing once loaded", async ctx => {
    needModel(ctx);
    for (const url of modelFetches) expect(url.startsWith(`https://huggingface.co/${LOCAL_EMBEDDING_MODEL}/resolve/`)).toBe(true);
    await provider.embed(["MAIL-CANARY-7731 a message that must not go anywhere"]);
    // The thread records every URL it lets through, and refuses all of them after loading.
    const after = (await provider.load()).modelFetches ?? [];
    expect(after).toEqual(modelFetches);
    expect(after.join()).not.toContain("CANARY");
  });

  it("ONNX Runtime's telemetry never starts", async ctx => {
    needModel(ctx);
    // Its telemetry is on unless the real environment says otherwise, and it talks to mobile.events.data.microsoft.com, not through env.fetch.
    // So this looks inside the process. A sample of every thread, taken while the model works, must show none of that SDK's threads.
    expect(process.env.ORT_DISABLE_TELEMETRY).toBe("1");
    if (process.platform !== "darwin") ctx.skip("this check uses macOS's sample tool");
    const busy = provider.embed(["MAIL-CANARY-7731"]);
    const { stdout } = await promisify(execFile)("sample", [String(process.pid), "1"], { maxBuffer: 64 * 1024 * 1024 });
    await busy;
    // The sampling itself has to have seen the runtime, or this proves nothing.
    expect(stdout).toContain("libonnxruntime");
    expect(stdout).not.toContain("Microsoft::Applications");
  }, 60_000);

  it("with a model directory it reads only that directory, gives the same vectors, and can't reach the network", async ctx => {
    needModel(ctx);
    const cached = join(process.cwd(), ".cache", "embeddings", LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_REVISION);
    if (!existsSync(cached)) ctx.skip("no cached model to copy");
    const dir = mkdtempSync(join(tmpdir(), "aegis-model-"));
    cpSync(cached, join(dir, LOCAL_EMBEDDING_MODEL), { recursive: true });
    const offline = new LocalEmbeddingProvider({ modelDir: dir });
    try {
      expect((await offline.load()).modelFetches).toEqual([]);
      const [a] = await offline.embed(["please update the beneficiary account"]);
      const [b] = await provider.embed(["please update the beneficiary account"]);
      expect(similarity(a!, b!)).toBeGreaterThan(0.9999);
    } finally { await offline.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it("a missing model directory fails plainly instead of downloading", async ctx => {
    needModel(ctx);
    const empty = mkdtempSync(join(tmpdir(), "aegis-model-empty-"));
    const offline = new LocalEmbeddingProvider({ modelDir: empty });
    try { await expect(offline.embed(["x"])).rejects.toBeInstanceOf(EmbeddingUnavailableError); }
    finally { await offline.close(); rmSync(empty, { recursive: true, force: true }); }
  }, 60_000);

  it("reports recall on the labelled synthetic set", async ctx => {
    needModel(ctx);
    const docs = await provider.embed(SEMANTIC_DOCS.map(d => embeddingText(d.subject, d.text)));
    const score = (q: Float32Array) => SEMANTIC_DOCS.map((d, i) => ({ id: d.id, s: similarity(q, docs[i]!) })).sort((a, b) => b.s - a.s);
    let hitsAt1 = 0, hitsAt5 = 0, found = 0, relevantTotal = 0, rr = 0, returned = 0, returnedRelevant = 0;
    const missed: string[] = [];
    for (const { q, relevant } of SEMANTIC_QUERIES) {
      const ranked = score((await provider.embed([q]))[0]!);
      const over = ranked.filter(r => r.s >= SEMANTIC_MIN_SIMILARITY);
      if (relevant.includes(ranked[0]!.id)) hitsAt1++;
      if (ranked.slice(0, 5).some(r => relevant.includes(r.id))) hitsAt5++;
      const rank = ranked.findIndex(r => relevant.includes(r.id));
      rr += 1 / (rank + 1);
      relevantTotal += relevant.length;
      found += over.filter(r => relevant.includes(r.id)).length;
      returned += over.length;
      returnedRelevant += over.filter(r => relevant.includes(r.id)).length;
      for (const id of relevant) if (!over.some(r => r.id === id)) missed.push(`${q} -> ${id} (${ranked.find(r => r.id === id)!.s.toFixed(3)})`);
    }
    const falseHits: string[] = [];
    for (const q of SEMANTIC_OFF_TOPIC) for (const r of score((await provider.embed([q]))[0]!).filter(x => x.s >= SEMANTIC_MIN_SIMILARITY)) falseHits.push(`${q} -> ${r.id} (${r.s.toFixed(3)})`);
    const n = SEMANTIC_QUERIES.length;
    console.log([
      `Semantic recall, ${n} queries over ${SEMANTIC_DOCS.length} synthetic messages, floor ${SEMANTIC_MIN_SIMILARITY}:`,
      `  top result relevant: ${hitsAt1}/${n}`, `  a relevant result in the top 5: ${hitsAt5}/${n}`, `  mean reciprocal rank: ${(rr / n).toFixed(3)}`,
      `  relevant messages above the floor (recall): ${found}/${relevantTotal}`, `  results above the floor that are relevant (precision): ${returnedRelevant}/${returned}`,
      `  off-topic queries' results above the floor: ${falseHits.length}`, ...falseHits.map(f => `    ${f}`), `  missed: ${missed.length}`, ...missed.map(m => `    ${m}`),
    ].join("\n"));
    // Floors below what's measured, there to catch a real regression. The numbers to quote are in the output above, and in docs/STATUS.md.
    expect(hitsAt5 / n).toBeGreaterThanOrEqual(0.8);
    expect(found / relevantTotal).toBeGreaterThanOrEqual(0.5);
  }, 120_000);

  it("embeds fast enough to be a background job", async ctx => {
    needModel(ctx);
    const t0 = Date.now();
    for (const d of SEMANTIC_DOCS) await provider.embed([embeddingText(d.subject, d.text)]);
    console.log(`Embedding: ${((Date.now() - t0) / SEMANTIC_DOCS.length).toFixed(1)} ms per short message, one at a time`);
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 60_000);
});
