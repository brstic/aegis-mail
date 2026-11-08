"use client";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Apple, ArrowRight, CheckCircle2, Download, KeyRound, Server } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { LimitBanner, linkClass, Page, PageSkeleton } from "@/components/settings/common";
import { Banner, Button, Card, Field, inputClass } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/client";

interface ServerSuggestion { host: string; port: number; security: "tls" | "starttls" }
interface Suggestion { confirmed: boolean; useOAuth?: "gmail" | "microsoft"; unsupported?: boolean; provider?: string; imap?: ServerSuggestion; smtp?: ServerSuggestion; usernames?: string[]; guidance: string }

const ICLOUD_IMAP: ServerSuggestion = { host: "imap.mail.me.com", port: 993, security: "tls" };
const ICLOUD_SMTP: ServerSuggestion = { host: "smtp.mail.me.com", port: 587, security: "starttls" };

function IcloudSteps() {
  return (
    <Card title={<span className="flex items-center gap-2"><Apple className="size-4" aria-hidden />Before you start with iCloud</span>}>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>Open <span className="font-medium">account.apple.com</span> and sign in.</li>
        <li>Go to Sign-In and Security, then App-Specific Passwords, and create one. Apple asks you to turn on two-factor authentication first if it's off.</li>
        <li>Paste that password below, with your iCloud address. We fill in everything else.</li>
      </ol>
      <details className="group mt-3 border-t border-line pt-3 text-[13px] text-muted">
        <summary className="cursor-pointer list-none font-medium hover:text-ink [&::-webkit-details-marker]:hidden">Details</summary>
        <ul className="mt-2 space-y-1">
          <li>Server settings: IMAP imap.mail.me.com, port 993, TLS. SMTP smtp.mail.me.com, port 587, STARTTLS.</li>
          <li>Username: usually the part of your iCloud address before the @. If that's refused we also try your full address.</li>
          <li>Sign in with Apple doesn't give access to iCloud Mail, so there's no button for it.</li>
          <li>To disconnect later, delete that app-specific password at account.apple.com.</li>
        </ul>
      </details>
    </Card>
  );
}

