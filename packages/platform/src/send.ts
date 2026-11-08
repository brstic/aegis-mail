import { randomUUID } from "node:crypto";
import { SendOutcomeUnknownError, type OutboundMessage } from "@aegis/domain";
import { emailDomain } from "@aegis/mail-parser";
import { adapterFor, loadAccount } from "./accounts";
import { audit } from "./audit";
import type { Tx } from "@aegis/db";
import { AppError, badRequest, conflict, type Ctx, forbidden, notFound, type Platform } from "./context";
import { msgCtx, type MessageEnvelope } from "./ingest";
import { DeferJob, enqueue, PermanentJobError } from "./jobs";

export interface DraftAttachment {
  id: string; filename: string; contentType: string; size: number; data: string;
  /** Set when the file came from another message, so it isn't copied twice and can be checked again at send. */
  source?: { messageId: string; attachmentId: string };
}
export interface DraftBody { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; inReplyTo?: string; references?: string[]; assumptions?: string[]; basis?: string; issues?: { code: string; message: string }[]; fromAlias?: string; attachments?: DraftAttachment[] }
/** Graph's /sendMail takes about 4 MB of base64 MIME, and it's the lowest limit of the providers we send through. */
export const MAX_DRAFT_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const aliasListed = (settings: { aliases?: { address: string }[] } | null | undefined, address: string) => (settings?.aliases ?? []).some(a => a.address.toLowerCase() === address.toLowerCase());
const dctx = (t: string, id: string) => msgCtx(t, id, "drafts");

export async function requireOwner(t: Tx, accountId: string) {
  const r = await t.one<{ ok: boolean }>("SELECT app.owns_account($1) ok", [accountId]);
  if (!r?.ok) throw new AppError(403, "read_only_access", "You have read-only access to this mailbox.");
}

/** The owner, or someone the owner explicitly allowed to send. Reading a shared mailbox doesn't imply this. */
export async function requireSender(t: Tx, accountId: string) {
  const r = await t.one<{ ok: boolean }>("SELECT app.can_send_account($1) ok", [accountId]);
  if (!r?.ok) throw new AppError(403, "read_only_access", "You have read-only access to this mailbox.");
}

export async function saveDraft(p: Platform, ctx: Ctx, input: { id?: string; accountId: string; threadId?: string; to: string[]; cc: string[]; bcc: string[]; subject: string; text: string; aiGenerated: boolean; fromAlias?: string; meta?: Partial<DraftBody> }) {
  const id = input.id ?? randomUUID();
  // Autosave rewrites the blob, so files added earlier come across from the saved copy. That copy can change while this runs, as a
  // file finishes copying from a message while the user types, so the write only lands on the blob it read. Otherwise it retries.
  for (let attempt = 0; attempt < DRAFT_WRITE_ATTEMPTS; attempt++) {
    const body: DraftBody = { to: input.to, cc: input.cc, bcc: input.bcc, subject: input.subject, text: input.text, ...input.meta };
    if (input.fromAlias) body.fromAlias = input.fromAlias;
    const prior = input.id ? await p.db.withUser(ctx, t => t.one<{ blob_enc: Buffer }>("SELECT blob_enc FROM drafts WHERE id=$1 AND user_id=$2", [id, ctx.userId])) : null;
    if (prior) { const was = await p.envelope.openJson<DraftBody>(dctx(ctx.tenantId, id), prior.blob_enc); if (was.attachments?.length) body.attachments = was.attachments; }
    const enc = await p.envelope.sealJson(dctx(ctx.tenantId, id), body);
    const outcome = await p.db.withUser(ctx, async t => {
      const acct = await loadAccount(t, input.accountId);
      if (!acct) throw notFound();
      await requireSender(t, input.accountId);
      if (input.threadId) { const th = await t.one<any>("SELECT account_id FROM threads WHERE id=$1", [input.threadId]); if (!th || th.account_id !== input.accountId) throw badRequest("wrong_account", "This reply must come from the account that received the conversation."); }
      const wrote = await t.query(
        `INSERT INTO drafts(id,tenant_id,account_id,user_id,thread_id,blob_enc,ai_generated) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET blob_enc=EXCLUDED.blob_enc, account_id=EXCLUDED.account_id, updated_at=now() WHERE drafts.state='editing' AND drafts.blob_enc IS NOT DISTINCT FROM $8 RETURNING id`,
        [id, ctx.tenantId, input.accountId, ctx.userId, input.threadId ?? null, enc, input.aiGenerated, prior?.blob_enc ?? null]);
      if (wrote.length) return "written";
      // Not written: either someone else changed it, so try again, or it's already sending, and this save has nothing to do.
      return (await t.one<{ state: string }>("SELECT state FROM drafts WHERE id=$1", [id]))?.state === "editing" ? "retry" : "locked";
    });
    if (outcome !== "retry") return { id };
  }
  throw conflict("draft_busy", "This draft is changing in another tab. Try again.");
}

