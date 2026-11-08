import type { Tx } from "@aegis/db";
import { rateLimit } from "./auth";
import type { Ctx, Platform } from "./context";
import { MAX_EMBEDDING_CHARS } from "./embeddings";
import { msgCtx, type MessageEnvelope } from "./ingest";
import { enqueue } from "./jobs";
import { errorCode } from "./log";

/**
 * Semantic search: find mail by meaning, with the model on this server and the vectors sealed like message bodies.
 * Postgres can't rank what it can't read, so a query opens vectors in memory and ranks them here. That's why it has a bound.
 */

/** Newest-first after RLS and filters. Older mail than this can only be found by words. The UI says so. */
export const SEMANTIC_CANDIDATE_LIMIT = 5000;
/** How many threads a query can add. */
export const SEMANTIC_TOP_K = 20;
/**
 * Below this cosine similarity a message isn't a match. Vector search always has a nearest neighbour, so without a floor every query
 * would "find" something. Picked by sweeping the labelled set in test-fixtures/semantic-set.ts: 0.2 lets in much more noise for no more
 * recall, and 0.3 loses a quarter of what this finds. That's a small set, picked on the same data it's measured on, so it's a judgement call.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.25;
/** A slow or cold model must not hold up the word results that are already available. */
const QUERY_EMBED_TIMEOUT_MS = 8000;
const BACKFILL_PAGE = 200;
const TABLE = "message_embeddings";

export function embeddingText(subject: string, text: string) {
  // Quoted history is about an older message, and would drown out what this one says.
  const own = text.split(/\r?\n/).filter(l => !/^\s*>/.test(l)).join(" ");
  return `${subject}\n${own}`.replace(/[ \t\r]+/g, " ").trim().slice(0, MAX_EMBEDDING_CHARS);
}

