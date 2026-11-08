"use client";
import { Explain, ExplainButton } from "@/explain/Explain";
import { ArrowLeft, EyeOff, KeyRound, LogOut, Wrench } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Banner, EmptyState } from "@/components/ui";
import { api } from "@/lib/client";

const NAV = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/tenants", label: "Tenants" },
  { href: "/admin/jobs", label: "Job queue" },
  { href: "/admin/health", label: "System health" },
  { href: "/admin/audit", label: "Operator audit log" },
];

/** Inverted header and its own navigation, so nobody mistakes this for the customer app. Same tokens, both themes. */
export function AdminShell({ children, needsMfa, demo }: { children: ReactNode; needsMfa: boolean; demo: boolean }) {
  const path = usePathname();
  const signOut = async () => { await api("/auth/signout", { method: "POST" }).catch(() => {}); window.location.assign("/sign-in"); };
  return (
    <div className="flex min-h-dvh flex-col bg-bg" data-testid="admin-shell">
      <header className="bg-ink text-bg">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <p className="flex items-center gap-2 text-sm font-semibold"><Wrench className="size-4 shrink-0" aria-hidden />Operator console{demo && <span className="rounded border border-current px-1.5 py-0.5 text-[11px] font-medium">Demo</span>}</p>
          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            <ExplainButton className="hover:!bg-transparent" />
            <Link href="/app" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 hover:bg-white/10"><ArrowLeft className="size-3.5" aria-hidden />Back to the app</Link>
            <button type="button" onClick={signOut} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 hover:bg-white/10"><LogOut className="size-3.5" aria-hidden />Sign out</button>
          </div>
        </div>
        {!needsMfa && (
          <nav aria-label="Operator sections" className="mx-auto w-full max-w-6xl px-2 pb-2 sm:px-4">
            <ul className="flex flex-wrap gap-1">
              {NAV.map(i => {
                const active = i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`);
                return <li key={i.href}><Link href={i.href} aria-current={active ? "page" : undefined} className={`inline-flex h-8 items-center rounded-lg px-2.5 text-[13px] font-medium ${active ? "bg-bg text-ink" : "text-bg/80 hover:bg-white/10 hover:text-bg"}`}>{i.label}</Link></li>;
              })}
            </ul>
          </nav>
        )}
      </header>
      <Explain />
      <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 p-4 sm:p-6">
        {needsMfa ? (
          <EmptyState icon={KeyRound} title="Sign in with a second factor" action={<Link href="/app/settings/security" className="inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-surface-2">Open security settings</Link>}>Operator access needs this session to have shown a second factor: a code from your authenticator app at sign-in, or a sign-in with a passkey. If you've just set one up, sign out and sign in again with it. Nothing here opens until then.</EmptyState>
        ) : (
          <>
            <div className="mb-4"><Banner tone="neutral" icon={EyeOff}>Content-blind by design. This console can't show mail, subjects, senders or mailbox addresses, and it can't act as a user.</Banner></div>
            {children}
          </>
        )}
      </main>
    </div>
  );
}

export const Stat = ({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) => (
  <div className="rounded-xl border border-line bg-surface p-4">
    <p className="text-[13px] text-muted">{label}</p>
    <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
    {note && <p className="mt-1 text-xs text-muted">{note}</p>}
  </div>
);

