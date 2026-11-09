"use client";
import { Columns2, LayoutList, Rows3, SlidersHorizontal, Square, Users, type LucideIcon } from "lucide-react";
import { usePrefPatch } from "../settings/common";
import { IconButton } from "../ui";
import { usePrefs } from "@/lib/client";
import { useEffect, useRef, useState } from "react";

export type MailLayout = "split" | "full" | "by_account" | "by_action" | "chronological";
/** What someone who never chose gets. One constant, so the switcher and the settings page show what the list is doing. */
export const DEFAULT_LAYOUT: MailLayout = "full";
export const LAYOUTS: { value: MailLayout; label: string; description: string; icon: LucideIcon }[] = [
  { value: "split", label: "Split", icon: Columns2, description: "List beside the open message." },
  { value: "full", label: "Full width", icon: Square, description: "The open message replaces the list." },
  { value: "by_account", label: "Grouped by account", icon: Users, description: "One group per mailbox." },
  { value: "by_action", label: "Grouped by action", icon: LayoutList, description: "Grouped by what each message needs." },
  { value: "chronological", label: "Chronological", icon: Rows3, description: "Newest first under date headings, in Focus too." },
];
const DENSITIES = [{ value: "compact", label: "Compact" }, { value: "comfortable", label: "Comfortable" }, { value: "spacious", label: "Spacious" }];

/** The same two settings as Personalization, a click away from the list they change. They save right away. */
export function LayoutSwitcher() {
  const { data: prefs } = usePrefs();
  const patch = usePrefPatch();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>("input:checked")?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.querySelector("button")?.focus(); } };
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", away);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", away); };
  }, [open]);
  const layout: MailLayout = prefs?.layout ?? DEFAULT_LAYOUT;
  const density = prefs?.density ?? "comfortable";
  const current = LAYOUTS.find(l => l.value === layout)!;
  return (
    <div className="relative">
      <div ref={btn}><IconButton icon={SlidersHorizontal} label={`Layout: ${current.label}, ${density}`} aria-haspopup="dialog" aria-expanded={open} active={open} onClick={() => setOpen(v => !v)} /></div>
      {open && (
        <div ref={box} role="group" aria-label="List layout and density" data-testid="layout-switcher" className="absolute top-full right-0 z-30 mt-1 w-72 max-w-[85vw] rounded-xl border border-line bg-surface p-2 shadow-soft">
          <fieldset>
            <legend className="px-1 pb-1 text-xs font-semibold text-muted">Layout</legend>
            {LAYOUTS.map(l => {
              const I = l.icon;
              return (
                <label key={l.value} className={`flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 text-[13px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${layout === l.value ? "bg-accent-soft" : "hover:bg-surface-2"}`}>
                  <input type="radio" name="mail-layout" className="sr-only" checked={layout === l.value} onChange={() => patch.mutate({ layout: l.value })} />
                  <I className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0"><span className={`block ${layout === l.value ? "font-semibold" : ""}`}>{l.label}</span><span className="block text-xs text-muted">{l.description}</span></span>
                </label>
              );
            })}
          </fieldset>
          <fieldset className="mt-2 border-t border-line pt-2">
            <legend className="sr-only">Density</legend>
            <p className="px-1 pb-1 text-xs font-semibold text-muted" aria-hidden>Density</p>
            <div className="grid grid-cols-3 gap-1">
              {DENSITIES.map(d => (
                <label key={d.value} className={`cursor-pointer rounded-lg px-1 py-1.5 text-center text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${density === d.value ? "bg-accent-soft font-semibold" : "hover:bg-surface-2"}`}>
                  <input type="radio" name="mail-density" className="sr-only" checked={density === d.value} onChange={() => patch.mutate({ density: d.value })} />
                  {d.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
