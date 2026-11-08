"use client";
import { AtSign, ChevronRight, EyeOff, Plug, Rocket, Search, ShieldCheck, SlidersHorizontal, Tags, type LucideIcon, Users } from "lucide-react";
import Link from "next/link";
import { Head } from "@/components/settings/common";
import { useAccounts, useMe } from "@/lib/client";

function Tile({ href, icon: Icon, title, children }: { href: string; icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 rounded-xl bg-surface p-3 hover:bg-surface-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted"><Icon className="size-4" aria-hidden /></span>
        <span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{title}</span><span className="block text-[13px] text-muted">{children}</span></span>
        <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
      </Link>
    </li>
  );
}

export default function SettingsIndex() {
  const { data: accounts } = useAccounts();
  const { data: me } = useMe();
  const trouble = accounts?.filter(a => a.status === "reconnect_required" || a.status === "error").length ?? 0;
  return (
    <>
      <Head title="Settings" description={me ? `Signed in as ${me.email}.` : undefined} />
      <ul className="space-y-2">
        <Tile href="/app/settings/accounts" icon={Plug} title="Accounts">{accounts ? `${accounts.length} connected${trouble ? `, ${trouble} need${trouble === 1 ? "s" : ""} attention` : ""}.` : "Your connected mailboxes."}</Tile>
        <Tile href="/app/settings/personalization" icon={SlidersHorizontal} title="Appearance and AI">Theme, layout, and what the AI does for you.</Tile>
        <Tile href="/app/settings/identity" icon={AtSign} title="Signatures">Your signature for each mailbox.</Tile>
        <Tile href="/app/settings/security" icon={ShieldCheck} title="Sign-in and security">{me ? `Two-step sign-in ${me.mfaEnabled ? "on" : "off"}. ` : ""}Passkeys and devices.</Tile>
      </ul>
      {/* Everything most people never need, one click away. */}
      <details className="group mt-6">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-muted hover:text-ink [&::-webkit-details-marker]:hidden"><ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />Advanced</summary>
        <ul className="mt-3 space-y-2">
          <Tile href="/app/settings/search" icon={Search} title="Search">Semantic search, the word index and related words.</Tile>
          <Tile href="/app/settings/topics" icon={Tags} title="Topics">Your own topics for new mail, and the built-in ones.</Tile>
          <Tile href="/app/settings/people" icon={Users} title="People and learning">What Focus has learned, and how to correct or reset it.</Tile>
          <Tile href="/app/privacy" icon={EyeOff} title="Privacy Center">How your mail is handled, your data controls, export and account deletion.</Tile>
          <Tile href="/app/onboarding" icon={Rocket} title="Setup">Connect another mailbox.</Tile>
        </ul>
      </details>
    </>
  );
}