export async function listDrafts(p: Platform, ctx: Ctx, opts: { state?: string[] } = {}) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT d.*, sa.scheduled_for, sa.error_code, a.email account_email FROM drafts d JOIN mail_accounts a ON a.id=d.account_id LEFT JOIN send_approvals sa ON sa.draft_id=d.id WHERE d.state = ANY($1) AND d.user_id=$2 ORDER BY d.updated_at DESC LIMIT 100", [opts.state ?? ["editing"], ctx.userId]));
  return Promise.all(rows.map(async r => {
    const body = await p.envelope.openJson<DraftBody>(dctx(ctx.tenantId, r.id), r.blob_enc);
    return { id: r.id, accountId: r.account_id, accountEmail: r.account_email, threadId: r.thread_id, state: r.state, aiGenerated: r.ai_generated, updatedAt: r.updated_at, scheduledFor: r.scheduled_for, errorCode: r.error_code, ...body, attachments: draftAttachmentList(body) };
  }));
}

const draftAttachmentList = (b: DraftBody) => (b.attachments ?? []).map(({ data: _data, source, ...meta }) => ({ ...meta, ...(source ? { sourceAttachmentId: source.attachmentId } : {}) }));

const DRAFT_WRITE_ATTEMPTS = 12;
/**
 * Changes a draft's attachments. Each attempt only lands on the blob it read, so two at once can't both pass the size check
 * or lose each other's file, and neither can an autosave running beside them.
 */
async function changeDraftAttachments(p: Platform, ctx: Ctx, draftId: string, change: (current: DraftAttachment[]) => DraftAttachment[]) {
  for (let attempt = 0; attempt < DRAFT_WRITE_ATTEMPTS; attempt++) {
    const d = await p.db.withUser(ctx, t => t.one<{ blob_enc: Buffer; state: string }>("SELECT blob_enc, state FROM drafts WHERE id=$1 AND user_id=$2", [draftId, ctx.userId]));
    if (!d) throw notFound();
    if (d.state !== "editing") throw conflict("draft_locked", "This draft is already being sent.");
    const body = await p.envelope.openJson<DraftBody>(dctx(ctx.tenantId, draftId), d.blob_enc);
    body.attachments = change(body.attachments ?? []);
    const enc = await p.envelope.sealJson(dctx(ctx.tenantId, draftId), body);
    const wrote = await p.db.withUser(ctx, t => t.query("UPDATE drafts SET blob_enc=$2, updated_at=now() WHERE id=$1 AND state='editing' AND blob_enc=$3 RETURNING id", [draftId, enc, d.blob_enc]));
    if (wrote.length) return { attachments: draftAttachmentList(body) };
  }
  throw conflict("draft_busy", "This draft is changing in another tab. Try again.");
}
const tooLarge = () => new AppError(413, "attachments_too_large", "Attachments on one message can total at most 3 MB.");
const totalSize = (list: DraftAttachment[]) => list.reduce((s, a) => s + a.size, 0);
const safeFilename = (name: string) => name.replace(/[\r\n/\\]+/g, "_").slice(0, 200);

