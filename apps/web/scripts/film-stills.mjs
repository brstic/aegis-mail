// Renders the frames shown to people who get the plain page: reduced motion, or no WebGL. Needs the site running.
//   node apps/web/scripts/film-stills.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
const base = process.env.FILM_URL ?? "http://localhost:3130";
const STILLS = { flurry: 0.08, stream: 0.62, seals: 0.97, autopsy: 0.72, xray: 0.9, uv: 0.5, scale: 0.6, case: 0.6, focus: 0.7, glass: 0.6, vault: 0.85, calm: 0.5 };
const OUT = new URL("../public/film/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 750 }, colorScheme: "light" })).newPage();
await page.goto(`${base}/?qa=1&tier=high`, { waitUntil: "domcontentloaded", timeout: 120_000 });
await page.waitForFunction(() => window.__film?.ready?.() === true, null, { timeout: 120_000 });
await page.waitForTimeout(2500);
await page.addStyleTag({ content: "header,.beat,.film-tag,#film-lines,#film-progress,nextjs-portal{display:none!important}" });
for (const [id, t] of Object.entries(STILLS)) {
  await page.evaluate(([id, t]) => { window.__film.seek(id, t); }, [id, t]);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}${id}.jpg`, type: "jpeg", quality: 74 });
}
await browser.close();
