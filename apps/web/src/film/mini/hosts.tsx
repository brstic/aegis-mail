"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/client";
import { LAYERS } from "../data/content";
import type { Layer } from "./scenes/Layers";
import { Mini } from "./Mini";

/** The parts of ordinary pages that drive a scene. Each keeps its information in the DOM, and the scene beside it is a second way of seeing it. */

const pill = (on: boolean) => `inline-flex min-h-9 items-center rounded-full px-3.5 text-[13px] font-medium transition-colors ${on ? "bg-ink text-bg" : "bg-surface-3 text-ink hover:bg-line-strong"}`;

/** On /security: the sample letter's layers, to pick through. */
export function SecurityExplorer() {
  const [sel, setSel] = useState<string>(LAYERS[0].id);
  const layers = useMemo<Layer[]>(() => LAYERS.map(l => ({ id: l.id, title: l.title, lines: [...l.print] })), []);
  const l = LAYERS.find(x => x.id === sel)!;
  return (
    <div className="mb-12 grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]" data-testid="security-explorer">
      <div>
        <div role="group" aria-label="Layers of a sample letter" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {LAYERS.map(x => <button key={x.id} type="button" aria-pressed={x.id === sel} className={`${pill(x.id === sel)} justify-center`} onClick={() => setSel(x.id)}>{x.title}</button>)}
        </div>
        <p className="mt-4 text-[15px] leading-relaxed" aria-live="polite">{l.ask}</p>
        {l.found.length > 0 && <ul className="mt-3 space-y-1 text-sm text-muted">{l.found.map(e => <li key={e.code} className="flex gap-2"><b className="tabular-nums text-ink">{e.weight > 0 ? "+" : ""}{e.weight}</b>{e.explanation}</li>)}</ul>}
        <p className="mt-3 text-[13px] text-muted">A synthetic forged invoice, with the findings the engine really gave it.</p>
      </div>
      <Mini scene="layers" className="h-80 sm:h-[26rem]" props={{ layers, selected: sel, onSelect: setSel }} />
    </div>
  );
}

export interface ReportEvidence { code: string; weight: number; source?: string; explanation: string }
const SOURCE_TITLE: Record<string, string> = { headers: "Sender", auth: "Authentication", url: "Links", content: "Wording", attachment: "Attachments", relationship: "History", llm: "Hosted model", list: "Mailing list" };

/** The report's findings carry their code, and the code's prefix says which check made it. */
const PREFIX: Record<string, string> = { HDR: "headers", AUTH: "auth", URL: "url", TXT: "content", ATT: "attachment", REL: "relationship", AI: "content", LLM: "llm", BULK: "list", SPAM: "content" };
const sourceOf = (e: ReportEvidence) => e.source ?? PREFIX[e.code.split("_")[0]!] ?? "other";

/**
 * On a security report, this message's real findings, as the same stack and the same balance. Everything is drawn in this browser from what
 * the page already fetched: nothing's uploaded, and no text leaves the canvas.
 */
export function MessageAutopsy({ evidence }: { evidence: ReportEvidence[] }) {
  const layers = useMemo<Layer[]>(() => {
    const by = new Map<string, ReportEvidence[]>();
    for (const e of evidence) { const k = sourceOf(e); by.set(k, [...(by.get(k) ?? []), e]); }
    return [...by.entries()].map(([source, list]) => ({
      id: source, title: SOURCE_TITLE[source] ?? "Other checks",
      tone: list.some(e => e.weight > 0) ? "raises" as const : "lowers" as const,
      lines: list.map(e => `${e.weight > 0 ? "+" : ""}${e.weight}  ${e.explanation}`),
    }));
  }, [evidence]);
  const [sel, setSel] = useState("");
  useEffect(() => {
    const on = (e: Event) => { const hit = evidence.find(x => x.code === (e as CustomEvent<string>).detail); if (hit) setSel(sourceOf(hit)); };
    window.addEventListener("aegis:evidence", on);
    return () => window.removeEventListener("aegis:evidence", on);
  }, [evidence]);
  const current = layers.find(l => l.id === sel) ?? layers[0];
  const weights = useMemo(() => evidence.map(e => e.weight), [evidence]);
  if (!layers.length) return null;
  return (
    <section aria-label="This message, taken apart" className="mb-5 rounded-xl bg-surface p-4 shadow-soft print:hidden" data-testid="message-autopsy">
      <h2 className="font-display text-xl tracking-tight">This message, taken apart</h2>
      <p className="mt-1 text-sm text-muted">One sheet for each thing that was checked. Select one to read it. The balance tips by the same weights.</p>
      <div role="group" aria-label="What was checked" className="mt-3 flex flex-wrap gap-2">
        {layers.map(l => <button key={l.id} type="button" aria-pressed={l.id === current?.id} className={pill(l.id === current?.id)} onClick={() => setSel(l.id)}>{l.title}</button>)}
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Mini scene="layers" className="h-72" props={{ layers, selected: current?.id ?? "", onSelect: setSel }} />
        <Mini scene="scale" className="h-72" props={{ weights }} />
      </div>
      {current && <ul className="mt-2 space-y-1 text-sm" aria-live="polite">{current.lines.map(t => <li key={t} className="[overflow-wrap:anywhere]">{t}</li>)}</ul>}
    </section>
  );
}

