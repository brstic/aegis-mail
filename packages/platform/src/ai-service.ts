import { htmlToText, sanitizeEmailHtml } from "@aegis/mail-parser";
import { LocalHeuristicProvider, checkDraft, selectProvider, validateRecipients, type DraftKind, type DraftRequest, type InferenceProvider, type ThreadMessageInput } from "@aegis/ai-core";
import { AppError, badRequest, type Ctx, notFound, type Platform } from "./context";
import { msgCtx, type MessageEnvelope } from "./ingest";
import { audit } from "./audit";
import { requireOwner, saveDraft } from "./send";
import { getPrefs } from "./prefs";
import { countAiAction } from "./limits";
import { recordAiUsage } from "./ai-usage";

export async function providerFor(p: Platform, ctx: { tenantId: string; userId: string }): Promise<InferenceProvider> {
  const override = p.inferenceOverride?.(ctx);
  if (override) return override;
  const prefs = await getPrefs(p, ctx as Ctx);
  const tenantOptOut = await p.db.withUser(ctx as Ctx, t => t.one<any>("SELECT policy->>'hostedModelsDisabled' d FROM tenant_policies WHERE tenant_id=$1", [ctx.tenantId]));
  return selectProvider({
    hosted: p.config.ai, aiEnabled: prefs.aiEnabled !== false, hostedConsent: prefs.hostedModelConsent === true && tenantOptOut?.d !== "true",
    onUsage: u => { void recordAiUsage(p, "user", ctx, u).catch(() => {}); },
  }).provider;
}

/**
 * Counts hosted model calls, against the workspace's limit if one is set. Local rules cost nothing and aren't counted, so reaching
 * a limit never removes summaries, and it never touches security analysis.
 */
export async function meterAi(p: Platform, ctx: Ctx, provider: InferenceProvider) {
  if (!provider.hosted) return;
  await countAiAction(p, ctx);
}

export async function threadInput(p: Platform, ctx: Ctx, threadId: string): Promise<{ input: ThreadMessageInput[]; accountId: string; flagged: boolean; ids: string[] }> {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT m.id, m.envelope_enc, m.from_me, m.risk_label, m.internal_date, m.account_id, c.blob_enc FROM messages m LEFT JOIN message_contents c ON c.message_id=m.id WHERE (m.thread_id=$1 OR m.id=$1) AND m.tombstoned_at IS NULL AND m.envelope_enc IS NOT NULL ORDER BY m.internal_date", [threadId]));
  if (!rows.length) throw notFound();
  const input = await Promise.all(rows.map(async r => {
    const e = await p.envelope.openJson<MessageEnvelope>(msgCtx(ctx.tenantId, r.id), r.envelope_enc);
    const c = r.blob_enc ? await p.envelope.openJson<{ text: string; html?: string | null }>(msgCtx(ctx.tenantId, r.id, "message_contents"), r.blob_enc) : { text: "", html: null };
    // What the person sees, so a benign plain part can't make a summary misdescribe the HTML they're reading.
    const visible = c.html ? htmlToText(sanitizeEmailHtml(c.html).html) : c.text;
    return { id: r.id, fromName: e.from?.name, from: e.from?.address ?? "", to: e.to.map(a => a.address), date: new Date(r.internal_date).toISOString(), subject: e.subject, text: visible, fromMe: r.from_me, riskLabel: r.risk_label };
  }));
  return { input, accountId: rows[0].account_id, flagged: rows.some(r => !r.from_me && ["suspicious", "high_risk", "malicious"].includes(r.risk_label)), ids: rows.map(r => r.id) };
}

