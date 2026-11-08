"use client";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Copy, KeyRound, LogOut, Plus, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmModal, fmtDateTime, Head, PageSkeleton, useShowMore } from "@/components/settings/common";
import { Banner, Button, Card, Chip, ErrorState, Field, inputClass } from "@/components/ui";
import { api, ApiError, useAction, useApi, useMe, useToast } from "@/lib/client";

/**
 * Adding a way in takes more than this session. People with a password type it. People who sign in through an identity provider have
 * none, so a recent sign-in stands in, and this sends them back through it when theirs has aged out.
 */
function useReauth() {
  const { data: me } = useMe();
  const [password, setPassword] = useState("");
  const usesPassword = !!me?.reauthWithPassword;
  return {
    usesPassword, password, clear: () => setPassword(""), ready: !usesPassword || password.length > 0,
    field: usesPassword ? <Field label="Your password" hint="Needed to add a way to sign in."><input type="password" autoComplete="current-password" className={inputClass} maxLength={256} value={password} onChange={e => setPassword(e.target.value)} /></Field> : null,
    body: usesPassword ? { password } : {},
  };
}

function SignInAgain() {
  const again = async () => { await api("/auth/signout", { method: "POST" }).catch(() => {}); window.location.assign("/sign-in?next=/app/settings/security"); };
  return <div className="mt-2 space-y-2" data-testid="reauth-required"><Banner tone="warn">For safety, this needs a sign-in from the last ten minutes. Sign in again, then come straight back here.</Banner><Button size="sm" icon={LogOut} onClick={again}>Sign out and sign in again</Button></div>;
}

function Sessions() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<{ id: string; device: string; createdAt: string; lastSeenAt: string; current: boolean }[]>(["sessions"], "/auth/sessions");
  const revoke = useAction<string>(id => api(`/auth/sessions/${id}`, { method: "DELETE" }), { refresh: false, success: "Session revoked.", onDone: () => void qc.invalidateQueries({ queryKey: ["sessions"] }) });
  const others = data?.filter(x => !x.current) ?? [];
  // This device first, then the most recently active. A long list stays short until you ask for the rest.
  const sorted = data ? [...data].sort((a, b) => Number(b.current) - Number(a.current) || new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime()) : undefined;
  const list = useShowMore(sorted, 5);
  const revokeOthers = useAction<void>(async () => { for (const o of others) await api(`/auth/sessions/${o.id}`, { method: "DELETE" }); }, { refresh: false, success: "Signed out everywhere else.", onDone: () => void qc.invalidateQueries({ queryKey: ["sessions"] }) });
  return (
    <Card title="Signed-in devices" description="Where you're signed in right now." action={others.length > 1 ? <Button size="sm" icon={LogOut} loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out everywhere else</Button> : undefined}>
      {isLoading ? <PageSkeleton blocks={1} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? <p className="text-sm text-muted">No active sessions.</p> : (
        <>
        <ul className="divide-y divide-line">
          {list.visible.map(s => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid="session-row">
              <div className="min-w-0 text-sm"><p className="flex flex-wrap items-center gap-2 font-medium">{s.device}{s.current && <Chip tone="accent">This device</Chip>}</p><p className="text-[13px] text-muted">Last active {fmtDateTime(s.lastSeenAt)}, signed in {fmtDateTime(s.createdAt)}</p></div>
              {!s.current && <Button size="sm" icon={LogOut} disabled={revoke.isPending} onClick={() => revoke.mutate(s.id)} aria-label={`Revoke session on ${s.device}, last active ${fmtDateTime(s.lastSeenAt)}`}>Revoke</Button>}
            </li>
          ))}
        </ul>
        {list.more && <div className="mt-1">{list.more}</div>}
        </>
      )}
    </Card>
  );
}

const SECOND_FACTOR = /^(\d{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5}-[A-Za-z2-7]{5})$/;

