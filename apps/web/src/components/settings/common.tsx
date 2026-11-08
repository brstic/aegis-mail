"use client";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Gauge, Lock, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api, useAction, type Capabilities } from "@/lib/client";
import { Banner, Button, EmptyState, Modal, PageHeader, Skeleton } from "../ui";

/** Sets the tab title. Client pages can't export metadata, and every route needs a distinct title. */
export function usePageTitle(title: string) {
  useEffect(() => { document.title = `${title} · Aegis Mail`; }, [title]);
}

const WIDTHS = { "2xl": "max-w-2xl", "3xl": "max-w-3xl", "4xl": "max-w-4xl", "5xl": "max-w-5xl" };

/** The content heading plus tab title, for pages inside a layout that already provides a scroll container. */
export function Head({ title, description, action, back }: { title: string; description?: ReactNode; action?: ReactNode; back?: { href: string; label: string } }) {
  usePageTitle(title);
  return (
    <>
      {back && <Link href={back.href} className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted underline-offset-2 hover:text-ink hover:underline"><ArrowLeft className="size-3.5" aria-hidden />{back.label}</Link>}
      <PageHeader title={title} description={description} action={action} />
    </>
  );
}

/** The back link for settings pages that live under the overview's "Advanced" list. */

/** A full page. `<main>` is overflow-hidden, so every page owns its scroll container. */
export function Page({ title, description, action, back, width = "3xl", children }: { title: string; description?: ReactNode; action?: ReactNode; back?: { href: string; label: string }; width?: keyof typeof WIDTHS; children: ReactNode }) {
  return (
    <div className="scroll-thin h-full overflow-auto">
      <div className={`mx-auto ${WIDTHS[width]} p-4 sm:p-6`}>
        <Head title={title} description={description} action={action} back={back} />
        {children}
      </div>
    </div>
  );
}

/**
 * The same white panel Inbox uses, for the other mail lists in the sidebar (Drafts, Scheduled), so moving between them never changes the
 * frame. White in both themes, like the mail itself.
 */
export function MailPanel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div data-preview-theme="light" className="flex h-full min-h-0 pr-2 pb-2 text-ink max-lg:p-0">
      <section aria-label={title} className="flex w-full min-w-0 flex-col overflow-hidden rounded-2xl bg-surface max-lg:rounded-none">
        <div className="flex min-h-12 shrink-0 items-center gap-3 px-4 py-1">
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-.012em]">{title}</h1>
          {action}
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto max-lg:pb-24">{children}</div>
      </section>
    </div>
  );
}

/** Section tabs rendered as real links. Wraps instead of scrolling so no destination is hidden at narrow widths. */
export function SubNav({ label, items, aside }: { label: string; items: { href: string; label: string; exact?: boolean }[]; aside?: ReactNode }) {
  const path = usePathname();
  // On a phone the tabs scroll sideways. Whichever edge has more tabs past it fades, so it's clear there's more.
  const [edge, setEdge] = useState({ start: false, end: false });
  const measure = (el: HTMLElement | null) => { if (!el) return; const start = el.scrollLeft > 2, end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2; setEdge(e => e.start === start && e.end === end ? e : { start, end }); };
  // Bring the current tab into view sideways, once per page. Only the tab strip scrolls: never the page, and never again on a re-render.
  const centerActive = (el: HTMLElement) => { const a = el.querySelector<HTMLElement>("[aria-current=page]"); if (a && el.scrollWidth > el.clientWidth) el.scrollLeft = a.offsetLeft - (el.clientWidth - a.offsetWidth) / 2; };
  const fade = `linear-gradient(to right, ${edge.start ? "transparent, black 2rem" : "black"}, ${edge.end ? "black calc(100% - 2rem), transparent" : "black"})`;
  return (
    <nav aria-label={label} className="mb-5 flex items-center gap-3 border-b border-line pb-2">
      <ul ref={el => { if (el && el.dataset.placed !== path) { el.dataset.placed = path; centerActive(el); } measure(el); }} onScroll={e => measure(e.currentTarget)} style={{ maskImage: fade, WebkitMaskImage: fade }} className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] sm:flex-wrap [&::-webkit-scrollbar]:hidden">
        {items.map(i => {
          const active = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
          return <li key={i.href} className="shrink-0"><Link href={i.href} aria-current={active ? "page" : undefined} className={`inline-flex h-8 items-center whitespace-nowrap rounded-lg px-2.5 text-[13px] transition-colors font-medium ${active ? "bg-accent-soft text-accent" : "text-ink hover:bg-surface-2"}`}>{i.label}</Link></li>;
        })}
      </ul>
      {aside && <div className="ml-auto shrink-0 text-xs text-muted max-sm:hidden">{aside}</div>}
    </nav>
  );
}

