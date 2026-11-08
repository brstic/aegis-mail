"use client";
import { Clock, MailQuestion, UserRoundX, WifiOff, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button, Skeleton } from "@/components/ui";
import { AuthTitle } from "./auth-frame";

type State =
  | { name: "loading" }
  | { name: "signed_out" }
  | { name: "ready"; email: string }
  | { name: "accepting"; email: string }
  | { name: "wrong_email"; email: string | null; message: string }
  | { name: "unverified"; email: string; resent?: boolean }
  | { name: "expired" }
  | { name: "error"; message: string; offline?: boolean };

function Problem({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-4 grid size-11 place-items-center rounded-full bg-surface-2 text-muted"><Icon className="size-5" aria-hidden /></span>
      <AuthTitle title={title}>{children}</AuthTitle>
    </div>
  );
}

/**
 * Uses plain fetch, not `api()`: that helper redirects to /sign-in on a 401,
 * and here a 401 is a normal state with its own explanation.
 */
export function InviteAccept({ token }: { token: string }) {
  const [state, setState] = useState<State>({ name: "loading" });
  const here = `/invite/${encodeURIComponent(token)}`;
  const nextParam = encodeURIComponent(here);

  const load = useCallback(async () => {
    setState({ name: "loading" });
    try {
      const res = await fetch("/api/v1/me", { credentials: "same-origin" });
      if (res.status === 401) { setState({ name: "signed_out" }); return; }
      if (!res.ok) { setState({ name: "error", message: "We couldn't check whether you're signed in." }); return; }
      const me = await res.json();
      setState({ name: "ready", email: me.email });
    } catch {
      setState({ name: "error", offline: true, message: "You appear to be offline. Nothing was changed." });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const accept = async (email: string) => {
    setState({ name: "accepting", email });
    try {
      const res = await fetch(`/api/v1/invites/${encodeURIComponent(token)}/accept`, { method: "POST", credentials: "same-origin" });
      if (res.ok) { window.location.assign("/app"); return; }
      const data = await res.json().catch(() => null);
      if (res.status === 401) setState({ name: "signed_out" });
      else if (res.status === 403 && data?.error?.code === "email_unverified") setState({ name: "unverified", email });
      else if (res.status === 403) setState({ name: "wrong_email", email, message: data?.error?.message ?? "This invitation was sent to a different email address." });
      else if (res.status === 404) setState({ name: "expired" });
      else setState({ name: "error", message: data?.error?.message ?? "The invitation couldn't be accepted." });
    } catch {
      setState({ name: "error", offline: true, message: "You appear to be offline. Nothing was changed." });
    }
  };

  const resend = async (email: string) => {
    await fetch("/api/v1/auth/verify/resend", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    setState({ name: "unverified", email, resent: true });
  };

  const switchAccount = async () => {
    await fetch("/api/v1/auth/signout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
    window.location.assign(`/sign-in?next=${nextParam}`);
  };

  switch (state.name) {
    case "loading":
      return <div role="status" aria-label="Checking your invitation" className="space-y-3"><Skeleton className="h-10 w-3/4" /><Skeleton className="h-4 w-full" /><Skeleton className="h-11 w-full" /></div>;
    case "signed_out":
      return (
        <>
          <AuthTitle title="You've been invited"><p>Sign in or create an account to accept. Use the same email address this invitation was sent to.</p></AuthTitle>
          <div className="grid gap-2">
            <Link href={`/sign-in?next=${nextParam}`} className="inline-flex h-12 items-center justify-center rounded-full bg-accent px-4 text-[15px] font-medium text-on-accent transition-colors hover:bg-accent-hover">Sign in</Link>
            <Link href={`/sign-up?next=${nextParam}`} className="inline-flex h-12 items-center justify-center rounded-full border border-line-strong bg-surface px-4 text-[15px] font-medium transition-colors hover:bg-surface-2">Create an account</Link>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-muted">Joining a workspace doesn&apos;t give its admins access to your mail content, and it doesn&apos;t connect a mailbox.</p>
        </>
      );
    case "ready":
    case "accepting":
      return (
        <>
          <AuthTitle title="Accept your invitation"><p>You&apos;re signed in as <strong className="font-semibold text-ink [overflow-wrap:anywhere]">{state.email}</strong>. Accepting adds this account to the workspace that invited you.</p></AuthTitle>
          <Button variant="primary" className="!h-12 w-full !rounded-full !text-[15px]" loading={state.name === "accepting"} onClick={() => accept(state.email)}>Accept invitation</Button>
          <p className="mt-4 text-[13px] leading-relaxed text-muted">Joining a workspace doesn&apos;t give its admins access to your mail content, and it doesn&apos;t connect a mailbox.</p>
        </>
      );
    case "wrong_email":
      return (
        <>
          <Problem icon={UserRoundX} title="This invitation is for someone else">
            <p>{state.message}{state.email && <> You&apos;re signed in as <strong className="font-semibold text-ink [overflow-wrap:anywhere]">{state.email}</strong>.</>} Sign in with the invited address, or ask the person who invited you to send a new invitation.</p>
          </Problem>
          <Button className="!h-12 w-full !rounded-full !text-[15px]" onClick={switchAccount}>Sign out and use another account</Button>
        </>
      );
    case "unverified":
      return (
        <>
          <Problem icon={MailQuestion} title="Confirm your email first">
            <p>This invitation is for <strong className="font-semibold text-ink [overflow-wrap:anywhere]">{state.email}</strong>, and you need to prove that address is yours before accepting. Use the link we emailed you, then come back to this page.</p>
          </Problem>
          {state.resent && <p role="status" className="mb-3 text-sm font-medium text-safe">We sent a new link.</p>}
          <div className="grid gap-2">
            <Button variant="primary" className="!h-12 w-full !rounded-full !text-[15px]" onClick={() => void load()}>I&apos;ve confirmed it</Button>
            <Button className="!h-12 w-full !rounded-full !text-[15px]" onClick={() => resend(state.email)}>Send the link again</Button>
          </div>
        </>
      );
    case "expired":
      return (
        <>
          <Problem icon={Clock} title="This invitation isn't valid anymore">
            <p>It may have expired, or it may already have been used. Ask the person who invited you to send a new one.</p>
          </Problem>
          <Link href="/app" className="font-medium text-accent underline underline-offset-2">Go to the app</Link>
        </>
      );
    case "error":
      return (
        <>
          <Problem icon={state.offline ? WifiOff : MailQuestion} title="That didn't work"><p>{state.message}</p></Problem>
          <Button className="!h-12 w-full !rounded-full !text-[15px]" onClick={() => void load()}>Try again</Button>
        </>
      );
  }
}
