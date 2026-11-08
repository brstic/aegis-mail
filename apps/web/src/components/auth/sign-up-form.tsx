"use client";
import { ArrowLeft, ArrowRight, Building2, Check, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from "react";
import { Logo } from "@/components/marketing/logo";
import { api, ApiError } from "@/lib/client";
import { FederatedButtons } from "./federated";
import { ThemeToggle } from "@/components/theme-toggle";

type Kind = "personal" | "organization";
type Step = "email" | "password" | "name";
const STEPS: Step[] = ["email", "password", "name"];

const big = "h-14 w-full rounded-2xl border border-line-strong bg-surface px-5 text-lg text-ink outline-none transition-shadow placeholder:text-faint focus:border-ink/35 focus:ring-4 focus:ring-ink/[0.04]";
const next = "inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-[15px] font-medium text-on-accent transition-opacity disabled:opacity-40";

function initials(name: string, email: string) {
  const n = name.trim().split(/\s+/).filter(Boolean).map(w => w[0]!.toUpperCase());
  return (n.length ? n.slice(0, 2).join("") : email[0]?.toUpperCase()) || "?";
}

/** 0..1, from length and variety. Only guidance: the server's rule is 12 characters. */
function strength(p: string) {
  if (!p) return 0;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/, /\s/].filter(r => r.test(p)).length;
  return Math.min(1, p.length / 20 * 0.8 + kinds * 0.05);
}

