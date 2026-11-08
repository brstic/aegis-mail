"use client";
import { AlertTriangle, ArrowLeft, ExternalLink, Globe, Lock, ShieldAlert, ShieldX, Unlock } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Logo } from "@/components/marketing/logo";
import { Banner, Button, ErrorState, RiskBadge, Skeleton } from "@/components/ui";
import { Providers, useApi } from "@/lib/client";

interface Inspect { href: string; host: string; risk: string | null; lookalike: string | null; blocked: boolean; insecure: boolean }

/** Only ordinary web links get an anchor. We never fetch the destination: the server only reads the URL's text. */
function safeHref(href: string) {
  try { const u = new URL(href); return u.protocol === "https:" || u.protocol === "http:" ? u : null; } catch { return null; }
}

function Close() {
  return <Button icon={ArrowLeft} onClick={() => { window.close(); window.setTimeout(() => { window.location.href = "/app"; }, 150); }}>Don't open it</Button>;
}

/** Every way this page can fail still leaves one clear way back. */
function Failed(props: Parameters<typeof ErrorState>[0]) {
  return (
    <div>
      <ErrorState {...props} />
      {/* Pulled up into the empty state's own bottom padding, so it sits with the message rather than below it. */}
      <div className="-mt-12 flex justify-center pb-4">
        <Link href="/app" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-surface-2"><ArrowLeft className="size-4" aria-hidden />Back to your inbox</Link>
      </div>
    </div>
  );
}

function Interstitial() {
  const sp = useSearchParams();
  const m = sp.get("m"), u = sp.get("u");
  const uuid = !!m && /^[0-9a-f-]{36}$/i.test(m);
  const { data, isLoading, error, refetch } = useApi<Inspect>(["link", m, u], uuid && u ? `/links/inspect?m=${encodeURIComponent(m!)}&u=${encodeURIComponent(u)}` : null, { retry: false });
  useEffect(() => { document.title = "Check this link · Aegis Mail"; }, []);
  if (!uuid || !u) return <Failed error={{ status: 400, message: "This link is incomplete, so it can't be checked. Go back to the message and try again." }} />;
  if (isLoading) return <div role="status" aria-label="Checking this link" className="space-y-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-16" /><Skeleton className="h-9 w-40" /></div>;
  if (error?.code === "bad_link") return <Failed error={{ message: "This isn't a web link we can open. Only http and https links are allowed." }} />;
  if (error || !data) return <Failed error={error ?? { message: "This link couldn't be checked." }} retry={() => refetch()} />;
  const url = safeHref(data.href);
  const highRisk = data.risk === "high_risk" || data.risk === "malicious";
  const hidden = !!url && (url.username || url.password);
  const warned = highRisk || !!data.lookalike || data.insecure || !!hidden || data.risk === "suspicious";
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Check this link before you open it</h1>
      <section aria-labelledby="dest" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="dest" className="flex items-center gap-1.5 text-[13px] font-medium text-muted"><Globe className="size-3.5" aria-hidden />This link really goes to</h2>
        <p data-testid="link-host" className="mt-1 font-mono text-xl font-semibold break-all sm:text-2xl">{data.host}</p>
        <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted">{data.insecure ? <Unlock className="size-3.5 shrink-0" aria-hidden /> : <Lock className="size-3.5 shrink-0" aria-hidden />}{data.insecure ? "Not encrypted (http)" : "Encrypted connection (https). That doesn't mean the site is trustworthy."}</p>
        <details className="mt-2 text-[13px]"><summary className="cursor-pointer text-muted">Show the full address</summary><p className="mt-1 font-mono text-xs break-all">{data.href}</p></details>
        {data.risk && <p className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-muted">The message it came from: <RiskBadge risk={data.risk} /></p>}
      </section>
      {data.blocked && <Banner tone="danger" icon={ShieldX}><strong className="font-semibold">This link is blocked.</strong> The message it came from was rated malicious, so we won't send you there. If you're sure you need this site, go to it another way, not from this email.</Banner>}
      {!data.blocked && highRisk && <Banner tone="danger" icon={ShieldAlert}><strong className="font-semibold">The message this link came from was rated high risk.</strong> It's likely phishing or fraud. Don't enter a password or payment details on this site.</Banner>}
      {!data.blocked && data.risk === "suspicious" && <Banner tone="warn" icon={AlertTriangle}><strong className="font-semibold">The message this link came from has some warning signs.</strong> Check that you expected it.</Banner>}
      {data.lookalike && <Banner tone="danger" icon={AlertTriangle}><strong className="font-semibold">This address looks like {data.lookalike}, but it isn't.</strong> Lookalike addresses are a common way to steal passwords.</Banner>}
      {data.insecure && <Banner tone="warn" icon={Unlock}><strong className="font-semibold">This link isn't encrypted.</strong> Others on the network could see or change what you send and receive. Don't enter passwords or personal details here.</Banner>}
      {hidden && <Banner tone="warn" icon={AlertTriangle}><strong className="font-semibold">Part of this address is disguised.</strong> Text before an @ in a link is often used to make it look like another site. The real destination is the name shown above.</Banner>}
      {!warned && !data.blocked && <p className="text-[13px] text-muted">We didn't find warning signs in this address. We haven't visited the site, so we can't tell you what's on it.</p>}
      <div className="flex flex-wrap items-center gap-2">
        {!data.blocked && url && <a href={url.href} rel="noopener noreferrer" target="_blank" className={`inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-sm font-medium ${warned ? "border border-line-strong bg-surface hover:bg-surface-2" : "bg-accent text-on-accent hover:bg-accent-hover"}`}><ExternalLink className="size-4" aria-hidden />{warned ? "Open link anyway" : "Open link"}<span className="sr-only"> (opens in a new tab)</span></a>}
        <Close />
      </div>
      <p className="text-xs text-muted">We check the address itself and the message it came from. We never visit the link for you, so opening it is the first time anyone from here contacts that site.</p>
    </div>
  );
}

export default function SafeLinkPage() {
  return (
    <Providers>
      <main className="min-h-dvh bg-bg">
        <div className="mx-auto max-w-xl px-4 py-8 sm:py-14">
          <div className="mb-8"><Logo href="/app" /></div>
          <Suspense fallback={<Skeleton className="h-32" />}><Interstitial /></Suspense>
        </div>
      </main>
    </Providers>
  );
}
