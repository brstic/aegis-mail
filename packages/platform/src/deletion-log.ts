import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Tx } from "@aegis/db";
import type { Platform } from "./context";
import { DeferJob, enqueue } from "./jobs";
import type { Logger } from "./log";

/**
 * The log of durable erasures that a restore replays. See docs/runbooks/backup-restore.md.
 *
 * An erasure writes a row to deletion_outbox in its own transaction, so the two commit together. A worker job ships rows to a
 * sink outside the database and marks them shipped. Delivery is at least once, and replay is idempotent.
 *
 * An entry holds ids, a kind and a time, and nothing else. This file is the only way an entry is built or read, and
 * assertContentFreeEntry is what enforces that.
 */
export const ERASURE_KINDS = ["account", "tenant_shred", "mailbox", "credential", "message_sealed", "message_purged", "search_off", "vectors_off"] as const;
export type ErasureKind = (typeof ERASURE_KINDS)[number];

const ID_FIELDS = ["tenantId", "userId", "accountId", "messageId"] as const;
type IdField = (typeof ID_FIELDS)[number];
/** What each kind has to name for a replay to find it. Mirrored by the CHECK constraints in migration 019. */
const REQUIRED: Record<ErasureKind, readonly IdField[]> = {
  account: ["userId"],
  tenant_shred: ["tenantId"],
  mailbox: ["tenantId", "accountId"],
  credential: ["tenantId", "accountId"],
  message_sealed: ["tenantId", "accountId", "messageId"],
  message_purged: ["tenantId", "accountId", "messageId"],
  search_off: ["tenantId", "userId"],
  vectors_off: ["tenantId", "userId"],
};

