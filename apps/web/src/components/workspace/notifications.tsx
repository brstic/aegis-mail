"use client";
import { Bell, BellOff, CheckCheck, ShieldAlert, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { api, useAction, useApi, useMediaQuery, usePrefs } from "@/lib/client";
import { Banner, Button, IconButton } from "../ui";

interface Item { id: string; kind: string; severity: "normal" | "critical"; title: string; href: string; at: string; read: boolean }
interface Feed { unread: number; waiting: number; items: Item[] }

const when = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Optional and off by default. Shows the same generic title as the center, never message content. */
function useBrowserAlerts(feed: Feed | undefined, enabled: boolean) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!feed) return;
    const unread = feed.items.filter(i => !i.read);
    if (seen.current && enabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
      for (const i of unread) if (!seen.current.has(i.id)) { try { new Notification(i.title, { tag: i.id }); } catch { /* Some browsers only allow this from a service worker. */ } }
    }
    seen.current = new Set(feed.items.map(i => i.id));
  }, [feed, enabled]);
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { data, refetch } = useApi<Feed>(["notifications"], "/notifications", { refetchInterval: 60_000 });
  const { data: prefs } = usePrefs();
  const refresh = () => void refetch();
  const read = useAction<string>(id => api(`/notifications/${id}/read`, { method: "POST" }), { refresh: false, onDone: refresh });
  const all = useAction<void>(() => api("/notifications/read-all", { method: "POST" }), { refresh: false, onDone: refresh });
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // On a phone the panel spans the screen, so it starts just under the bell, wherever banners have pushed that to.
  const phone = useMediaQuery("(max-width: 639px)");
  const [top, setTop] = useState(56);
  useBrowserAlerts(data, (prefs as { browserNotifications?: boolean } | undefined)?.browserNotifications === true);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    const onClick = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, [open]);
  const unread = data?.unread ?? 0;
  // Blocked mail is one quiet line, not a wall of identical alerts.
  const blocked = data?.items.filter(i => i.kind === "held_message") ?? [];
  const rest = data?.items.filter(i => i.kind !== "held_message") ?? [];
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <div className="relative" ref={root}>
      <button ref={button} aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} data-testid="notification-bell" onClick={() => { setTop((button.current?.getBoundingClientRect().bottom ?? 52) + 4); setOpen(v => !v); }} className={`relative grid size-8 shrink-0 place-items-center rounded-lg transition-colors hover:bg-surface-2 hover:text-ink ${open ? "bg-surface-2 text-ink" : "text-muted"}`}>
        <Bell className="size-4" aria-hidden />
        {unread > 0 && <span aria-hidden className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full border border-danger/40 bg-danger-soft px-0.5 text-[10px] font-semibold text-danger tabular-nums">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div ref={panel} role="dialog" aria-labelledby={titleId} tabIndex={-1} data-testid="notification-panel" style={phone ? { top, maxHeight: `calc(100dvh - ${top + 8}px)` } : undefined} className="fixed inset-x-2 z-30 overflow-auto sm:max-h-[70dvh] rounded-xl border border-line bg-surface shadow-soft outline-none sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-1 sm:w-96">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 id={titleId} className="text-sm font-semibold">Notifications</h2>
            {unread > 0 && <Button size="sm" variant="ghost" icon={CheckCheck} loading={all.isPending} onClick={() => all.mutate()}>Mark all read</Button>}
          </div>
          {!data?.items.length
            ? <p className="px-3 py-6 text-center text-sm text-muted">You&apos;re all caught up.</p>
            : <ul>{blocked.length > 0 && (
                <li className="border-b border-line" data-testid="notification-row">
                  <Link href={blocked[0]!.href} onClick={() => { for (const b of blocked) if (!b.read) read.mutate(b.id); setOpen(false); }} className="flex items-start gap-3 px-3 py-3 hover:bg-surface-2">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-safe-soft text-safe"><ShieldCheck className="size-4" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-[13.5px] ${blocked.some(b => !b.read) ? "font-medium text-ink" : "text-muted"}`}>{blocked.length} dangerous {blocked.length === 1 ? "email" : "emails"} stopped</span>
                      <span className="mt-0.5 block text-xs text-muted">Kept out of everyone&apos;s inbox. Latest {when(blocked[0]!.at)}.</span>
                    </span>
                  </Link>
                </li>
              )}{rest.map(n => (
                <li key={n.id} className="flex items-start gap-1 border-b border-line last:border-b-0" data-testid="notification-row">
                  <Link href={n.href} onClick={() => { if (!n.read) read.mutate(n.id); setOpen(false); }} className="min-w-0 flex-1 px-3 py-2.5 hover:bg-surface-2">
                    <span className={`flex items-center gap-1.5 text-[13.5px] break-words ${n.read ? "text-muted" : "font-medium text-ink"}`}>{n.severity === "critical" && <ShieldAlert className="size-3.5 shrink-0 text-danger" aria-label="Security alert" />}{n.title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{when(n.at)}{!n.read && <span className="sr-only">. Unread</span>}</span>
                  </Link>
                  {!n.read && <IconButton icon={CheckCheck} label={`Mark read: ${n.title}`} className="mt-1 mr-1" onClick={() => read.mutate(n.id)} />}
                </li>
              ))}</ul>}
          {!!data?.waiting && <p className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-xs text-muted"><BellOff className="size-3.5 shrink-0" aria-hidden />{data.waiting} more waiting for your working hours or the end of quiet hours.</p>}
          <p className="border-t border-line px-3 py-2 text-xs text-muted"><Link href="/app/settings/personalization" onClick={() => setOpen(false)} className="font-medium text-accent underline underline-offset-2">Notification settings</Link></p>
        </div>
      )}
    </div>
  );
}

