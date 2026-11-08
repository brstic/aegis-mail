// Runs the whole film on the real GPU and prints frame times per chapter. Needs the site running.
//   node apps/web/scripts/film-perf.mjs 1440x900@2 [seconds] [tier] [cpu slowdown]
import { chromium } from "@playwright/test";
const [size = "1440x900@2", secs = "45", tier = "high", slow = "1"] = process.argv.slice(2);
const [wh, dpr = "1"] = size.split("@");
const [width, height] = wh.split("x").map(Number);
const base = process.env.FILM_URL ?? "http://localhost:3130";
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(dpr) });
const page = await ctx.newPage();
if (Number(slow) > 1) { const c = await ctx.newCDPSession(page); await c.send("Emulation.setCPUThrottlingRate", { rate: Number(slow) }); }
const t0 = Date.now();
await page.goto(`${base}/?qa=1&tier=${tier}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(() => window.__film?.ready?.() === true, null, { timeout: 180_000 });
console.log("first frame after", Date.now() - t0, "ms");
await page.waitForTimeout(5000);
const r = await page.evaluate(async secs => {
  const f = window.__film.film, ids = window.__film.chapters, last = f.ranges.calm, total = last.top + last.h * 0.6;
  const by = {}; const start = performance.now(); let prev = start, chap = ids[0];
  await new Promise(done => { const step = now => {
    const g = now - prev; prev = now;
    (by[chap] ??= []).push(g);
    const p = (now - start) / (secs * 1000), y = Math.min(1, p) * total;
    window.scrollTo(0, y);
    for (const id of ids) if (y >= f.ranges[id].top) chap = id;
    if (p < 1) requestAnimationFrame(step); else done();
  }; requestAnimationFrame(step); });
  const g = window.__three?.gl; const out = {};
  for (const [k, v] of Object.entries(by)) { const s = [...v].sort((a, b) => a - b); out[k] = { fps: Math.round(1000 / (v.reduce((a, b) => a + b, 0) / v.length)), p95: Math.round(s[Math.floor(s.length * 0.95)]), worst: Math.round(s[s.length - 1]) }; }
  return { out, textures: g?.info.memory.textures, geometries: g?.info.memory.geometries, programs: g?.info.programs?.length };
}, Number(secs));
for (const [k, v] of Object.entries(r.out)) console.log(k.padEnd(9), `${v.fps} fps  p95 ${v.p95} ms  worst ${v.worst} ms`);
console.log(`textures ${r.textures}, geometries ${r.geometries}, programs ${r.programs}`);
await browser.close();
