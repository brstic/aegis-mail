import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createTestDb } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { mime } from "@aegis/test-fixtures";
import { connectAccount, createPlatform, drainJobs, enqueue, getFocus, getThread, listThreads, makeLogger, signUp } from "../index";

/** Local measurement to set SLOs from evidence: one laptop, one Postgres, synthetic mail. */
const N = Number(process.argv[2] ?? 1000);
const { db, drop } = await createTestDb("bench");
const p = createPlatform({ db, kms: new LocalDevKms(randomBytes(32)), log: makeLogger(() => {}), env: {}, config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" } });
const s = await signUp(p, { email: "bench@example.org", password: "correct-horse-battery", name: "Bench", workspaceKind: "personal" });
const ctx = { tenantId: s.tenantId, userId: s.userId };
const acct = await connectAccount(p, ctx, { kind: "demo", email: "bench@example.org", displayName: "B", credential: { kind: "demo" } });
await drainJobs(p);
const WORDS = "budget invoice contract proposal meeting review schedule delivery client project update report quarter launch design".split(" ");
for (let i = 0; i < N; i++) {
  const w = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  const raw = Buffer.from(mime({ from: `"Sender ${i % 60}" <s${i % 60}@org${i % 12}.test>`, subject: `${w()} ${w()} ${i}`, text: Array.from({ length: 80 }, w).join(" ") + " Can you take a look?", html: i % 3 ? undefined : `<p>${w()}</p><a href="https://org${i % 12}.test/x">link</a>` }));
  await p.db.withWorker(ctx.tenantId, t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw) VALUES ($1,$2,$3,$4,$5)", [acct, ctx.tenantId, `b${i}`, new Date(Date.now() - i * 6e4), raw]));
}
await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId: acct } }));
const t0 = Date.now();
await drainJobs(p);
const ingestMs = Date.now() - t0;
const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))]!;
async function time(name: string, fn: () => Promise<unknown>, runs = 30) {
  const xs: number[] = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); await fn(); xs.push(performance.now() - t); }
  return { name, p50: Math.round(pct(xs, 0.5)), p95: Math.round(pct(xs, 0.95)) };
}
const first = (await listThreads(p, ctx, { view: "inbox", limit: 1 })).items[0]!;
const results = [
  await time("Inbox page (50 threads)", () => listThreads(p, ctx, { view: "inbox", limit: 50 })),
  await time("Focus", () => getFocus(p, ctx)),
  await time("Search, one term", () => listThreads(p, ctx, { view: "inbox", q: "budget", limit: 50 })),
  await time("Search, field + filter", () => listThreads(p, ctx, { view: "inbox", q: "from:sender subject:invoice is:unread", limit: 50 })),
  await time("Open thread", () => getThread(p, ctx, first.id)),
];
const lines = ["# Measured performance", "", `\`pnpm bench ${N}\` on ${new Date().toISOString().slice(0, 10)}: one laptop, local PostgreSQL, ${N} synthetic messages, no network or provider latency. A starting point for SLOs, not a production measurement.`, "", `Ingestion (parse, scan, encrypt, classify, store): **${(N / (ingestMs / 1000)).toFixed(0)} messages/s**, one worker.`, "", "| Operation | p50 ms | p95 ms |", "|---|---|---|", ...results.map(r => `| ${r.name} | ${r.p50} | ${r.p95} |`), ""];
writeFileSync(new URL("../../../../docs/bench.md", import.meta.url), lines.join("\n"));
console.log(lines.join("\n"));
await drop();