export async function addDraftAttachment(p: Platform, ctx: Ctx, draftId: string, input: { filename: string; contentType?: string; dataBase64: string }) {
  const size = Buffer.from(input.dataBase64, "base64").length;
  if (!size) throw badRequest("attachment_empty", "That file is empty.");
  return changeDraftAttachments(p, ctx, draftId, current => {
    if (totalSize(current) + size > MAX_DRAFT_ATTACHMENT_BYTES) throw tooLarge();
    return [...current, { id: randomUUID(), filename: safeFilename(input.filename), contentType: input.contentType ?? "application/octet-stream", size, data: input.dataBase64 }];
  });
}

export async function removeDraftAttachment(p: Platform, ctx: Ctx, draftId: string, attachmentId: string) {
  return changeDraftAttachments(p, ctx, draftId, current => current.filter(a => a.id !== attachmentId));
}

/** A message with one of these verdicts can't have its files carried on. Unknown is different: it's for the person to judge, so it's off by default. */
const REFUSED_MESSAGE_LABELS = new Set(["suspicious", "high_risk", "malicious"]);
/** infected is the scanner's finding. unscannable and error mean it had no finding at all, so this product can't vouch for the file. not_scanned is the baseline when no engine is deployed, and the composer says so. */
const REFUSED_SCAN_STATUSES = new Set(["infected", "unscannable", "error"]);

/**
 * Forwarding the original's files. The composer's choices are only requests: every rule is checked here, from what's stored, on each call.
 * The caller must be able to read the message (RLS decides, and "can't" looks like "doesn't exist") and send from the draft's account.
 */