function Pop3Limits() {
  return (
    <Card title={<span className="flex items-center gap-2"><Download className="size-4" aria-hidden />What POP3 can't do</span>} description="Read this before connecting. If your provider offers IMAP, use that instead.">
      <ul className="list-disc space-y-1 pl-5 text-[13px]">
        <li>No folders or labels. Mail is imported into one place.</li>
        <li>No search on your mail server, and read status doesn't sync.</li>
        <li>No sending from this connection.</li>
        <li>Changes you make here don't reach your mail server.</li>
        <li>New mail is checked about every 15 minutes.</li>
      </ul>
    </Card>
  );
}

const TROUBLE: Record<string, { title: string; body: (ctx: { icloud: boolean; pop3: boolean }) => React.ReactNode }> = {
  auth_failed: { title: "The server rejected your username or password", body: ({ icloud }) => (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      <li><strong className="font-semibold">Most often: you need an app password, not your regular password.</strong> Providers with two-factor sign-in reject your account password here, even when it's correct. {icloud ? "For iCloud, generate an app-specific password at account.apple.com under Sign-In and Security." : "Look for app passwords in your provider's security settings."}</li>
      <li>Check the username. Some servers want the full address, others only the part before the @.</li>
      <li>Check that IMAP or POP access is turned on in your provider's settings.</li>
    </ul>
  ) },
  tls_failed: { title: "We couldn't make a secure connection", body: () => (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      <li>Match the port to the security type: usually 993 with TLS for IMAP, 995 with TLS for POP3, and 587 with STARTTLS for SMTP.</li>
      <li>The server's certificate may have expired or may not match its name. We won't connect without a valid certificate, because your password would be at risk. Your provider has to fix this.</li>
    </ul>
  ) },
  host_blocked: { title: "That server address isn't allowed", body: () => (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      <li>We don't connect to private or internal network addresses, or to unusual ports. Use the server's public name.</li>
      <li>Allowed ports are 143 and 993 for IMAP, 110 and 995 for POP3, and 25, 465, 587 and 2525 for SMTP.</li>
    </ul>
  ) },
  host_unreachable: { title: "We couldn't reach that server", body: () => (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      <li>Check the server name for typos.</li>
      <li>Check the port. The server may be down, or its firewall may be blocking connections from outside your network.</li>
    </ul>
  ) },
  timeout: { title: "The server took too long to respond", body: () => (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      <li>Try again in a few minutes. The server may be busy.</li>
      <li>If it keeps happening, check the port. A wrong port often just waits and never answers.</li>
    </ul>
  ) },
  protocol_error: { title: "The server sent a response we couldn't understand", body: ({ pop3 }) => (
    <ul className="mt-1 list-disc space-y-1 pl-5">
      <li>Check that this server and port are for {pop3 ? "POP3" : "IMAP"}. Pointing at the wrong kind of server is the usual cause.</li>
      <li>Check whether the security type should be TLS or STARTTLS for this port.</li>
    </ul>
  ) },
};

function Trouble({ error, icloud, pop3 }: { error: ApiError; icloud: boolean; pop3: boolean }) {
  if (error.code === "limit_reached") return <LimitBanner message={error.message} />;
  const t = TROUBLE[error.code];
  return (
    <div role="alert" data-testid="connect-trouble" data-code={error.code} className="rounded-lg border border-danger/30 bg-danger-soft p-3 text-[13px]">
      <p className="flex items-center gap-2 font-semibold text-danger"><AlertTriangle className="size-4 shrink-0" aria-hidden />{t?.title ?? "We couldn't connect with those settings"}</p>
      {t ? t.body({ icloud, pop3 }) : <p className="mt-1">{error.message}</p>}
      <p className="mt-2 text-muted">Nothing was saved. We only store your password after a connection works.</p>
    </div>
  );
}

function Manual() {
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const provider = sp.get("provider");
  const isIcloudFlow = provider === "icloud", pop3 = provider === "pop3";
  const config = useApi<{ googleConfigured: boolean; microsoftConfigured: boolean }>(["public-config"], "/public/config", { staleTime: 300_000 });
  const [email, setEmail] = useState(sp.get("email") ?? "");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [checking, setChecking] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [security, setSecurity] = useState<"tls" | "starttls">("tls");
  const [wantsSend, setWantsSend] = useState(true);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpSecurity, setSmtpSecurity] = useState<"tls" | "starttls">("starttls");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const applySettings = (s: Suggestion, address: string) => {
    const imap = isIcloudFlow ? ICLOUD_IMAP : pop3 ? null : s.imap;
    const smtp = isIcloudFlow ? ICLOUD_SMTP : s.smtp;
    if (imap) { setHost(imap.host); setPort(String(imap.port)); setSecurity(imap.security); }
    else if (pop3) { setHost(s.imap ? s.imap.host.replace(/^imap\./, "pop.") : ""); setPort("995"); setSecurity("tls"); }
    if (smtp) { setSmtpHost(smtp.host); setSmtpPort(String(smtp.port)); setSmtpSecurity(smtp.security); }
    setUsername(s.usernames?.[0] ?? address);
    setDisplayName(d => d || address);
    setReviewed(false); setFailure(null);
  };

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault();
    const address = email.trim();
    if (!address) return;
    setChecking(true); setLookupError(null); setShowForm(false); setSuggestion(null);
    try {
      const s = await api<Suggestion>("/accounts/discover", { body: { email: address } });
      if (s.useOAuth) {
        setSuggestion(s);
        const configured = s.useOAuth === "gmail" ? config.data?.googleConfigured : config.data?.microsoftConfigured;
        if (configured) window.location.href = `/api/v1/oauth/${s.useOAuth}/start?loginHint=${encodeURIComponent(address)}`;
        return;
      }
      setSuggestion(s);
      if (!s.unsupported) { applySettings(s, address); setShowForm(true); }
    } catch (err) { setLookupError(err instanceof ApiError ? err.message : "That address couldn't be checked."); }
    finally { setChecking(false); }
  };
  // Arriving from a reconnect link: the address is already known.
  useEffect(() => { if (sp.get("email") && config.data) void lookup(); }, [config.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setFailure(null);
    try {
      const send = !pop3 && wantsSend && !!smtpHost.trim();
      await api("/accounts/imap", { body: {
        displayName: displayName.trim() || email.trim(), email: email.trim(), username: username.trim(), password,
        imapHost: host.trim(), imapPort: Number(port), imapSecurity: security,
        ...(send ? { smtpHost: smtpHost.trim(), smtpPort: Number(smtpPort), smtpSecurity } : {}),
        readOnly: pop3 ? true : !wantsSend, kind: pop3 ? "pop3" : "imap",
      } });
      setPassword("");
      await qc.invalidateQueries({ queryKey: ["accounts"] });
      router.push("/app/settings/accounts");
    } catch (err) {
      setFailure(err instanceof ApiError ? err : new ApiError(0, "unknown", "We couldn't connect with those settings."));
      setPassword("");
    } finally { setBusy(false); }
  };

  const icloud = isIcloudFlow || suggestion?.provider === "icloud";
  const title = isIcloudFlow ? "Connect iCloud Mail" : pop3 ? "Import from POP3" : "Connect other email";
  const Icon = isIcloudFlow ? Apple : pop3 ? Download : Server;
  const passwordLabel = icloud ? "App-specific password" : "App password or mailbox password";
  const oauthName = suggestion?.useOAuth === "gmail" ? "Google" : "Microsoft";
  const ready = email.trim() && username.trim() && password && host.trim() && reviewed;
  return (
    <Page width="4xl" title={title} description="Your password is tested first and only stored if the connection works. We encrypt it and can't show it again." back={{ href: "/app/connect", label: "All connection options" }}>
      <div className="space-y-4">
        {isIcloudFlow && <IcloudSteps />}
        {pop3 && <Pop3Limits />}
        <Card title={<span className="flex items-center gap-2"><Icon className="size-4" aria-hidden />Your email address</span>}>
          <form onSubmit={lookup} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-56"><Field label="Email address"><input type="email" required autoComplete="email" className={inputClass} value={email} onChange={e => setEmail(e.target.value)} /></Field></div>
            <Button type="submit" icon={ArrowRight} loading={checking} disabled={!email.trim()}>Continue</Button>
          </form>
          {lookupError && <div className="mt-3"><Banner tone="danger">{lookupError}</Banner></div>}
          {suggestion?.unsupported && <div className="mt-3" data-testid="unsupported"><Banner tone="warn" icon={AlertTriangle}><strong className="font-semibold">This provider isn't supported.</strong> {suggestion.guidance}</Banner></div>}
          {suggestion?.useOAuth && (
            <div className="mt-3" data-testid="use-oauth">
              {(suggestion.useOAuth === "gmail" ? config.data?.googleConfigured : config.data?.microsoftConfigured)
                ? <Banner tone="info">This address connects by signing in with {oauthName}, not a password. Taking you there now.</Banner>
                : <Banner tone="neutral">This address has to connect by signing in with {oauthName}, and {oauthName} connections aren't configured on this deployment. Passwords aren't accepted for it. <Link href="/app/connect" className="font-semibold underline underline-offset-2">See other options</Link></Banner>}
            </div>
          )}
          {showForm && suggestion && !isIcloudFlow && !pop3 && <p className="mt-3 text-[13px] text-muted">{suggestion.guidance}</p>}
          {showForm && pop3 && <p className="mt-3 text-[13px] text-muted">We don't know this provider's POP3 server for certain. Check the name below against its help pages.</p>}
        </Card>
        {showForm && (
          <form onSubmit={connect} className="space-y-4">
            <Card title="Sign-in" description={icloud ? undefined : "Providers with two-factor sign-in need an app password, made in their security settings."}>
              <div className="space-y-3">
                <Field label="Name in the sidebar"><input className={inputClass} value={displayName} maxLength={100} onChange={e => setDisplayName(e.target.value)} /></Field>
                <Field label="Username" hint={suggestion?.usernames && suggestion.usernames.length > 1 ? `Usually ${suggestion.usernames[0]}. If refused, ${suggestion.usernames[1]}.` : undefined}><input required autoComplete="username" spellCheck={false} autoCapitalize="off" className={inputClass} value={username} onChange={e => setUsername(e.target.value)} /></Field>
                <Field label={passwordLabel} hint={icloud ? "Generated at account.apple.com. Your Apple Account password won't work." : undefined}><input type="password" required autoComplete="off" className={inputClass} value={password} onChange={e => setPassword(e.target.value)} /></Field>
              </div>
            </Card>
            <Card title="Confirm your server settings" description={suggestion?.confirmed || isIcloudFlow ? "From our built-in list. Check them against your provider if anything looks wrong." : "These are a guess from your address. Check them with your provider."}>
              <div className="space-y-3">
                <fieldset className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
                  <legend className="sr-only">Incoming server</legend>
                  <Field label={pop3 ? "POP3 server" : "IMAP server"}><input required spellCheck={false} autoCapitalize="off" className={inputClass} value={host} onChange={e => setHost(e.target.value)} /></Field>
                  <Field label="Port"><input required inputMode="numeric" className={inputClass} value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ""))} /></Field>
                  <Field label="Security"><select className={inputClass} value={security} onChange={e => setSecurity(e.target.value as "tls" | "starttls")}><option value="tls">TLS</option><option value="starttls">STARTTLS</option></select></Field>
                </fieldset>
                {!pop3 && (
                  <>
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={wantsSend} onChange={e => setWantsSend(e.target.checked)} /><span>Send mail from this account<span className="block text-[13px] text-muted">Turn this off to connect read-only. Changes here then won't reach your mailbox.</span></span></label>
                    {wantsSend && (
                      <fieldset className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem]">
                        <legend className="sr-only">Outgoing server</legend>
                        <Field label="SMTP server"><input spellCheck={false} autoCapitalize="off" className={inputClass} value={smtpHost} onChange={e => setSmtpHost(e.target.value)} /></Field>
                        <Field label="Port"><input inputMode="numeric" className={inputClass} value={smtpPort} onChange={e => setSmtpPort(e.target.value.replace(/\D/g, ""))} /></Field>
                        <Field label="Security"><select className={inputClass} value={smtpSecurity} onChange={e => setSmtpSecurity(e.target.value as "tls" | "starttls")}><option value="starttls">STARTTLS</option><option value="tls">TLS</option></select></Field>
                      </fieldset>
                    )}
                  </>
                )}
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /><span>I've checked these settings. My password will be sent to the server named above.</span></label>
              </div>
            </Card>
            {failure && <Trouble error={failure} icloud={icloud} pop3={pop3} />}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!ready}>Test and connect</Button>
              <span className="flex items-center gap-1.5 text-[13px] text-muted"><CheckCircle2 className="size-3.5" aria-hidden />We start with the last 30 days of mail.</span>
            </div>
          </form>
        )}
      </div>
    </Page>
  );
}

export default function ManualPage() { return <Suspense fallback={<div className="p-6"><PageSkeleton /></div>}><Manual /></Suspense>; }
