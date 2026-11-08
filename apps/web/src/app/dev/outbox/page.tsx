import { listDevOutbox } from "@aegis/platform";
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AuthFrame } from "@/components/auth/auth-frame";
import { platform } from "@/server/platform";
import { OutboxList } from "./outbox-list";

export const metadata: Metadata = { title: "Test outbox (demo mode)", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Exists only when DEMO_MODE=true. Anywhere else it's a 404, the same as a page that was never built. It's open without
 * sign-in because the mail it shows includes password reset links for people who can't sign in. Demo mode already has a
 * public login and must never be used with real people.
 */
export default async function DevOutboxPage() {
  if (!platform().config.demoMode) notFound();
  const mail = (await listDevOutbox(platform())).map(m => ({ id: m.id, to: m.to, subject: m.subject, text: m.text, createdAt: new Date(m.createdAt).toISOString() }));
  return (
    <AuthFrame wide>
      <Link href="/app" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted underline-offset-2 hover:text-ink hover:underline"><ArrowLeft className="size-3.5" aria-hidden />Back to mail</Link>
      <h1 className="font-display text-[2.25rem] leading-[1.1] tracking-tight">Test outbox</h1>
      <p className="mt-2 mb-5 text-sm text-muted">Demo mode: account emails land here instead of being sent, so you can open their links.</p>
      {mail.length === 0
        ? <p className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Nothing yet. Sign up or ask for a password reset, then reload in a moment.</p>
        : <OutboxList mail={mail} />}
    </AuthFrame>
  );
}
