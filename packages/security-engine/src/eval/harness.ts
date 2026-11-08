import { CORPUS, HOLDOUT, mime, type Sample } from "@aegis/test-fixtures";
import { parseMail } from "@aegis/mail-parser";
import { analyzeMessage, ENGINE_VERSION, EMPTY_RELATIONSHIP } from "../index";

export interface SetMetrics { n: number; tp: number; fp: number; tn: number; fn: number; precision: number | null; recall: number | null; fpr: number | null }
export interface EvalReport {
  engineVersion: string; corpus: string; generatedAt: string;
  sets: Record<string, SetMetrics>; overallCore: SetMetrics;
  ece: number; byCategory: Record<string, { n: number; caught: number }>;
  misses: { id: string; set: string; p: number; label: string }[];
  falsePositives: { id: string; p: number; label: string; codes: string[] }[];
}

const FLAGGED = new Set(["suspicious", "high_risk", "malicious"]);

function metrics(rows: { malicious: boolean; flagged: boolean }[]): SetMetrics {
  const tp = rows.filter(r => r.malicious && r.flagged).length, fp = rows.filter(r => !r.malicious && r.flagged).length;
  const tn = rows.filter(r => !r.malicious && !r.flagged).length, fn = rows.filter(r => r.malicious && !r.flagged).length;
  return { n: rows.length, tp, fp, tn, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, fpr: fp + tn ? fp / (fp + tn) : null };
}

/** Expected calibration error over 5 bins. Measured on the synthetic corpus only. */
function ece(rows: { malicious: boolean; p: number }[]): number {
  let total = 0;
  for (let b = 0; b < 5; b++) {
    const lo = b / 5, hi = (b + 1) / 5;
    const bin = rows.filter(r => r.p >= lo && (b === 4 ? r.p <= hi : r.p < hi));
    if (!bin.length) continue;
    const acc = bin.filter(r => r.malicious).length / bin.length;
    const conf = bin.reduce((s, r) => s + r.p, 0) / bin.length;
    total += (bin.length / rows.length) * Math.abs(acc - conf);
  }
  return total;
}

async function holdoutRows() {
  const out: { split: "dev" | "test"; malicious: boolean; flagged: boolean }[] = [];
  for (const malicious of [true, false]) {
    const xs = HOLDOUT.filter(s => s.malicious === malicious);
    for (const [i, s] of xs.entries()) {
      const mail = await parseMail(Buffer.from(mime({ from: s.from, subject: s.subject, text: s.text, auth: "pass" })));
      const r = await analyzeMessage(mail, mail.attachments, { relationship: { ...EMPTY_RELATIONSHIP, ownerNames: ["morgan lee"], ownDomains: ["fernhill.example"] } });
      out.push({ split: i % 2 === 1 ? "dev" : "test", malicious, flagged: FLAGGED.has(r.label) });
    }
  }
  return out;
}

export async function runEval(samples: Sample[] = CORPUS): Promise<EvalReport> {
  const rows: { s: Sample; malicious: boolean; flagged: boolean; p: number; label: string; codes: string[] }[] = [];
  for (const s of samples) {
    const mail = await parseMail(Buffer.from(s.raw));
    const attachments = mail.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size, sha256: a.sha256, content: a.content }));
    const r = await analyzeMessage(mail, attachments, { relationship: { ...EMPTY_RELATIONSHIP, ownerNames: ["morgan lee"], ownDomains: ["fernhill.example"], ...s.relationship } });
    rows.push({ s, malicious: s.malicious, flagged: FLAGGED.has(r.label), p: r.threatProbability, label: r.label as string, codes: r.evidence.filter(e => e.weight > 0).map(e => e.code) });
  }
  // Independent set, split once. "dev" was inspected while improving rules. "test" is only ever scored, never read: changing
  // rules in response to its failures would make it another dev set.
  const held = await holdoutRows();
  const bySet = (name: string) => rows.filter(r => r.s.set === name);
  const sets: Record<string, SetMetrics> = {};
  for (const n of ["core", "benign", "benign_hard", "adversarial"]) sets[n] = metrics(bySet(n));
  sets.holdout_dev = metrics(held.filter(r => r.split === "dev"));
  sets.holdout_test = metrics(held.filter(r => r.split === "test"));
  const overallCore = metrics(rows.filter(r => r.s.set !== "adversarial"));
  const byCategory: EvalReport["byCategory"] = {};
  for (const r of rows.filter(x => x.malicious)) {
    const c = (byCategory[r.s.category ?? "unknown"] ??= { n: 0, caught: 0 });
    c.n++; if (r.flagged) c.caught++;
  }
  return {
    engineVersion: ENGINE_VERSION, corpus: "synthetic, hand-written, not field data", generatedAt: new Date().toISOString(),
    sets, overallCore, ece: ece(rows), byCategory,
    misses: rows.filter(r => r.malicious && !r.flagged).map(r => ({ id: r.s.id, set: r.s.set, p: +r.p.toFixed(3), label: r.label })),
    falsePositives: rows.filter(r => !r.malicious && r.flagged).map(r => ({ id: r.s.id, p: +r.p.toFixed(3), label: r.label, codes: r.codes })),
  };
}
