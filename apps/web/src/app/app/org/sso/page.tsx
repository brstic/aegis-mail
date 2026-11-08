"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Lock, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Details, fmtDate, Head, PageSkeleton, ROLE_LABEL } from "@/components/settings/common";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Field, inputClass, Toggle } from "@/components/ui";
import { api, useAction, useApi, useMe, useToast } from "@/lib/client";

interface Config { id: string; domain: string; protocol: "oidc" | "saml"; issuer: string; clientId: string | null; samlEntryPoint: string | null; enabled: boolean; enforced: boolean; jitEnabled: boolean; jitRole: string; lastSuccessAt: string | null }
interface Overview { organization: boolean; domains: string[]; configs: Config[]; callbackUrl: string; samlBaseUrl: string; scim: { baseUrl: string; token: { createdAt: string; lastUsedAt: string | null } | null; managed: number } }

const JIT_ROLES = ["member", "workspace_manager", "security_admin"];

function ConfigForm({ domain, existing, samlBaseUrl, onDone }: { domain: string; existing?: Config; samlBaseUrl: string; onDone: () => void }) {
  const [protocol, setProtocol] = useState<"oidc" | "saml">(existing?.protocol ?? "oidc");
  const [issuer, setIssuer] = useState(existing?.issuer ?? "");
  const [clientId, setClientId] = useState(existing?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [entryPoint, setEntryPoint] = useState(existing?.samlEntryPoint ?? "");
  const [cert, setCert] = useState("");
  const [jit, setJit] = useState(existing?.jitEnabled ?? true);
  const [role, setRole] = useState(existing?.jitRole ?? "member");
  const hasSecret = existing?.protocol === "oidc";
  const save = useAction<void>(() => protocol === "oidc"
    ? api("/org/sso", { body: { domain, issuer: issuer.trim(), clientId: clientId.trim(), ...(secret ? { clientSecret: secret } : {}), jitEnabled: jit, jitRole: role } })
    : api("/org/sso/saml", { body: { domain, idpEntityId: issuer.trim(), entryPoint: entryPoint.trim(), idpCert: cert, jitEnabled: jit, jitRole: role } }), { refresh: false, success: `Saved single sign-on for ${domain}.`, onDone: () => { setSecret(""); setCert(""); onDone(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };
  return (
    <form onSubmit={submit} className="space-y-3" data-testid="sso-form">
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium">Protocol</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {(["oidc", "saml"] as const).map(v => <label key={v} className="inline-flex min-h-6 items-center gap-2"><input type="radio" name={`protocol-${domain}`} value={v} checked={protocol === v} onChange={() => setProtocol(v)} className="size-4 accent-[var(--accent)]" />{v === "oidc" ? "OpenID Connect" : "SAML 2.0"}</label>)}
        </div>
      </fieldset>
      {protocol === "oidc" ? (
        <>
          <Field label="Issuer URL" hint="Exactly as your provider gives it. We read its OpenID Connect discovery document when you save."><input type="url" required className={inputClass} value={issuer} onChange={e => setIssuer(e.target.value)} spellCheck={false} autoCapitalize="off" placeholder="https://login.example.com" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client ID"><input required className={inputClass} value={clientId} onChange={e => setClientId(e.target.value)} spellCheck={false} autoCapitalize="off" autoComplete="off" /></Field>
            <Field label="Client secret" hint={hasSecret ? "Leave empty to keep the current one. It can't be shown again." : "Stored encrypted. It can't be shown again."}><input type="password" required={!hasSecret} className={inputClass} value={secret} onChange={e => setSecret(e.target.value)} autoComplete="new-password" /></Field>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1 rounded-lg bg-surface-2 p-2.5 text-[13px]" data-testid="saml-sp">
            <p className="text-muted">Give your provider these values</p>
            <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_1fr]">
              <dt className="text-muted">ACS URL</dt><dd className="font-mono text-xs break-all">{samlBaseUrl}/{domain}/acs</dd>
              <dt className="text-muted">Entity ID</dt><dd className="font-mono text-xs break-all">{samlBaseUrl}/{domain}</dd>
            </dl>
            <p className="text-muted">Sign the assertion. Send the email address as the NameID, and add an attribute named <code className="font-mono text-xs">email_verified</code> with the value <code className="font-mono text-xs">true</code>. Sign-in has to start here, not from your provider&apos;s app page.</p>
          </div>
          <Field label="Provider entity ID"><input required className={inputClass} value={issuer} onChange={e => setIssuer(e.target.value)} spellCheck={false} autoCapitalize="off" /></Field>
          <Field label="Provider sign-in URL"><input type="url" required className={inputClass} value={entryPoint} onChange={e => setEntryPoint(e.target.value)} spellCheck={false} autoCapitalize="off" placeholder="https://login.example.com/sso/saml" /></Field>
          <Field label="Provider signing certificate" hint="PEM format. You'll need to paste it again whenever you edit this."><textarea required rows={5} className={`${inputClass} !h-auto py-2 font-mono text-xs`} value={cert} onChange={e => setCert(e.target.value)} spellCheck={false} /></Field>
        </>
      )}
      <Toggle label="Add people automatically on first sign-in" checked={jit} onChange={setJit} description="Anyone your provider signs in with this domain joins this workspace. With this off, add people by invitation or SCIM first." />
      {jit && <div className="max-w-xs"><Field label="Role for people added this way"><select className={inputClass} value={role} onChange={e => setRole(e.target.value)}>{JIT_ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r] ?? r}</option>)}</select></Field></div>}
      {save.error && <Banner tone="danger">{save.error.message}</Banner>}
      <Button type="submit" variant="primary" icon={ShieldCheck} loading={save.isPending}>Save</Button>
    </form>
  );
}

