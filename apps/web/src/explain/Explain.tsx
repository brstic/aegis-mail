"use client";
import { ChevronLeft, ChevronRight, CircleHelp, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { notesFor, type Note } from "./registry";

/** Finds what a note points at. A note can name several things, separated by commas: whichever is on screen first. */
export function locate(note: Note): HTMLElement | null {
  if (!note.find) return null;
  for (const part of note.find.split(",").map(s => s.trim())) {
    if (part.startsWith("css:")) { const el = document.querySelector<HTMLElement>(part.slice(4)); if (el && el.getClientRects().length) return el; continue; }
    const candidates = document.querySelectorAll<HTMLElement>("main h1, main h2, main h3, main h4, main button, main legend, main label, main th, main a, main [role=heading], main dt, main p.font-medium");
    const want = part.toLowerCase();
    for (const el of candidates) if (el.getClientRects().length && el.textContent?.trim().toLowerCase().startsWith(want)) return el;
  }
  return null;
}

const OPEN_EVENT = "aegis:explain";
export const openExplain = (tour = false) => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { tour } }));

export function ExplainButton({ className = "" }: { className?: string }) {
  return (
    <button type="button" data-testid="explain-toggle" aria-label="Explain this screen" title="Explain this screen" onClick={() => openExplain()} className={`grid size-8 shrink-0 place-items-center rounded-lg hover:bg-surface-2 ${className}`}>
      <CircleHelp className="size-[18px]" aria-hidden />
    </button>
  );
}

/**
 * Says what's on this screen. A panel beside the page, not over it, so the page can still be used while it's open. Selecting an entry
 * brings that thing into view and rings it. A tour is the same list, one at a time. Open with the button, Shift+E or the command palette.
 */
export function Explain() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [tour, setTour] = useState(false);
  const [at, setAt] = useState(0);
  const ring = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [found, setFound] = useState<boolean[]>([]);

  const close = useCallback(() => { setOpen(false); setTour(false); opener.current?.focus?.(); }, []);

  useEffect(() => {
    const on = (e: Event) => {
      opener.current = document.activeElement as HTMLElement;
      const t = (e as CustomEvent<{ tour: boolean }>).detail?.tour ?? false;
      setOpen(v => t || !v); setTour(t); setAt(0);
    };
    const key = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName) || (e.target as HTMLElement).isContentEditable;
      if (e.key === "E" && e.shiftKey && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openExplain(); }
    };
    window.addEventListener(OPEN_EVENT, on);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener(OPEN_EVENT, on); window.removeEventListener("keydown", key); };
  }, []);

  // A page's contents arrive after it does, so what can be pointed at is checked for a little while.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The route changed, so the list did.
    setNotes(notesFor(path)); setAt(0);
    const list = notesFor(path);
    const check = () => setFound(list.map(n => !!locate(n)));
    check();
    const iv = window.setInterval(check, 700);
    return () => clearInterval(iv);
  }, [open, path]);

  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  // Escape closes it wherever focus is, including after the control that had focus went away.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("dialog[open], [role=dialog]")) close(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, close]);

  // The ring follows its target through scrolling and layout changes.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = ring.current, n = notes[at];
      if (!el) return;
      const t = n ? locate(n) : null;
      if (!t) { el.style.opacity = "0"; return; }
      const r = t.getBoundingClientRect();
      el.style.opacity = "1";
      el.style.transform = `translate(${r.left - 5}px, ${r.top - 5}px)`;
      el.style.width = `${r.width + 10}px`; el.style.height = `${r.height + 10}px`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, at, notes]);

  const go = (i: number) => {
    setAt(i);
    const t = notes[i] && locate(notes[i]!);
    if (t) t.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  if (!open) return null;
  const current = notes[at];
  return (
    <>
      <div ref={ring} aria-hidden className="pointer-events-none fixed top-0 left-0 z-40 rounded-lg border-2 border-accent opacity-0 shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_22%,transparent)] transition-[width,height,opacity] duration-150" />
      <aside
        ref={panel} tabIndex={-1} role="complementary" aria-label="About this screen" data-testid="explain-panel"
        className="fixed right-3 bottom-3 z-40 flex max-h-[min(70svh,34rem)] w-[min(calc(100vw-1.5rem),23rem)] flex-col rounded-xl border border-line-strong bg-surface shadow-soft outline-none sm:top-16 sm:max-h-none"
      >
        <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
          <h2 className="font-display text-lg leading-tight tracking-tight">{tour ? `Tour: ${at + 1} of ${notes.length}` : "About this screen"}</h2>
          <button type="button" aria-label="Close" onClick={close} className="ml-auto grid size-8 place-items-center rounded-lg hover:bg-surface-2"><X className="size-4" aria-hidden /></button>
        </header>
        {tour && current ? (
          <div className="flex-1 overflow-auto px-3.5 py-3" aria-live="polite">
            <h3 className="text-[15px] font-semibold">{current.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">{current.text}</p>
          </div>
        ) : (
          <ul className="scroll-thin flex-1 overflow-auto p-1.5" data-testid="explain-list">
            {notes.map((n, i) => (
              <li key={n.title}>
                <button type="button" aria-current={i === at} data-found={found[i] ? "true" : "false"} onClick={() => go(i)} className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-2 ${i === at ? "bg-accent-soft" : ""}`}>
                  <span className="block text-[13px] font-semibold">{n.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-muted">{n.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer className="flex items-center gap-1.5 border-t border-line px-2.5 py-2">
          {tour ? (
            <>
              <button type="button" onClick={() => go(Math.max(0, at - 1))} disabled={at === 0} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-40"><ChevronLeft className="size-4" aria-hidden />Back</button>
              {at < notes.length - 1
                ? <button type="button" onClick={() => go(at + 1)} className="ml-auto inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-2.5 text-[13px] font-medium text-on-accent">Next<ChevronRight className="size-4" aria-hidden /></button>
                : <button type="button" onClick={close} className="ml-auto inline-flex h-8 items-center rounded-lg bg-accent px-2.5 text-[13px] font-medium text-on-accent">Done</button>}
              <button type="button" onClick={() => setTour(false)} className="h-8 rounded-lg px-2 text-[13px] hover:bg-surface-2">Skip</button>
            </>
          ) : (
            <button type="button" onClick={() => { setTour(true); go(0); }} className="inline-flex h-8 items-center rounded-lg px-2 text-[13px] font-medium text-accent hover:bg-surface-2">Take the tour of this screen</button>
          )}
        </footer>
      </aside>
    </>
  );
}
