import { ThreadListQuery, ThreadAction, FeedbackBody, QuarantineDecision, DraftAttachmentBody, DraftUpsert, SendDraftBody, ImapConnectBody, AssistantBody, PreferencesBody, RuleBody, CAPABILITIES } from "@aegis/domain";
import * as P from "@aegis/platform";
import { AppError } from "@aegis/platform";
import { z } from "zod";
import { NextResponse } from "next/server";
import { platform } from "../platform";
import type { RouteDef } from "../router";

const Id = z.object({ id: z.string().uuid() });
void Id;

function attachmentHeaders(filename: string) {
  // Never inline: an attachment can't execute or render in our origin. Name is sanitized for the header.
  const safe = filename.replace(/[^\w.\- ]+/g, "_").slice(0, 150) || "attachment";
  return { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${safe}"`, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "no-store" };
}

export const mailRoutes: RouteDef[] = [
  { m: "GET", p: "/accounts", h: async ({ ctx }) => P.publicAccounts(platform(), ctx) },
  { m: "PATCH", p: "/accounts/:id", body: z.object({ displayName: z.string().min(1).max(100).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(), isPrimary: z.boolean().optional(), paused: z.boolean().optional(), aliases: z.array(z.object({ address: z.string().email().max(254), name: z.string().max(100).optional() })).max(20).optional() }), h: async ({ ctx, params, body }) => { await P.updateAccount(platform(), ctx, params.id!, body); return { ok: true }; } },
  { m: "POST", p: "/accounts/:id/sync", h: async ({ ctx, params }) => { await P.requestSync(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/accounts/:id/disconnect", body: z.object({ deleteData: z.boolean() }), h: async ({ ctx, params, body }) => P.disconnectAccount(platform(), ctx, params.id!, body) },
  { m: "POST", p: "/accounts/discover", body: z.object({ email: z.string().email() }), h: async ({ body }) => (await import("@aegis/mail-adapters")).suggestSettings(body.email) },
  { m: "POST", p: "/accounts/imap", body: ImapConnectBody, h: async ({ ctx, body }) => {
    const p = platform();
    await P.checkAccountLimit(p, ctx);
    const { createAdapter } = await import("@aegis/mail-adapters");
    const credential = { kind: "password" as const, username: body.username, password: body.password, imap: { host: body.imapHost, port: body.imapPort, security: body.imapSecurity }, smtp: body.smtpHost ? { host: body.smtpHost, port: body.smtpPort ?? 587, security: body.smtpSecurity ?? "starttls" as const } : undefined };
    // Nothing is stored until a real connection succeeds. Failure details are credential-free.
    const adapter = createAdapter(body.kind, { email: body.email, readOnly: body.readOnly }, credential);
    const test = await adapter.testConnection().finally(() => adapter.close?.());
    if (!test.ok) return NextResponse.json({ error: { code: test.problem ?? "unknown", message: test.detail ?? "We couldn't connect with those settings." } }, { status: 422 });
    const id = await P.connectAccount(p, ctx, { kind: body.kind, email: body.email, displayName: body.displayName, readOnly: body.readOnly, credential });
    return { id, capabilities: CAPABILITIES[body.kind as "imap" | "pop3"] };
  } },
  { m: "GET", p: "/oauth/:provider/start", query: z.object({ readOnly: z.enum(["true", "false"]).default("false"), loginHint: z.string().email().optional() }), h: async ({ ctx, params, query }) => {
    const provider = params.provider;
    if (provider !== "gmail" && provider !== "microsoft") throw new AppError(404, "not_found", "Not found");
    // People arrive here by following a link, so a refusal has to land on a page, not on raw JSON.
    const origin = platform().config.appOrigin;
    try {
      await P.checkAccountLimit(platform(), ctx);
      const { url } = await P.beginMailboxOAuth(platform(), ctx, provider, { readOnly: query.readOnly === "true", loginHint: query.loginHint });
      return NextResponse.redirect(url);
    } catch (e) {
      if (e instanceof AppError && e.code === "provider_not_configured") return NextResponse.redirect(`${origin}/app/connect?error=unavailable`);
      if (e instanceof AppError && e.code === "limit_reached") return NextResponse.redirect(`${origin}/app/connect?error=limit_reached`);
      throw e;
    }
  } },
  { m: "GET", p: "/oauth/:provider/callback", query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), h: async ({ ctx, params, query }) => {
    const provider = params.provider;
    const origin = platform().config.appOrigin;
    if (provider !== "gmail" && provider !== "microsoft") throw new AppError(404, "not_found", "Not found");
    if (query.error || !query.code || !query.state) return NextResponse.redirect(`${origin}/app/connect?error=${encodeURIComponent(query.error === "access_denied" ? "denied" : "failed")}`);
    try {
      await P.finishMailboxOAuth(platform(), ctx, provider, { code: query.code, state: query.state });
      return NextResponse.redirect(`${origin}/app/connect?connected=${provider}`);
    } catch (e) {
      if (e instanceof AppError && e.code === "oauth_state_invalid") return NextResponse.redirect(`${origin}/app/connect?error=expired`);
      return NextResponse.redirect(`${origin}/app/connect?error=failed`);
    }
  } },

  { m: "GET", p: "/focus", query: z.object({ accountId: z.string().uuid().optional() }), h: async ({ ctx, query }) => {
    const prefs = await P.getPrefs(platform(), ctx);
    return P.getFocus(platform(), ctx, { accountId: query.accountId, hidden: prefs.hiddenSections, pinned: prefs.pinnedSections });
  } },
  { m: "GET", p: "/threads", query: ThreadListQuery, h: async ({ ctx, query }) => {
    if (query.view === "drafts" || query.view === "scheduled") throw new AppError(400, "invalid", "Use /drafts for this view.");
    return P.listThreads(platform(), ctx, query);
  } },
  { m: "GET", p: "/threads/:id", query: z.object({ showImagesFor: z.string().uuid().optional(), dark: z.enum(["1", "0"]).optional() }), h: async ({ ctx, params, query }) => P.getThread(platform(), ctx, params.id!, { showImagesFor: query.showImagesFor, dark: query.dark === "1" }) },
  { m: "POST", p: "/threads/:id/actions", body: ThreadAction, h: async ({ ctx, params, body }) => P.threadAction(platform(), ctx, params.id!, body) },
  { m: "POST", p: "/threads/:id/summary", h: async ({ ctx, params }) => P.summarizeThread(platform(), ctx, params.id!) },
  { m: "POST", p: "/threads/:id/draft", body: z.object({ kind: z.enum(["acknowledge", "detailed", "decline", "clarify", "follow_up", "payment_inquiry", "meeting", "custom"]), tone: z.enum(["neutral", "warm", "brief", "formal"]).optional(), instruction: z.string().max(2000).optional() }), h: async ({ ctx, session, params, body }) => P.suggestDraft(platform(), ctx, params.id!, { ...body, ownerName: session.name }) },

  { m: "POST", p: "/messages/:id/feedback", body: FeedbackBody, h: async ({ ctx, params, body }) => P.recordFeedback(platform(), ctx, params.id!, body.kind) },
  { m: "POST", p: "/messages/:id/quarantine", body: QuarantineDecision, h: async ({ ctx, params, body }) => P.decideQuarantine(platform(), ctx, params.id!, body.decision) },
  { m: "GET", p: "/org/blocked", h: async ({ ctx }) => P.orgQuarantine(platform(), ctx) },
  { m: "POST", p: "/org/blocked/:id", body: QuarantineDecision, h: async ({ ctx, params, body }) => P.orgQuarantineDecide(platform(), ctx, params.id!, body.decision) },
  { m: "POST", p: "/messages/:id/contact", body: z.object({ pref: z.enum(["vip", "ignore", "clear"]) }), h: async ({ ctx, params, body }) => { await P.setContactPreference(platform(), ctx, params.id!, body.pref); return { ok: true }; } },
  { m: "POST", p: "/messages/:id/seal", maxBody: 100_000_000, body: P.SealBody, h: async ({ ctx, params, body }) => { await P.sealMessage(platform(), ctx, params.id!, body); return { ok: true }; } },
  { m: "GET", p: "/attachments/:id", h: async ({ ctx, params }) => {
    const a = await P.getAttachment(platform(), ctx, params.id!);
    return new Response(new Uint8Array(a.bytes), { headers: attachmentHeaders(a.filename) });
  } },
  { m: "GET", p: "/links/inspect", query: z.object({ m: z.string().uuid(), u: z.string().max(4000) }), h: async ({ ctx, query }) => P.inspectLink(platform(), ctx, query.m, query.u) },

  { m: "GET", p: "/contacts", h: async ({ ctx }) => P.listContacts(platform(), ctx) },
  { m: "PATCH", p: "/contacts/:id", body: z.object({ vip: z.boolean().optional(), ignored: z.boolean().optional() }), h: async ({ ctx, params, body }) => { await P.setContact(platform(), ctx, params.id!, body); return { ok: true }; } },
  { m: "POST", p: "/contacts/reset-learning", h: async ({ ctx }) => P.resetLearning(platform(), ctx) },
  { m: "GET", p: "/labels", h: async ({ ctx }) => P.listLabels(platform(), ctx) },
  { m: "POST", p: "/labels", body: z.object({ accountId: z.string().uuid(), name: z.string().min(1).max(64), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }), h: async ({ ctx, body }) => P.createLabel(platform(), ctx, body.accountId, body.name, body.color) },
  { m: "DELETE", p: "/labels/:id", h: async ({ ctx, params }) => { await P.deleteLabel(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "GET", p: "/mail/refusals", query: z.object({ since: z.string().datetime() }), h: async ({ ctx, query }) => P.recentRefusals(platform(), ctx, new Date(query.since)) },

  { m: "GET", p: "/search/semantic", h: async ({ ctx }) => P.semanticSearchStatus(platform(), ctx) },

  { m: "GET", p: "/drafts", query: z.object({ state: z.enum(["editing", "scheduled", "failed", "unknown"]).optional() }), h: async ({ ctx, query }) => P.listDrafts(platform(), ctx, { state: query.state ? [query.state] : ["editing", "failed", "unknown"] }) },
  { m: "POST", p: "/drafts", body: DraftUpsert.extend({ id: z.string().uuid().optional() }), h: async ({ ctx, body }) => P.saveDraft(platform(), ctx, body) },
  { m: "DELETE", p: "/drafts/:id", h: async ({ ctx, params }) => { await P.deleteDraft(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/drafts/:id/attachments", maxBody: 5_000_000, body: DraftAttachmentBody, h: async ({ ctx, params, body }) => P.addDraftAttachment(platform(), ctx, params.id!, body) },
  { m: "POST", p: "/drafts/:id/attachments/from-message", body: z.object({ messageId: z.string().uuid(), attachmentIds: z.array(z.string().uuid()).min(1).max(50) }), h: async ({ ctx, params, body }) => P.copyAttachmentsToDraft(platform(), ctx, params.id!, body) },
  { m: "DELETE", p: "/drafts/:id/attachments/:attachmentId", h: async ({ ctx, params }) => P.removeDraftAttachment(platform(), ctx, params.id!, params.attachmentId!) },
  { m: "POST", p: "/drafts/:id/send", body: SendDraftBody, h: async ({ ctx, params, body }) => P.approveSend(platform(), ctx, params.id!, body) },
  { m: "POST", p: "/drafts/:id/cancel", h: async ({ ctx, params }) => { await P.cancelScheduled(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "POST", p: "/drafts/:id/retry", h: async ({ ctx, params }) => { await P.retrySend(platform(), ctx, params.id!); return { ok: true }; } },

  { m: "POST", p: "/assistant", body: AssistantBody, h: async ({ ctx, session, body }) => P.runAssistant(platform(), ctx, body.message, body.threadId, session.name) },
  { m: "GET", p: "/digest", query: z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }), h: async ({ ctx, query }) => P.digest(platform(), ctx, query.hours) },
  { m: "GET", p: "/insights", query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), h: async ({ ctx, query }) => P.personalInsights(platform(), ctx, query.days) },
  { m: "GET", p: "/tasks/export.ics", h: async ({ ctx }) => new Response(P.tasksToIcs(await P.listTasks(platform(), ctx), new Date()), { headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": `attachment; filename="tasks.ics"`, "Cache-Control": "no-store" } }) },
  { m: "GET", p: "/tasks", query: z.object({ status: z.enum(["open", "done", "dismissed"]).default("open") }), h: async ({ ctx, query }) => P.listTasks(platform(), ctx, query.status) },
  { m: "POST", p: "/tasks", body: z.object({ text: z.string().min(1).max(500), accountId: z.string().uuid(), dueAt: z.string().datetime().optional(), threadId: z.string().uuid().optional() }), h: async ({ ctx, body }) => P.createTask(platform(), ctx, body) },
  { m: "PATCH", p: "/tasks/:id", body: z.object({ status: z.enum(["open", "done", "dismissed"]) }), h: async ({ ctx, params, body }) => { await P.setTaskStatus(platform(), ctx, params.id!, body.status); return { ok: true }; } },

  { m: "GET", p: "/automations", h: async ({ ctx }) => P.listAutomations(platform(), ctx) },
  { m: "POST", p: "/automations", body: RuleBody, h: async ({ ctx, body }) => P.createAutomation(platform(), ctx, body as never) },
  { m: "POST", p: "/automations/parse", body: z.object({ text: z.string().min(1).max(1000) }), h: async ({ body }) => P.ruleFromText(body.text) },
  { m: "POST", p: "/automations/dry-run", body: z.object({ definition: z.unknown() }), h: async ({ ctx, body }) => P.dryRun(platform(), ctx, body.definition) },
  { m: "PATCH", p: "/automations/:id", body: z.object({ enabled: z.boolean().optional(), name: z.string().min(1).max(100).optional(), definition: z.unknown().optional() }), h: async ({ ctx, params, body }) => { if (body.enabled !== undefined) await P.setAutomationEnabled(platform(), ctx, params.id!, body.enabled); if (body.name !== undefined || body.definition !== undefined) await P.updateAutomation(platform(), ctx, params.id!, { name: body.name, definition: body.definition }); return { ok: true }; } },
  { m: "GET", p: "/automations/:id/runs", h: async ({ ctx, params }) => P.automationRuns(platform(), ctx, params.id!) },
  { m: "DELETE", p: "/automations/:id", h: async ({ ctx, params }) => { await P.deleteAutomation(platform(), ctx, params.id!); return { ok: true }; } },
  { m: "GET", p: "/proposals", h: async ({ ctx }) => P.listProposals(platform(), ctx) },
  { m: "POST", p: "/proposals/:id", body: z.object({ approve: z.boolean() }), h: async ({ ctx, params, body }) => { await P.decideProposal(platform(), ctx, params.id!, body.approve); return { ok: true }; } },

  { m: "GET", p: "/preferences", h: async ({ ctx }) => P.getPrefs(platform(), ctx) },
  { m: "PATCH", p: "/preferences", body: PreferencesBody.extend({ tone: z.enum(["neutral", "warm", "brief", "formal"]).optional() }), h: async ({ ctx, body }) => P.updatePrefs(platform(), ctx, body as never) },
  { m: "GET", p: "/privacy", h: async ({ ctx }) => P.privacyCenter(platform(), ctx) },
  { m: "GET", p: "/privacy/export", h: async ({ ctx }) => new Response(JSON.stringify(await P.exportData(platform(), ctx), null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="aegis-export.json"`, "Cache-Control": "no-store" } }) },
  { m: "POST", p: "/privacy/delete-account", body: z.object({ confirmEmail: z.string().email(), password: z.string().max(256).default(""), totp: z.string().regex(/^\d{6}$/).optional() }), h: async ({ ctx, session, body }) => { await P.deleteAccount(platform(), ctx, { confirmEmail: body.confirmEmail, email: session.email, password: body.password, totp: body.totp }); return { ok: true }; } },
];
