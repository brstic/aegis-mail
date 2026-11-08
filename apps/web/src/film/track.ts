import { gOf, type ChapterId } from "./store";

/**
 * A value that follows the scroll through keys placed on chapters. Monotone cubic: it passes through every key and never
 * overshoots, so a held key really holds. The camera and the letter both ride one of these.
 */
export interface Key { ch: ChapterId; t: number; v: number[]; cut?: boolean }
interface Run { xs: number[]; ys: number[][]; tan: number[][] }

function tangents(xs: number[], ys: number[]) {
  const n = xs.length;
  const d = new Array<number>(n).fill(0);
  if (n < 2) return d;
  const h: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) { h[i] = Math.max(1e-6, xs[i + 1]! - xs[i]!); m[i] = (ys[i + 1]! - ys[i]!) / h[i]!; }
  d[0] = m[0]!; d[n - 1] = m[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1]! * m[i]! <= 0) { d[i] = 0; continue; }
    const a = 2 * h[i]! + h[i - 1]!, b = h[i]! + 2 * h[i - 1]!;
    d[i] = (a + b) / (a / m[i - 1]! + b / m[i]!);
  }
  return d;
}

export class Track {
  private runs: Run[] = [];
  readonly out: number[];
  constructor(private fields: number) { this.out = new Array<number>(fields).fill(0); }

  compile(keys: Key[]) {
    const placed = keys.map(k => ({ ...k, g: gOf(k.ch, k.t) })).sort((a, b) => a.g - b.g);
    this.runs = [];
    let cur: typeof placed = [];
    const close = () => {
      if (!cur.length) return;
      const xs = cur.map(k => k.g);
      const ys: number[][] = [], tan: number[][] = [];
      for (let f = 0; f < this.fields; f++) { ys[f] = cur.map(k => k.v[f]!); tan[f] = tangents(xs, ys[f]!); }
      this.runs.push({ xs, ys, tan });
      cur = [];
    };
    for (const k of placed) { if (k.cut) close(); cur.push(k); }
    close();
  }

  at(y: number): number[] {
    const R = this.runs;
    if (!R.length) return this.out;
    let run = R[0]!;
    for (const r of R) { if (y >= r.xs[0]!) run = r; else break; }
    const xs = run.xs, n = xs.length;
    if (y <= xs[0]!) { for (let f = 0; f < this.fields; f++) this.out[f] = run.ys[f]![0]!; return this.out; }
    if (y >= xs[n - 1]!) { for (let f = 0; f < this.fields; f++) this.out[f] = run.ys[f]![n - 1]!; return this.out; }
    let i = 0;
    while (i < n - 2 && y >= xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!, t = (y - xs[i]!) / h, t2 = t * t, t3 = t2 * t;
    for (let f = 0; f < this.fields; f++) {
      const a = run.ys[f]![i]!, b = run.ys[f]![i + 1]!, d0 = run.tan[f]![i]!, d1 = run.tan[f]![i + 1]!;
      this.out[f] = (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * h * d0 + (-2 * t3 + 3 * t2) * b + (t3 - t2) * h * d1;
    }
    return this.out;
  }
}
