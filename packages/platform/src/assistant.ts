import { AssistantToolCall, isActionRequest, planFromText } from "@aegis/ai-core";
import { meterAi, providerFor, suggestDraft, summarizeThread, threadInput } from "./ai-service";
import { AppError, badRequest, type Ctx, type Platform } from "./context";
import { msgCtx, type MessageEnvelope } from "./ingest";
import { getThread, listThreads } from "./mail";

export interface AssistantReply { tool: string; text: string; results?: { threadId: string; subject: string; from?: string; date?: string; risk?: string | null }[]; checklist?: string[]; draft?: unknown; verified: boolean; }

/**
 * All retrieval runs through RLS-scoped services as the signed-in user, so the assistant can't reach what they can't.
 * The planner only yields the tools in AssistantToolCall. None of them send, forward, delete or change policy.
 */
export async function runAssistant(p: Platform, ctx: Ctx, message: string, threadId: string | undefined, ownerName: string): Promise<AssistantReply> {
  const call = await planAssistant(p, ctx, message, threadId);
  if (!call) return { tool: "unsupported", text: "I can't do that.", verified: false };
  switch (call.tool) {
    case "unsupported": return { tool: call.tool, text: call.reason, verified: false };
    case "search_messages": {
      const r = await listThreads(p, ctx, { view: "inbox", q: call.query, limit: 10 });
      if (!r.items.length) {
        const loose = await listThreads(p, ctx, { view: "inbox", q: call.query, limit: 10, concepts: true });
        if (!loose.items.length) {
          // Where a deployment has semantic search on, it answers to the same access rules as word search. It's off otherwise, and this finds nothing.
          const near = await listThreads(p, ctx, { view: "inbox", q: call.query, limit: 10, semantic: true });
          if (near.items.length) return { tool: call.tool, text: `No word match. ${near.items.length} ${near.items.length === 1 ? "conversation" : "conversations"} close in meaning, which can be wrong, so check them:`, results: rows(near.items), verified: true };
          return { tool: call.tool, text: "I couldn't find anything matching that in your mailboxes.", results: [], verified: true };
        }
        return { tool: call.tool, text: `No exact match. ${loose.items.length} related ${loose.items.length === 1 ? "conversation" : "conversations"}:`, results: rows(loose.items), verified: true };
      }
      return { tool: call.tool, text: `Found ${r.items.length} ${r.items.length === 1 ? "conversation" : "conversations"}:`, results: rows(r.items), verified: true };
    }
    case "list_unanswered": {
      const cutoff = p.now().getTime() - call.days * 864e5;
      const r = await listThreads(p, ctx, { view: "inbox", limit: 100 });
      const out = r.items.filter(i => i.needsReply && !i.lastFromMe && new Date(i.date).getTime() >= cutoff);
      return { tool: call.tool, text: out.length ? `${out.length} ${out.length === 1 ? "conversation is" : "conversations are"} waiting on you from the last ${call.days} days:` : "Nothing's waiting on a reply from you.", results: rows(out), verified: true };
    }
    case "summarize_thread": {
      if (!call.threadId) return { tool: call.tool, text: "Open a conversation first and I'll summarize it.", verified: false };
      const s = await summarizeThread(p, ctx, call.threadId);
      return { tool: call.tool, text: s.bullets.map((b: { text: string }) => `• ${b.text}`).join("\n") || "There isn't much to summarize here.", verified: s.basis === "extractive" };
    }
    case "explain_risk": {
      if (!call.threadId) return { tool: call.tool, text: "Open a conversation first and I'll explain its security rating.", verified: false };
      const t = await getThread(p, ctx, call.threadId);
      const m = t.messages[t.messages.length - 1]!;
      if (!m.security) return { tool: call.tool, text: "This message hasn't been analyzed.", verified: true };
      return { tool: call.tool, text: `Rated ${m.security.label.replace(/_/g, " ")}. ${m.security.summary} ${m.security.rationale}`.trim(), verified: true };
    }
    case "make_checklist": {
      const r = await listThreads(p, ctx, { view: "inbox", limit: 100 });
      const cutoff = p.now().getTime() - call.days * 864e5;
      const items = r.items.filter(i => i.needsReply && new Date(i.date).getTime() >= cutoff).map(i => `Reply to ${i.from?.name ?? i.from?.address ?? "sender"}: ${i.subject}`);
      return { tool: call.tool, text: items.length ? "Here's your checklist:" : "Nothing outstanding.", checklist: items, verified: true };
    }
    case "count_messages": {
      const cutoff = p.now().getTime() - call.days * 864e5;
      const rowsDb = await p.db.withUser(ctx, t => t.query<any>("SELECT id, envelope_enc FROM messages WHERE internal_date > $1 AND NOT from_me AND envelope_enc IS NOT NULL AND tombstoned_at IS NULL AND NOT held", [new Date(cutoff)]));
      let n = 0;
      for (const r of rowsDb) {
        const e = await p.envelope.openJson<MessageEnvelope>(msgCtx(ctx.tenantId, r.id), r.envelope_enc);
        if (call.topic === "all" || e.topics.includes(call.topic)) n++;
      }
      return { tool: call.tool, text: `${n} ${n === 1 ? "message" : "messages"} ${call.topic === "all" ? "" : `about ${call.topic} `}in the last ${call.days} days. Quarantined mail isn't counted.`, verified: true };
    }
    case "newsletter_digest": {
      const r = await listThreads(p, ctx, { view: "inbox", limit: 100 });
      const cutoff = p.now().getTime() - call.days * 864e5;
      const out = r.items.filter(i => i.topics.includes("newsletter") && new Date(i.date).getTime() >= cutoff);
      return { tool: call.tool, text: out.length ? `${out.length} newsletters from the last ${call.days} days:` : "No newsletters in that period.", results: rows(out), verified: true };
    }
    case "create_draft": {
      if (!call.threadId) return { tool: call.tool, text: "Open the conversation you'd like to reply to, then ask again.", verified: false };
      await threadInput(p, ctx, call.threadId);
      const d = await suggestDraft(p, ctx, call.threadId, { kind: "custom", instruction: call.instruction, ownerName });
      return { tool: call.tool, text: `Here's an editable draft from ${d.from}. Nothing has been sent.`, draft: d, verified: false };
    }
  }
  throw badRequest("unknown_tool", "Unknown tool");
}

/** Whatever plans, the output has to parse as a closed tool list. Hosted planning falls back to rules if it fails. */
async function planAssistant(p: Platform, ctx: Ctx, message: string, threadId?: string): Promise<AssistantToolCall | null> {
  const local = () => { const r = AssistantToolCall.safeParse(planFromText(message, threadId)); return r.success ? r.data : null; };
  if (isActionRequest(message)) return local();
  const provider = await providerFor(p, ctx);
  if (!provider.plan) return local();
  try {
    await meterAi(p, ctx, provider);
    return AssistantToolCall.parse(await provider.plan(message, threadId));
  } catch (e) {
    if (e instanceof AppError && e.code === "limit_reached") throw e;
    return local();
  }
}

function rows(items: { id: string; subject: string; from?: { name?: string; address: string }; date: string; risk: string | null }[]) {
  return items.slice(0, 20).map(i => ({ threadId: i.id, subject: i.subject, from: i.from?.name ?? i.from?.address, date: i.date, risk: i.risk }));
}
