import { membersSeeBlocked } from "./quarantine";
import type { FolderRole, MessageChange, PriorityDecision } from "@aegis/domain";
import { FOCUS_SECTION_LABELS, type FocusSection } from "@aegis/domain";
import type { Tx } from "@aegis/db";
import { hostOf, sanitizeEmailHtml, wrapForSandbox } from "@aegis/mail-parser";
import { audit } from "./audit";
import { AppError, badRequest, type Ctx, forbidden, notFound, type Platform } from "./context";
import { conceptTsQuery } from "./search-concepts";
import { fuseRanks, semanticMatches, type SemanticOutcome } from "./semantic-search";
import { requireOwner } from "./send";
import { msgCtx, type MessageEnvelope } from "./ingest";
import { enqueue } from "./jobs";

export interface ThreadRow {
  id: string; accountId: string; messageId: string; subject: string; snippet: string; from?: { name?: string; address: string }; to: { name?: string; address: string }[]; date: string;
  isRead: boolean; isStarred: boolean; hasAttachments: boolean; count: number; folder: string; risk: string | null; action: string | null; held: boolean; section: string | null; topics: string[]; intent: string;
  duplicateOf: string | null; score: number | null; reasons?: string[]; confidence?: number; needsReply?: boolean; due?: PriorityDecision["due"]; labels: { id: string; name: string; color: string | null }[]; lastFromMe: boolean; failed: boolean;
  /** Only on a search with semantic on: how this row got here. */
  match?: "words" | "meaning" | "both";
}

const VIEW_WHERE: Record<string, string> = {
  inbox: "m.folder_role='inbox' AND NOT m.held",
  focus: "m.folder_role='inbox'",
  important: "m.folder_role='inbox' AND NOT m.held AND (m.priority_section IN ('needs_attention','important_people','todays_commitments') OR m.is_starred)",
  starred: "m.is_starred AND NOT m.held",
  // Your message is the last word in the conversation. One that was answered isn't awaiting anything.
  awaiting: "m.from_me AND m.folder_role='sent' AND EXISTS (SELECT 1 FROM threads aw WHERE aw.id=m.thread_id AND aw.last_from_me)",
  sent: "m.folder_role='sent'",
  archive: "m.folder_role='archive' AND NOT m.held",
  spam: "m.folder_role='spam' AND NOT m.held",
  trash: "m.folder_role='trash' AND NOT m.held",
  quarantine: "m.held",
};

export interface ParsedQuery { text: string[]; from: string[]; to: string[]; subject: string[]; after?: Date; before?: Date; hasAttachment?: boolean; unread?: boolean; risk?: string; section?: string; label?: string; account?: string; flagged?: boolean; due?: string }