export async function summarizeThread(p: Platform, ctx: Ctx, threadId: string) {
  const prefs = await getPrefs(p, ctx);
  if (prefs.aiEnabled === false || prefs.summariesEnabled === false) throw new AppError(409, "ai_disabled", "AI features are off. Turn them on in Settings.");
  const { input, accountId } = await threadInput(p, ctx, threadId);
  // The mailbox owner decides whether their mail goes to a hosted model, not someone they shared it with. And a
  // grantee can read but not write, so nothing is cached for them.
  const owned = (await p.db.withUser(ctx, t => t.one<{ ok: boolean }>("SELECT app.owns_account($1) ok", [accountId])))?.ok === true;
  const provider = owned ? await providerFor(p, ctx) : new LocalHeuristicProvider();
  const cached = await p.db.withUser(ctx, t => t.one<any>("SELECT blob_enc, id, provider, message_count_at FROM ai_artifacts WHERE thread_id=$1 AND kind='summary'", [threadId]));
  if (cached && cached.message_count_at === input.length && cached.provider === provider.id) return { ...(await p.envelope.openJson<any>(msgCtx(ctx.tenantId, cached.id, "ai_artifacts"), cached.blob_enc)), cached: true };
  await meterAi(p, ctx, provider);
  const summary = await provider.summarize(input);
  const out = { ...summary, provider: provider.id, hosted: provider.hosted, model: provider.model };
  if (!owned) return out;
  // Fresh id per regeneration, sealed against that id so AAD binds it.
  const id = crypto.randomUUID();
  const enc = await p.envelope.sealJson(msgCtx(ctx.tenantId, id, "ai_artifacts"), out);
  await p.db.withUser(ctx, t => t.query(
    `INSERT INTO ai_artifacts(id,tenant_id,account_id,thread_id,kind,provider,model,blob_enc,message_count_at) VALUES ($1,$2,$3,$4,'summary',$5,$6,$7,$8)
     ON CONFLICT (thread_id,kind) DO UPDATE SET id=EXCLUDED.id, blob_enc=EXCLUDED.blob_enc, provider=EXCLUDED.provider, model=EXCLUDED.model, message_count_at=EXCLUDED.message_count_at, created_at=now()`,
    [id, ctx.tenantId, accountId, threadId, provider.id, provider.model, enc, input.length]));
  return out;
}

export async function suggestDraft(p: Platform, ctx: Ctx, threadId: string, opts: { kind: DraftKind; tone?: DraftRequest["tone"]; instruction?: string; ownerName: string }) {
  const prefs = await getPrefs(p, ctx);
  if (prefs.aiEnabled === false) throw new AppError(409, "ai_disabled", "AI features are off. Turn them on in Settings.");
  const { input, accountId, flagged } = await threadInput(p, ctx, threadId);
  const account = await p.db.withUser(ctx, t => t.one<any>("SELECT email, read_only FROM mail_accounts WHERE id=$1", [accountId]));
  if (!account) throw notFound();
  // As with summaries: only the mailbox owner's consent can send its mail to a hosted model. Someone it's shared with gets
  // the local model, whatever they've agreed to for their own mail.
  const owned = (await p.db.withUser(ctx, t => t.one<{ ok: boolean }>("SELECT app.owns_account($1) ok", [accountId])))?.ok === true;
  const provider = owned ? await providerFor(p, ctx) : new LocalHeuristicProvider();
  const req: DraftRequest = { kind: opts.kind, tone: opts.tone ?? prefs.tone ?? "neutral", instruction: opts.instruction, thread: input, ownerName: opts.ownerName, ownerAddress: account.email };
  await meterAi(p, ctx, provider);
  const draft = await provider.draft(req);
  const check = checkDraft(draft, req);
  if (check.blocked) {
    await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "access.denied", targetType: "thread", targetId: threadId, meta: { reason: "draft_blocked", code: check.issues[0]?.code } }));
    throw new AppError(422, "draft_blocked", "The suggested draft was discarded because it contained a link, address or credential that isn't from this conversation.");
  }
  const latest = [...input].reverse().find(m => !m.fromMe) ?? input[input.length - 1]!;
  const to = latest.fromMe ? latest.to : [latest.from];
  const recipients = validateRecipients(to, input, account.email);
  const saved = await saveDraft(p, ctx, { accountId, threadId, to, cc: [], bcc: [], subject: draft.subject, text: draft.text, aiGenerated: true, meta: { assumptions: draft.assumptions, basis: draft.basis, issues: check.issues } });
  await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "draft.generated", targetType: "draft", targetId: saved.id, meta: { provider: provider.id } }));
  return { draftId: saved.id, accountId, from: account.email, to, subject: draft.subject, text: draft.text, assumptions: draft.assumptions, issues: check.issues, basis: draft.basis, provider: provider.id, hosted: provider.hosted, flaggedThread: flagged, unfamiliarRecipients: recipients.unfamiliar };
}

