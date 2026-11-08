import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/content.ts"], bundle: true, format: "iife", target: "chrome110", outfile: "dist/content.js", minify: true,
  // Browsers have no domainToUnicode. See src/url-shim.ts and the README for what that misses.
  alias: { "node:url": "./src/url-shim.ts" },
});
copyFileSync("manifest.json", "dist/manifest.json");
console.log("Built dist/");
