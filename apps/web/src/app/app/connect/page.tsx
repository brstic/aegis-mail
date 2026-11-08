"use client";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { accountLimitMessage, latencyLabel, LimitBanner, type LimitsInfo, Page, PageSkeleton } from "@/components/settings/common";
import { ConnectTiles } from "@/components/workspace/connect-tiles";
import { Banner } from "@/components/ui";
import { useAccounts, useApi } from "@/lib/client";

const ERRORS: Record<string, string> = {
  denied: "You didn't grant access, so nothing was connected. You can try again whenever you're ready.",
  unavailable: "That provider's connection isn't configured on this deployment, so it can't be connected or reconnected here. Your mail already here stays.",
  limit_reached: "This workspace has reached its limit for connected accounts, so nothing was connected. The server admin can raise it.",
  expired: "That connection attempt expired or started somewhere else. Nothing was connected. Please try again.",
  failed: "The connection didn't finish, so nothing was connected. Please try again. If it keeps happening, your organization may block third-party apps.",
};

function Result() {
  const sp = useSearchParams();
  const connected = sp.get("connected"), err = sp.get("error");
  const { data: accounts } = useAccounts();
  if (connected) {
    const name = connected === "gmail" ? "Google" : connected === "microsoft" ? "Microsoft" : "Your";
    const a = accounts?.find(x => x.kind === connected);
    return <Banner tone="safe" icon={CheckCircle2} action={<Link href="/app/settings/accounts" className="font-semibold underline underline-offset-2">See sync status</Link>}>{name} account connected. We're starting with its last 30 days of mail. {a && `After that: ${latencyLabel(a.capabilities).toLowerCase()}.`}</Banner>;
  }
  if (err) return <Banner tone="warn" icon={AlertTriangle}>{ERRORS[err] ?? ERRORS.failed}</Banner>;
  return null;
}

function Connect() {
  // No limit is the default. One only shows when the server admin has set it and it's been reached.
  const limits = useApi<LimitsInfo>(["limits"], "/limits");
  const max = limits.data?.limits.accounts ?? null;
  const atLimit = max !== null && limits.data!.usage.accounts >= max;
  return (
    <Page width="4xl" title="Connect your email" description="Pick where your mail is. You can disconnect at any time." back={{ href: "/app/settings/accounts", label: "Accounts" }}>
      <div className="space-y-4">
        <Suspense><Result /></Suspense>
        {atLimit && <LimitBanner message={accountLimitMessage(max)} />}
        <ConnectTiles atLimit={atLimit} />
      </div>
    </Page>
  );
}

export default function ConnectPage() { return <Suspense fallback={<div className="p-6"><PageSkeleton /></div>}><Connect /></Suspense>; }