export const vectorBytes = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
/** The pool can hand back unaligned memory, and Float32Array needs alignment, so this copies. */
export function bytesVector(b: Buffer) {
  const out = new Float32Array(b.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = b.readFloatLE(i * 4);
  return out;
}
/** Both sides are unit length, so this is cosine similarity. */
export function similarity(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Every condition for indexing a mailbox, read under a share lock on the account. An owner turning search off takes the conflicting
 * lock before deleting, so either this sees the new preference, or the delete runs after this transaction and sees its row.
 */
async function indexingAllowed(t: Tx, accountId: string) {
  const r = await t.one<{ status: string; privacy_mode: string; prefs: Record<string, unknown> | null }>(
    `SELECT a.status, o.privacy_mode, up.prefs FROM mail_accounts a JOIN organizations o ON o.id=a.tenant_id LEFT JOIN user_preferences up ON up.user_id=a.owner_user_id WHERE a.id=$1 FOR SHARE OF a`, [accountId]);
  if (!r || r.status === "disconnected") return false;
  // Client-sealed mode promises the server does no content processing it doesn't have to.
  if (r.privacy_mode === "client_sealed") return false;
  return r.prefs?.serverSearchEnabled !== false && r.prefs?.semanticSearchEnabled !== false;
}

/** Message rows whose bodies this server can still read. A sealed body never qualifies, and nor does anything about it. */
const EMBEDDABLE = "m.state='classified' AND m.tombstoned_at IS NULL AND c.blob_enc IS NOT NULL AND c.sealed_blob IS NULL";

/** Job. Nothing here is on the ingest path, so a stuck model costs this job a timeout and a retry, and mail keeps flowing. */
export async function embedMessage(p: Platform, tenantId: string, accountId: string, messageId: string) {
  const provider = p.embeddings;
  if (!provider) return;
  const row = await p.db.withWorker(tenantId, async t => {
    if (!(await indexingAllowed(t, accountId))) return null;
    return t.one<{ envelope_enc: Buffer | null; blob_enc: Buffer; model: string | null }>(
      `SELECT m.envelope_enc, c.blob_enc, e.model FROM messages m JOIN message_contents c ON c.message_id=m.id LEFT JOIN message_embeddings e ON e.message_id=m.id WHERE m.id=$1 AND m.account_id=$2 AND ${EMBEDDABLE}`, [messageId, accountId]);
  });
  if (!row || row.model === provider.id) return;
  const envelope = row.envelope_enc ? await p.envelope.openJson<MessageEnvelope>(msgCtx(tenantId, messageId), row.envelope_enc) : null;
  const content = await p.envelope.openJson<{ text: string }>(msgCtx(tenantId, messageId, "message_contents"), row.blob_enc);
  // Outside any transaction: a slow model shouldn't hold a database connection.
  const [vector] = await provider.embed([embeddingText(envelope?.subject ?? "", content.text ?? "")]);
  const sealed = await p.envelope.seal(msgCtx(tenantId, messageId, TABLE), vectorBytes(vector!));
  await p.db.withWorker(tenantId, async t => {
    if (!(await indexingAllowed(t, accountId))) return;
    // The share lock means sealing or deleting this message either happened already, so nothing's written, or waits and then removes this.
    const still = await t.one(`SELECT 1 FROM messages m JOIN message_contents c ON c.message_id=m.id WHERE m.id=$1 AND m.account_id=$2 AND ${EMBEDDABLE} FOR SHARE OF m, c`, [messageId, accountId]);
    if (!still) return;
    await t.query(
      `INSERT INTO ${TABLE}(message_id,tenant_id,account_id,model,vector_enc) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (message_id) DO UPDATE SET model=EXCLUDED.model, vector_enc=EXCLUDED.vector_enc, created_at=now()`, [messageId, tenantId, accountId, provider.id, sealed]);
  });
}

/**
 * Job. Queues embedding for a mailbox's mail that hasn't any, a page at a time, so existing mail catches up after the feature is
 * turned on, a model changes, or a job died. Walks by ID, so a message that keeps failing can't stop the walk or restart it.
 */
export async function backfillEmbeddings(p: Platform, tenantId: string, accountId: string, afterId?: string) {
  const provider = p.embeddings;
  if (!provider) return 0;
  return p.db.withWorker(tenantId, async t => {
    if (!(await indexingAllowed(t, accountId))) return 0;
    const rows = await t.query<{ id: string }>(
      `SELECT m.id FROM messages m JOIN message_contents c ON c.message_id=m.id LEFT JOIN message_embeddings e ON e.message_id=m.id AND e.model=$2
       WHERE m.account_id=$1 AND ${EMBEDDABLE} AND e.message_id IS NULL AND m.id > $3 ORDER BY m.id LIMIT ${BACKFILL_PAGE}`, [accountId, provider.id, afterId ?? "00000000-0000-0000-0000-000000000000"]);
    for (const r of rows) await enqueue(t, { tenantId, kind: "embed.message", payload: { accountId, messageId: r.id }, dedupeKey: `embed:${r.id}`, maxAttempts: 3 });
    if (rows.length === BACKFILL_PAGE) {
      const last = rows[rows.length - 1]!.id;
      await enqueue(t, { tenantId, kind: "embed.backfill", payload: { accountId, messageId: last }, dedupeKey: `embed-backfill:${accountId}:${last}` });
    }
    return rows.length;
  });
}

/** Erases a person's vectors in one workspace, for opting out. The lock is the other half of indexingAllowed. */
export async function deleteOwnedEmbeddings(t: Tx, userId: string) {
  const owned = await t.query<{ id: string }>("SELECT id FROM mail_accounts WHERE owner_user_id=$1 FOR NO KEY UPDATE", [userId]);
  await t.query(`DELETE FROM ${TABLE} WHERE account_id = ANY($1::uuid[])`, [owned.map(a => a.id)]);
}

export type SemanticOutcome =
  | { status: "used"; candidates: number; limit: number; capped: boolean; latencyMs: number }
  /** Not enabled on this deployment. */
  | { status: "unavailable" }
  /** Enabled, but nothing this person can see has a vector yet. */
  | { status: "no_index" }
  /** The model didn't answer in time or failed. Word results still come back. */
  | { status: "failed" }
  | { status: "rate_limited" }
  /** Only operators in the query, so there's nothing to compare by meaning. */
  | { status: "not_applicable" };

export interface SemanticMatch { messageId: string; threadKey: string; similarity: number }

/**
 * Ranks what this person can already read. The candidate query runs in their RLS context with the same conditions as word search,
 * which is what keeps colleagues' mail, held mail and tombstones out: there's no separate access logic here to get wrong.
 */
export async function semanticMatches(p: Platform, ctx: Ctx, input: { text: string; where: string[]; params: unknown[] }): Promise<{ outcome: SemanticOutcome; matches: SemanticMatch[] }> {
  const provider = p.embeddings;
  if (!provider) return { outcome: { status: "unavailable" }, matches: [] };
  const t0 = Date.now();
  // Each query embeds the text and opens thousands of records, which adds up.
  try { await rateLimit(p, `semantic:${ctx.userId}`, 120, 60); }
  catch { return { outcome: { status: "rate_limited" }, matches: [] }; }
  let query: Float32Array;
  try { [query] = await provider.embed([input.text.slice(0, MAX_EMBEDDING_CHARS)], { timeoutMs: QUERY_EMBED_TIMEOUT_MS }) as [Float32Array]; }
  catch (e) {
    // The error's name only. The query is the user's words and goes nowhere.
    p.log.warn("search.semantic_failed", { errorCode: errorCode(e) });
    return { outcome: { status: "failed" }, matches: [] };
  }
  const rows = await p.db.withUser(ctx, t => t.query<{ id: string; thread_id: string | null; vector_enc: Buffer }>(
    `SELECT m.id, m.thread_id, e.vector_enc FROM messages m JOIN message_embeddings e ON e.message_id=m.id
     WHERE ${input.where.join(" AND ")} AND e.model=$${input.params.length + 1} ORDER BY m.internal_date DESC LIMIT ${SEMANTIC_CANDIDATE_LIMIT}`, [...input.params, provider.id]));
  if (!rows.length) return { outcome: { status: "no_index" }, matches: [] };
  const opened = await p.envelope.openMany(ctx.tenantId, "body", rows.map(r => ({ table: TABLE, recordId: r.id, blob: r.vector_enc })));
  const best = new Map<string, SemanticMatch>();
  for (let i = 0; i < rows.length; i++) {
    const bytes = opened[i];
    if (!bytes || bytes.length !== provider.dimensions * 4) continue;
    const score = similarity(query, bytesVector(bytes));
    if (score < SEMANTIC_MIN_SIMILARITY) continue;
    const threadKey = rows[i]!.thread_id ?? rows[i]!.id;
    const had = best.get(threadKey);
    if (!had || score > had.similarity) best.set(threadKey, { messageId: rows[i]!.id, threadKey, similarity: score });
  }
  const matches = [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, SEMANTIC_TOP_K);
  const latencyMs = Date.now() - t0;
  p.log.info("search.semantic", { count: rows.length, latencyMs });
  return { outcome: { status: "used", candidates: rows.length, limit: SEMANTIC_CANDIDATE_LIMIT, capped: rows.length >= SEMANTIC_CANDIDATE_LIMIT, latencyMs }, matches };
}

/** Reciprocal rank fusion. Rank decides, not score: word results have no score, and sorting by date would bury the best meaning match. */
export function fuseRanks<T extends { id: string }>(words: T[], meaning: { row: T; similarity: number }[]) {
  const K = 60;
  const scored = new Map<string, { row: T; score: number; inWords: boolean; inMeaning: boolean; order: number }>();
  words.forEach((row, i) => scored.set(row.id, { row, score: 1 / (K + i), inWords: true, inMeaning: false, order: i }));
  meaning.forEach(({ row }, i) => {
    const had = scored.get(row.id);
    if (had) { had.score += 1 / (K + i); had.inMeaning = true; }
    else scored.set(row.id, { row, score: 1 / (K + i), inWords: false, inMeaning: true, order: words.length + i });
  });
  return [...scored.values()].sort((a, b) => b.score - a.score || a.order - b.order)
    .map(s => ({ ...s.row, match: (s.inWords && s.inMeaning ? "both" : s.inMeaning ? "meaning" : "words") as "both" | "meaning" | "words" }));
}

/** Reads actual state, so the search page and Settings can't claim more than is true. */
export async function semanticSearchStatus(p: Platform, ctx: Ctx) {
  const [prefRow, counts] = await Promise.all([
    p.db.withUser(ctx, t => t.one<{ prefs: Record<string, unknown> }>("SELECT prefs FROM user_preferences WHERE user_id=$1", [ctx.userId])),
    p.db.withUser(ctx, async t => ({
      org: await t.one<{ privacy_mode: string }>("SELECT privacy_mode FROM organizations WHERE id=$1", [ctx.tenantId]),
      indexed: (await t.one<{ c: number }>(`SELECT count(*)::int c FROM ${TABLE} e JOIN messages m ON m.id=e.message_id WHERE m.tombstoned_at IS NULL`))?.c ?? 0,
      eligible: (await t.one<{ c: number }>(`SELECT count(*)::int c FROM messages m JOIN message_contents c ON c.message_id=m.id WHERE ${EMBEDDABLE}`))?.c ?? 0,
    })),
  ]);
  const prefs = prefRow?.prefs ?? {};
  const serverSearchEnabled = prefs.serverSearchEnabled !== false, enabled = prefs.semanticSearchEnabled !== false;
  const reason = !p.embeddings ? "deployment" : counts.org?.privacy_mode === "client_sealed" ? "privacy_mode" : null;
  return { available: reason === null, reason, enabled, serverSearchEnabled, model: p.embeddings?.id ?? null, dimensions: p.embeddings?.dimensions ?? null, indexed: counts.indexed, eligible: counts.eligible, candidateLimit: SEMANTIC_CANDIDATE_LIMIT, topK: SEMANTIC_TOP_K };
}