function ConfigRow({ c, email, samlBaseUrl, onDone }: { c: Config; email?: string; samlBaseUrl: string; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const enforce = useAction<boolean>(enforced => api(`/org/sso/${c.id}/enforce`, { body: { enforced } }), { refresh: false, success: v => "Saved.", onDone });
  const remove = useAction<void>(() => api(`/org/sso/${c.id}`, { method: "DELETE" }), { refresh: false, success: "Single sign-on removed.", onDone });
  const sameDomain = email?.toLowerCase().endsWith(`@${c.domain}`);
  return (
    <li className="space-y-3 border-b border-line p-3 last:border-b-0" data-testid="sso-config">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-all">{c.domain}</span>
        {c.lastSuccessAt ? <Chip tone="safe">Last sign-in worked {fmtDate(c.lastSuccessAt)}</Chip> : <Chip tone="warn">Not tested yet</Chip>}
        {c.enforced && <Chip tone="accent">Required</Chip>}
      </div>
      <dl className="grid gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">Protocol</dt><dd>{c.protocol === "saml" ? "SAML 2.0" : "OpenID Connect"}</dd>
        <dt className="text-muted">{c.protocol === "saml" ? "Entity ID" : "Issuer"}</dt><dd className="break-all">{c.issuer}</dd>
        {c.protocol === "oidc" ? <><dt className="text-muted">Client ID</dt><dd className="break-all">{c.clientId}</dd></> : <><dt className="text-muted">Sign-in URL</dt><dd className="break-all">{c.samlEntryPoint}</dd><dt className="text-muted">ACS URL</dt><dd className="font-mono text-xs break-all">{samlBaseUrl}/{c.domain}/acs</dd></>}
        <dt className="text-muted">New people</dt><dd>{c.jitEnabled ? `Join automatically as ${ROLE_LABEL[c.jitRole] ?? c.jitRole}` : "Must be added first"}</dd>
      </dl>
      {!c.lastSuccessAt && (sameDomain
        ? <a href={`/api/v1/auth/sso/start?email=${encodeURIComponent(email!)}`} className="inline-flex h-7 items-center rounded-lg border border-line-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">Test sign-in now</a>
        : <p className="text-[13px] text-muted">To test, sign out and choose "Use single sign-on" with an address on this domain.</p>)}
      <Toggle label="Require single sign-on for this domain" checked={c.enforced} disabled={!c.lastSuccessAt && !c.enforced} onChange={v => enforce.mutate(v)} description={c.lastSuccessAt ? "Passwords, passkeys, social sign-in and password reset stop working for addresses on this domain, including owners'. If your provider goes down, nobody on this domain can sign in until it's back or an operator turns this off." : "Available after one successful sign-in, so a mistake here can't lock everyone out."} />
      {enforce.error && <Banner tone="warn">{enforce.error.message}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setEditing(v => !v)} aria-expanded={editing}>{editing ? "Close" : "Edit"}</Button>
        {confirmRemove
          ? <><Button size="sm" variant="danger" icon={Trash2} loading={remove.isPending} onClick={() => remove.mutate()}>Remove single sign-on</Button><Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button></>
          : <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmRemove(true)}>Remove</Button>}
      </div>
      {editing && <div className="border-t border-line pt-3"><ConfigForm domain={c.domain} existing={c} samlBaseUrl={samlBaseUrl} onDone={() => { setEditing(false); onDone(); }} /></div>}
    </li>
  );
}

