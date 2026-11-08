import { z } from "zod";

/**
 * Typed assistant tools. Server-owned; authorization happens in the executor (platform/assistant.ts) under the
 * user's RLS context. This list is the complete capability surface: there's deliberately no send, forward,
 * delete or policy tool, so injected text has nothing to call. create_draft only ever produces an editable draft.
 */
export const AssistantToolCall = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("search_messages"), query: z.string().max(500), risk: z.enum(["any", "flagged"]).default("any") }),
  z.object({ tool: z.literal("list_unanswered"), days: z.number().int().min(1).max(90).default(7) }),
  z.object({ tool: z.literal("summarize_thread"), threadId: z.string().uuid().optional() }),
  z.object({ tool: z.literal("explain_risk"), threadId: z.string().uuid().optional() }),
  z.object({ tool: z.literal("make_checklist"), days: z.number().int().min(1).max(90).default(7) }),
  z.object({ tool: z.literal("count_messages"), topic: z.string().max(64), days: z.number().int().min(1).max(366).default(31) }),
  z.object({ tool: z.literal("create_draft"), threadId: z.string().uuid().optional(), instruction: z.string().max(2000) }),
  z.object({ tool: z.literal("newsletter_digest"), days: z.number().int().min(1).max(31).default(7) }),
  z.object({ tool: z.literal("unsupported"), reason: z.string().max(300) }),
]);
export type AssistantToolCall = z.infer<typeof AssistantToolCall>;

const FORBIDDEN = /\b(forward|delete|erase|wipe|send (it|this|that|them|all|every|my)|auto-?reply|mark .*safe|disable .*(security|quarantine|policy)|release .*quarantine)\b/i;

/** Requests to act never reach a model at all. Exported so the executor checks before asking one. */
export function isActionRequest(message: string): boolean { return FORBIDDEN.test(message) && !/\bdraft\b/i.test(message); }

/** Deterministic planner for the local provider. Only ever maps to the tools above. */
export function planFromText(message: string, threadId?: string): AssistantToolCall {
  const m = message.trim();
  const days = /\b(today)\b/i.test(m) ? 1 : /\bthis week\b/i.test(m) ? 7 : /\blast month\b/i.test(m) ? 31 : /\bthis month\b/i.test(m) ? 31 : 7;
  if (/\bdraft\b/i.test(m) || /^(write|reply)\b/i.test(m)) return { tool: "create_draft", threadId, instruction: m.slice(0, 2000) };
  if (FORBIDDEN.test(m)) return { tool: "unsupported", reason: "I can't send, forward, delete or change security settings. Those need you to act directly, so nothing has been done." };
  if (/\bwhy\b.*\b(suspicious|flag|risk|quarantin|held|phish|unsafe|dangerous|blocked)\b/i.test(m)) return { tool: "explain_risk", threadId };
  if (/\bchecklist\b|\bto-?do\b/i.test(m)) return { tool: "make_checklist", days };
  if (/\bunanswered\b|\bunreplied\b|\bhaven'?t (replied|answered)\b|\bneeds? (a )?(reply|response)\b/i.test(m)) return { tool: "list_unanswered", days };
  if (/\bnewsletters?\b.*\b(digest|sort|summar)|\bdigest\b/i.test(m)) return { tool: "newsletter_digest", days };
  if (/\bhow many\b|\bcount\b/i.test(m)) return { tool: "count_messages", topic: /\binvoice/i.test(m) ? "invoices" : /\bnewsletter/i.test(m) ? "newsletter" : /\bcontract/i.test(m) ? "legal" : "all", days };
  if (/\bsummar/i.test(m)) return { tool: "summarize_thread", threadId };
  const query = m.replace(/^(please )?(find|show|search( for)?|look for|where is|get)( me)?( all)?( the)?( message| email| mail)?( where| that| which| from)?\s*/i, "");
  return { tool: "search_messages", query: query.slice(0, 500), risk: /\b(payment|bank) (details|change)|changed payment|suspicious\b/i.test(m) ? "any" : "any" };
}