/** Wide tables scroll inside this box, never the page. Focusable so keyboard users can scroll it. */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return <div role="region" aria-label={label} tabIndex={0} className="scroll-thin overflow-x-auto rounded-lg border border-line">{children}</div>;
}
export const thClass = "border-b border-line bg-surface-2 px-3 py-2 text-left text-xs font-semibold text-muted";
export const tdClass = "border-b border-line px-3 py-2 align-top text-[13px] [tr:last-child>&]:border-b-0";
export const textareaClass = "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-ink/35 focus:outline-none focus:ring-4 focus:ring-ink/[0.04]";
export const linkClass = "font-medium text-accent underline underline-offset-2";

export function PageSkeleton({ blocks = 3 }: { blocks?: number }) {
  return <div role="status" aria-label="Loading" className="space-y-3">{Array.from({ length: blocks }).map((_, i) => <div key={i} className="space-y-2 rounded-xl bg-surface p-4"><Skeleton className="h-4 w-1/3" /><Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" /></div>)}</div>;
}

export function NoAccess({ title = "You don't have access", children }: { title?: string; children: ReactNode }) {
  return <EmptyState icon={Lock} title={title}>{children}</EmptyState>;
}

/** A limit this server's admin set has been reached (code limit_reached). Calm: nothing is wrong, and nothing was lost. */
export function LimitBanner({ message }: { message: string }) {
  return <Banner tone="neutral" icon={Gauge}>{message}</Banner>;
}

/** The limits that apply to the signed-in person. Null means no limit, which is the default on a self-hosted server. */
export interface LimitsInfo { limits: { accounts: number | null; aiActionsPerMonth: number | null; automations: number | null; seats: number | null; indexBytes: number | null }; usage: { accounts: number; aiActions: number; seats: number; indexBytes: number } }
export const accountLimitMessage = (n: number) => `This workspace's limit is ${n.toLocaleString()} connected ${n === 1 ? "account" : "accounts"}. The server admin can raise it.`;

export function ConfirmModal({ title, children, confirmLabel, danger, busy, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{confirmLabel}</Button></>}><div className="space-y-2 text-sm">{children}</div></Modal>;
}

/** A labelled single-choice group, for options where every choice should stay visible. */
export function ChoiceGroup<T extends string>({ legend, hint, value, options, onChange, disabled, columns = 2 }: { legend: string; hint?: ReactNode; value: T | undefined; options: { value: T; label: string; description?: ReactNode; icon?: LucideIcon }[]; onChange: (v: T) => void; disabled?: boolean; columns?: 2 | 3 }) {
  const name = useId();
  // Local copy so the radio stays selected in the same frame as the click, before the saved value comes back.
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium">{legend}</legend>
      {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      <div className={`mt-2 grid gap-2 ${columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {options.map(o => {
          const Icon = o.icon;
          const on = local === o.value;
          return (
            <label key={o.value} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${on ? "border-accent bg-accent-soft" : "border-line-strong hover:bg-surface-2"}`}>
              <input type="radio" name={name} className="mt-0.5 accent-[var(--accent)]" checked={on} onChange={() => { setLocal(o.value); onChange(o.value); }} />
              <span className="min-w-0"><span className="flex items-center gap-1.5 font-medium">{Icon && <Icon className="size-3.5" aria-hidden />}{o.label}</span>{o.description && <span className="mt-0.5 block text-[13px] text-muted">{o.description}</span>}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Fine print most people never need, closed until asked for. */
export function Details({ summary = "Details", children, className = "mt-3" }: { summary?: string; children: ReactNode; className?: string }) {
  return (
    <details className={`group text-[13px] text-muted ${className}`}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium hover:text-ink [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />{summary}</summary>
      <div className="mt-2 space-y-1.5">{children}</div>
    </details>
  );
}

/** Shows the first `initial` items, then a "Show N more" button. */
export function useShowMore<T>(items: T[] | undefined, initial: number) {
  const [all, setAll] = useState(false);
  const list = items ?? [];
  const hidden = all ? 0 : Math.max(0, list.length - initial);
  return { visible: all ? list : list.slice(0, initial), hidden, more: hidden ? <button type="button" className="inline-flex h-8 items-center text-[13px] font-medium text-accent hover:underline" onClick={() => setAll(true)}>Show {hidden} more</button> : null };
}

let prefSavesInFlight = 0;
/** Saves preferences optimistically, so controls answer at once and keep keyboard focus while the request runs. A failed save rolls back. */
export function usePrefPatch(success?: string) {
  const qc = useQueryClient();
  // Refreshes only once the last save lands, so a reply to an earlier save can't undo a newer choice on screen.
  const sync = () => { if (prefSavesInFlight > 0) return; for (const key of ["prefs", "privacy", "threads", "focus"]) void qc.invalidateQueries({ queryKey: [key] }); };
  return useAction<Record<string, unknown>, any>(async body => {
    prefSavesInFlight++;
    await qc.cancelQueries({ queryKey: ["prefs"] });
    qc.setQueryData(["prefs"], (old: any) => (old ? { ...old, ...body } : old));
    qc.setQueryData(["privacy"], (old: any) => {
      if (!old?.controls) return old;
      const controls = { ...old.controls };
      for (const k of Object.keys(controls)) if (k in body) controls[k] = body[k];
      return { ...old, controls };
    });
    try { const saved = await api("/preferences", { method: "PATCH", body }); prefSavesInFlight--; return saved; }
    catch (e) { prefSavesInFlight--; sync(); throw e; }
  }, { refresh: false, success, onDone: sync });
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export const ROLE_LABEL: Record<string, string> = { owner: "Owner", security_admin: "Security admin", workspace_manager: "Workspace manager", member: "Member" };
export const PROVIDER_LABEL: Record<string, string> = { gmail: "Google", microsoft: "Microsoft", imap: "IMAP and SMTP", pop3: "POP3", demo: "Demo mailbox" };
export const providerLabel = (kind: string) => PROVIDER_LABEL[kind] ?? kind;

/** Sync timing comes from the provider's real latency budget. Polling is never described as immediate. */
export function latencyLabel(c: Pick<Capabilities, "latencyBudgetSeconds" | "pushNotifications">) {
  const s = c.latencyBudgetSeconds;
  const unit = s < 60 ? `${s} seconds` : s === 60 ? "minute" : `${Math.round(s / 60)} minutes`;
  return c.pushNotifications ? `Usually within about ${s === 60 ? "a minute" : unit}, using provider notifications` : `Checks for new mail about every ${unit}`;
}

export function TextPair({ term, children }: { term: string; children: ReactNode }) {
  return <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3"><dt className="shrink-0 text-[13px] text-muted sm:w-44">{term}</dt><dd className="min-w-0 text-[13px] break-words">{children}</dd></div>;
}

/** Display names for the built-in topic keys, shared by Insights and Settings › Topics. */
export const TOPIC_LABEL: Record<string, string> = { invoices: "Invoices", finance: "Finance", legal: "Legal", meetings: "Meetings", travel: "Travel", hr: "HR", sales: "Sales", support: "Support", alerts: "Alerts", newsletter: "Newsletters" };