function Totp() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: me, isLoading } = useMe();
  const [enroll, setEnroll] = useState<{ secret: string; uri: string } | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [code, setCode] = useState("");
  const [current, setCurrent] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const reauth = useReauth();
  const [confirmStart, setConfirmStart] = useState(false);
  const begin = useAction<void, { secret: string; uri: string }>(() => api("/auth/totp/begin", { body: { ...reauth.body, ...(me?.mfaEnabled ? { code: current } : {}) } }), { refresh: false, onDone: r => { setEnroll(r); setConfirmReplace(false); setConfirmStart(false); setCurrent(""); reauth.clear(); } });
  const beginProblem = begin.error && (begin.error instanceof ApiError && begin.error.code === "reauth_required" ? <SignInAgain /> : <div className="mt-2"><Banner tone="danger">{begin.error.message}</Banner></div>);
  const off = useAction<void>(() => api("/auth/totp/disable", { body: { code: current } }), { refresh: false, success: "Authenticator app is off.", onDone: () => { setConfirmOff(false); setCurrent(""); void qc.invalidateQueries({ queryKey: ["me"] }); } });
  const currentField = <div className="mt-3 w-56"><Field label="Current code" hint="6 digits from your app, or a recovery code."><input className={inputClass} autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} maxLength={17} value={current} onChange={e => setCurrent(e.target.value.replace(/[^0-9A-Za-z-]/g, ""))} /></Field></div>;
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [confirmReplaceCodes, setConfirmReplaceCodes] = useState(false);
  const codesLeft = useApi<{ remaining: number }>(["recovery-codes"], me?.mfaEnabled ? "/auth/totp/recovery-codes" : null);
  const replaceCodes = useAction<void, { recoveryCodes: string[] }>(() => api("/auth/totp/recovery-codes", { body: { code: current } }), { refresh: false, onDone: r => { setFreshCodes(r.recoveryCodes); setConfirmReplaceCodes(false); setCurrent(""); void qc.invalidateQueries({ queryKey: ["recovery-codes"] }); } });
  const confirm = useAction<void, { recoveryCodes?: string[] }>(() => api("/auth/totp/confirm", { body: { code } }), { refresh: false, success: "Authenticator app is on. Your other devices were signed out, and we've emailed you about it.", onDone: r => { setFreshCodes(r.recoveryCodes ?? null); setEnroll(null); setCode(""); for (const k of ["me", "sessions"]) void qc.invalidateQueries({ queryKey: [k] }); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (/^\d{6}$/.test(code)) confirm.mutate(); };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast({ text: "Copied." }); } catch { toast({ text: "Couldn't copy. Select the text and copy it yourself.", tone: "danger" }); } };
  return (
    <Card title="Authenticator app" description="A 6-digit code from an app on your phone, asked for when you sign in with a password." action={me && (me.mfaEnabled ? <Chip tone="safe"><CheckCircle2 className="size-3" aria-hidden />On</Chip> : <Chip tone="warn">Off</Chip>)}>
      {isLoading ? <PageSkeleton blocks={1} /> : enroll ? (
        <div className="space-y-3" data-testid="totp-enroll">
          <p className="text-sm">Add this account to your authenticator app. QR codes aren't available here, so enter the key by hand or paste the setup link.</p>
          <div>
            <h3 className="text-[13px] font-medium">Setup key</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2"><code data-testid="totp-secret" className="min-w-0 rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-[13px] break-all">{enroll.secret}</code><Button size="sm" icon={Copy} onClick={() => copy(enroll.secret)} aria-label="Copy setup key">Copy</Button></div>
          </div>
          <div>
            <h3 className="text-[13px] font-medium">Setup link</h3>
            <div className="mt-1 flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 basis-60 rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-xs break-all">{enroll.uri}</code><Button size="sm" icon={Copy} onClick={() => copy(enroll.uri)} aria-label="Copy setup link">Copy</Button></div>
          </div>
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
            <div className="w-44"><Field label="6-digit code"><input className={inputClass} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></Field></div>
            <Button type="submit" variant="primary" loading={confirm.isPending} disabled={code.length !== 6}>Turn on</Button>
          </form>
          {confirm.error && <Banner tone="danger">{confirm.error.message}</Banner>}
          <p className="text-xs text-muted">{me?.mfaEnabled ? "Your current app keeps working until you enter a correct code from the new one." : "Until you enter a correct code, signing in doesn't ask for one."}</p>
        </div>
      ) : me?.mfaEnabled ? (
        <div className="space-y-2">
          <p className="text-sm">Signing in with a password asks for a code from your app.</p>
          {freshCodes && (
            <div data-testid="recovery-codes" className="rounded-lg border border-warn/40 bg-warn-soft p-3">
              <h4 className="text-sm font-semibold">Save your recovery codes now</h4>
              <p className="mt-0.5 text-[13px]">Each one works once if you lose your authenticator app. They aren't shown again, and we can't recover them for you.</p>
              <ul className="mt-2 grid gap-x-4 gap-y-0.5 font-mono text-[13px] sm:grid-cols-2">{freshCodes.map(c => <li key={c}>{c}</li>)}</ul>
              <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" onClick={() => void copy(freshCodes.join("\n"))}>Copy all</Button><Button size="sm" variant="primary" onClick={() => setFreshCodes(null)}>I've saved them</Button></div>
            </div>
          )}
          {codesLeft.data && <p className="text-[13px] text-muted" data-testid="recovery-left">{codesLeft.data.remaining} recovery {codesLeft.data.remaining === 1 ? "code" : "codes"} left.{codesLeft.data.remaining <= 2 ? " Replace them soon, so you don't get locked out." : ""}</p>}
          <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => setConfirmReplace(true)}>Move to a new app</Button><Button size="sm" onClick={() => setConfirmReplaceCodes(true)}>Replace recovery codes</Button><Button size="sm" variant="danger" onClick={() => setConfirmOff(true)}>Turn off</Button></div>
        </div>
      ) : (
        <>
          {/* With no password to ask for, there's nothing to confirm first: the server checks the sign-in is recent. */}
          <Button icon={Smartphone} loading={begin.isPending} onClick={() => { if (reauth.usesPassword) setConfirmStart(true); else begin.mutate(); }}>Set up authenticator app</Button>
          {!reauth.usesPassword && beginProblem}
        </>
      )}
      {confirmStart && <ConfirmModal title="Set up an authenticator app?" confirmLabel="Continue" busy={begin.isPending} onConfirm={() => { if (reauth.ready) begin.mutate(); }} onClose={() => setConfirmStart(false)}><p className="mb-3">After this, signing in with a password also needs a code. Your other devices are signed out when it's turned on.</p>{reauth.field}{beginProblem}</ConfirmModal>}
      {confirmReplace && <ConfirmModal title="Move to a new app?" confirmLabel="Continue" busy={begin.isPending} onConfirm={() => { if (SECOND_FACTOR.test(current) && reauth.ready) begin.mutate(); }} onClose={() => setConfirmReplace(false)}><p className="mb-3">Enter a code from your current app. It keeps working until the new one is confirmed.</p>{reauth.field}{currentField}{beginProblem}</ConfirmModal>}
      {confirmReplaceCodes && <ConfirmModal title="Replace your recovery codes?" confirmLabel="Replace" busy={replaceCodes.isPending} onConfirm={() => { if (SECOND_FACTOR.test(current)) replaceCodes.mutate(); }} onClose={() => { setConfirmReplaceCodes(false); setCurrent(""); }}><p>Your old codes stop working straight away.</p>{currentField}{replaceCodes.error && <div className="mt-2"><Banner tone="danger">{replaceCodes.error.message}</Banner></div>}</ConfirmModal>}
      {confirmOff && <ConfirmModal title="Turn off your authenticator app?" danger confirmLabel="Turn off" busy={off.isPending} onConfirm={() => { if (SECOND_FACTOR.test(current)) off.mutate(); }} onClose={() => setConfirmOff(false)}><p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />Signing in will only need your password. Enter a current code to confirm.</p>{currentField}{off.error && <div className="mt-2"><Banner tone="danger">{off.error.message}</Banner></div>}</ConfirmModal>}
    </Card>
  );
}