export async function copyAttachmentsToDraft(p: Platform, ctx: Ctx, draftId: string, input: { messageId: string; attachmentIds: string[] }) {
  const wanted = [...new Set(input.attachmentIds)];
  const { files, denial } = await p.db.withUser(ctx, async t => {
    const d = await t.one<{ account_id: string; state: string }>("SELECT account_id, state FROM drafts WHERE id=$1 AND user_id=$2", [draftId, ctx.userId]);
    if (!d) throw notFound();
    if (d.state !== "editing") throw conflict("draft_locked", "This draft is already being sent.");
    await requireSender(t, d.account_id);
    const m = await t.one<{ risk_label: string | null; held: boolean; state: string; sealed: boolean }>(
      "SELECT m.risk_label, m.held, m.state, c.sealed_blob IS NOT NULL sealed FROM messages m LEFT JOIN message_contents c ON c.message_id=m.id WHERE m.id=$1 AND m.tombstoned_at IS NULL", [input.messageId]);
    if (!m) throw notFound();
    const rows = await t.query<{ id: string; size_bytes: number; scan_status: string; meta_enc: Buffer; blob_enc: Buffer | null }>("SELECT id, size_bytes, scan_status, meta_enc, blob_enc FROM attachments WHERE message_id=$1 AND id = ANY($2::uuid[])", [input.messageId, wanted]);
    // Each ID has to be a file on this message. Otherwise a readable message could vouch for any file.
    if (rows.length !== wanted.length) throw notFound();
    const refuse = (code: string, reason: string, message: string) => ({ files: [] as typeof rows, denial: { code, reason, message } });
    if (m.held) return refuse("attachments_refused", "held", "This message is in quarantine, so its attachments can't be forwarded. Review it there first.");
    if (m.sealed) return refuse("attachment_unavailable", "sealed", "This message is sealed, so its attachments aren't stored here any more.");
    if (m.state !== "classified" || !m.risk_label) return refuse("attachments_refused", "unrated", "This message hasn't finished being checked, so its attachments can't be forwarded yet.");
    if (REFUSED_MESSAGE_LABELS.has(m.risk_label)) return refuse("attachments_refused", "flagged_message", "This message was flagged, so its attachments can't be forwarded. You can still forward the text.");
    if (rows.some(r => REFUSED_SCAN_STATUSES.has(r.scan_status))) return refuse("attachments_refused", "flagged_attachment", "The malware scanner flagged or couldn't read one of these attachments, so it can't be forwarded.");
    if (rows.some(r => !r.blob_enc)) return refuse("attachment_unavailable", "not_stored", "One of these attachments isn't stored here, usually because it's too large or storing attachments is off. Download it from your provider and attach it yourself.");
    return { files: rows, denial: null };
  });
  if (denial) {
    // After the transaction: an error thrown inside would roll this back too.
    await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "access.denied", targetType: "message", targetId: input.messageId, meta: { reason: denial.reason, kind: "forward_attachments" } }));
    throw new AppError(denial.code === "attachments_refused" ? 403 : 400, denial.code, denial.message);
  }
  // Sizes first, so a request that can't fit doesn't decrypt anything.
  if (files.reduce((s, f) => s + f.size_bytes, 0) > MAX_DRAFT_ATTACHMENT_BYTES) throw tooLarge();
  const decrypted = await Promise.all(files.map(async f => ({
    id: f.id,
    meta: await p.envelope.openJson<{ filename: string; contentType?: string }>(msgCtx(ctx.tenantId, f.id, "attachments"), f.meta_enc),
    bytes: await p.envelope.open(msgCtx(ctx.tenantId, f.id, "attachments.blob"), f.blob_enc!),
  })));
  const added = await changeDraftAttachments(p, ctx, draftId, current => {
    const have = new Set(current.flatMap(a => a.source ? [a.source.attachmentId] : []));
    const fresh = decrypted.filter(f => !have.has(f.id));
    if (totalSize(current) + fresh.reduce((s, f) => s + f.bytes.length, 0) > MAX_DRAFT_ATTACHMENT_BYTES) throw tooLarge();
    return [...current, ...fresh.map(f => ({
      id: randomUUID(), filename: safeFilename(f.meta.filename || "attachment"),
      // Came from the sender's headers.
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(f.meta.contentType ?? "") ? f.meta.contentType! : "application/octet-stream",
      size: f.bytes.length, data: f.bytes.toString("base64"), source: { messageId: input.messageId, attachmentId: f.id },
    }))];
  });
  await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "send.requested", targetType: "draft", targetId: draftId, meta: { kind: "forward_attachments", count: decrypted.length } }));
  return added;
}

export async function deleteDraft(p: Platform, ctx: Ctx, id: string) {
  const r = await p.db.withUser(ctx, t => t.query("DELETE FROM drafts WHERE id=$1 AND state IN ('editing','scheduled') RETURNING id", [id]));
  if (!r.length) throw notFound();
}

/** What stops a draft leaving, whenever it's checked. RLS decides which messages `t` can see, so a source it can't see counts as gone. */
async function outboundProblem(t: Tx, tenantId: string, body: DraftBody): Promise<{ status: number; code: string; message: string } | null> {
  const sources = [...new Set((body.attachments ?? []).flatMap(a => a.source ? [a.source.messageId] : []))];
  if (sources.length) {
    const seen = await t.query<{ id: string; risk_label: string | null; held: boolean }>("SELECT id, risk_label, held FROM messages WHERE id = ANY($1::uuid[]) AND tombstoned_at IS NULL", [sources]);
    if (seen.length < sources.length) return { status: 409, code: "attachment_source_gone", message: "An attachment here came from a message you can't open any more. Remove it to send." };
    if (seen.some(m => m.held || REFUSED_MESSAGE_LABELS.has(m.risk_label ?? ""))) return { status: 403, code: "attachments_refused", message: "An attachment here came from a message that has since been flagged. Remove it to send." };
  }
  const pol = await t.one<{ policy: { outboundBlockDomains?: string[] } }>("SELECT policy FROM tenant_policies WHERE tenant_id=$1", [tenantId]);
  const blocked = (pol?.policy?.outboundBlockDomains ?? []).map(x => x.toLowerCase());
  const hit = [...body.to, ...body.cc, ...body.bcc].find(r => { const dom = emailDomain(r); return blocked.some(b => dom === b || dom.endsWith(`.${b}`)); });
  return hit ? { status: 403, code: "outbound_blocked", message: `Your organization's policy doesn't allow sending to ${emailDomain(hit)}.` } : null;
}

