import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { type Ctx, listThreads, msgCtx, type Platform, SEMANTIC_CANDIDATE_LIMIT, vectorBytes } from "../index";
import { LOCAL_EMBEDDING_MODEL } from "../embeddings";
import { deliver, demoAccount, testPlatform, user } from "./harness";

/** What it costs to open and rank the bound in full: real sealed rows, real RLS, real envelope. Real-model query embedding (a few ms) isn't included here: see the real-model test. */
describe("semantic search at its candidate bound", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, acct: string;
  const provider = {
    id: `bench-${LOCAL_EMBEDDING_MODEL}`, dimensions: 384,
    async embed(texts: string[]) { return texts.map(() => { const v = new Float32Array(384); v[0] = 1; return v; }); },
  };
  beforeAll(async () => {
    ({ p, drop } = await testPlatform({ embeddings: provider }));
    ctx = await user(p, "bench@sem.test");
    acct = await demoAccount(p, ctx, "bench@sem.test");
    await deliver(p, ctx, acct, { from: "a@b.test", subject: "Seed", text: "seed" });
    // One past the bound, so the cap has something to cut. Dimensions match the real model: 384 floats.
    const n = SEMANTIC_CANDIDATE_LIMIT + 1;
    const rows: { id: string; enc: Buffer; i: number }[] = [];
    for (let i = 0; i < n; i++) {
      const id = randomUUID();
      const v = new Float32Array(384);
      for (let d = 0; d < 384; d++) v[d] = Math.sin(i + d);
      const norm = Math.hypot(...v);
      rows.push({ id, i, enc: await p.envelope.seal(msgCtx(ctx.tenantId, id, "message_embeddings"), vectorBytes(v.map(x => x / norm))) });
    }
    for (let at = 0; at < rows.length; at += 500) {
      const page = rows.slice(at, at + 500);
      await p.db.withWorker(ctx.tenantId, async t => {
        await t.query(`INSERT INTO messages(id,tenant_id,account_id,provider_message_id,internal_date,folder_role,size_bytes,state,risk_label,policy_action) SELECT id,$1,$2,'b-'||id, now() - (i * interval '1 minute'),'inbox',10,'classified','safe','allow' FROM unnest($3::uuid[], $4::int[]) AS u(id,i)`, [ctx.tenantId, acct, page.map(r => r.id), page.map(r => r.i)]);
        await t.query(`INSERT INTO message_embeddings(message_id,tenant_id,account_id,model,vector_enc) SELECT id,$1,$2,$3,enc FROM unnest($4::uuid[], $5::bytea[]) AS u(id,enc)`, [ctx.tenantId, acct, provider.id, page.map(r => r.id), page.map(r => r.enc)]);
      });
    }
  }, 180_000);
  afterAll(() => drop());

  it(`opens and ranks at most ${SEMANTIC_CANDIDATE_LIMIT} vectors per query, and says when it hit that`, async () => {
    const times: number[] = [];
    let last: Awaited<ReturnType<typeof listThreads>> | undefined;
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      last = await listThreads(p, ctx, { view: "inbox", q: "anything at all", limit: 20, semantic: true });
      times.push(performance.now() - t0);
    }
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`Semantic query over ${SEMANTIC_CANDIDATE_LIMIT} sealed 384-dimension vectors, whole listThreads call: median ${sorted[3]!.toFixed(0)} ms, worst ${sorted[6]!.toFixed(0)} ms, first ${times[0]!.toFixed(0)} ms`);
    expect(last!.semantic).toMatchObject({ status: "used", candidates: SEMANTIC_CANDIDATE_LIMIT, capped: true, limit: SEMANTIC_CANDIDATE_LIMIT });
    // Generous: this guards against a return to one key-store round trip per record, not against a slow laptop.
    expect(sorted[3]!).toBeLessThan(2000);
  }, 120_000);
});
