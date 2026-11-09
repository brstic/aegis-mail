import { existsSync } from "node:fs";
import { createPlatform, DEMO_LOGIN, seedDemo } from "../index";
// Node's own parser, the same one the worker's --env-file uses: it handles quotes, comments and Windows line endings.
if (existsSync(".env")) process.loadEnvFile(".env");
const p = createPlatform();
const r = await seedDemo(p);
console.log(r.created ? `Seeded demo workspace. Sign in with ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}` : "Demo workspace already exists.");
await p.db.close();