/**
 * The only route to sending. Requires a human session, an idempotency key, and the From address the UI displayed.
 * Nothing in the assistant or automations calls this.
 */
export async function approveSend(p: Platform, ctx: Ctx, draftId: string, input: { expectedFrom: string; idempotencyKey: string; scheduledFor?: string; acknowledgedRisk: boolean }) {
  const { approvalId, duplicate, runAt, accountId } = await p.db.withUser(ctx, async t => {
    const d = await t.one<any>("SELECT d.*, a.email, a.read_only, a.status, a.kind, a.owner_user_id, a.settings FROM drafts d JOIN mail_accounts a ON a.id=d.account_id WHERE d.id=$1 AND d.user_id=$2", [draftId, ctx.userId]);
    if (!d) throw notFound();
    const prior = await t.one<any>("SELECT id, state FROM send_approvals WHERE account_id=$1 AND idempotency_key=$2", [d.account_id, input.idempotencyKey]);
    if (prior) return { approvalId: prior.id as string, duplicate: true, runAt: undefined, accountId: d.account_id as string };
    // The identity shown must be the identity used. This is what stops accidental cross-account sends.
    if (d.email.toLowerCase() !== input.expectedFrom.toLowerCase() && !aliasListed(d.settings, input.expectedFrom)) {
      await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "access.denied", targetType: "draft", targetId: draftId, meta: { reason: "identity_mismatch" } });
      throw conflict("identity_mismatch", `This draft would send from ${d.email}, not ${input.expectedFrom}. Check the From account and try again.`);
    }
    if (d.read_only) throw forbidden("This mailbox is connected read-only, so it can't send.");
    if (d.status !== "active") throw conflict("account_unavailable", "This mailbox needs to be reconnected before it can send.");
    if (d.kind === "pop3") throw badRequest("send_unsupported", "POP3 connections can't send mail.");
    if (d.state !== "editing") throw conflict("draft_locked", "This draft is already being sent.");
    if (d.thread_id) {
      const risky = await t.one<any>("SELECT 1 FROM messages WHERE thread_id=$1 AND NOT from_me AND risk_label IN ('suspicious','high_risk','malicious') LIMIT 1", [d.thread_id]);
      if (risky && !input.acknowledgedRisk) throw new AppError(428, "risk_acknowledgement_required", "This conversation has been flagged as suspicious. Confirm you want to reply.");
    }
    // Checked against what's actually in the draft, on the server, and again by the worker when it leaves.
    const problem = await outboundProblem(t, ctx.tenantId, await p.envelope.openJson<DraftBody>(dctx(ctx.tenantId, draftId), d.blob_enc));
    if (problem) throw new AppError(problem.status, problem.code, problem.message);
    const when = input.scheduledFor ? new Date(input.scheduledFor) : undefined;
    if (when && when.getTime() < p.now().getTime() - 60_000) throw badRequest("schedule_past", "Pick a time in the future.");
    const rfcId = `<${randomUUID()}@${emailDomain(d.email) || "local"}>`;
    const a = await t.one<{ id: string }>(
      "INSERT INTO send_approvals(tenant_id,account_id,draft_id,approved_by,session_id,idempotency_key,rfc_message_id,expected_from,scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [ctx.tenantId, d.account_id, draftId, ctx.userId, ctx.sessionId ?? null, input.idempotencyKey, rfcId, input.expectedFrom.toLowerCase(), when ?? null]);
    // What was checked has to be what goes out. Autosave can land during this transaction, and after this update it can't.
    const locked = await t.query("UPDATE drafts SET state=$2 WHERE id=$1 AND state='editing' AND blob_enc=$3 RETURNING id", [draftId, when ? "scheduled" : "sending", d.blob_enc]);
    if (!locked.length) throw conflict("draft_changed", "This draft changed while it was being sent. Check it and send again.");
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "send.authorized", targetType: "draft", targetId: draftId, meta: { outcome: when ? "scheduled" : "now", kind: d.owner_user_id === ctx.userId ? "owner" : "delegate" } });
    return { approvalId: a!.id, duplicate: false, runAt: when, accountId: d.account_id as string };
  });
  if (!duplicate) await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "send.execute", payload: { approvalId, accountId }, runAt, dedupeKey: `send:${approvalId}`, maxAttempts: 4 }));
  return { approvalId, duplicate, scheduledFor: runAt?.toISOString() ?? null };
}

