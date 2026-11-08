"use client";
import { ArrowRight, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { PageSkeleton } from "@/components/settings/common";
import { ConnectTiles } from "@/components/workspace/connect-tiles";
import { useAccounts, useMe } from "@/lib/client";

/**
 * The first screen after sign-up. With no mailbox yet, it's one question: where's your email? Once one is connected, it says you're
 * protected, shows the first sync, and sends you to your inbox. How mail is handled is one sentence here, and every detail is a link away.
 */
export default function OnboardingPage() {
  const { data: accounts, isLoading } = useAccounts();
  const { data: me } = useMe();
  const first = me?.name?.trim().split(/\s+/)[0];
  const has = !!accounts?.length;
  return (
    <div className="scroll-thin h-full overflow-auto">
      <div className="mx-auto max-w-2xl px-5 py-10 sm:py-16">
        {isLoading ? <PageSkeleton blocks={2} /> : !has ? (
          <>
            <h1 className="font-display text-[2rem] leading-[1.08] font-semibold tracking-tight sm:text-[2.5rem]">{first ? `Welcome, ${first}.` : "Welcome."} Where&apos;s your email?</h1>
            <p className="mt-3 text-lg text-muted">Connect the mailbox you already use. Your mail stays where it is, and every new message is checked before it reaches you.</p>
            <div className="mt-8"><ConnectTiles /></div>
            <p className="mt-8 text-[13px] text-muted">Our servers open each message in memory to check and sort it, then store it encrypted. <Link href="/app/privacy" className="font-medium text-accent hover:underline">How your mail is handled</Link></p>
          </>
        ) : (
          <>
            <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent"><ShieldCheck className="size-7" aria-hidden /></span>
            <h1 className="mt-5 font-display text-[2rem] leading-[1.08] font-semibold tracking-tight sm:text-[2.5rem]">You&apos;re protected.</h1>
            <p className="mt-3 text-lg text-muted">Every new message is checked as it arrives. What looks dangerous is kept out of your inbox.</p>
            <ul className="mt-8 divide-y divide-line rounded-2xl border border-line bg-surface" aria-label="Connected mailboxes">
              {accounts!.map(a => {
                const syncing = a.sync.phase === "initial";
                return (
                  <li key={a.id} className="flex items-center gap-3 px-5 py-4 text-sm" data-testid="onboarding-account">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: a.color }} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.email}</span><span className="block text-[13px] text-muted">{syncing ? `Bringing in the last 30 days: ${a.sync.messagesSynced} messages so far` : `${a.sync.messagesSynced} messages checked`}</span></span>
                    {syncing ? <Loader2 className="size-4 shrink-0 animate-spin text-muted" aria-label="Syncing" /> : <CheckCircle2 className="size-5 shrink-0 text-safe" aria-label="Ready" />}
                  </li>
                );
              })}
            </ul>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/app/inbox" className="inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-[15px] font-medium text-on-accent hover:bg-accent-hover">Go to your inbox<ArrowRight className="size-4" aria-hidden /></Link>
              <Link href="/app/connect" className="inline-flex h-12 items-center rounded-full px-5 text-[15px] font-medium text-accent hover:bg-surface-2">Add another mailbox</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
