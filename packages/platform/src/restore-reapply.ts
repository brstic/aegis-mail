import { readFile } from "node:fs/promises";
import type { Db } from "@aegis/db";
import { audit } from "./audit";
import { type DeletionEntry, DeletionLogBrokenError, ERASURE_KINDS, type ErasureKind, type LogProblem, outboxEntry, type SinkReceipt, verifyLogText } from "./deletion-log";
import { destroyCredential, eraseAccount, eraseMailboxContent, eraseSealedPlaintext, eraseSearchWords, type ErasureScope, shredTenantTx, tombstoneAndPurge } from "./erasure";
import { recountThread } from "./ingest";
import { cancelJobs, enqueue } from "./jobs";
import { deleteOwnedEmbeddings } from "./semantic-search";

/**
 * Replays a deletion log against a restored database, before anyone can reach it. Takes a Db and no Platform on purpose: it holds no KMS
 * and can't read mail, and it runs on the restore operator's login (migration 019). It doesn't call providers either: their grants
 * were revoked, or the instructions shown, when the deletion happened.
 */
export interface ReapplyOptions {
  /** Apply what can be trusted despite a broken chain: every line whose own hash holds. Lines that fail it are skipped and counted. */
  allowBrokenChain?: boolean;
  /** The head from the worker's `deletion_log.shipped` log line, or wherever else it's been kept apart from this file. */
  expectHead?: SinkReceipt;
  /** Check the chain and the witnesses, and change nothing. */
  verifyOnly?: boolean;
}
export type KindCounts = Record<ErasureKind, number>;
export interface ReapplyReport {
  chain: { ok: boolean; lines: number; head: SinkReceipt; problems: LogProblem[]; witnessRows: number };
  /** Entries from the log, plus any row the backup held that hadn't been shipped when it was taken. */
  entries: number;
  unshippedInBackup: number;
  applied: KindCounts;
  alreadyErased: KindCounts;
  /** A personal workspace under suspension when its owner's deletion was logged: its shred is queued, and waits like the live one. */
  shredsQueued: number;
  /** Lines left out under allowBrokenChain. */
  skippedLines: number;
  /** Other sessions on this database. There should be none, because nothing is meant to be reaching it yet. */
  otherConnections: number;
}
const zeroCounts = () => Object.fromEntries(ERASURE_KINDS.map(k => [k, 0])) as KindCounts;
const REASON = { reason: "restore_reapply" };

export class DeletionLogUnavailableError extends Error { override name = "DeletionLogUnavailableError"; }

export async function reapplyDeletions(db: Db, logPath: string, opts: ReapplyOptions = {}): Promise<ReapplyReport> {
  let text: string;
  try { text = await readFile(logPath, "utf8"); } catch { throw new DeletionLogUnavailableError("Can't read the deletion log at that path. Nothing was applied. A missing log isn't the same as no deletions."); }
  const schema = await db.withSystem(t => t.one<{ r: string | null }>("SELECT to_regclass('public.deletion_outbox')::text r"));
  if (!schema?.r) throw new DeletionLogUnavailableError("This database has no deletion_outbox table, so the backup predates migration 019. Run pnpm db:migrate first. Nothing was applied.");

  const log = verifyLogText(text);
  const outbox = await db.withSystem(t => t.query<any>("SELECT * FROM deletion_outbox"));
  const problems = [...log.problems, ...witnessProblems(log, outbox)];
  if (opts.expectHead && (log.head.seq !== opts.expectHead.seq || log.head.hash !== opts.expectHead.hash)) problems.push({ line: opts.expectHead.seq, code: "head_mismatch" });
  const witnessRows = outbox.filter(r => r.sink_seq != null).length;
  if (problems.length && !opts.allowBrokenChain) throw new DeletionLogBrokenError(problems, "deletion_log_broken", `${problemsMessage(problems)} Nothing was applied. Find an intact copy of the log. If there isn't one, --allow-broken-chain applies the lines that hold together and reports the rest.`);

  const inLog = new Set(log.entries.map(e => e.id));
  // Committed before the backup was taken and not in this log: its erasure is in the backup, and a replay finishes whatever followed from it.
  const unshipped = outbox.filter(r => r.shipped_at == null && !inLog.has(r.id)).map(outboxEntry);
  const entries: DeletionEntry[] = [...log.entries, ...unshipped];
  const conns = await db.withSystem(t => t.one<{ c: number }>("SELECT count(*)::int c FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"));
  const report: ReapplyReport = {
    chain: { ok: problems.length === 0, lines: log.lines, head: log.head, problems, witnessRows },
    entries: entries.length, unshippedInBackup: unshipped.length, applied: zeroCounts(), alreadyErased: zeroCounts(), shredsQueued: 0,
    skippedLines: log.lines - log.entries.length + (log.problems.some(p => p.code === "torn_tail") ? 1 : 0), otherConnections: conns?.c ?? 0,
  };
  if (opts.verifyOnly) return report;
  // Every statement is idempotent, so a run that dies here is finished by running it again.
  for (const e of entries) (await replayEntry(db, e, report)) ? report.applied[e.kind]++ : report.alreadyErased[e.kind]++;
  return report;
}

