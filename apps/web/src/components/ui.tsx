"use client";
import Link from "next/link";
import { AlertTriangle, CircleHelp, ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, X, Inbox as InboxIcon, WifiOff, Lock, Gauge, type LucideIcon } from "lucide-react";
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from "react";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; icon?: LucideIcon; loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "secondary", size = "md", icon: Icon, loading, className = "", children, disabled, ...rest }, ref) {
  const v = { primary: "bg-accent text-on-accent hover:bg-accent-hover", secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-2", ghost: "text-ink hover:bg-surface-2", danger: "border border-danger/40 bg-danger-soft text-danger hover:brightness-95" }[variant];
  const s = size === "sm" ? "h-7 gap-1.5 px-2.5 text-[13px]" : "h-9 gap-2 px-3.5 text-sm";
  return (
    <button ref={ref} disabled={disabled || loading} className={`inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50 ${v} ${s} ${className}`} {...rest}>
      {Icon && <Icon className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />}
      {loading ? "Working…" : children}
    </button>
  );
});

export function IconButton({ icon: Icon, label, active, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; active?: boolean }) {
  return (
    <button aria-label={label} title={label} aria-pressed={active} className={`grid size-8 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 ${active ? "bg-surface-2 text-ink" : ""} ${className}`} {...rest}>
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

export function Chip({ children, tone = "neutral", className = "", title }: { children: ReactNode; tone?: "neutral" | "danger" | "warn" | "info" | "safe" | "accent"; className?: string; title?: string }) {
  const t = { neutral: "bg-surface-2 text-muted", danger: "bg-danger-soft text-danger", warn: "bg-warn-soft text-warn", info: "bg-info-soft text-info", safe: "bg-safe-soft text-safe", accent: "bg-accent-soft text-accent" }[tone];
  return <span title={title} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${t} ${className}`}>{children}</span>;
}

export const RISK: Record<string, { label: string; tone: "danger" | "warn" | "info" | "safe" | "neutral"; icon: LucideIcon; describe: string }> = {
  malicious: { label: "Malicious", tone: "danger", icon: ShieldX, describe: "Strong signs of an attack" },
  high_risk: { label: "High risk", tone: "danger", icon: ShieldAlert, describe: "Likely phishing or fraud" },
  suspicious: { label: "Suspicious", tone: "warn", icon: AlertTriangle, describe: "Some warning signs" },
  unknown_unscannable: { label: "Couldn't verify", tone: "info", icon: ShieldQuestion, describe: "Part of this couldn't be inspected, so it isn't rated safe" },
  safe: { label: "No concerns found", tone: "safe", icon: ShieldCheck, describe: "No warning signs were found. This isn't a guarantee." },
  bulk_low_priority: { label: "Bulk", tone: "neutral", icon: CircleHelp, describe: "Newsletter or bulk mail" },
};

export function RiskBadge({ risk, quiet }: { risk: string | null | undefined; quiet?: boolean }) {
  const r = risk ? RISK[risk] : null;
  if (!r || (quiet && (risk === "safe" || risk === "bulk_low_priority"))) return null;
  const I = r.icon;
  return <Chip tone={r.tone}><I className="size-3" aria-hidden />{r.label}</Chip>;
}

function hueOf(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
export function Avatar({ name, address, size = 32 }: { name?: string; address?: string; size?: number }) {
  const label = (name || address || "?").trim();
  const initials = label.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join("");
  return <span aria-hidden className="grid shrink-0 place-items-center rounded-full font-semibold text-white" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hueOf(address ?? label)} 28% 34%)` }}>{initials}</span>;
}

export function Skeleton({ className = "" }: { className?: string }) { return <div className={`skeleton ${className}`} aria-hidden />; }
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return <div role="status" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="flex items-center gap-3 border-b border-line px-4 py-3"><Skeleton className="size-8 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-3/4" /></div></div>)}</div>;
}

