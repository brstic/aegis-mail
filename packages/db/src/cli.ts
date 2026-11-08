import { readFileSync, existsSync } from "node:fs";
import { createDatabase, dropDatabase, ensureLogin, migrate } from "./index";

if (existsSync(".env")) for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]; }
const url = process.env.DATABASE_URL ?? "postgres://localhost:5432/aegis_dev";
const cmd = process.argv[2];
const log = (s: string) => console.log(s);
/** Local-only login roles. Production provisions its own, with passwords, in its secret manager. */
async function devLogins() {
  await migrate(url, { log });
  // A deployment already holds real logins in its secret manager. A passwordless role here would only be clutter to audit.
  if (process.env.NODE_ENV === "production" && process.env.DEMO_MODE !== "true") return;
  await ensureLogin(url, "aegis_web_login", "aegis_web_conn");
  await ensureLogin(url, "aegis_worker_login", "aegis_worker_conn");
  await ensureLogin(url, "aegis_restore_login", "aegis_restore_conn");
}
if (cmd === "create") { await createDatabase(url); log("database ready"); }
else if (cmd === "migrate") { await devLogins(); log("migrations applied"); }
else if (cmd === "reset") { await dropDatabase(url); await createDatabase(url); await devLogins(); log("database reset"); }
else { console.error("usage: cli.ts create|migrate|reset"); process.exit(1); }
