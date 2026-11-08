"use client";
import { Bot, Check, Send, X } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { api, ApiError, useEscape } from "@/lib/client";
import { Banner, Chip, IconButton, inputClass } from "../ui";
import { useWorkspace } from "./shell";

interface Turn { role: "user" | "assistant"; text: string; results?: { threadId: string; subject: string; from?: string; risk?: string | null }[]; checklist?: string[]; verified?: boolean; draft?: any; error?: boolean }
const SUGGESTIONS = ["Show important unanswered emails from this week", "Find the message where my supplier changed payment details", "How many invoices did I receive last month?", "Turn the unanswered items into a checklist", "Sort my newsletters into a weekly digest"];

export function AssistantPane({ threadId, onClose }: { threadId: string | null; onClose: () => void }) {
  const { compose } = useWorkspace();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEscape(onClose, true, 1);
  const ask = async (message: string) => {
    if (!message.trim()) return;
    setInput(""); setBusy(true);
    setTurns(t => [...t, { role: "user", text: message }]);
    try {
      const r = await api<any>("/assistant", { body: { message, threadId: threadId ?? undefined } });
      setTurns(t => [...t, { role: "assistant", text: r.text, results: r.results, checklist: r.checklist, verified: r.verified, draft: r.draft }]);
    } catch (e) {
      setTurns(t => [...t, { role: "assistant", text: e instanceof ApiError ? e.message : "That didn't work.", error: true }]);
    } finally { setBusy(false); setTimeout(() => end.current?.scrollIntoView({ block: "end" }), 30); }
  };
  return (
    <aside aria-label="Assistant" className="fixed inset-0 z-30 flex flex-col border-l border-line bg-surface sm:static sm:w-80 sm:shrink-0 print:hidden">
      <div className="flex items-center justify-between border-b border-line py-1.5 pr-1.5 pl-3"><h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-accent" aria-hidden />Assistant</h2><IconButton icon={X} label="Close assistant" onClick={onClose} /></div>
      <div className="scroll-thin flex-1 space-y-3 overflow-auto p-3" aria-live="polite">
        {!turns.length && (
          <div className="space-y-3">
            <p className="text-[13px] text-muted">Ask about your mail. I can search, summarize, explain risk, and prepare drafts. I can't send, forward, delete or change settings.</p>
            <div className="flex flex-col gap-1.5">{SUGGESTIONS.map(s => <button key={s} onClick={() => ask(s)} className="rounded-lg border border-line px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2">{s}</button>)}</div>
          </div>
        )}
        {turns.map((t, i) => t.role === "user"
          ? <div key={i} className="ml-6 rounded-lg bg-accent-soft px-3 py-2 text-[13px]">{t.text}</div>
          : <div key={i} className="space-y-2 text-[13px]">
              {t.error ? <Banner tone="danger">{t.text}</Banner> : <p className="whitespace-pre-wrap">{t.text}</p>}
              {t.results?.map(r => <Link key={r.threadId} href={`/app/inbox?t=${r.threadId}`} className="block rounded-lg border border-line px-2.5 py-1.5 hover:bg-surface-2"><div className="truncate font-medium">{r.subject}</div><div className="truncate text-xs text-muted">{r.from}{r.risk && !["safe", "bulk_low_priority"].includes(r.risk) ? ` · ${r.risk.replace(/_/g, " ")}` : ""}</div></Link>)}
              {t.checklist && <ul className="space-y-1">{t.checklist.map(c => <li key={c} className="flex gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />{c}</li>)}</ul>}
              {t.draft && <button className="rounded-lg border border-accent px-2.5 py-1 text-[13px] font-medium text-accent hover:bg-accent-soft" onClick={() => compose({ draftId: t.draft.draftId, accountId: t.draft.accountId, threadId: threadId ?? undefined, mode: threadId ? "reply" : undefined, to: t.draft.to, subject: t.draft.subject, text: t.draft.text, aiGenerated: true, assumptions: t.draft.assumptions, issues: t.draft.issues, flaggedThread: t.draft.flaggedThread, provider: t.draft.provider, hosted: t.draft.hosted })}>Open draft to review</button>}
              {t.verified && !t.error && <Chip tone="safe">From your mailboxes</Chip>}
            </div>)}
        {busy && <div className="text-[13px] text-muted" role="status">Working…</div>}
        <div ref={end} />
      </div>
      <form className="flex gap-1.5 border-t border-line p-2" onSubmit={e => { e.preventDefault(); void ask(input); }}>
        <input value={input} onChange={e => setInput(e.target.value)} aria-label="Ask the assistant" placeholder={threadId ? "Ask about this conversation" : "Ask about your mail"} className={inputClass} />
        <IconButton icon={Send} label="Send to assistant" type="submit" disabled={busy || !input.trim()} />
      </form>
    </aside>
  );
}
