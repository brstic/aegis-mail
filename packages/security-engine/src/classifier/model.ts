/**
 * A small logistic-regression text classifier over hashed word unigrams and bigrams. No dependencies, runs in microseconds,
 * nothing leaves the process, and it's linear in input size. Weights come from `pnpm train` on synthetic training text only.
 */
export const DIM = 1 << 16;

export function features(text: string): Map<number, number> {
  const words = text.toLowerCase().slice(0, 20_000).match(/[a-z][a-z'-]{1,24}/g) ?? [];
  const f = new Map<number, number>();
  const bump = (s: string) => { const h = hash(s); f.set(h, (f.get(h) ?? 0) + 1); };
  for (let i = 0; i < words.length; i++) {
    bump(words[i]!);
    if (i + 1 < words.length) bump(`${words[i]} ${words[i + 1]}`);
  }
  // Length-normalized, so padding doesn't dilute or inflate a score.
  const norm = Math.sqrt([...f.values()].reduce((s, v) => s + v * v, 0)) || 1;
  for (const [k, v] of f) f.set(k, v / norm);
  return f;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % DIM;
}

export interface LinearModel { version: string; bias: number; weights: Record<string, number> }

export function score(model: LinearModel, text: string): number {
  let z = model.bias;
  for (const [k, v] of features(text)) z += (model.weights[k] ?? 0) * v;
  return 1 / (1 + Math.exp(-z));
}

export function train(samples: { text: string; y: 0 | 1 }[], opts: { epochs?: number; lr?: number; l2?: number; seed?: number } = {}): LinearModel {
  const { epochs = 30, lr = 0.5, l2 = 1e-4, seed = 42 } = opts;
  const w = new Float64Array(DIM);
  let bias = 0, s = seed;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const data = samples.map(x => ({ f: [...features(x.text)], y: x.y }));
  for (let e = 0; e < epochs; e++) {
    for (let i = data.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [data[i], data[j]] = [data[j]!, data[i]!]; }
    const rate = lr / (1 + e * 0.1);
    for (const { f, y } of data) {
      let z = bias;
      for (const [k, v] of f) z += w[k]! * v;
      const err = y - 1 / (1 + Math.exp(-z));
      bias += rate * err;
      for (const [k, v] of f) w[k]! += rate * (err * v - l2 * w[k]!);
    }
  }
  const weights: Record<string, number> = {};
  for (let i = 0; i < DIM; i++) if (Math.abs(w[i]!) > 0.01) weights[i] = Math.round(w[i]! * 1000) / 1000;
  return { version: "synthetic-lr-1", bias: Math.round(bias * 1000) / 1000, weights };
}