/** Beside the sign-in and sign-up forms. The form tells this when it's busy and when it's done, and waits a moment for it to open. */
export const AUTH_OPEN_MS = 720;
export function announceSignedIn(go: () => void) {
  const can = document.querySelector("[data-auth-envelope] canvas");
  window.dispatchEvent(new Event("aegis:auth-done"));
  if (can) window.setTimeout(go, AUTH_OPEN_MS); else go();
}
/**
 * The sign-in page's shield. Letters pass through; threats are stopped at the surface, and the kind of attack each one stands for is
 * named underneath. Decorative, and labelled as examples.
 */
/** `className` must position the shield (for example `absolute inset-0`); it is the containing box for the chip. */
export function AuthShield({ busy, className = "absolute inset-0" }: { busy: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("aegis:auth-done", on);
    return () => window.removeEventListener("aegis:auth-done", on);
  }, []);
  const onBlock = useCallback((text: string) => setLabel(l => ({ text, n: (l?.n ?? 0) + 1 })), []);
  return (
    <div data-auth-envelope className={className}>
      <div className="absolute inset-0"><Mini scene="shield" className="h-full w-full" props={{ open, busy, onBlock }} /></div>
      {label && (
        <p key={label.n} aria-hidden="true" className="auth-chip pointer-events-none absolute top-20 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--auth-chip-bg)] px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-[var(--auth-fg)] shadow-sm ring-1 ring-[var(--auth-chip-ring)] backdrop-blur-md">
          <span className="size-2 rounded-full bg-[#ff453a] shadow-[0_0_10px_#ff453a]" />{label.text}<span className="text-[var(--auth-muted)]">· blocked</span>
        </p>
      )}
    </div>
  );
}

/** At the first step of onboarding that has mail to show: the first real message, through the same stack. */
export function FirstMessage({ threadId }: { threadId: string }) {
  const { data } = useApi<{ messages: { security?: { evidence: ReportEvidence[] } }[] }>(["thread", threadId, "first"], `/threads/${threadId}`);
  const evidence = data?.messages[data.messages.length - 1]?.security?.evidence ?? [];
  return evidence.length ? <MessageAutopsy evidence={evidence} /> : null;
}

/** On /privacy-architecture: the vault opens as you read down the page. */
export function ScrollVault({ keyClasses, rootLabel }: { keyClasses: string[]; rootLabel: string }) {
  const [open, setOpen] = useState(0);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { const t = Math.min(1, window.scrollY / (window.innerHeight * 0.7)); setOpen(Math.round(t * 20) / 20); });
    };
    window.addEventListener("scroll", on, { passive: true });
    on();
    return () => { window.removeEventListener("scroll", on); cancelAnimationFrame(raf); };
  }, []);
  return <Mini scene="vault" className="h-80 sm:h-96" props={{ keyClasses, searchIndex: true, rootLabel, open: 0.6 + open * 0.3 }} />;
}

/** Tells a report's stack which check a finding belongs to, as you move over it in the list. */
export const hoverEvidence = (code: string) => window.dispatchEvent(new CustomEvent("aegis:evidence", { detail: code }));
