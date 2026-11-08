// Screenshots any moment of the film on the real GPU, for looking at it. Needs the site running.
//   node apps/web/scripts/film-shot.mjs <out dir> <WxH> chapter:time [chapter:time ...]
//   Options as env: FILM_URL (default http://localhost:3130), FILM_THEME=dark, FILM_POINTER=0.3,-0.2, FILM_CONTROLS='{"forged":true}'
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const [out, size, ...moments] = process.argv.slice(2);
if (!out || !size || !moments.length) { console.error("usage: film-shot.mjs <out dir> <WxH> chapter:time ..."); process.exit(2); }
const [width, height] = size.split("x").map(Number);
const base = process.env.FILM_URL ?? "http://localhost:3130";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: Number(process.env.FILM_DPR ?? 1), colorScheme: process.env.FILM_THEME === "dark" ? "dark" : "light" });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", e => problems.push(e.message));
page.on("console", m => { if (m.type() === "error") problems.push(m.text()); });
await page.goto(`${base}/?qa=1&tier=${process.env.FILM_TIER ?? "high"}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(() => window.__film?.ready?.() === true, null, { timeout: 120_000 });
await page.waitForTimeout(2500);
if (process.env.FILM_CONTROLS) await page.evaluate(c => Object.assign(window.__film.film.controls, JSON.parse(c)), process.env.FILM_CONTROLS);
for (const moment of moments) {
  const [id, t] = moment.split(":");
  const y = await page.evaluate(([id, t]) => window.__film.seek(id, +t), [id, t]);
  if (process.env.FILM_POINTER) {
    const [px, py] = process.env.FILM_POINTER.split(",").map(Number);
    await page.mouse.move(((px + 1) / 2) * width, ((py + 1) / 2) * height);
  }
  await page.waitForTimeout(Number(process.env.FILM_SETTLE ?? 900));
  const name = `${id}-${t}${process.env.FILM_TAG ? "-" + process.env.FILM_TAG : ""}.png`;
  await page.screenshot({ path: `${out}/${name}` });
  console.log(name, "y=" + Math.round(y));
}
const info = await page.evaluate(() => { const g = window.__three?.gl; const c = g?.getContext(); const e = c?.getExtension("WEBGL_debug_renderer_info"); return { calls: g?.info.render.calls, tris: g?.info.render.triangles, fps: window.__film.film.fps, gpu: e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : "?" }; });
console.log(JSON.stringify(info));
if (problems.length) console.log("PROBLEMS\n" + [...new Set(problems)].slice(0, 12).join("\n"));
await browser.close();