/** Shown until the address is proven. Accepting an invitation needs it. */
/** One of this person's workspaces is suspended, so it's gone from their list. They should hear why, and that nothing was deleted. */
export function SuspendedWorkspacesBanner({ items }: { items?: { name: string; reason: string }[] }) {
  if (!items?.length) return null;
  return <div className="space-y-2 px-2 pt-2 print:hidden" data-testid="suspended-banner">{items.map(w => <Banner key={w.name} tone="danger">{w.name} has been suspended by the service operator, so it isn't available right now. Nothing has been deleted. Reason given: {w.reason}</Banner>)}</div>;
}

export function VerifyEmailBanner({ email, mailAvailable, demo }: { email: string; mailAvailable: boolean; demo: boolean }) {
  const [sent, setSent] = useState(false);
  const resend = useAction<void>(() => api("/auth/verify/resend", { method: "POST" }), { refresh: false, onDone: () => setSent(true) });
  return (
    <section aria-label="Verify your email" data-testid="verify-banner" className="flex flex-wrap items-center gap-2 rounded-lg bg-info-soft px-3 py-2 text-[13px] text-info">
      <p className="min-w-0 flex-1 basis-60 [overflow-wrap:anywhere]">
        {!mailAvailable
          ? <><strong className="font-semibold">Your email isn&apos;t verified, and this deployment can&apos;t send mail yet.</strong> An administrator needs to set up a mail relay before you can accept invitations.</>
          : sent ? <>We sent a new link to <strong className="font-semibold">{email}</strong>.{demo && <> Demo mode: see the <a className="font-semibold underline underline-offset-2" href="/dev/outbox">test outbox</a>.</>}</>
          : <>Confirm your email: we sent a link to <strong className="font-semibold">{email}</strong>.{demo && <> <a className="font-semibold whitespace-nowrap underline underline-offset-2" href="/dev/outbox">Open the test outbox</a>.</>}</>}
      </p>
      {mailAvailable && <button type="button" disabled={resend.isPending} onClick={() => resend.mutate()} className="shrink-0 font-semibold underline underline-offset-2 disabled:opacity-50">{resend.isPending ? "Sending…" : "Resend"}</button>}
    </section>
  );
}
