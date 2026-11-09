import { existsSync } from "node:fs";
import { Db } from "@aegis/db";
import { connectionFor, DeletionLogBrokenError, DeletionLogUnavailableError, reapplyDeletions, type ReapplyOptions } from "../index";

/**
 * Re-applies logged deletions to a restored database, before anyone can reach it. See docs/runbooks/backup-restore.md.
 *   pnpm restore:reapply <log path> [--expect-head=<seq>:<hash>] [--verify-only] [--allow-broken-chain]
 * Connects as DATABASE_URL_RESTORE, a member of aegis_restore_conn. Needs no KMS access. Prints counts and never an id.
 * Exit: 0 applied, 1 failed part way (safe to run again), 2 log refused and nothing applied, 64 usage.
 */
// Node's own parser, the same one the worker's --env-file uses: it handles quotes, comments and Windows line endings.
if (existsSync(".env")) process.loadEnvFile(".env");
const USAGE = "usage: restore:reapply <log path> [--expect-head=<seq>:<hash>] [--verify-only] [--allow-broken-chain]";
const opts: ReapplyOptions = {};
let path: string | undefined, bad = false;
for (const a of process.argv.slice(2)) {
  if (a === "--") continue;
  const head = a.match(/^--expect-head=(\d+):([0-9a-f]{64})$/);
  if (a === "--allow-broken-chain") opts.allowBrokenChain = true;
  else if (a === "--verify-only") opts.verifyOnly = true;
  else if (head) opts.expectHead = { seq: Number(head[1]), hash: head[2]! };
  else if (a.startsWith("--") || path) bad = true;
  else path = a;
}
if (bad || !path) { console.error(USAGE); process.exit(64); }

let url: string;
try { url = connectionFor("restore", process.env); } catch (e) { console.error(e instanceof Error ? e.message : "No database connection configured."); process.exit(64); }
const db = new Db(url, 4);
try {
  const r = await reapplyDeletions(db, path, opts);
  if (r.otherConnections) console.warn(`warning: ${r.otherConnections} other session(s) on this database. Nothing should be able to reach it until this has finished.`);
  if (!r.chain.ok) console.warn(`warning: --allow-broken-chain was used. The log has ${r.chain.problems.length} problem(s) and ${r.skippedLines} line(s) were left out, so some deletions may not have been re-applied. Investigate before opening this database.`);
  for (const p of r.chain.problems.slice(0, 20)) console.warn(`  line ${p.line}: ${p.code}`);
  console.log(`log: ${r.chain.lines} line(s), chain ${r.chain.ok ? "intact" : "BROKEN"}, head ${r.chain.head.seq}:${r.chain.head.hash}`);
  console.log(`witness: ${r.chain.witnessRows} shipped row(s) in the restored database checked against the log`);
  // A file can't show its own last lines were removed. Only --expect-head or the witness can.
  if (!opts.expectHead) console.log("head not compared: check it against the newest deletion_log.shipped line in your logs, or pass --expect-head");
  console.log(`entries: ${r.entries} (${r.unshippedInBackup} from the backup's own unshipped rows)`);
  if (opts.verifyOnly) console.log("verify only: nothing was applied");
  else {
    for (const k of Object.keys(r.applied) as (keyof typeof r.applied)[]) if (r.applied[k] || r.alreadyErased[k]) console.log(`${k}: ${r.applied[k]} applied, ${r.alreadyErased[k]} already erased`);
    if (r.shredsQueued) console.log(`shreds queued: ${r.shredsQueued}, for suspended workspaces. They wait in the worker, like the live ones.`);
    console.log("done. This re-applies deletions to this database only. The backup file itself is unchanged and stays readable until it expires.");
  }
} catch (e) {
  if (e instanceof DeletionLogBrokenError || e instanceof DeletionLogUnavailableError) { console.error(e.message); process.exitCode = 2; }
  else { console.error(`Stopped part way: ${e instanceof Error ? e.message : "unknown error"}. Every step is idempotent, so fix that and run it again.`); process.exitCode = 1; }
} finally { await db.close(); }