export function EmptyState({ icon: Icon = InboxIcon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-surface-2 text-muted"><Icon className="size-5" aria-hidden /></span>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: { status?: number; code?: string; message: string }; retry?: () => void }) {
  if (error.status === 0) return <EmptyState icon={WifiOff} title="You're offline" action={retry && <Button onClick={retry}>Try again</Button>}>Your drafts are kept on this device until you reconnect. Nothing will be sent while you're offline.</EmptyState>;
  if (error.code === "limit_reached") return <EmptyState icon={Gauge} title="Limit reached">{error.message}</EmptyState>;
  if (error.status === 403) return <EmptyState icon={Lock} title="You don't have access">{error.message}</EmptyState>;
  if (error.status === 404) return <EmptyState icon={CircleHelp} title="Not found">This may have been removed, or it isn't shared with you.</EmptyState>;
  return <EmptyState icon={AlertTriangle} title="That didn't load" action={retry && <Button onClick={retry}>Try again</Button>}>{error.message}</EmptyState>;
}

export function Banner({ tone = "info", icon: Icon, children, action }: { tone?: "info" | "warn" | "danger" | "safe" | "neutral"; icon?: LucideIcon; children: ReactNode; action?: ReactNode }) {
  const t = { info: "bg-info-soft text-info", warn: "bg-warn-soft text-warn", danger: "bg-danger-soft text-danger", safe: "bg-safe-soft text-safe", neutral: "bg-surface-2 text-muted" }[tone];
  return <div className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px] ${t}`}>{Icon && <Icon className="size-4 shrink-0" aria-hidden />}<div className="min-w-0 flex-1">{children}</div>{action}</div>;
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  // Held in a ref: callers pass inline functions, and re-running this on every render would pull focus back to the first field.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,textarea,select,button:not([aria-label='Close'])")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("a,button:not(:disabled),input,textarea,select")];
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); prev?.focus(); };
  }, []);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4 print:hidden" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className={`flex max-h-[90vh] w-full flex-col rounded-xl border border-line bg-surface shadow-soft ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><h2 id={id} className="text-[15px] font-semibold">{title}</h2><IconButton icon={X} label="Close" onClick={onClose} /></div>
        <div className="scroll-thin flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

const FOCUSABLE = "a[href],button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex='0']";

/** A panel that slides over the page edge: the navigation drawer and the intelligence pane on narrow screens. */
export function Sheet({ title, side = "right", onClose, children, closeLabel = "Close", hideTitle }: { title: string; side?: "left" | "right"; onClose: () => void; children: ReactNode; closeLabel?: string; hideTitle?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const key = (e: KeyboardEvent) => {
      if (!ref.current) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key === "Tab") {
        const f = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); prev?.focus?.(); };
  }, []);
  return (
    <div className="fixed inset-0 z-40 print:hidden" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div ref={ref} className={`absolute inset-y-0 flex w-[min(24rem,92vw)] flex-col bg-surface shadow-soft ${side === "left" ? "left-0" : "right-0"}`}>
        <div className={`flex shrink-0 items-center gap-2 border-b border-line py-1.5 pr-1.5 pl-3 ${hideTitle ? "justify-end border-b-0" : "justify-between"}`}>{!hideTitle && <h2 className="truncate text-sm font-semibold">{title}</h2>}<IconButton icon={X} label={closeLabel} onClick={onClose} /></div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

export interface MenuItem { label: string; icon?: LucideIcon; onSelect?: () => void; href?: string; danger?: boolean; hint?: string; disabled?: boolean; current?: boolean }
/** A button that opens a list of actions. Arrow keys move, Enter selects, Escape closes and returns focus to the button. */
export function Menu({ trigger, items, label, align = "right" }: { trigger: (p: { "aria-haspopup": "menu"; "aria-expanded": boolean; onClick: () => void; ref: (el: HTMLButtonElement | null) => void }) => ReactElement; items: MenuItem[]; label: string; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus();
    const key = (e: KeyboardEvent) => {
      const list = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btn.current?.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
      else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
      else if (e.key === "Tab") setOpen(false);
    };
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", away);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("mousedown", away); };
  }, [open]);
  const cls = "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2 aria-disabled:opacity-50";
  return (
    <div className="relative">
      {trigger({ "aria-haspopup": "menu", "aria-expanded": open, onClick: () => setOpen(v => !v), ref: el => { btn.current = el; } })}
      {open && (
        <div ref={box} role="menu" aria-label={label} className={`absolute top-full z-30 mt-1 max-h-[70vh] w-60 max-w-[85vw] overflow-auto rounded-xl border border-line bg-surface p-1.5 shadow-soft ${align === "right" ? "right-0" : "left-0"}`}>
          {items.map(i => {
            const I = i.icon;
            const body = <>{I && <I className="size-3.5 shrink-0 text-muted" aria-hidden />}<span className="min-w-0 flex-1 truncate">{i.label}</span>{i.hint && <span className="shrink-0 text-xs text-muted">{i.hint}</span>}</>;
            const run = () => { setOpen(false); i.onSelect?.(); };
            return i.href
              ? <Link key={i.label} role="menuitem" tabIndex={-1} aria-current={i.current ? "true" : undefined} href={i.href} onClick={run} className={`${cls} ${i.current ? "font-semibold" : ""}`}>{body}</Link>
              : <button key={i.label} type="button" role="menuitem" tabIndex={-1} aria-disabled={i.disabled || undefined} aria-current={i.current ? "true" : undefined} onClick={() => { if (!i.disabled) run(); }} className={`${cls} ${i.danger ? "text-danger" : ""} ${i.current ? "font-semibold" : ""}`}>{body}</button>;
          })}
        </div>
      )}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[13px] font-medium">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}{error && <span className="mt-1 block text-xs text-danger" role="alert">{error}</span>}</label>;
}
export const inputClass = "h-9 w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint focus:border-ink/35 focus:outline-none focus:ring-4 focus:ring-ink/[0.04]";

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0"><div id={id} className="text-sm font-medium">{label}</div>{description && <div className="mt-0.5 text-[13px] text-muted">{description}</div>}</div>
      <button role="switch" aria-checked={checked} aria-labelledby={id} disabled={disabled} onClick={() => onChange(!checked)} className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-accent" : "bg-line-strong"}`}>
        <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`} />
      </button>
    </div>
  );
}

export function Card({ title, description, children, action }: { title?: ReactNode; description?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl bg-surface p-5">
      {(title || action) && <div className="mb-2 flex flex-wrap items-start justify-between gap-x-3 gap-y-2"><div className="min-w-[min(100%,14rem)] flex-1">{title && <h2 className="text-[15px] font-semibold">{title}</h2>}{description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}</div>{action}</div>}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return <header className="mb-5 flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap"><div className="min-w-0 flex-1"><h1 className="text-xl font-semibold tracking-tight">{title}</h1>{description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}</div>{action && <div className="shrink-0">{action}</div>}</header>;
}
export function Kbd({ children }: { children: ReactNode }) { return <kbd className="rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">{children}</kbd>; }