/** A restored database knows what had been shipped by the time of its backup, independently of the log's own storage. */
function witnessProblems(log: ReturnType<typeof verifyLogText>, outbox: any[]): LogProblem[] {
  const bySeq = new Map(log.entries.map(e => [e.seq, e]));
  const out: LogProblem[] = [];
  for (const r of outbox) {
    if (r.sink_seq == null) continue;
    const line = bySeq.get(Number(r.sink_seq));
    if (!line) out.push({ line: Number(r.sink_seq), code: "witness_missing" });
    else if (line.id !== r.id || line.hash !== r.sink_hash) out.push({ line: Number(r.sink_seq), code: "witness_mismatch" });
  }
  return out.sort((a, b) => a.line - b.line);
}
function problemsMessage(problems: LogProblem[]) { return new DeletionLogBrokenError(problems).message; }

/** True if it found something to erase. */
async function replayEntry(db: Db, e: DeletionEntry, report: ReapplyReport): Promise<boolean> {
  switch (e.kind) {
    case "account": return replayAccount(db, e.userId!, report);
    case "tenant_shred": return replayShred(db, e.tenantId!);
    case "mailbox": return replayMailbox(db, e.tenantId!, e.accountId!);
    case "credential": return replayCredential(db, e.tenantId!, e.accountId!);
    case "message_sealed": return replaySealed(db, e.tenantId!, e.messageId!);
    case "message_purged": return replayPurged(db, e.tenantId!, e.messageId!);
    case "search_off": return replayOptOut(db, e.tenantId!, e.userId!, "search");
    case "vectors_off": return replayOptOut(db, e.tenantId!, e.userId!, "vectors");
  }
}

async function replayAccount(db: Db, userId: string, report: ReapplyReport) {
  const live = await db.withSystem(t => t.one("SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL", [userId]));
  if (!live) return false;
  const scope: ErasureScope = {
    db,
    tenantTx: (c, fn) => db.withWorker(c.tenantId, fn),
    eraseMailbox: async (c, accountId) => { await replayMailbox(db, c.tenantId, accountId); },
    auditMeta: REASON,
    // The live deletion queued this shred, and may not have run it: a suspension holds it. A logged tenant_shred means it did run.
    shredPersonal: async tenantId => {
      const held = await db.withWorker(tenantId, t => t.one("SELECT 1 FROM tenant_suspensions WHERE tenant_id=$1", [tenantId]));
      if (!held) { await replayShred(db, tenantId); return; }
      await db.withSystem(t => enqueue(t, { tenantId, kind: "tenant.shred" }));
      report.shredsQueued++;
    },
  };
  await eraseAccount(scope, userId);
  return true;
}

