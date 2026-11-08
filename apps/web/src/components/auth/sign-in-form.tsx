"use client";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { ArrowLeft, KeyRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client";
import { announceSignedIn } from "@/film/mini/hosts";
import { AuthTitle } from "./auth-frame";
import { DemoPanel } from "./demo-panel";
import { PasswordInput } from "./password-field";
import { FederatedButtons } from "./federated";

const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

export function SignInForm({ next, initialError = null, mfaTicket = null }: { next: string | null; initialError?: string | null; mfaTicket?: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [step, setStep] = useState<"password" | "totp">(mfaTicket ? "totp" : "password");
  const [busy, setBusy] = useState<"form" | "passkey" | null>(null);
  const [error, setError] = useState(initialError ?? "");
  const [ssoRequired, setSsoRequired] = useState(false);
  const [passkeyOk, setPasskeyOk] = useState(true);
  const totpRef = useRef<HTMLInputElement>(null);

  // Full navigation, so the app's server layout renders with the new session cookie.
  const done = () => announceSignedIn(() => window.location.assign(next ?? "/app"));

  useEffect(() => { setPasskeyOk(browserSupportsWebAuthn()); }, []);
  useEffect(() => { if (step === "totp") totpRef.current?.focus(); }, [step]);
  useEffect(() => { window.dispatchEvent(new CustomEvent("aegis:auth-busy", { detail: busy !== null })); }, [busy]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("form"); setError(""); setSsoRequired(false);
    try {
      if (mfaTicket) { await api("/auth/sso/mfa", { body: { ticket: mfaTicket, code: totp } }); done(); return; }
      await api("/auth/signin", { body: { email, password, ...(step === "totp" ? { totp } : {}) } });
      done();
    } catch (err) {
      setBusy(null);
      if (err instanceof ApiError && err.code === "mfa_required") { setStep("totp"); return; }
      if (err instanceof ApiError && err.code === "invalid_mfa") setTotp("");
      if (err instanceof ApiError && err.code === "sso_required") setSsoRequired(true);
      setError(messageOf(err));
    }
  };

  const passkey = async () => {
    setBusy("passkey"); setError("");
    try {
      const { options, challengeId } = await api<{ options: Parameters<typeof startAuthentication>[0]["optionsJSON"]; challengeId: string }>("/auth/passkey/signin/begin", { method: "POST" });
      const response = await startAuthentication({ optionsJSON: options });
      await api("/auth/passkey/signin/finish", { body: { challengeId, response } });
      done();
    } catch (err) {
      setBusy(null);
      // The browser reports a cancelled or timed-out prompt as NotAllowedError.
      if (err instanceof Error && err.name === "NotAllowedError") setError("The passkey prompt was closed or timed out. Nothing was signed in.");
      else setError(err instanceof ApiError ? err.message : "That passkey didn't work. Try again, or sign in with your password.");
    }
  };

  const signUpHref = next ? `/sign-up?next=${encodeURIComponent(next)}` : "/sign-up";

  const input = `${inputClass} !h-12 !rounded-xl !px-4 !text-base`;
  const pill = "!h-12 w-full !rounded-full !text-[15px]";
  return (
    <div className="min-w-0">
      {step === "password" ? (
        <>
          <AuthTitle title="Sign in"><p>Welcome back.</p></AuthTitle>
          <form onSubmit={submit} className="space-y-4" aria-busy={busy === "form"}>
            <Field label="Email"><input type="email" name="email" required autoComplete="username webauthn" spellCheck={false} value={email} onChange={e => setEmail(e.target.value)} className={input} /></Field>
            <Field label="Password"><PasswordInput name="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className={input} /></Field>
            {error && <p role="alert" className="text-sm font-medium text-danger">{error}{ssoRequired && <> <a className="underline underline-offset-2" href={`/api/v1/auth/sso/start?email=${encodeURIComponent(email)}${next ? `&next=${encodeURIComponent(next)}` : ""}`}>Continue with single sign-on</a>.</>}</p>}
            <Button type="submit" variant="primary" className={pill} loading={busy === "form"} disabled={busy !== null}>Sign in</Button>
          </form>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
            <Link href="/forgot-password" className="font-medium text-accent hover:underline">Forgot your password?</Link>
            {passkeyOk && <button type="button" onClick={passkey} disabled={busy !== null} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline disabled:opacity-50"><KeyRound className="size-4" aria-hidden />{busy === "passkey" ? "Waiting for passkey…" : "Sign in with a passkey"}</button>}
          </div>
          <FederatedButtons next={next} email={email} />
          <DemoPanel onSignedIn={done} />
          <p className="mt-6 text-center text-sm text-muted">New here? <Link href={signUpHref} className="font-medium text-accent hover:underline">Create an account</Link></p>
        </>
      ) : (
        <>
          <AuthTitle title="Enter your code"><p>Enter the 6-digit code from your authenticator app{email ? ` for ${email}` : ""}.</p></AuthTitle>
          <form onSubmit={submit} className="space-y-4" aria-busy={busy === "form"}>
            <Field label="Authentication code" hint="Lost your device? Enter one of your recovery codes instead.">
              <input ref={totpRef} type="text" name="totp" required autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} pattern="[0-9]{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5}" maxLength={17} title="6 digits, or a recovery code" value={totp} onChange={e => setTotp(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))} className={`${input} text-center font-mono tracking-[0.3em]`} />
            </Field>
            {error && <p role="alert" className="text-sm font-medium text-danger">{error}</p>}
            <Button type="submit" variant="primary" className={pill} loading={busy === "form"} disabled={busy !== null}>Verify and sign in</Button>
            {mfaTicket
              ? <Link href="/sign-in" className="flex h-10 w-full items-center justify-center gap-2 rounded-full text-sm font-medium hover:bg-surface-2"><ArrowLeft className="size-4" aria-hidden />Back</Link>
              : <Button type="button" variant="ghost" icon={ArrowLeft} className="w-full !rounded-full" onClick={() => { setStep("password"); setTotp(""); setError(""); }}>Back</Button>}
          </form>
        </>
      )}
    </div>
  );
}