export async function listTasks(p: Platform, ctx: Ctx, status = "open") {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT x.*, m.risk_label FROM tasks x LEFT JOIN messages m ON m.id=x.message_id WHERE x.status=$1 AND x.owner_user_id=$2 AND (m.risk_label IS NULL OR m.risk_label IN ('safe','bulk_low_priority')) ORDER BY x.due_at NULLS LAST, x.created_at DESC LIMIT 200", [status, ctx.userId]));
  return Promise.all(rows.map(async r => ({ id: r.id, threadId: r.thread_id, accountId: r.account_id, status: r.status, dueAt: r.due_at, dueUncertain: r.due_uncertain, remindAt: r.remind_at, source: r.source, ...(await p.envelope.openJson<{ text: string; kind: string; owner: string; due?: { text: string; evidence: string } }>(msgCtx(ctx.tenantId, r.id, r.source === "automation" ? "tasks" : "tasks"), r.blob_enc)) })));
}
export async function setTaskStatus(p: Platform, ctx: Ctx, id: string, status: "open" | "done" | "dismissed") {
  const r = await p.db.withUser(ctx, t => t.query("UPDATE tasks SET status=$2 WHERE id=$1 AND owner_user_id=$3 RETURNING id", [id, status, ctx.userId]));
  if (!r.length) throw notFound();
}
export async function createTask(p: Platform, ctx: Ctx, input: { text: string; accountId: string; dueAt?: string; threadId?: string }) {
  if (!input.text.trim()) throw badRequest("empty", "Add a description.");
  await p.db.withUser(ctx, t => requireOwner(t, input.accountId));
  const id = crypto.randomUUID();
  const enc = await p.envelope.sealJson(msgCtx(ctx.tenantId, id, "tasks"), { text: input.text.slice(0, 500), kind: "request", owner: "you" });
  await p.db.withUser(ctx, t => t.query("INSERT INTO tasks(id,tenant_id,account_id,owner_user_id,thread_id,blob_enc,source,dedupe_key,due_at) VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,$8)", [id, ctx.tenantId, input.accountId, ctx.userId, input.threadId ?? null, enc, `manual:${id}`, input.dueAt ?? null]));
  return { id };
}

/** "What changed" digest, computed from data the user can already see. */
export async function digest(p: Platform, ctx: Ctx, hours = 24) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT m.id, m.envelope_enc, m.risk_label, m.priority_section, m.held, m.thread_id FROM messages m WHERE m.internal_date > now() - ($1::int * interval '1 hour') AND m.envelope_enc IS NOT NULL AND NOT m.from_me AND m.tombstoned_at IS NULL ORDER BY m.internal_date DESC LIMIT 200", [hours]));
  const out = { hours, total: rows.length, needsAttention: [] as any[], heldForReview: 0, newsletters: [] as any[], other: 0 };
  for (const r of rows) {
    const e = await p.envelope.openJson<MessageEnvelope>(msgCtx(ctx.tenantId, r.id), r.envelope_enc);
    if (r.held || ["suspicious", "high_risk", "malicious"].includes(r.risk_label)) out.heldForReview++;
    else if (r.priority_section === "needs_attention" || r.priority_section === "todays_commitments") out.needsAttention.push({ threadId: r.thread_id, subject: e.subject, from: e.from?.name ?? e.from?.address });
    else if (e.isBulk) out.newsletters.push({ threadId: r.thread_id, subject: e.subject, from: e.from?.name ?? e.from?.address });
    else out.other++;
  }
  return out;
}