async function replayShred(db: Db, tenantId: string) {
  return db.withWorker(tenantId, async t => {
    const destroyed = await shredTenantTx(t, tenantId);
    if (destroyed) await audit(t, { tenantId, event: "key.shredded", meta: { kind: "tenant", ...REASON } });
    return destroyed > 0;
  });
}

async function replayMailbox(db: Db, tenantId: string, accountId: string) {
  await db.withSystem(t => cancelJobs(t, accountId));
  return db.withWorker(tenantId, async t => {
    const found = await t.one("SELECT 1 FROM mail_accounts WHERE id=$1", [accountId]);
    await eraseMailboxContent(t, accountId);
    await destroyCredential(t, accountId);
    await t.query("DELETE FROM mail_accounts WHERE id=$1", [accountId]);
    if (found) await audit(t, { tenantId, event: "data.deleted", targetType: "account", targetId: accountId, meta: { kind: "mailbox", ...REASON } });
    return !!found;
  });
}

/** The mailbox was disconnected and its mail kept. Without this it comes back connected, and the worker syncs it again. */
async function replayCredential(db: Db, tenantId: string, accountId: string) {
  await db.withSystem(t => cancelJobs(t, accountId));
  return db.withWorker(tenantId, async t => {
    const had = await t.one("SELECT 1 FROM credential_envelopes WHERE account_id=$1", [accountId]);
    const account = await t.query("UPDATE mail_accounts SET status='disconnected' WHERE id=$1 AND status<>'disconnected' RETURNING id", [accountId]);
    await destroyCredential(t, accountId);
    return !!had || account.length > 0;
  });
}

async function replaySealed(db: Db, tenantId: string, messageId: string) {
  return db.withWorker(tenantId, async t => {
    const m = await t.one<{ thread_id: string | null; readable: boolean }>("SELECT m.thread_id, (c.blob_enc IS NOT NULL OR EXISTS (SELECT 1 FROM message_search s WHERE s.message_id=m.id)) readable FROM messages m LEFT JOIN message_contents c ON c.message_id=m.id WHERE m.id=$1", [messageId]);
    if (!m) return false;
    await eraseSealedPlaintext(t, messageId, m.thread_id);
    if (m.readable) await audit(t, { tenantId, event: "data.deleted", targetType: "message", targetId: messageId, meta: { kind: "sealed", ...REASON } });
    return m.readable;
  });
}

async function replayPurged(db: Db, tenantId: string, messageId: string) {
  return db.withWorker(tenantId, async t => {
    const rows = await tombstoneAndPurge(t, "id=$1 AND tombstoned_at IS NULL", [messageId]);
    for (const m of rows) await recountThread(t, m.thread_id);
    return rows.length > 0;
  });
}

/**
 * Sets the preference as well as erasing, or a restored "on" would index new mail for someone who turned it off. Turning it back on isn't
 * an erasure, so it isn't logged, and a person who did that has to do it again after a restore. The docs say so.
 */
async function replayOptOut(db: Db, tenantId: string, userId: string, what: "search" | "vectors") {
  const patch = what === "search" ? { serverSearchEnabled: false } : { semanticSearchEnabled: false };
  const pref = await db.withSystem(async t => {
    if (!await t.one("SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL", [userId])) return false;
    return (await t.query("INSERT INTO user_preferences(user_id,prefs) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET prefs=user_preferences.prefs || $2::jsonb, updated_at=now() WHERE user_preferences.prefs @> $2::jsonb IS NOT TRUE RETURNING user_id", [userId, JSON.stringify(patch)])).length > 0;
  });
  const erased = await db.withWorker(tenantId, async t => {
    const words = what === "search" ? await eraseSearchWords(t, userId) : [];
    const vectors = await t.one<{ c: number }>("SELECT count(*)::int c FROM message_embeddings WHERE account_id IN (SELECT id FROM mail_accounts WHERE owner_user_id=$1)", [userId]);
    await deleteOwnedEmbeddings(t, userId);
    return words.length + (vectors?.c ?? 0) > 0;
  });
  return pref || erased;
}
