import { existsSync, readFileSync } from "node:fs";
import { createPlatform, DEMO_LOGIN, seedDemo } from "../index";
if (existsSync(".env")) for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]; }
const p = createPlatform();
const r = await seedDemo(p);
console.log(r.created ? `Seeded demo workspace. Sign in with ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}` : "Demo workspace already exists.");
await p.db.close();