/** Gmail-style operators. Unknown operators fall through as plain terms. */
export function parseSearch(q: string): ParsedQuery {
  const out: ParsedQuery = { text: [], from: [], to: [], subject: [] };
  for (const m of q.matchAll(/(\w+):("[^"]*"|\S+)|"([^"]+)"|(\S+)/g)) {
    const key = m[1]?.toLowerCase(); const raw = m[2]?.replace(/^"|"$/g, "");
    if (m[3]) { out.text.push(m[3]); continue; }
    if (m[4]) { out.text.push(m[4]); continue; }
    if (!key || raw === undefined) continue;
    switch (key) {
      case "from": out.from.push(raw); break;
      case "to": out.to.push(raw); break;
      case "subject": out.subject.push(raw); break;
      case "after": { const d = new Date(raw.replace(/\//g, "-")); if (!Number.isNaN(d.getTime())) out.after = d; break; }
      case "before": { const d = new Date(raw.replace(/\//g, "-")); if (!Number.isNaN(d.getTime())) out.before = d; break; }
      case "has": if (raw === "attachment") out.hasAttachment = true; break;
      case "is": if (raw === "unread") out.unread = true; if (raw === "read") out.unread = false; if (raw === "flagged") out.flagged = true; break;
      case "risk": out.risk = raw; break;
      case "priority": out.section = raw; break;
      case "due": out.due = raw; break;
      case "label": out.label = raw; break;
      case "account": out.account = raw; break;
      default: out.text.push(`${key}:${raw}`);
    }
  }
  return out;
}

function tsTerm(s: string, weight: string) {
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(w => `'${w.toLowerCase().replace(/'/g, "")}':*${weight}`).join(" & ");
}

export function buildTsQuery(q: ParsedQuery): string | null {
  const parts = [
    ...q.text.map(s => tsTerm(s, "")), ...q.from.map(s => tsTerm(s, "B")), ...q.to.map(s => tsTerm(s, "C")), ...q.subject.map(s => tsTerm(s, "A")),
  ].filter(Boolean);
  return parts.length ? parts.join(" & ") : null;
}

const THREAD_ROW_COLUMNS = `m.*, COALESCE(th.message_count,1) tcount, COALESCE(th.last_from_me,false) last_from_me,
       (SELECT detail_enc FROM priority_decisions pd WHERE pd.message_id=m.id ORDER BY created_at DESC LIMIT 1) prio_enc,
       (SELECT COALESCE(json_agg(json_build_object('id',l.id,'name',l.name,'color',l.color)),'[]') FROM message_labels ml JOIN mail_labels l ON l.id=ml.label_id WHERE ml.message_id=m.id) labels`;

export async function listThreads(p: Platform, ctx: Ctx, q: { view: string; accountId?: string; labelId?: string; q?: string; cursor?: string; limit: number; concepts?: boolean; semantic?: boolean }): Promise<{ items: ThreadRow[]; nextCursor: string | null; semantic?: SemanticOutcome }> {
  // Blocked mail in an organization belongs to its admins: members get an empty list, not a view of it.
  if (q.view === "quarantine" && !(await membersSeeBlocked(p, ctx))) return { items: [], nextCursor: null };
  const tenantId = ctx.tenantId;
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = ["m.tombstoned_at IS NULL", "m.state IN ('classified','failed')"];
  const parsed = q.q ? parseSearch(q.q) : null;
  let meaningScope: { where: string[]; params: unknown[] } | null = null;
  // A label is its own view over everything it's on, archived mail included. The Labels page counts it that way.
  const viewCond = parsed ? "NOT m.held" : q.labelId ? "NOT m.held AND m.folder_role NOT IN ('trash','spam')" : VIEW_WHERE[q.view] ?? VIEW_WHERE.inbox!;
  // Search includes quarantine only when explicitly asked, so a held phish isn't surfaced as a normal result.
  where.push(parsed?.risk || parsed?.flagged ? "TRUE" : viewCond);
  if (q.accountId) where.push(`m.account_id=${add(q.accountId)}`);
  if (q.labelId) where.push(`EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id=m.id AND ml.label_id=${add(q.labelId)})`);
  if (parsed) {
    if (parsed.after) where.push(`m.internal_date >= ${add(parsed.after)}`);
    if (parsed.before) where.push(`m.internal_date < ${add(parsed.before)}`);
    if (parsed.hasAttachment) where.push("m.has_attachments");
    if (parsed.unread !== undefined) where.push(parsed.unread ? "NOT m.is_read" : "m.is_read");
    if (parsed.risk) where.push(`m.risk_label=${add(parsed.risk)}`);
    if (parsed.flagged) where.push("m.risk_label IN ('suspicious','high_risk','malicious','unknown_unscannable')");
    if (parsed.section) where.push(`m.priority_section=${add(parsed.section)}`);
    if (parsed.due) {
      // Firm dates only. Task rows hold the date in the clear so it can be queried; the task's text stays encrypted.
      const span: Record<string, string> = { overdue: "x.due_at < now()", today: "x.due_at::date = now()::date", week: "x.due_at >= now() AND x.due_at < now() + interval '7 days'", any: "x.due_at IS NOT NULL" };
      const cond = span[parsed.due.toLowerCase()];
      if (cond) where.push(`EXISTS (SELECT 1 FROM tasks x WHERE x.thread_id=m.thread_id AND x.status='open' AND NOT x.due_uncertain AND ${cond})`);
    }
    if (parsed.label) where.push(`EXISTS (SELECT 1 FROM message_labels ml JOIN mail_labels l ON l.id=ml.label_id WHERE ml.message_id=m.id AND lower(l.name)=lower(${add(parsed.label)}))`);
    if (parsed.account) where.push(`m.account_id IN (SELECT id FROM mail_accounts WHERE email ILIKE ${add(`%${parsed.account}%`)} OR display_name ILIKE ${add(`%${parsed.account}%`)})`);
    // Meaning search answers to everything above, so it can't reach what word search couldn't. Field operators filter it too, exactly.
    if (q.semantic) {
      meaningScope = { where: [...where], params: [...params] };
      const fields = buildTsQuery({ ...parsed, text: [] });
      if (fields) { meaningScope.params.push(fields); const n = `$${meaningScope.params.length}`; meaningScope.where.push(`EXISTS (SELECT 1 FROM message_search s WHERE s.message_id=m.id AND s.tsv @@ to_tsquery('simple', ${n}))`); }
    }
    // With concepts on, plain words widen to related ones. Field operators stay exact, since those are deliberate.
    const conceptQuery = q.concepts && !parsed.from.length && !parsed.to.length && !parsed.subject.length ? conceptTsQuery(parsed.text.join(" ")) : null;
    // Field operators match exact words only. English stemming drops stopwords, and OR-ing that in would make `from:will invoice` ignore the sender.
    const exact = buildTsQuery({ ...parsed, text: [] });
    if (exact) where.push(`EXISTS (SELECT 1 FROM message_search s WHERE s.message_id=m.id AND s.tsv @@ to_tsquery('simple', ${add(exact)}))`);
    const ts = conceptQuery ?? buildTsQuery({ ...parsed, from: [], to: [], subject: [] });
    if (ts) where.push(`EXISTS (SELECT 1 FROM message_search s WHERE s.message_id=m.id AND s.tsv @@ (to_tsquery('simple', ${add(ts)}) || to_tsquery('english', $${params.length})))`);
  }
  if (q.cursor) { const d = new Date(q.cursor); if (!Number.isNaN(d.getTime())) where.push(`m.internal_date < ${add(d)}`); }
  const limit = q.limit;
  // Page in SQL: find each thread's latest matching message, sort, cut, and only then join the heavier per-row data.
  const rows = await p.db.withUser(ctx, t => t.query<any>(
    `WITH latest AS (
       SELECT DISTINCT ON (COALESCE(m.thread_id, m.id)) m.id, m.internal_date FROM messages m WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(m.thread_id, m.id), m.internal_date DESC
     ), page AS (SELECT id FROM latest ORDER BY internal_date DESC LIMIT ${limit + 1})
     SELECT ${THREAD_ROW_COLUMNS}
     FROM page JOIN messages m ON m.id=page.id LEFT JOIN threads th ON th.id=m.thread_id ORDER BY m.internal_date DESC`, params));
  const pageRows = rows.slice(0, limit);
  const items = await Promise.all(pageRows.map(r => hydrate(p, tenantId, r)));
  const nextCursor = rows.length > limit ? new Date(pageRows[pageRows.length - 1].internal_date).toISOString() : null;
  // Later pages are words only: the closest meanings were on the first.
  if (!q.semantic || q.cursor || !parsed) return { items, nextCursor };
  const text = parsed.text.join(" ").trim();
  if (!text || !meaningScope) return { items, nextCursor, semantic: { status: "not_applicable" } };
  const { outcome, matches } = await semanticMatches(p, ctx, { text, ...meaningScope });
  if (outcome.status !== "used") return { items, nextCursor, semantic: outcome };
  // Fetched back through RLS rather than trusted from the ranking.
  const known = new Map(items.map(i => [i.id, i]));
  const missing = matches.filter(m => !known.has(m.threadKey)).map(m => m.messageId);
  const extra = missing.length ? await p.db.withUser(ctx, t => t.query<any>(`SELECT ${THREAD_ROW_COLUMNS} FROM messages m LEFT JOIN threads th ON th.id=m.thread_id WHERE m.id = ANY($1::uuid[])`, [missing])) : [];
  for (const row of await Promise.all(extra.map(r => hydrate(p, tenantId, r)))) known.set(row.id, row);
  const meaning = matches.flatMap(m => { const row = known.get(m.threadKey); return row ? [{ row, similarity: m.similarity }] : []; });
  return { items: fuseRanks(items, meaning), nextCursor, semantic: outcome };
}

async function hydrate(p: Platform, tenantId: string, r: any): Promise<ThreadRow> {
  const e = r.envelope_enc ? await p.envelope.openJson<MessageEnvelope>(msgCtx(tenantId, r.id), r.envelope_enc) : null;
  const d = r.prio_enc ? await p.envelope.openJson<PriorityDecision>(msgCtx(tenantId, r.id, "priority_decisions"), r.prio_enc) : null;
  return {
    id: r.thread_id ?? r.id, accountId: r.account_id, messageId: r.id, subject: e?.subject ?? "(This message couldn't be read)", snippet: e?.snippet ?? "This message couldn't be analyzed, so it hasn't been rated safe.", from: e?.from, to: e?.to ?? [],
    date: new Date(r.internal_date).toISOString(), isRead: r.is_read, isStarred: r.is_starred, hasAttachments: r.has_attachments, count: r.tcount, folder: r.folder_role, risk: r.risk_label, action: r.policy_action, held: r.held,
    section: r.priority_section, topics: e?.topics ?? [], intent: e?.intent ?? "fyi", duplicateOf: r.duplicate_of ?? null, score: r.priority_score, reasons: d?.reasons, confidence: d?.confidence, needsReply: d?.needsReply, due: d?.due, labels: r.labels ?? [], lastFromMe: r.last_from_me, failed: r.state === "failed",
  };
}

export async function getFocus(p: Platform, ctx: Ctx, opts: { accountId?: string; hidden?: string[]; pinned?: string[] } = {}) {
  const [inbox, waiting] = await Promise.all([
    listThreads(p, ctx, { view: "focus", accountId: opts.accountId, limit: 100 }),
    listThreads(p, ctx, { view: "awaiting", accountId: opts.accountId, limit: 30 }),
  ]);
  const cutoff = p.now().getTime() - 14 * 864e5;
  const sections: Record<string, ThreadRow[]> = {};
  const push = (k: string, r: ThreadRow) => { (sections[k] ??= []).push(r); };
  for (const r of inbox.items) {
    if (r.lastFromMe) continue;
    // Mail that was blocked never reaches Focus: it waits in Blocked, out of the way. Only mail we aren't sure about is shown,
    // apart from the rest and marked, because it may well be fine.
    if (r.held || ["high_risk", "malicious"].includes(r.risk ?? "")) continue;
    if (["suspicious", "unknown_unscannable"].includes(r.risk ?? "")) { push("security_review", r); continue; }
    push(r.section ?? "read_later", r);
  }
  for (const r of waiting.items) if (r.lastFromMe && new Date(r.date).getTime() > cutoff) {
    const days = Math.floor((p.now().getTime() - new Date(r.date).getTime()) / 864e5);
    // A suggestion from elapsed time only, so it's phrased as one. Never a firm deadline.
    push("waiting_on_someone", { ...r, reasons: [days >= 3 ? `You sent the last message ${days} days ago and haven't heard back. Consider following up.` : "You sent the last message and haven't heard back."] });
  }
  for (const k of Object.keys(sections)) if (k !== "waiting_on_someone" && k !== "security_review") sections[k]!.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const order: FocusSection[] = ["needs_attention", "security_review", "todays_commitments", "important_people", "waiting_on_someone", "read_later", "low_priority"];
  const pinned = opts.pinned ?? [];
  const finalOrder = [...order].sort((a, b) => Number(pinned.includes(b)) - Number(pinned.includes(a)));
  // Security review can't be hidden, even by a stored preference: a flagged message must not drop out of sight.
  return { sections: finalOrder.filter(k => k === "security_review" || !(opts.hidden ?? []).includes(k)).map(k => ({ key: k, label: FOCUS_SECTION_LABELS[k], items: sections[k] ?? [] })) };
}

export function safeLinkUrl(p: Platform, messageId: string, href: string) {
  return `${p.config.appOrigin}/safe-link?m=${encodeURIComponent(messageId)}&u=${encodeURIComponent(href)}`;
}

export async function getThread(p: Platform, ctx: Ctx, threadId: string, opts: { showImagesFor?: string; dark?: boolean } = {}) {
  const tenantId = ctx.tenantId;
  const rows = await p.db.withUser(ctx, t => t.query<any>(
    `SELECT m.*, c.blob_enc, c.sealed_blob, c.sealed_meta, a.email account_email, a.display_name account_name, a.kind account_kind, a.read_only,
       sa.threat_probability, sa.severity, sa.evidence_completeness, sa.detail_enc, sa.categories, sa.provenance,
       (SELECT detail_enc FROM priority_decisions pd WHERE pd.message_id=m.id ORDER BY created_at DESC LIMIT 1) prio_enc,
       q.state qstate, q.original_folder_role, q.provider_moved,
       (SELECT COALESCE(json_agg(json_build_object('id',x.id,'size',x.size_bytes,'scan',x.scan_status,'stored',x.blob_enc IS NOT NULL,'meta',encode(x.meta_enc,'base64'))),'[]') FROM attachments x WHERE x.message_id=m.id) atts
     FROM messages m JOIN mail_accounts a ON a.id=m.account_id LEFT JOIN message_contents c ON c.message_id=m.id
     LEFT JOIN LATERAL (SELECT * FROM security_analyses s WHERE s.message_id=m.id ORDER BY created_at DESC LIMIT 1) sa ON true
     LEFT JOIN quarantine_items q ON q.message_id=m.id
     WHERE (m.thread_id=$1 OR m.id=$1) AND m.tombstoned_at IS NULL ORDER BY m.internal_date`, [threadId]));
  if (!rows.length) throw notFound();
  const policy = await p.db.withUser(ctx, t => t.one<any>("SELECT policy FROM tenant_policies WHERE tenant_id=$1", [tenantId]));
  const remoteAllowed = policy?.policy?.blockRemoteImages === false;
  const messages = await Promise.all(rows.map(async r => {
    const e = r.envelope_enc ? await p.envelope.openJson<MessageEnvelope>(msgCtx(tenantId, r.id), r.envelope_enc) : null;
    const c = r.blob_enc ? await p.envelope.openJson<{ text: string; html: string | null; sanitized: any }>(msgCtx(tenantId, r.id, "message_contents"), r.blob_enc) : null;
    const sec = r.detail_enc ? await p.envelope.openJson<{ summary: string; actionRationale: string; evidence: any[] }>(msgCtx(tenantId, r.id, "security_analyses"), r.detail_enc) : null;
    const prio = r.prio_enc ? await p.envelope.openJson<PriorityDecision>(msgCtx(tenantId, r.id, "priority_decisions"), r.prio_enc) : null;
    const dangerous = ["high_risk", "malicious"].includes(r.risk_label);
    const allowImages = !dangerous && (opts.showImagesFor === r.id || remoteAllowed);
    const san = c?.html ? sanitizeEmailHtml(c.html, { allowRemoteImages: allowImages, rewriteHref: h => /^https?:/i.test(h) ? safeLinkUrl(p, r.id, h) : h }) : null;
    const attachments = await Promise.all((r.atts as any[]).map(async a => ({ id: a.id, size: a.size, scan: a.scan, stored: a.stored, ...(await p.envelope.openJson<{ filename: string; contentType: string; disposition: string }>(msgCtx(tenantId, a.id, "attachments"), Buffer.from(a.meta, "base64"))) })));
    return {
      id: r.id, accountId: r.account_id, subject: e?.subject ?? "(This message couldn't be read)", from: e?.from, to: e?.to ?? [], cc: e?.cc ?? [], replyTo: e?.replyTo, date: new Date(r.internal_date).toISOString(), isRead: r.is_read, isStarred: r.is_starred, fromMe: r.from_me, folder: r.folder_role, failed: r.state === "failed",
      text: c?.text ?? "", sealed: !!r.sealed_blob, sealedBlob: r.sealed_blob ? r.sealed_blob.toString("base64") : null, sealedMeta: r.sealed_meta,
      // Sanitized HTML, wrapped with its CSP. High-risk messages render as plain text only.
      html: san && !dangerous ? wrapForSandbox(san.html, { allowRemoteImages: allowImages, dark: opts.dark }) : null,
      safeTextOnly: dangerous,
      blockedRemote: san?.blockedRemote ?? 0, trackingPixels: san?.trackingPixels ?? 0, imagesAllowed: allowImages,
      attachments, topics: e?.topics ?? [], intent: e?.intent ?? "fyi", messageIdHeader: e?.messageId, references: e?.references ?? [],
      security: r.risk_label ? { label: r.risk_label, action: r.policy_action, probability: r.threat_probability, severity: r.severity, completeness: r.evidence_completeness, categories: r.categories ?? [], provenance: r.provenance ?? [], summary: sec?.summary ?? "This message couldn't be analyzed.", rationale: sec?.actionRationale ?? "", evidence: (sec?.evidence ?? []).filter((x: any) => x.weight !== 0 || x.code.startsWith("TRK") || x.code.startsWith("BULK")).map((x: any) => ({ code: x.code, explanation: x.explanation, weight: x.weight })) } : null,
      priority: prio ? { score: prio.score, section: prio.section, sectionLabel: FOCUS_SECTION_LABELS[prio.section], confidence: prio.confidence, reasons: prio.reasons, needsReply: prio.needsReply, due: prio.due, features: prio.features } : null,
      quarantine: r.qstate ? { state: r.qstate, originalFolder: r.original_folder_role, providerMoved: r.provider_moved } : null,
      held: r.held,
    };
  }));
  const last = rows[rows.length - 1];
  const access = await p.db.withUser(ctx, t => t.one<{ ok: boolean; send: boolean }>("SELECT app.owns_account($1) ok, app.can_send_account($1) send", [last.account_id]));
  const labels = await p.db.withUser(ctx, t => t.query<{ id: string; name: string; color: string | null }>("SELECT DISTINCT l.id, l.name, l.color FROM message_labels ml JOIN mail_labels l ON l.id=ml.label_id WHERE ml.message_id = ANY($1::uuid[]) ORDER BY l.name", [rows.map(r => r.id)]));
  return { id: rows[0].thread_id ?? rows[0].id, accountId: last.account_id, account: { email: last.account_email, displayName: last.account_name, kind: last.account_kind, readOnly: last.read_only || !access?.ok, shared: !access?.ok, canSend: !last.read_only && !!access?.send }, labels, subject: messages[messages.length - 1]!.subject, messages };
}

const ACTIONS: Record<string, { folder?: FolderRole; read?: boolean; star?: boolean }> = {
  archive: { folder: "archive" }, trash: { folder: "trash" }, spam: { folder: "spam" }, not_spam: { folder: "inbox" }, inbox: { folder: "inbox" },
  read: { read: true }, unread: { read: false }, star: { star: true }, unstar: { star: false },
};

/** Optimistic local update plus a provider job. If the provider ultimately refuses, the job's dead handler rolls back. */
export async function threadAction(p: Platform, ctx: Ctx, threadId: string, a: { action: string; labelId?: string }) {
  const out = await p.db.withUser(ctx, async t => {
    const msgs = await t.query<any>("SELECT m.id, m.account_id, m.folder_role, m.is_read, m.is_starred, m.held, acc.read_only, acc.status, acc.kind FROM messages m JOIN mail_accounts acc ON acc.id=m.account_id WHERE (m.thread_id=$1 OR m.id=$1) AND m.tombstoned_at IS NULL AND (NOT m.from_me OR $2)", [threadId, a.action === "star" || a.action === "unstar" || a.action === "archive" || a.action === "trash"]);
    if (!msgs.length) throw notFound();
    await requireOwner(t, msgs[0].account_id);
    if (msgs[0].read_only) throw badRequest("read_only", "This mailbox is connected read-only. Reconnect with write access to change messages.");
    if (a.action === "label" || a.action === "unlabel") {
      if (!a.labelId) throw badRequest("label_required", "Choose a label.");
      const label = await t.one<any>("SELECT id, remote_id, name, account_id FROM mail_labels WHERE id=$1", [a.labelId]);
      if (!label) throw notFound();
      if (label.account_id !== msgs[0].account_id) throw badRequest("wrong_account", "That label belongs to a different mailbox.");
      for (const m of msgs) {
        if (a.action === "label") await t.query("INSERT INTO message_labels(message_id,label_id,tenant_id,account_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [m.id, label.id, ctx.tenantId, m.account_id]);
        else await t.query("DELETE FROM message_labels WHERE message_id=$1 AND label_id=$2", [m.id, label.id]);
      }
      // IMAP has folders, not labels, so there a label only exists here and there's nothing to tell the provider.
      if (msgs[0].kind === "imap") return [];
      return msgs.map(m => ({ m, change: a.action === "label" ? { addLabels: [label.remote_id ?? label.name] } : { removeLabels: [label.remote_id ?? label.name] }, rollback: { label_id: label.id, label_applied: a.action !== "label" } }));
    }
    const def = ACTIONS[a.action];
    if (!def) throw badRequest("unknown_action", "Unknown action.");
    // Held mail changes state only through the quarantine flow, so an inbox shortcut can't bypass review.
    if (msgs.some(m => m.held) && def.folder) throw badRequest("held", "This message is in quarantine. Review it there to release or delete it.");
    // Malicious mail deleted from quarantine can't come back through Trash when release needs an admin's approval.
    if (def.folder && def.folder !== "trash") {
      const barred = await t.one("SELECT 1 FROM messages m JOIN quarantine_items q ON q.message_id=m.id WHERE (m.thread_id=$1 OR m.id=$1) AND m.risk_label='malicious' AND q.state='deleted' LIMIT 1", [threadId]);
      if (barred) throw forbidden("This message was rated malicious and deleted from quarantine, so it can't be moved back.");
    }
    const changes = [];
    for (const m of msgs) {
      await t.query("UPDATE messages SET folder_role=COALESCE($2,folder_role), is_read=COALESCE($3,is_read), is_starred=COALESCE($4,is_starred), updated_at=now() WHERE id=$1", [m.id, def.folder ?? null, def.read ?? null, def.star ?? null]);
      const change: MessageChange = {};
      if (def.folder) change.moveToRole = def.folder;
      if (def.read !== undefined) change.isRead = def.read;
      if (def.star !== undefined) change.isStarred = def.star;
      changes.push({ m, change, rollback: { folder_role: m.folder_role, is_read: m.is_read, is_starred: m.is_starred } });
    }
    return changes;
  });
  await p.db.withSystem(async t => {
    for (const { m, change, rollback } of out) await enqueue(t, { tenantId: ctx.tenantId, kind: "provider.change", payload: { accountId: m.account_id, messageId: m.id, change, rollback, userId: ctx.userId } });
  });
  return { ok: true, affected: out.length };
}

export async function listLabels(p: Platform, ctx: Ctx, accountId?: string) {
  return p.db.withUser(ctx, t => t.query<any>(`SELECT l.id, l.name, l.color, l.account_id "accountId", (SELECT count(*)::int FROM message_labels ml WHERE ml.label_id=l.id) count FROM mail_labels l ${accountId ? "WHERE l.account_id=$1" : ""} ORDER BY l.name`, accountId ? [accountId] : []));
}
export async function createLabel(p: Platform, ctx: Ctx, accountId: string, name: string, color?: string) {
  await p.db.withUser(ctx, t => requireOwner(t, accountId));
  return p.db.withUser(ctx, t => t.one<any>("INSERT INTO mail_labels(tenant_id,account_id,name,color) VALUES ($1,$2,$3,$4) ON CONFLICT (account_id,name) DO UPDATE SET color=COALESCE(EXCLUDED.color, mail_labels.color) RETURNING id, name, color", [ctx.tenantId, accountId, name.slice(0, 64), color ?? null]));
}

/** Deletes it here and from every message here. The provider's own label, if any, stays: the adapters have no call for that. */
export async function deleteLabel(p: Platform, ctx: Ctx, id: string) {
  await p.db.withUser(ctx, async t => {
    const l = await t.one<{ account_id: string }>("SELECT account_id FROM mail_labels WHERE id=$1", [id]);
    if (!l) throw notFound();
    await requireOwner(t, l.account_id);
    await t.query("DELETE FROM mail_labels WHERE id=$1", [id]);
  });
}

/**
 * Changes this person asked for that the provider ended up refusing, after the optimistic local change was rolled back.
 * Audit rows are content-free and carry the requester as the actor, so this needs no new storage and only returns their own.
 */
export async function recentRefusals(p: Platform, ctx: Ctx, since: Date) {
  return p.db.withUser(ctx, t => t.query<{ messageId: string; threadId: string | null; at: string; code: string | null }>(
    `SELECT e.target_id "messageId", m.thread_id "threadId", e.created_at at, e.meta->>'code' code
     FROM audit_events e LEFT JOIN messages m ON m.id::text = e.target_id
     WHERE e.event='provider.sync_failed' AND e.actor_user_id=$1 AND e.created_at > $2 ORDER BY e.created_at DESC LIMIT 50`, [ctx.userId, since]));
}

export async function getAttachment(p: Platform, ctx: Ctx, id: string) {
  const r = await p.db.withUser(ctx, t => t.one<any>("SELECT a.*, m.risk_label, m.held FROM attachments a JOIN messages m ON m.id=a.message_id WHERE a.id=$1 AND m.tombstoned_at IS NULL", [id]));
  if (!r) throw notFound();
  if (["malicious", "high_risk"].includes(r.risk_label)) throw badRequest("attachment_blocked", "This attachment is blocked because the message was rated high risk.");
  if (!r.blob_enc) throw badRequest("attachment_unavailable", "This attachment is too large to store here. Open it at your mail provider.");
  const meta = await p.envelope.openJson<{ filename: string; contentType: string }>(msgCtx(ctx.tenantId, id, "attachments"), r.meta_enc);
  return { ...meta, bytes: await p.envelope.open(msgCtx(ctx.tenantId, id, "attachments.blob"), r.blob_enc), scan: r.scan_status };
}

/** Destination details for the click-through interstitial. Never fetches the URL. */
export async function inspectLink(p: Platform, ctx: Ctx, messageId: string, href: string) {
  const r = await p.db.withUser(ctx, t => t.one<any>("SELECT risk_label FROM messages WHERE id=$1", [messageId]));
  if (!r) throw notFound();
  const host = hostOf(href);
  if (!host || !/^https?:/i.test(href)) throw badRequest("bad_link", "That link can't be opened.");
  const { findLookalike, decodeIdnHost } = await import("@aegis/security-engine");
  // Only a deliberate imitation is worth interrupting someone for: the same name under another ending, or a real name spelled alike, isn't one.
  const found = findLookalike(host);
  const hit = found && found.kind !== "tld_variant" && !found.nearMiss ? found : null;
  await p.db.withUser(ctx, t => t.query("SELECT 1"));
  return { href, host: decodeIdnHost(host), risk: r.risk_label, lookalike: hit ? hit.brand ?? hit.target : null, blocked: r.risk_label === "malicious", insecure: href.startsWith("http:") };
}

export async function markRead(t: Tx, id: string) { await t.query("UPDATE messages SET is_read=true WHERE id=$1", [id]); }

/** The relationship graph, inspectable. Strength is evidence, not a trust rating, and the UI says so. */
export async function listContacts(p: Platform, ctx: Ctx, accountId?: string) {
  const rows = await p.db.withUser(ctx, t => t.query<any>(`SELECT c.*, a.display_name FROM contacts c JOIN mail_accounts a ON a.id=c.account_id WHERE c.identity_enc IS NOT NULL ${accountId ? "AND c.account_id=$1" : ""} ORDER BY c.is_vip DESC, (c.trusted_at IS NOT NULL) DESC, c.received_count + c.sent_to_count DESC LIMIT 200`, accountId ? [accountId] : []));
  return Promise.all(rows.map(async r => ({
    id: r.id, accountId: r.account_id, account: r.display_name, received: r.received_count, sentTo: r.sent_to_count, replied: r.replied_count, dismissed: r.dismissed_count, vip: r.is_vip, ignored: r.is_ignored, lastSeenAt: r.last_seen_at,
    // A sender exception: flagged mail from them was reviewed and cleared. Who decided, and how far it reaches.
    exception: r.trusted_at ? { scope: r.trusted_scope as "sender" | "domain", by: r.trusted_by as "ai" | "user", at: r.trusted_at } : null,
    ...(await p.envelope.openJson<{ name?: string; address: string }>({ tenantId: ctx.tenantId, keyClass: "metadata", table: "contacts", recordId: r.id }, r.identity_enc)),
  })));
}
export async function setContact(p: Platform, ctx: Ctx, id: string, patch: { vip?: boolean; ignored?: boolean; /** Only `false`: an exception is removed here, never granted. */ exception?: false }) {
  const drop = patch.exception === false;
  const r = await p.db.withUser(ctx, t => t.query(
    `UPDATE contacts SET is_vip=COALESCE($2,is_vip), is_ignored=COALESCE($3,is_ignored),
       trusted_at=CASE WHEN $4 THEN NULL ELSE trusted_at END, trusted_scope=CASE WHEN $4 THEN NULL ELSE trusted_scope END, trusted_by=CASE WHEN $4 THEN NULL ELSE trusted_by END
     WHERE id=$1 RETURNING id`, [id, patch.vip ?? null, patch.ignored ?? null, drop]));
  if (!r.length) {
    const visible = await p.db.withUser(ctx, t => t.one("SELECT 1 FROM contacts WHERE id=$1", [id]));
    if (visible) throw new AppError(403, "read_only_access", "You have read-only access to this mailbox.");
    throw notFound();
  }
}
/** Forgets what was learned from behaviour. Rebuilds as mail arrives. Doesn't touch mail or rules. */
export async function resetLearning(p: Platform, ctx: Ctx) {
  const r = await p.db.withUser(ctx, t => t.query("UPDATE contacts SET dismissed_count=0, replied_count=0, is_vip=false, is_ignored=false WHERE account_id IN (SELECT id FROM mail_accounts WHERE owner_user_id=$1) RETURNING id", [ctx.userId]));
  return { reset: r.length };
}

export async function auditDenied(p: Platform, ctx: Ctx, target: string) {
  await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "access.denied", targetType: "thread", targetId: target }));
}
