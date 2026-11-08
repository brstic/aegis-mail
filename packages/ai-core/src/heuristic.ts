import { extractActions, sentences } from "./text";
import type { DraftRequest, DraftResult, InferenceProvider, ThreadMessageInput, ThreadSummary } from "./types";

const first = (s?: string) => s?.split(/\s+/)[0] ?? "";
const reSubject = (s: string) => (/^\s*re:/i.test(s) ? s : `Re: ${s}`);

/** Deterministic and offline. Output is extractive: it quotes rather than generates, so it can't invent facts. */
export class LocalHeuristicProvider implements InferenceProvider {
  readonly id = "local-rules";
  readonly model = "rules-v1";
  readonly hosted = false;

  async summarize(thread: ThreadMessageInput[]): Promise<ThreadSummary> {
    const bullets = [];
    const ordered = [...thread].sort((a, b) => a.date.localeCompare(b.date));
    for (const m of ordered.slice(-5)) {
      const ss = sentences(m.text).filter(s => !/^(hi|hello|hey|dear|thanks|thank you|best|regards|cheers)\b[^.?!]{0,40}[,.!]?$/i.test(s) && s.split(" ").length > 2);
      const pick = ss.find(s => /[?]|\b(need|please|can you|could you|by |due|decision|confirm)\b/i.test(s)) ?? ss[0];
      if (pick) bullets.push({ text: `${m.fromMe ? "You" : first(m.fromName) || m.from}: ${pick}`, messageIds: [m.id] });
    }
    const latest = ordered[ordered.length - 1];
    const ask = latest && !latest.fromMe ? extractActions(latest.id, latest.text, false, new Date(latest.date))[0]?.text : undefined;
    return { bullets, ask, basis: "extractive" };
  }

  async actions(thread: ThreadMessageInput[], ref: Date) {
    return thread.flatMap(m => extractActions(m.id, m.text, m.fromMe, ref));
  }

  async draft(req: DraftRequest): Promise<DraftResult> {
    const latest = [...req.thread].sort((a, b) => b.date.localeCompare(a.date)).find(m => !m.fromMe) ?? req.thread[req.thread.length - 1];
    const name = first(latest?.fromName);
    const hi = req.tone === "formal" ? `Dear ${name || "there"},` : `Hi ${name || "there"},`;
    const sign = req.tone === "formal" ? `Kind regards,\n${req.ownerName}` : req.tone === "brief" ? first(req.ownerName) : `Thanks,\n${first(req.ownerName)}`;
    const assumptions: string[] = [];
    const bodies: Record<DraftRequest["kind"], string> = {
      acknowledge: "Thanks for your message. I've got this and will come back to you shortly.",
      detailed: "Thanks for your message.\n\n[Add your answer here. This draft doesn't guess at dates, prices or commitments.]",
      decline: "Thanks for thinking of me. Unfortunately I won't be able to take this on right now.",
      clarify: "Thanks for your message. Before I respond, could you clarify [what you need to know]?",
      follow_up: "Following up on this. Do you have an update?",
      payment_inquiry: "Could you confirm the status of this payment? I'd also like to verify any payment details by phone, using a number we already have on file.",
      meeting: "That could work. Could you share a couple of times that suit you?",
      custom: req.instruction ? `[Your request: ${req.instruction.slice(0, 500)}]\n\n[The local rules engine can't compose free text. Write your reply here, or enable a hosted model in Privacy Center.]` : "",
    };
    if (req.kind === "detailed" || req.kind === "clarify" || req.kind === "custom") assumptions.push("Contains placeholders to fill in. Local rules don't generate facts.");
    return { text: `${hi}\n\n${bodies[req.kind]}\n\n${sign}`, subject: reSubject(latest?.subject ?? ""), assumptions, basis: "template" };
  }
}