export interface ErasureFact { kind: ErasureKind; tenantId?: string | null; userId?: string | null; accountId?: string | null; messageId?: string | null }
export interface DeletionEntry { id: string; kind: ErasureKind; tenantId: string | null; userId: string | null; accountId: string | null; messageId: string | null; at: string }
export interface LogLine extends DeletionEntry { v: 1; seq: number; prev: string; hash: string }
export interface SinkReceipt { seq: number; hash: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const GENESIS_HASH = "0".repeat(64);
const ENTRY_KEYS = new Set(["id", "kind", "at", ...ID_FIELDS]);
const LINE_KEYS = new Set([...ENTRY_KEYS, "v", "seq", "prev", "hash"]);

/** Throws on any field outside the allowlist, or a value that isn't an id, a kind or a time. Messages name the field, never the value. */
export function assertContentFreeEntry(e: Record<string, unknown>, allowed: ReadonlySet<string> = ENTRY_KEYS) {
  for (const k of Object.keys(e)) if (!allowed.has(k)) throw new Error(`deletion log field not allowed: ${k.slice(0, 40)}`);
  if (typeof e.id !== "string" || !UUID.test(e.id)) throw new Error("deletion log entry needs a uuid id");
  if (typeof e.kind !== "string" || !ERASURE_KINDS.includes(e.kind as ErasureKind)) throw new Error("deletion log entry has an unknown kind");
  if (typeof e.at !== "string" || !ISO.test(e.at)) throw new Error("deletion log entry needs an ISO time");
  for (const f of ID_FIELDS) if (e[f] != null && (typeof e[f] !== "string" || !UUID.test(e[f] as string))) throw new Error(`deletion log field isn't a uuid: ${f}`);
  for (const f of REQUIRED[e.kind as ErasureKind]) if (e[f] == null) throw new Error(`deletion log entry of this kind needs ${f}`);
}

/** The same fact always gets the same id, so a retry or a second path recording it (web, then worker) is one entry. */
export function entryId(f: ErasureFact): string {
  const h = createHash("sha256").update(JSON.stringify([f.kind, f.tenantId ?? null, f.userId ?? null, f.accountId ?? null, f.messageId ?? null])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Call inside the transaction that erases. The job carries no payload: job payloads are content-free, and a shipper reads rows, not
 * names. One job at a time across the deployment, and tick() queues another if this one is lost.
 */
export async function recordErasure(t: Tx, f: ErasureFact) {
  assertContentFreeEntry({ id: entryId(f), kind: f.kind, at: new Date(0).toISOString(), tenantId: f.tenantId, userId: f.userId, accountId: f.accountId, messageId: f.messageId });
  await t.query("INSERT INTO deletion_outbox(id,kind,tenant_id,user_id,account_id,message_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [entryId(f), f.kind, f.tenantId ?? null, f.userId ?? null, f.accountId ?? null, f.messageId ?? null]);
  await enqueue(t, { tenantId: f.tenantId ?? null, kind: "deletion.ship", dedupeKey: SHIP_DEDUPE_KEY });
}
const SHIP_DEDUPE_KEY = "deletion-ship";

// ---------- The chain ----------
function lineHash(l: Omit<LogLine, "hash">): string {
  return createHash("sha256").update(JSON.stringify([l.v, l.seq, l.id, l.kind, l.tenantId, l.userId, l.accountId, l.messageId, l.at, l.prev])).digest("hex");
}

export type LogProblemCode = "malformed" | "not_allowed" | "hash_mismatch" | "seq_gap" | "prev_mismatch" | "torn_tail" | "witness_missing" | "witness_mismatch" | "head_mismatch";
export interface LogProblem { line: number; code: LogProblemCode }
export interface VerifiedLog {
  /** Lines whose own hash holds. With a clean chain, that's all of them. */
  entries: LogLine[];
  lines: number;
  head: SinkReceipt;
  problems: LogProblem[];
}

/**
 * Finds tampering and anything cut from the start or the middle. A file alone can't reveal lines cut from the end, or a chain rewritten
 * from some point to the end: that takes a witness outside it. reapply checks the head logged by the worker and what the restored database recorded.
 */
export function verifyLogText(text: string): VerifiedLog {
  const problems: LogProblem[] = [], entries: LogLine[] = [];
  const raw = text.split("\n");
  const last = raw.pop()!;
  let prev = GENESIS_HASH, seq = 0, n = 0;
  for (const s of raw) {
    n++;
    let o: any;
    try { o = JSON.parse(s); } catch { problems.push({ line: n, code: "malformed" }); continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { problems.push({ line: n, code: "malformed" }); continue; }
    try {
      assertContentFreeEntry(o, LINE_KEYS);
      if (o.v !== 1 || !Number.isSafeInteger(o.seq) || o.seq < 1 || typeof o.prev !== "string" || !HASH.test(o.prev) || typeof o.hash !== "string" || !HASH.test(o.hash)) throw new Error("shape");
    } catch { problems.push({ line: n, code: "not_allowed" }); continue; }
    const line: LogLine = { v: 1, seq: o.seq, id: o.id, kind: o.kind, tenantId: o.tenantId ?? null, userId: o.userId ?? null, accountId: o.accountId ?? null, messageId: o.messageId ?? null, at: o.at, prev: o.prev, hash: o.hash };
    const { hash: _stored, ...rest } = line;
    const selfConsistent = lineHash(rest) === line.hash;
    if (!selfConsistent) problems.push({ line: n, code: "hash_mismatch" });
    if (line.seq !== seq + 1) problems.push({ line: n, code: "seq_gap" });
    if (line.prev !== prev) problems.push({ line: n, code: "prev_mismatch" });
    if (selfConsistent) entries.push(line);
    // Pick the chain up again from here, so one break is reported once and not on every line after it.
    prev = line.hash;
    seq = line.seq;
  }
  // Every line is written with its newline. Without one, the end of this file is a write that never finished, or a cut.
  if (last.length) problems.push({ line: n + 1, code: "torn_tail" });
  return { entries, lines: n, head: { seq, hash: prev }, problems };
}

export class DeletionLogBrokenError extends Error {
  override name = "DeletionLogBrokenError";
  readonly code: string;
  constructor(readonly problems: LogProblem[], code = "deletion_log_broken", message?: string) {
    super(message ?? describeProblems(problems));
    this.code = code;
  }
}
const PROBLEM_TEXT: Record<LogProblemCode, string> = {
  malformed: "isn't valid JSON",
  not_allowed: "has a field or value an entry can't hold",
  hash_mismatch: "doesn't match its own hash, so it was changed after it was written",
  seq_gap: "has the wrong sequence number, so lines are missing or out of order",
  prev_mismatch: "doesn't follow from the line before it, so lines were changed, removed or reordered",
  torn_tail: "is incomplete. It's a write that never finished, or the file was cut",
  witness_missing: "is missing, though the restored database records it as shipped, so the log was cut or replaced",
  witness_mismatch: "isn't what the restored database records as shipped there, so the log was rewritten",
  head_mismatch: "isn't the head you expected, so the log was cut or rewritten",
};
export function describeProblems(problems: LogProblem[]): string {
  const shown = problems.slice(0, 5).map(p => `line ${p.line} ${PROBLEM_TEXT[p.code]}`).join("; ");
  return `The deletion log failed verification: ${shown}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""}.`;
}

// ---------- Sinks ----------
/** Somewhere outside the database. Once append returns, its entries must survive a crash of this machine. */
export interface DeletionSink {
  readonly kind: string;
  /** In order, one receipt per entry. An id it already holds gets its original receipt and isn't written again. */
  append(entries: DeletionEntry[]): Promise<SinkReceipt[]>;
  head(): Promise<SinkReceipt>;
}

/**
 * Append-only JSONL with fsync. **This is only "outside the database" if the path is on separate storage**, under separate
 * control from the database and its backups. On the database's own disk it's lost in the same failure that makes you restore.
 * Writers are serialized by shipDeletionLog's advisory lock, and a writer notices another's appends from the file's size.
 */
export class FileDeletionSink implements DeletionSink {
  readonly kind = "file";
  private size = -1;
  private tail: SinkReceipt = { seq: 0, hash: GENESIS_HASH };
  private seen = new Map<string, SinkReceipt>();
  constructor(readonly path: string, private log?: Logger) {}

  private async load() {
    let size = -1;
    try { size = (await stat(this.path)).size; } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
    if (size === this.size) return;
    if (size < this.size) throw new DeletionLogBrokenError([], "deletion_log_truncated", "The deletion log got shorter while this process was writing to it. Nothing more is written until someone checks it.");
    if (size < 0) { this.size = -1; return; }
    const buf = await readFile(this.path);
    const v = verifyLogText(buf.toString("utf8"));
    const broken = v.problems.filter(p => p.code !== "torn_tail");
    if (broken.length) throw new DeletionLogBrokenError(broken);
    let keep = buf.length;
    if (v.problems.length) {
      // Never acknowledged, because append only returns after the sync, so its row is still unshipped and goes out again.
      // shipDeletionLog separately refuses a log shorter than what the database knows was shipped, so this can't hide a cut.
      keep = buf.lastIndexOf(0x0a) + 1;
      const fh = await open(this.path, "r+");
      try { await fh.truncate(keep); await fh.sync(); } finally { await fh.close(); }
      this.log?.warn("deletion_log.torn_tail_removed", { count: 1 });
    }
    this.seen = new Map(v.entries.map(e => [e.id, { seq: e.seq, hash: e.hash }]));
    this.tail = v.head;
    this.size = keep;
  }

  async head() { await this.load(); return this.size < 0 ? { seq: 0, hash: GENESIS_HASH } : { ...this.tail }; }

  async append(entries: DeletionEntry[]) {
    await this.load();
    if (this.size < 0) { this.tail = { seq: 0, hash: GENESIS_HASH }; this.seen = new Map(); }
    let { seq, hash } = this.tail;
    const out: SinkReceipt[] = [], fresh: { id: string; receipt: SinkReceipt }[] = [];
    let chunk = "";
    for (const e of entries) {
      assertContentFreeEntry({ ...e });
      const known = this.seen.get(e.id) ?? fresh.find(f => f.id === e.id)?.receipt;
      if (known) { out.push(known); continue; }
      const rest = { v: 1 as const, seq: seq + 1, id: e.id, kind: e.kind, tenantId: e.tenantId, userId: e.userId, accountId: e.accountId, messageId: e.messageId, at: e.at, prev: hash };
      const line: LogLine = { ...rest, hash: lineHash(rest) };
      chunk += `${JSON.stringify(line)}\n`;
      seq = line.seq; hash = line.hash;
      const receipt = { seq, hash };
      fresh.push({ id: e.id, receipt });
      out.push(receipt);
    }
    if (!chunk) return out;
    const created = this.size < 0;
    const fh = await open(this.path, "a", 0o600);
    let wrote = 0;
    try {
      const bytes = Buffer.from(chunk, "utf8");
      while (wrote < bytes.length) wrote += (await fh.write(bytes, wrote)).bytesWritten;
      await fh.sync();
    } catch (e) { this.size = -2; throw e; /* The next load re-reads whatever reached the file. */ } finally { await fh.close(); }
    if (created) await syncDir(dirname(this.path));
    for (const f of fresh) this.seen.set(f.id, f.receipt);
    this.tail = { seq, hash };
    this.size = Math.max(this.size, 0) + wrote;
    return out;
  }
}

/** A new file's name isn't durable until its directory is synced too. Not every filesystem lets you, and that's not worth failing over. */
async function syncDir(dir: string) {
  const d = await open(dir, "r").catch(() => null);
  try { await d?.sync().catch(() => {}); } finally { await d?.close(); }
}

export class DeletionSinkConfigError extends Error { override name = "DeletionSinkConfigError"; }

/** Null when nothing's configured. A bad path is an error now, not a job that fails later. */
export function deletionSinkFromEnv(env: NodeJS.ProcessEnv, log?: Logger): DeletionSink | null {
  const path = env.AEGIS_DELETION_LOG_PATH;
  if (!path) return null;
  if (!isAbsolute(path)) throw new DeletionSinkConfigError("AEGIS_DELETION_LOG_PATH must be an absolute path.");
  try { accessSync(dirname(path), constants.W_OK); } catch { throw new DeletionSinkConfigError("AEGIS_DELETION_LOG_PATH's directory doesn't exist or can't be written. It should be on storage separate from the database."); }
  return new FileDeletionSink(path, log);
}

/**
 * Same rule as the dev KMS: a production worker with nowhere to ship refuses to boot, rather than letting a restore quietly bring deletions back.
 * Only the worker ships, so only the worker needs it. The web process writes outbox rows either way.
 */
export function assertDeletionSinkAllowed(sink: DeletionSink | null, processRole: string, env: { NODE_ENV?: string; DEMO_MODE?: string }) {
  if (processRole === "worker" && !sink && env.NODE_ENV === "production" && env.DEMO_MODE !== "true") {
    throw new Error("AEGIS_DELETION_LOG_PATH is required in production: without a deletion log, restoring a backup brings deleted accounts back. See docs/runbooks/backup-restore.md.");
  }
}

// ---------- Shipping ----------
const SHIP_BATCH = 500;
const SHIP_LOCK = 727003;
/** An hour behind means the log isn't keeping up, so restores would miss recent deletions. Health stops reporting it as fine. */
const BACKLOG_ALERT_MS = 3600_000;

/**
 * Worker job. The sink syncs before the row is marked, so a crash in between sends it again, and the sink hands back the original receipt.
 * The log is one chain across tenants, so this runs on the worker's system surface, one shipper at a time.
 */
export async function shipDeletionLog(p: Platform): Promise<number> {
  const sink = p.deletionSink;
  // Rows wait in the outbox. Production can't get here: see assertDeletionSinkAllowed.
  if (!sink) return 0;
  let total = 0, last: SinkReceipt | null = null;
  for (;;) {
    const batch = await p.db.withSystem(async t => {
      const lock = await t.one<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) ok", [SHIP_LOCK]);
      if (!lock?.ok) throw new DeferJob(1000);
      const rows = await t.query<any>("SELECT id, kind, tenant_id, user_id, account_id, message_id, erased_at FROM deletion_outbox WHERE shipped_at IS NULL ORDER BY erased_at, id LIMIT $1", [SHIP_BATCH]);
      if (!rows.length) return { count: 0, head: null };
      // The file may have been cut, or be a new empty one. Continuing would build a clean chain that's missing what the database knows it shipped.
      const known = await t.one<{ seq: number | null }>("SELECT max(sink_seq) seq FROM deletion_outbox");
      const head = await sink.head();
      if (known?.seq != null && known.seq > head.seq) throw new DeletionLogBrokenError([{ line: head.seq + 1, code: "witness_missing" }], "deletion_log_truncated");
      const receipts = await sink.append(rows.map(outboxEntry));
      await t.query(
        "UPDATE deletion_outbox o SET shipped_at=now(), sink_seq=x.seq, sink_hash=x.hash FROM unnest($1::uuid[],$2::bigint[],$3::text[]) AS x(id,seq,hash) WHERE o.id=x.id",
        [rows.map(r => r.id), receipts.map(r => r.seq), receipts.map(r => r.hash)]);
      return { count: rows.length, head: receipts[receipts.length - 1]! };
    });
    total += batch.count;
    if (batch.head) last = batch.head;
    if (batch.count < SHIP_BATCH) break;
  }
  // Logged so the head has a witness outside the log's own storage. It's what --expect-head compares against.
  if (last) p.log.info("deletion_log.shipped", { count: total, chainSeq: last.seq, chainHash: last.hash });
  return total;
}

export function outboxEntry(r: { id: string; kind: ErasureKind; tenant_id: string | null; user_id: string | null; account_id: string | null; message_id: string | null; erased_at: Date }): DeletionEntry {
  return { id: r.id, kind: r.kind, tenantId: r.tenant_id, userId: r.user_id, accountId: r.account_id, messageId: r.message_id, at: new Date(r.erased_at).toISOString() };
}

/**
 * From tick(), so a lost or dead-lettered job can't strand a row. The heartbeat is what the operator health page reads, so it
 * says "configured and keeping up" only if that's true. A worker without a sink never writes one.
 */
export async function deletionLogTick(p: Platform) {
  if (!p.deletionSink) return;
  await p.db.withSystem(async t => {
    const b = await t.one<{ c: number; oldest: Date | null }>("SELECT count(*)::int c, min(erased_at) oldest FROM deletion_outbox WHERE shipped_at IS NULL");
    if (b?.c) await enqueue(t, { tenantId: null, kind: "deletion.ship", dedupeKey: SHIP_DEDUPE_KEY });
    if (b?.oldest && p.now().getTime() - new Date(b.oldest).getTime() > BACKLOG_ALERT_MS) p.log.warn("deletion_log.backlog", { count: b.c });
    else await t.query("INSERT INTO service_heartbeats(component,last_seen_at) VALUES ('deletion_log',now()) ON CONFLICT (component) DO UPDATE SET last_seen_at=now()");
  });
}
