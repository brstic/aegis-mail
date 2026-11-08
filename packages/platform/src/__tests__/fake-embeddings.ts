import { createHash } from "node:crypto";
import type { EmbeddingProvider } from "../embeddings";

/** Deterministic and instant: words hash into buckets, so texts sharing words are close. It knows nothing about meaning. */
export class FakeEmbeddings implements EmbeddingProvider {
  readonly id = "fake-bag-of-words";
  readonly dimensions = 64;
  calls: string[][] = [];
  /** Runs while a document is "being embedded", for testing what can change during that gap. */
  during?: () => Promise<void>;
  fail = false;
  async embed(texts: string[]) {
    this.calls.push(texts);
    if (this.fail) throw new Error("fake model failure");
    if (this.during) { const f = this.during; this.during = undefined; await f(); }
    return texts.map(t => {
      const v = new Float32Array(this.dimensions);
      for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) v[createHash("sha256").update(w).digest().readUInt16BE(0) % this.dimensions]! += 1;
      const n = Math.hypot(...v) || 1;
      return v.map(x => x / n);
    });
  }
}
