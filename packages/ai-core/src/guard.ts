import type { DraftRequest, DraftResult } from "./types";

export interface DraftCheck { ok: boolean; blocked: boolean; issues: { code: string; message: string }[] }

const MONEY = /(?:[$€£]\s?\d[\d,]{0,24}(?:\.\d{1,8})?|\b\d[\d,]{0,24}(?:\.\d{1,8})?\s?(?:usd|eur|gbp|dollars|euros|pounds)\b)/gi;
const DATE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi;
const ATTACH = /\b(attached|see attachment|i'?ve attached|enclosed|find attached)\b/i;
const COMMIT = /\b(i (guarantee|promise|commit)|we (guarantee|promise|commit)|i('ve| have) (already )?(sent|paid|wired|transferred|signed))\b/i;
const URL = /\bhttps?:\/\/[^\s<>"')\]]{1,2000}/gi;
const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi;
const SECRETS = /\b(password|api[- ]?key|secret|one[- ]time code|recovery code)\s{0,8}[:=]\s{0,8}\S/i;

/**
 * Independent post-generation check. Runs on every draft from every provider, outside the model.
 * "Invented" means absent from the thread and the user's own instruction. Blocked drafts aren't offered.
 */
export function checkDraft(draft: DraftResult, req: DraftRequest): DraftCheck {
  const context = `${req.thread.map(m => `${m.subject}\n${m.text}\n${m.from}\n${m.to.join(" ")}`).join("\n")}\n${req.instruction ?? ""}`.toLowerCase();
  const issues: DraftCheck["issues"] = [];
  let blocked = false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const m of draft.text.match(MONEY) ?? []) if (!context.includes(norm(m))) issues.push({ code: "INVENTED_AMOUNT", message: `The amount "${m}" doesn't appear in this conversation.` });
  for (const m of draft.text.match(DATE) ?? []) if (!context.includes(norm(m))) issues.push({ code: "INVENTED_DATE", message: `The date "${m}" doesn't appear in this conversation.` });
  if (ATTACH.test(draft.text)) issues.push({ code: "CLAIMS_ATTACHMENT", message: "The draft mentions an attachment. Add one or remove the mention." });
  const c = draft.text.match(COMMIT);
  if (c) issues.push({ code: "UNVERIFIED_COMMITMENT", message: `The draft says "${c[0]}". Check that's true before sending.` });
  // Exfiltration: a model steered by injected content may try to add links or addresses from nowhere.
  for (const m of draft.text.match(URL) ?? []) if (!context.includes(m.toLowerCase())) { issues.push({ code: "NEW_LINK", message: `The link ${m} isn't from this conversation. Removed from the suggestion for safety.` }); blocked = true; }
  for (const m of draft.text.match(EMAIL) ?? []) if (!context.includes(m.toLowerCase()) && m.toLowerCase() !== req.ownerAddress.toLowerCase()) { issues.push({ code: "NEW_ADDRESS", message: `The address ${m} isn't from this conversation.` }); blocked = true; }
  if (SECRETS.test(draft.text)) { issues.push({ code: "SECRET_IN_DRAFT", message: "The draft appears to contain a credential." }); blocked = true; }
  return { ok: issues.length === 0, blocked, issues };
}

/** Recipients a draft may be addressed to without extra confirmation: people already in the thread. */
export function validateRecipients(recipients: string[], thread: { from: string; to: string[] }[], owner: string): { ok: boolean; unfamiliar: string[] } {
  const known = new Set(thread.flatMap(m => [m.from, ...m.to]).map(a => a.toLowerCase()));
  const unfamiliar = recipients.filter(r => !known.has(r.toLowerCase()) && r.toLowerCase() !== owner.toLowerCase());
  return { ok: unfamiliar.length === 0, unfamiliar };
}