export async function cancelScheduled(p: Platform, ctx: Ctx, draftId: string) {
  await p.db.withUser(ctx, async t => {
    const d = await t.one<any>("SELECT state FROM drafts WHERE id=$1 AND user_id=$2", [draftId, ctx.userId]);
    if (!d) throw notFound();
    if (d.state !== "scheduled") throw conflict("not_scheduled", "This message isn't scheduled.");
    await t.query("DELETE FROM send_approvals WHERE draft_id=$1", [draftId]);
    await t.query("UPDATE drafts SET state='editing' WHERE id=$1", [draftId]);
  });
  await p.db.withSystem(t => t.query("UPDATE jobs SET state='cancelled' WHERE kind='send.execute' AND state='queued' AND dedupe_key LIKE 'send:%' AND payload->>'accountId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM send_approvals s WHERE s.id::text = jobs.payload->>'approvalId')").catch(() => []));
}

/** Worker. A timeout leaves outcome "unknown", and retries first ask the provider whether it was delivered. */
export async function executeSend(p: Platform, tenantId: string, approvalId: string) {
  const a = await p.db.withWorker(tenantId, async t => {
    const row = await t.one<any>("SELECT s.*, d.blob_enc, d.thread_id FROM send_approvals s JOIN drafts d ON d.id=s.draft_id WHERE s.id=$1 FOR UPDATE OF s", [approvalId]);
    if (!row) return null;
    // Replay of a finished or in-doubt job is a no-op; only an explicit reconcile can move "unknown" forward.
    if (row.state === "completed" || row.state === "failed" || row.state === "unknown") return { ...row, skip: true };
    await t.query("UPDATE send_approvals SET state='sending', attempts=attempts+1 WHERE id=$1", [approvalId]);
    return row;
  });
  if (!a || a.skip) return;
  const { adapter, account } = await adapterFor(p, tenantId, a.account_id);
  // An alias has to still be listed when it goes out, for the same reason as the access check below.
  const fromAlias = account.email.toLowerCase() === a.expected_from ? null : (account.settings?.aliases ?? []).find((x: { address: string; name?: string }) => x.address.toLowerCase() === a.expected_from);
  if (account.email.toLowerCase() !== a.expected_from && !fromAlias) throw new PermanentJobError("identity_mismatch");
  // Recheck when it actually goes out: a scheduled send outlives the session and maybe the person's access.
  const stillAllowed = account.owner_user_id === a.approved_by || !!(await p.db.withWorker(tenantId, t => t.one("SELECT 1 FROM mailbox_grants WHERE account_id=$1 AND grantee_user_id=$2 AND can_send", [a.account_id, a.approved_by])));
  if (!stillAllowed || account.status !== "active") {
    await p.db.withWorker(tenantId, async t => {
      await t.query("UPDATE send_approvals SET state='failed', error_code='no_longer_authorized' WHERE id=$1", [approvalId]);
      await t.query("UPDATE drafts SET state='failed' WHERE id=$1", [a.draft_id]);
    });
    throw new PermanentJobError("no_longer_authorized");
  }
  // A prior attempt may have delivered, then crashed before recording. Never send twice.
  if (a.attempts > 0) {
    const found = await adapter.findSentByMessageId(a.rfc_message_id);
    if (found) { await complete(p, tenantId, approvalId, a.draft_id, found.remoteId); return; }
  }
  const draft = await p.envelope.openJson<DraftBody>(dctx(tenantId, a.draft_id), a.blob_enc);
  // A scheduled send or a retried job can leave long after approval, and the policy or the source message may have changed.
  const problem = await p.db.withWorker(tenantId, t => outboundProblem(t, tenantId, draft));
  if (problem) {
    await p.db.withWorker(tenantId, async t => {
      await t.query("UPDATE send_approvals SET state='failed', error_code=$2 WHERE id=$1", [approvalId, problem.code]);
      await t.query("UPDATE drafts SET state='failed' WHERE id=$1", [a.draft_id]);
      await audit(t, { tenantId, event: "send.failed", targetType: "draft", targetId: a.draft_id, meta: { reason: problem.code } });
    });
    throw new PermanentJobError(problem.code);
  }
  let threadHeaders: Pick<OutboundMessage, "inReplyTo" | "references" | "remoteThreadId"> = {};
  if (a.thread_id) {
    const last = await p.db.withWorker(tenantId, t => t.one<any>("SELECT m.id, m.envelope_enc, th.provider_thread_id FROM messages m JOIN threads th ON th.id=m.thread_id WHERE m.thread_id=$1 AND m.envelope_enc IS NOT NULL ORDER BY m.internal_date DESC LIMIT 1", [a.thread_id]));
    if (last) {
      const e = await p.envelope.openJson<MessageEnvelope>(msgCtx(tenantId, last.id), last.envelope_enc);
      threadHeaders = { inReplyTo: e.messageId, references: [...e.references, ...(e.messageId ? [e.messageId] : [])].slice(-20), remoteThreadId: last.provider_thread_id ?? undefined };
    }
  }
  const owner = await p.db.withWorker(tenantId, t => t.one<any>("SELECT name FROM users WHERE id=$1", [account.owner_user_id]));
  const msg: OutboundMessage = {
    from: fromAlias ? { name: fromAlias.name ?? owner?.name, address: fromAlias.address } : { name: owner?.name, address: account.email }, to: draft.to.map(address => ({ address })), cc: draft.cc.map(address => ({ address })), bcc: draft.bcc.map(address => ({ address })),
    subject: draft.subject, text: draft.text, messageId: a.rfc_message_id, ...threadHeaders,
    attachments: draft.attachments?.map(x => ({ filename: x.filename, contentType: x.contentType, content: Buffer.from(x.data, "base64") })),
  };
  try {
    const res = await adapter.send(msg);
    await complete(p, tenantId, approvalId, a.draft_id, res.remoteId, res.rejectedRecipients?.length);
    await p.db.withSystem(t => enqueue(t, { tenantId, kind: "sync.account", payload: { accountId: a.account_id }, dedupeKey: `sync:${a.account_id}` }));
  } catch (e) {
    if (e instanceof SendOutcomeUnknownError) {
      await p.db.withWorker(tenantId, async t => { await t.query("UPDATE send_approvals SET state='unknown', error_code='outcome_unknown' WHERE id=$1", [approvalId]); await t.query("UPDATE drafts SET state='unknown' WHERE id=$1", [a.draft_id]); });
      await p.db.withSystem(t => enqueue(t, { tenantId, kind: "send.reconcile", payload: { approvalId, accountId: a.account_id }, runAt: new Date(p.now().getTime() + 30_000), maxAttempts: 6 }));
      return;
    }
    await p.db.withWorker(tenantId, async t => {
      await t.query("UPDATE send_approvals SET state='failed', error_code='provider_rejected' WHERE id=$1", [approvalId]);
      await t.query("UPDATE drafts SET state='failed' WHERE id=$1", [a.draft_id]);
      await audit(t, { tenantId, event: "send.failed", targetType: "draft", targetId: a.draft_id });
    });
    throw new PermanentJobError("provider_rejected");
  } finally {
    await adapter.close?.().catch(() => {});
  }
}

