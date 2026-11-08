"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Banner, Button, Field, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client";
import { AuthTitle } from "./auth-frame";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [demo, setDemo] = useState(false);
  useEffect(() => { api<{ demoMode: boolean }>("/public/config").then(c => setDemo(c.demoMode === true)).catch(() => {}); }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await api("/auth/password/forgot", { body: { email: email.trim() } }); setSent(true); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Something went wrong. Try again."); }
    finally { setBusy(false); }
  };
  if (sent) return (
    <>
      <AuthTitle title="Check your email"><p>If there&apos;s an account for <strong className="font-semibold text-ink [overflow-wrap:anywhere]">{email}</strong>, a link to reset the password is on its way. It works for 1 hour. If nothing arrives, check the address and your spam folder.</p></AuthTitle>
      {demo && <div className="mb-4"><Banner tone="info">Demo mode: nothing is really sent. Open the <a className="font-semibold underline underline-offset-2" href="/dev/outbox">test outbox</a> to see it.</Banner></div>}
      <Link href="/sign-in" className="font-medium text-accent underline underline-offset-2">Back to sign in</Link>
    </>
  );
  return (
    <>
      <AuthTitle title="Reset your password"><p>We&apos;ll email a link to the address on your account. <Link href="/sign-in">Back to sign in</Link>.</p></AuthTitle>
      <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
        <Field label="Email"><input type="email" name="email" required maxLength={254} autoComplete="username" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)} className={`${inputClass} !h-12 !rounded-xl !px-4 !text-base`} /></Field>
        {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="!h-12 w-full !rounded-full !text-[15px]" loading={busy}>Send reset link</Button>
      </form>
    </>
  );
}
