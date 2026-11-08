// Puts screenshots on one contact sheet, for looking at many moments at once.
//   node apps/web/scripts/film-sheet.mjs <out.png> <columns> <image> [image ...]
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
const [out, cols, ...files] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1900, height: 1000 } });
const cells = files.map(f => `<figure style="margin:0"><img style="width:100%;display:block" src="data:image/png;base64,${readFileSync(f).toString("base64")}"><figcaption style="font:13px monospace;padding:2px 4px;background:#222;color:#fff">${f.split("/").pop()}</figcaption></figure>`).join("");
await p.setContent(`<body style="margin:0;background:#222;display:grid;gap:4px;grid-template-columns:repeat(${cols},1fr)">${cells}</body>`);
await p.waitForTimeout(300);
await p.screenshot({ path: out, fullPage: true });
await b.close();