async function complete(p: Platform, tenantId: string, approvalId: string, draftId: string, remoteId?: string, refusedRecipients?: number) {
  await p.db.withWorker(tenantId, async t => {
    await t.query("UPDATE send_approvals SET state='completed', remote_id=$2, completed_at=now(), error_code=$3 WHERE id=$1", [approvalId, remoteId ?? null, refusedRecipients ? "recipients_refused" : null]);
    await t.query("UPDATE drafts SET state='sent' WHERE id=$1", [draftId]);
    await audit(t, { tenantId, event: "send.completed", targetType: "draft", targetId: draftId, ...(refusedRecipients ? { meta: { outcome: "partial", count: refusedRecipients } } : {}) });
    // The server took the message but refused some addresses. Saying "sent" and nothing more would be wrong. Goes to whoever approved it.
    if (refusedRecipients) await t.query("INSERT INTO notifications(tenant_id,user_id,kind,severity,ref_id,dedupe_key,deliver_at) SELECT tenant_id, approved_by, 'send_partial', 'critical', draft_id, 'partial:' || id, now() FROM send_approvals WHERE id=$1 ON CONFLICT (tenant_id,user_id,dedupe_key) DO NOTHING", [approvalId]);
  });
}

/**
 * Resolves "unknown" by asking the provider. Never auto-resends.
 * Absence isn't proof of non-delivery: many SMTP servers don't file a Sent copy, so IMAP lookups can miss a delivered
 * message. So the end state reads "unconfirmed" and the UI tells the user it may have gone out before they retry.
 */