function Passkeys() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useApi<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }[]>(["passkeys"], "/auth/passkeys");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: me } = useMe();
  const [code, setCode] = useState("");
  const reauth = useReauth();
  const [stale, setStale] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!reauth.ready) { setProblem("Enter your password to add a passkey."); return; }
    setBusy(true); setProblem(null); setStale(false);
    try {
      const { startRegistration, browserSupportsWebAuthn } = await import("@simplewebauthn/browser");
      if (!browserSupportsWebAuthn()) { setProblem("This browser doesn't support passkeys."); return; }
      const { options, challengeId } = await api<{ options: any; challengeId: string }>("/auth/passkey/register/begin", { body: { ...reauth.body, ...(me?.mfaEnabled ? { code: code.trim() } : {}) } });
      const response = await startRegistration({ optionsJSON: options });
      await api("/auth/passkey/register/finish", { body: { challengeId, response, name: name.trim() || undefined } });
      toast({ text: "Passkey added. Your other devices were signed out, and we've emailed you about it." });
      setName(""); reauth.clear();
      for (const k of ["passkeys", "sessions"]) void qc.invalidateQueries({ queryKey: [k] });
    } catch (err) {
      const n = (err as { name?: string; code?: string })?.name, c = (err as { code?: string })?.code;
      if (err instanceof ApiError && err.code === "reauth_required") setStale(true);
      else if (n === "NotAllowedError" || c === "ERROR_CEREMONY_ABORTED") setProblem("The passkey request was cancelled or timed out. Nothing was added.");
      else if (n === "InvalidStateError" || c === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") setProblem("This device already has a passkey for your account.");
      else setProblem(err instanceof ApiError ? err.message : "We couldn't add that passkey.");
    } finally { setBusy(false); }
  };
  return (
    <Card title="Passkeys" description="Sign in with your device's fingerprint, face or screen lock. A passkey can't be phished the way a password can.">
      {isLoading ? <PageSkeleton blocks={1} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? <p className="mb-3 text-sm text-muted">No passkeys yet.</p> : (
        <ul className="mb-3 divide-y divide-line">{data.map(k => <li key={k.id} className="flex items-center gap-2 py-2 text-sm" data-testid="passkey-row"><KeyRound className="size-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0"><span className="block font-medium break-words">{k.name}</span><span className="block text-[13px] text-muted">Added {fmtDateTime(k.createdAt)}{k.lastUsedAt ? `, last used ${fmtDateTime(k.lastUsedAt)}` : ", not used yet"}</span></span><Button size="sm" variant="ghost" className="ml-auto" aria-label={`Remove passkey ${k.name}`} onClick={async () => { try { await api(`/auth/passkeys/${k.id}/remove`, { body: me?.mfaEnabled ? { code: code.trim() } : {} }); toast({ text: "Passkey removed. Also delete it from your device." }); void qc.invalidateQueries({ queryKey: ["passkeys"] }); } catch (err) { setProblem(err instanceof ApiError ? err.message : "We couldn't remove that passkey."); } }}>Remove</Button></li>)}</ul>
      )}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-48"><Field label="Name (optional)" hint="So you can tell your passkeys apart."><input className={inputClass} maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="Work laptop" /></Field></div>
        {reauth.field && <div className="min-w-0 flex-1 basis-48">{reauth.field}</div>}
        {me?.mfaEnabled && <div className="w-44"><Field label="Current 6-digit code" hint="Needed to add or remove a passkey."><input className={inputClass} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></Field></div>}
        <Button type="submit" icon={Plus} loading={busy} className="mb-5">Add a passkey</Button>
      </form>
      {problem && <div className="mt-2"><Banner tone="warn">{problem}</Banner></div>}
      {stale && <SignInAgain />}
    </Card>
  );
}

export default function SecuritySettingsPage() {
  return (
    <>
      <Head title="Sign-in and security" description="How you sign in, and the devices that are signed in." />
      <div className="space-y-4"><Sessions /><Totp /><Passkeys /></div>
    </>
  );
}
