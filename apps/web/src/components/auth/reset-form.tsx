"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { PasswordInput } from "./password-field";
import { api, ApiError } from "@/lib/client";
import { AuthTitle } from "./auth-frame";

export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dead, setDead] = useState(false);
  const [error, setError] = useState("");
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (needCode) codeRef.current?.focus(); }, [needCode]);
  const tooShort = password.length > 0 && password.length < 12;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) { setError("Use at least 12 characters for your password."); return; }
    setBusy(true); setError("");
    try {
      await api("/auth/password/reset", { body: { token, password, ...(needCode ? { totp } : {}) } });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "mfa_required") { setNeedCode(true); }
      else if (err instanceof ApiError && err.code === "token_invalid") { setDead(true); }
      else { if (err instanceof ApiError && err.code === "invalid_mfa") setTotp(""); setError(err instanceof ApiError ? err.message : "Something went wrong. Try again."); }
    } finally { setBusy(false); }
  };
  if (done) return (
    <>
      <AuthTitle title="Password changed"><p>You&apos;ve been signed out everywhere, so sign in with your new password.</p></AuthTitle>
      <Link href="/sign-in" className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-accent px-4 font-medium text-on-accent transition-colors hover:bg-accent-hover">Go to sign in</Link>
    </>
  );
  if (dead) return (
    <>
      <AuthTitle title="This link isn't valid anymore"><p>It may have expired or already been used. Reset links work for 1 hour and only once.</p></AuthTitle>
      <Link href="/forgot-password" className="font-medium text-accent underline underline-offset-2">Send a new link</Link>
    </>
  );
  return (
    <>
      <AuthTitle title="Choose a new password"><p>Changing it signs you out on every device.</p></AuthTitle>
      <form onSubmit={submit} className="space-y-4" aria-busy={busy}>
        <Field label="New password" hint="At least 12 characters. A long phrase works well, and pasting from a password manager is fine." error={tooShort ? `${12 - password.length} more characters needed.` : undefined}>
          <PasswordInput name="password" required minLength={12} maxLength={256} autoComplete="new-password" aria-invalid={tooShort || undefined} value={password} onChange={e => setPassword(e.target.value)} className={`${inputClass} !h-12 !rounded-xl !px-4 !text-base`} />
        </Field>
        {needCode && (
          <Field label="Authentication code" hint="This account uses an authenticator app, so email alone can't reset the password.">
            <input ref={codeRef} type="text" name="totp" required autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} pattern="[0-9]{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5}" maxLength={17} title="6 digits, or a recovery code" value={totp} onChange={e => setTotp(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))} className={`${inputClass} !h-12 !rounded-xl !px-4 font-mono !text-base tracking-widest`} />
          </Field>
        )}
        {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
        <Button type="submit" variant="primary" className="!h-12 w-full !rounded-full !text-[15px]" loading={busy}>Change password</Button>
      </form>
    </>
  );
}