export async function reconcileSend(p: Platform, tenantId: string, approvalId: string, attempt: number, maxAttempts: number) {
  const a = await p.db.withWorker(tenantId, t => t.one<any>("SELECT * FROM send_approvals WHERE id=$1", [approvalId]));
  if (!a || a.state !== "unknown") return;
  const { adapter } = await adapterFor(p, tenantId, a.account_id);
  const found = await adapter.findSentByMessageId(a.rfc_message_id);
  await adapter.close?.().catch(() => {});
  if (found) { await complete(p, tenantId, approvalId, a.draft_id, found.remoteId); return; }
  if (attempt >= maxAttempts) {
    await p.db.withWorker(tenantId, async t => {
      await t.query("UPDATE send_approvals SET state='failed', error_code='outcome_unconfirmed' WHERE id=$1", [approvalId]);
      await t.query("UPDATE drafts SET state='failed' WHERE id=$1", [a.draft_id]);
      await audit(t, { tenantId, event: "send.failed", targetType: "draft", targetId: a.draft_id, meta: { reason: "not_found_after_timeout" } });
    });
    return;
  }
  throw new DeferJob(60_000 * attempt, true);
}

export async function retrySend(p: Platform, ctx: Ctx, draftId: string) {
  await p.db.withUser(ctx, async t => {
    const d = await t.one<any>("SELECT state FROM drafts WHERE id=$1 AND user_id=$2", [draftId, ctx.userId]);
    if (!d) throw notFound();
    if (d.state !== "failed") throw conflict("not_failed", "This draft hasn't failed.");
    await t.query("DELETE FROM send_approvals WHERE draft_id=$1", [draftId]);
    await t.query("UPDATE drafts SET state='editing' WHERE id=$1", [draftId]);
  });
}
