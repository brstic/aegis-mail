import { existsSync, readFileSync } from "node:fs";
import { createPlatform, grantOperator, kmsFromEnv, listOperators, revokeOperator, syncOperatorsFromEnv } from "../index";

/**
 * Operator access, on the migrating connection only. The web and worker logins can't reach these functions.
 *   pnpm operators sync            make env-sourced operators match AEGIS_PLATFORM_ADMINS
 *   pnpm operators grant <email>   grant one verified account
 *   pnpm operators revoke <email>
 *   pnpm operators list
 */
if (existsSync(".env")) for (const l of readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]; }
const [cmd, arg] = process.argv.slice(2);
const p = createPlatform({ kms: await kmsFromEnv() });
const NEEDS = { no_account: "no account with this address yet: create it first", unverified: "this account's address isn't verified: verify it first" } as Record<string, string>;
try {
  if (cmd === "sync") {
    for (const r of await syncOperatorsFromEnv(p, process.env.AEGIS_PLATFORM_ADMINS)) console.log(`${r.email}: ${NEEDS[r.outcome] ?? r.outcome}${r.outcome === "granted" && !r.mfa ? " (no authenticator app yet, so /admin stays closed until MFA is on)" : ""}`);
  } else if (cmd === "grant" && arg) {
    const r = await grantOperator(p, arg, "cli");
    console.log(`${arg}: ${NEEDS[r.outcome] ?? r.outcome}`);
    if (r.outcome !== "granted") process.exitCode = 1;
  } else if (cmd === "revoke" && arg) {
    console.log(`${arg}: ${(await revokeOperator(p, arg)) ? "revoked" : "nothing to revoke"}`);
  } else if (cmd === "list") {
    for (const o of await listOperators(p)) console.log(`${o.email}\t${o.source}\t${o.revoked_at ? "revoked" : "active"}`);
  } else {
    console.error("usage: operators sync | grant <email> | revoke <email> | list");
    process.exitCode = 1;
  }
} finally { await p.db.close(); }