/** A preview of the inbox you're making. It fills in as you type, and leans towards the pointer. */
function Preview({ name, email, kind, team, step, done }: { name: string; email: string; kind: Kind; team: string; step: number; done: boolean }) {
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setTilt({ x: ((e.clientY - r.top) / r.height - 0.5) * -8, y: ((e.clientX - r.left) / r.width - 0.5) * 10 });
  };
  const rows = [
    { from: "Priya Shah", subject: "Signed statement of work", w: "72%" },
    { from: "Jordan Blake", subject: "Client call moved to 3pm", w: "58%" },
    { from: "Dad", subject: "Dinner Sunday?", w: "40%" },
  ];
  return (
    <div className="hidden select-none lg:block" onPointerMove={onMove} onPointerLeave={() => setTilt({ x: 0, y: 0 })} aria-hidden="true">
      <div className="signup-card mx-auto w-[400px] rounded-[28px] bg-surface p-5 text-ink shadow-[0_40px_80px_-30px_rgba(0,40,120,.35)] ring-1 ring-line" style={{ transform: `perspective(1200px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` } as CSSProperties}>
        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-accent text-[15px] font-semibold text-on-accent transition-transform" style={{ transform: `scale(${name || email ? 1 : 0.85})` }}>{initials(name, email)}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold">{name || (kind === "organization" && team) || "Your inbox"}</p>
            <p className="truncate text-[13px] text-muted">{email || "you@example.com"}</p>
          </div>
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-all duration-500 ${done ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted"}`}>
            <ShieldCheck className="size-3.5" />{done ? "AI protection on" : "Setting up"}
          </span>
        </div>
        {kind === "organization" && step >= 2 && <p className="mt-3 inline-flex rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-muted">{team || "Your team"} · you manage security</p>}
        <div className="mt-4 space-y-1">
          {rows.map((r, i) => (
            <div key={r.from} className="signup-row flex items-center gap-3 rounded-xl px-2 py-2.5" style={{ transitionDelay: `${i * 80}ms` }}>
              <span className={`size-8 shrink-0 rounded-full transition-colors duration-500 ${step > i ? "bg-line-strong" : "bg-surface-2"}`} />
              <div className="min-w-0 flex-1">
                {step > i ? <p className="signup-step truncate text-[13px] font-semibold">{r.from}</p> : <div className="h-3 w-24 rounded-full bg-surface-2" />}
                <div className="mt-1 h-2 rounded-full bg-surface-2" style={{ width: r.w }} />
              </div>
            </div>
          ))}
          <div className="signup-row flex items-center gap-3 rounded-xl bg-danger-soft px-2 py-2.5" style={{ opacity: done ? 1 : 0, transform: done ? "none" : "translateY(6px)" }}>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-danger"><ShieldCheck className="size-4" /></span>
            <p className="text-[13px] text-muted"><span className="font-semibold text-danger">Phishing stopped.</span> It never reached you.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Sign-up, one question at a time: email, a password, your name, and who it's for. A preview of your inbox builds beside it as you
 * answer. Nothing about mailboxes yet: you connect those next.
 */
export function SignUpForm({ next: nextPath }: { next: string | null }) {
  const [step, setStep] = useState<Step>("email");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [kind, setKind] = useState<Kind>("personal");
  const [team, setTeam] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [emailTaken, setEmailTaken] = useState(false);
  const [ssoRequired, setSsoRequired] = useState(false);
  const [byInvitation, setByInvitation] = useState(false);
  useEffect(() => {
    fetch("/api/v1/public/config").then(r => r.ok ? r.json() : null).then(c => setByInvitation(c?.signup === "invite"), () => {});
  }, []);
  const field = useRef<HTMLInputElement>(null);
  const idx = STEPS.indexOf(step);
  useEffect(() => { field.current?.focus(); }, [step]);
  const s = strength(password);
  const okPassword = password.length >= 12;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const go = (to: Step) => { setError(""); setStep(to); };
  const advance = (e: FormEvent) => {
    e.preventDefault();
    if (step === "email") { if (!emailOk) { setError("Enter an email address like name@example.com."); return; } go("password"); }
    else if (step === "password") { if (!okPassword) { setError("Use at least 12 characters."); return; } go("name"); }
    else { if (!name.trim()) { setError("Tell us what to call you."); return; } void create(); }
  };

  const create = async () => {
    setBusy(true); setError(""); setEmailTaken(false); setSsoRequired(false);
    const trimmedTeam = team.trim();
    try {
      await api("/auth/signup", { body: { email: email.trim(), password, name: name.trim(), workspaceKind: kind, ...(kind === "organization" && trimmedTeam ? { workspaceName: trimmedTeam } : {}) } });
      setDone(true);
      window.setTimeout(() => window.location.assign(nextPath ?? "/app/onboarding"), 900);
    } catch (err) {
      setBusy(false);
      const taken = err instanceof ApiError && err.code === "email_taken";
      setEmailTaken(taken);
      setSsoRequired(err instanceof ApiError && err.code === "sso_required");
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      if (taken || (err instanceof ApiError && err.code === "signup_closed")) setStep("email");
    }
  };

  const signInHref = nextPath ? `/sign-in?next=${encodeURIComponent(nextPath)}` : "/sign-in";
  const Q: Record<Step, { title: string; sub?: string }> = {
    email: { title: "Let's set up your inbox.", sub: "Start with the email you'll sign in with." },
    password: { title: "Choose a password.", sub: "At least 12 characters. A short sentence is easy to remember." },
    name: { title: "Last one. What's your name?" },
  };

  return (
    <div className="signup-bg relative flex min-h-dvh flex-col overflow-hidden text-[15px]">
      <header className="flex h-16 items-center justify-between px-5 sm:px-10"><Logo /><div className="flex items-center gap-2">{!done && <><p className="text-sm text-muted max-sm:hidden">Have an account? <Link href={signInHref} className="font-medium text-accent hover:underline">Sign in</Link></p><Link href={signInHref} className="text-sm font-medium text-accent sm:hidden">Sign in</Link></>}<ThemeToggle className="text-muted hover:bg-surface-2 hover:text-ink" /></div></header>
      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-16 px-5 py-8 sm:px-10 lg:grid-cols-[minmax(0,1fr)_440px]">
        <div className="mx-auto w-full max-w-[480px] lg:mx-0">
          <div className="mb-10 flex items-center gap-1.5" role="progressbar" aria-label="Sign-up progress" aria-valuemin={1} aria-valuemax={3} aria-valuenow={idx + 1}>
            {STEPS.map((x, i) => <span key={x} className={`h-1.5 rounded-full transition-all duration-500 ${i <= idx ? "w-8 bg-accent" : "w-4 bg-line-strong"}`} />)}
            <span className="ml-2 text-xs text-muted">Step {idx + 1} of 3</span>
          </div>
          {done ? (
            <div className="signup-step" role="status">
              <span className="grid size-16 place-items-center rounded-full bg-accent text-on-accent signup-pop"><Check className="size-8" /></span>
              <h1 className="mt-6 font-display text-[2.5rem] leading-[1.05] font-semibold tracking-tight">You&apos;re in.</h1>
              <p className="mt-3 text-lg text-muted">Next, connect a mailbox.</p>
            </div>
          ) : (
            <form key={step} onSubmit={advance} className="signup-step" aria-busy={busy} noValidate>
              <h1 className="font-display text-[2.25rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-[2.75rem]">{Q[step].title}</h1>
              {Q[step].sub && <p className="mt-3 text-lg text-muted">{Q[step].sub}</p>}
              {step === "email" && byInvitation && <p className="mt-3 text-[15px] text-muted">New accounts on this server are by invitation. Use the address your invitation was sent to.</p>}
              <div className="mt-8">
                {step === "email" && <label className="block"><span className="sr-only">Email</span><input ref={field} type="email" name="email" aria-label="Email" required maxLength={254} autoComplete="email" spellCheck={false} placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} className={big} /></label>}
                {step === "password" && (
                  <div className="flex items-center gap-4">
                    <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
                    <label className="block flex-1"><span className="sr-only">Password</span><span className="relative block"><input ref={field} type={showPw ? "text" : "password"} name="password" aria-label="Password" required minLength={12} maxLength={256} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className={`${big} !pr-20`} /><button type="button" aria-pressed={showPw} onClick={() => setShowPw(v => !v)} className="absolute inset-y-0 right-3 my-auto h-9 rounded-full px-3 text-sm font-medium text-accent hover:bg-surface-2">{showPw ? "Hide" : "Show"}</button></span></label>
                    <span className="relative grid size-14 shrink-0 place-items-center" aria-hidden="true">
                      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--border-strong)" strokeWidth="3" /><circle cx="18" cy="18" r="15" fill="none" stroke={okPassword ? "var(--safe)" : "var(--accent)"} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${s * 94.2} 94.2`} className="transition-all duration-300" /></svg>
                      {okPassword ? <Check className="size-5 text-safe" /> : <span className="text-xs font-semibold text-muted tabular-nums">{password.length}</span>}
                    </span>
                  </div>
                )}
                {step === "password" && <p className="mt-2 text-sm text-muted" aria-live="polite">{okPassword ? (s > 0.85 ? "Strong password." : "Good. Longer is even better.") : `${Math.max(0, 12 - password.length)} more characters.`}</p>}
                {step === "name" && <label className="block"><span className="sr-only">Your name</span><input ref={field} type="text" name="name" aria-label="Name" required maxLength={100} autoComplete="name" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} className={big} /></label>}
                {step === "name" && (
                  <div className="mt-4">
                    <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
                      <Building2 className="size-5 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1"><span className="block font-medium">For a team</span><span className="block text-[13px] text-muted">Invite people later. You manage security for everyone.</span></span>
                      <input type="checkbox" className="peer sr-only" checked={kind === "organization"} onChange={e => setKind(e.target.checked ? "organization" : "personal")} />
                      <span aria-hidden className="relative h-7 w-12 shrink-0 rounded-full bg-line-strong transition-colors peer-checked:bg-accent after:absolute after:top-0.5 after:left-0.5 after:size-6 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
                    </label>
                    {kind === "organization" && <label className="mt-3 block"><span className="mb-1.5 block text-sm font-medium">Team name <span className="font-normal text-muted">(optional)</span></span><input type="text" name="workspaceName" maxLength={100} autoComplete="organization" value={team} onChange={e => setTeam(e.target.value)} className={big} /></label>}
                  </div>
                )}
              </div>
              {error && <p role="alert" className="mt-3 text-sm font-medium text-danger">{error}{emailTaken && <> <Link href={signInHref} className="underline underline-offset-2">Sign in instead</Link>.</>}{ssoRequired && <> <a className="underline underline-offset-2" href={`/api/v1/auth/sso/start?email=${encodeURIComponent(email)}${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ""}`}>Continue with single sign-on</a>.</>}</p>}
              <div className="mt-8 flex items-center gap-3">
                {idx > 0 && <button type="button" onClick={() => go(STEPS[idx - 1]!)} disabled={busy} className="inline-flex h-12 items-center gap-1.5 rounded-full px-4 text-[15px] font-medium text-muted hover:bg-surface-2 hover:text-ink"><ArrowLeft className="size-4" aria-hidden />Back</button>}
                <button type="submit" className={next} disabled={busy}>{step === "name" ? (busy ? "Creating…" : "Create account") : <>Continue<ArrowRight className="size-4" aria-hidden /></>}</button>
                {step !== "name" && <span className="text-xs text-muted max-sm:hidden">or press Enter</span>}
              </div>
              {step === "email" && <div className="mt-6 max-w-sm"><FederatedButtons next={nextPath} verb="Sign up" /></div>}
              {step === "name" && <p className="mt-6 text-[13px] leading-relaxed text-muted">See <Link href="/legal/privacy" className="underline underline-offset-2">how Aegis Mail handles your data</Link>.</p>}
            </form>
          )}
        </div>
        <Preview name={name} email={email} kind={kind} team={team} step={idx + (done ? 1 : 0)} done={done} />
      </main>
    </div>
  );
}