function ScimCard({ scim, onDone }: { scim: Overview["scim"]; onDone: () => void }) {
  const toast = useToast();
  const [shown, setShown] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const rotate = useAction<void, { token: string }>(() => api("/org/scim/token", { method: "POST" }), { refresh: false, success: "New token created.", onDone: r => { setShown(r.token); onDone(); } });
  const revoke = useAction<void>(() => api("/org/scim/token", { method: "DELETE" }), { refresh: false, success: "Token revoked.", onDone: () => { setShown(null); setConfirmRevoke(false); onDone(); } });
  const copy = async (v: string) => { try { await navigator.clipboard.writeText(v); toast({ text: "Copied." }); } catch { toast({ text: "Couldn't copy. Select it and copy it yourself.", tone: "danger" }); } };
  return (
    <Card title="SCIM provisioning" description="Lets your identity provider add and remove people here. It can't see mail. People it removes lose their membership and their mailboxes in this workspace disconnect.">
      <div className="space-y-3">
        <dl className="grid gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Base URL</dt><dd className="font-mono text-xs break-all" data-testid="scim-base">{scim.baseUrl}</dd>
          <dt className="text-muted">Token</dt><dd>{scim.token ? <>Active, created {fmtDate(scim.token.createdAt)}{scim.token.lastUsedAt ? `, last used ${fmtDate(scim.token.lastUsedAt)}` : ", not used yet"}</> : "None"}</dd>
          <dt className="text-muted">People it manages</dt><dd>{scim.managed}</dd>
        </dl>
        {shown && (
          <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3" data-testid="scim-token">
            <p className="flex items-center gap-1.5 text-[13px] font-medium"><KeyRound className="size-3.5" aria-hidden />Copy this now. It's only shown once.</p>
            <div className="flex flex-wrap gap-2"><input readOnly aria-label="SCIM bearer token" className={`${inputClass} min-w-0 flex-1 basis-60 font-mono text-xs`} value={shown} onFocus={e => e.target.select()} /><Button icon={Copy} onClick={() => copy(shown)}>Copy</Button></div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button icon={RefreshCw} loading={rotate.isPending} onClick={() => rotate.mutate()}>{scim.token ? "Replace token" : "Generate token"}</Button>
          {scim.token && (confirmRevoke
            ? <><Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>Revoke token</Button><Button variant="ghost" onClick={() => setConfirmRevoke(false)}>Keep</Button></>
            : <Button variant="ghost" onClick={() => setConfirmRevoke(true)}>Revoke</Button>)}
        </div>
        {scim.token && <p className="text-[13px] text-muted">Replacing a token ends the old one right away, so update your provider at the same time.</p>}
      </div>
    </Card>
  );
}

export default function SsoPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const isOwner = me?.role === "owner";
  const { data, isLoading, error, refetch } = useApi<Overview>(["org", "sso"], isOwner ? "/org/sso" : null, { retry: false });
  const changed = () => void qc.invalidateQueries({ queryKey: ["org", "sso"] });
  const [adding, setAdding] = useState("");
  const head = <Head title="Single sign-on" description="Signing in through your identity provider, and provisioning people from it." />;
  if (me && !isOwner) return <>{head}<Banner tone="neutral" icon={Lock}>Only owners can manage single sign-on, because whoever controls the identity provider can sign in as anyone on the domain.</Banner></>;
  if (isLoading || !me) return <>{head}<PageSkeleton blocks={3} /></>;
  if (error || !data) return <>{head}<ErrorState error={error ?? { message: "This isn't available." }} retry={() => refetch()} /></>;
  if (!data.organization) return <>{head}<Banner tone="neutral">Single sign-on is for organization workspaces.</Banner></>;
  const unconfigured = data.domains.filter(d => !data.configs.some(c => c.domain === d));
  return (
    <>
      {head}
      <div className="space-y-4">
        <p className="text-[13px] text-muted" data-testid="sso-advice">Test with one account before requiring it for everyone.</p>
        <Card title="Identity provider" description="One provider per verified domain, using OpenID Connect or SAML 2.0.">
          <div className="space-y-3">
            <div className="rounded-lg bg-surface-2 p-2.5 text-[13px]"><p className="text-muted">OpenID Connect redirect URI to register with your provider</p><p className="font-mono text-xs break-all" data-testid="sso-callback">{data.callbackUrl}</p></div>
            <Details summary="Setup details" className="mt-0">
              <p>Your provider must send the email address and say it&apos;s verified: for OpenID Connect, <code className="font-mono text-xs">email</code> and <code className="font-mono text-xs">email_verified: true</code> in the ID token. Without them, sign-in is refused.</p>
              <p>Linking to an existing account by email only ever happens on a domain verified here.</p>
            </Details>
            {data.configs.length > 0 && <ul className="rounded-lg border border-line">{data.configs.map(c => <ConfigRow key={c.id} c={c} email={me.email} samlBaseUrl={data.samlBaseUrl} onDone={changed} />)}</ul>}
            {data.domains.length === 0
              ? <EmptyState icon={ShieldCheck} title="Verify a domain first" action={<Link href="/app/org/domains" className="inline-flex h-9 items-center rounded-lg border border-line-strong px-3.5 text-sm font-medium hover:bg-surface-2">Go to Domains</Link>}>Single sign-on is set up per verified domain.</EmptyState>
              : unconfigured.length > 0 && (
                <div className="space-y-3 border-t border-line pt-3">
                  <div className="max-w-xs"><Field label="Add a provider for"><select className={inputClass} value={adding} onChange={e => setAdding(e.target.value)}><option value="">Choose a domain</option>{unconfigured.map(d => <option key={d} value={d}>{d}</option>)}</select></Field></div>
                  {adding && <ConfigForm key={adding} domain={adding} samlBaseUrl={data.samlBaseUrl} onDone={() => { setAdding(""); changed(); }} />}
                </div>
              )}
          </div>
        </Card>
        <ScimCard scim={data.scim} onDone={changed} />
      </div>
    </>
  );
}
