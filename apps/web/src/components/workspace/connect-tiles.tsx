"use client";
import { ChevronRight, Download } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ProviderIcon } from "@/components/marketing/provider-icons";
import { useApi } from "@/lib/client";

/**
 * The ways in, as big tiles with each provider's mark. Google and Microsoft go straight to their own sign-in page, where they show
 * what's asked for, and appear only when this server has them switched on. Less common options sit behind one click.
 */
export function ConnectTiles({ atLimit = false }: { atLimit?: boolean }) {
  const config = useApi<{ googleConfigured: boolean; microsoftConfigured: boolean }>(["public-config"], "/public/config", { staleTime: 300_000 });
  const tile = "group flex min-h-[5.5rem] items-center gap-4 rounded-2xl border border-line bg-surface px-5 py-4 text-left transition-all hover:-translate-y-0.5 hover:border-line-strong hover:shadow-soft";
  const off = "flex min-h-[5.5rem] items-center gap-4 rounded-2xl border border-dashed border-line bg-surface/60 px-5 py-4 text-left";
  const body = (icon: ReactNode, name: string, line: string, live = true) => (
    <>
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-surface-2">{icon}</span>
      <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">{name}</span><span className="block text-[13px] leading-snug text-muted">{line}</span></span>
      {live && <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />}
    </>
  );
  // Only what works is a tile. A provider whose sign-in isn't switched on here gets one quiet line instead of a dead end.
  const google = !!config.data?.googleConfigured, microsoft = !!config.data?.microsoftConfigured;
  const oauth = (provider: "gmail" | "microsoft", name: string, icon: ReactNode, line: string) => {
    if (atLimit) return <div className={off} aria-disabled="true">{body(icon, name, "This workspace's account limit is reached.", false)}</div>;
    return <a href={`/api/v1/oauth/${provider}/start`} className={tile}>{body(icon, name, line)}</a>;
  };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {google && oauth("gmail", "Gmail", <ProviderIcon kind="gmail" className="size-6" />, "Sign in with Google. It reads, organizes and sends only mail you approve.")}
        {microsoft && oauth("microsoft", "Outlook", <ProviderIcon kind="outlook" className="size-6" />, "Outlook.com, Hotmail and Microsoft 365.")}
        {atLimit ? <div className={off}>{body(<ProviderIcon kind="icloud" className="size-6" />, "iCloud Mail", "This workspace's account limit is reached.", false)}</div>
          : <Link href="/app/connect/manual?provider=icloud" className={tile}>{body(<ProviderIcon kind="icloud" className="size-6" />, "iCloud Mail", "We'll walk you through an app password.")}</Link>}
        {atLimit ? <div className={off}>{body(<ProviderIcon kind="imap" className="size-6" />, "Other email", "This workspace's account limit is reached.", false)}</div>
          : <Link href="/app/connect/manual" className={tile}>{body(<ProviderIcon kind="imap" className="size-6 text-muted" />, "Other email", "Yahoo, Fastmail, Zoho, your company's server.")}</Link>}
      </div>
      <details className="group text-sm">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[13px] font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />More options</summary>
        <div className="mt-2 space-y-2 rounded-xl bg-surface-2 p-4 text-[13px] text-muted">
          {config.data?.googleConfigured && <p><a href="/api/v1/oauth/gmail/start?readOnly=true" className="font-medium text-accent hover:underline">Connect Gmail read-only</a>: warnings and Focus work, but you can't send or organize from here.</p>}
          {config.data?.microsoftConfigured && <p><a href="/api/v1/oauth/microsoft/start?readOnly=true" className="font-medium text-accent hover:underline">Connect Outlook read-only</a>: the same, for Microsoft.</p>}
          {!atLimit && <p className="flex items-center gap-1.5"><Download className="size-3.5" aria-hidden /><Link href="/app/connect/manual?provider=pop3" className="font-medium text-accent hover:underline">Import an older account</Link> that only offers POP3. Mail is copied in about every 15 minutes.</p>}
          <p>Proton Mail can&apos;t be connected yet.</p>
        </div>
      </details>
    </div>
  );
}
