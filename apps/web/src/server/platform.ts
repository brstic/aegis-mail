import { createPlatform, kmsConfigured, kmsFromEnv, type Platform } from "@aegis/platform";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const rootEnv = join(process.cwd(), "../../.env");
if (existsSync(rootEnv)) for (const l of readFileSync(rootEnv, "utf8").split("\n")) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]; }

const g = globalThis as unknown as { __aegis?: Platform };
/** One pool per process, surviving Next's dev module reloads. The web process logs in as the web role only. */
export function platform(): Platform {
  if (kmsConfigured() && !g.__aegis) throw new Error("Call initPlatform() first when a root key or KMS is configured");
  return (g.__aegis ??= createPlatform({ processRole: "web" }));
}
/** The root of trust loads asynchronously. Runs at server start, from instrumentation.ts. */
export async function initPlatform() { if (!g.__aegis) g.__aegis = createPlatform({ processRole: "web", kms: await kmsFromEnv() }); }
