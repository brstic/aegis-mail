import { createPlatform, kmsConfigured, kmsFromEnv, type Platform } from "@aegis/platform";
import { existsSync } from "node:fs";
import { join } from "node:path";

const rootEnv = join(process.cwd(), "../../.env");
// Node's own parser, the same one the worker's --env-file uses: it handles quotes, comments and Windows line endings.
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const g = globalThis as unknown as { __aegis?: Platform };
/** One pool per process, surviving Next's dev module reloads. The web process logs in as the web role only. */
export function platform(): Platform {
  if (kmsConfigured() && !g.__aegis) throw new Error("Call initPlatform() first when a root key or KMS is configured");
  return (g.__aegis ??= createPlatform({ processRole: "web" }));
}
/** The root of trust loads asynchronously. Runs at server start, from instrumentation.ts. */
export async function initPlatform() { if (!g.__aegis) g.__aegis = createPlatform({ processRole: "web", kms: await kmsFromEnv() }); }
