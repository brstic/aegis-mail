"use client";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleSlash, Clock, Download, ExternalLink, Minus, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfirmModal, Details, fmtDateTime, linkClass, Page, PageSkeleton, providerLabel, TableScroll, tdClass, TextPair, thClass, usePrefPatch } from "@/components/settings/common";
import { Banner, Button, Card, Chip, ErrorState, Field, inputClass, Modal, Toggle } from "@/components/ui";
import { api, useAction, useApi, useMe } from "@/lib/client";
import { SealFlow } from "./seal";

interface Privacy {
  mode: { id: string; name: string; claim: string; plain: string; notClaimed: string[] };
  processors: { name: string; purpose: string; plaintext: boolean; condition: string; caveat?: string }[];
  keys: { provider: string; productionSafe: boolean; classes: { class: string; version: number }[]; recovery: string; warning: string | null };
  model: { id: string; model: string; hosted: boolean; hostedConfigured: boolean; consent: boolean; training: string; retention: string };
  connections: { id: string; kind: string; email: string; displayName: string; readOnly: boolean; status: string; simulated: string | null; credential: string; scopes: string[]; grantedAt: string | null; limitations: string[]; revokeSupported: boolean }[];
  controls: { aiEnabled: boolean; summariesEnabled: boolean; topicsEnabled: boolean; storeAttachments: boolean; personalizationEnabled: boolean; hostedModelConsent: boolean; serverSearchEnabled: boolean; semanticSearchEnabled: boolean };
  region: string | null;
  retention: { days: number | null; plain: string };
  sealedCount: number;
  review: { status: string; certifications: string[]; note: string };
  admins: string;
  origin: string;
}
const KEY_NAME: Record<string, string> = { body: "Message bodies", metadata: "Metadata", index: "Search keys", credential: "Credentials" };
interface Incident { id: string; sharedBy: string; analyst: string; mine: boolean; redacted: boolean; note: string | null; expiresAt: string; revokedAt: string | null; snapshot: { riskLabel?: string } }

type Cell = { v: "yes" | "no" | "partial" | "none"; text: string };
const yes = (text = "Yes"): Cell => ({ v: "yes", text }), no = (text = "No"): Cell => ({ v: "no", text }), part = (text: string): Cell => ({ v: "partial", text });
const CLAIMS: { claim: string; a: Cell; b: Cell; c: Cell }[] = [
  { claim: "Encrypted in transit (TLS)", a: yes(), b: yes(), c: yes() },
  { claim: "Encrypted at rest with per-tenant keys", a: yes(), b: yes(), c: yes() },
  { claim: "No admin screen, API or database role shows mail content to workspace admins", a: yes("Yes, enforced by database rules and tests"), b: yes(), c: yes() },
  { claim: "Mail text kept out of logs, jobs and telemetry", a: yes("Yes, tested"), b: yes(), c: yes() },
  { claim: "Staff have no routine access", a: part("By policy and access controls. Depends on the deployment"), b: part("Same"), c: part("Same") },
  { claim: "The server can't decrypt cached message bodies", a: no(), b: part("Yes, for sealed bodies only"), c: part("Only inside the measured workload") },
  { claim: "The operator can't retrieve your mail at all", a: no(), b: no("No. Server-held provider tokens can fetch it again until you disconnect"), c: no("No, unless key release is independent of the operator") },
  { claim: "Scans new mail around the clock", a: yes(), b: part("Before sealing only. Sealed bodies aren't analyzed again"), c: part("Yes, if scanners run inside the boundary") },
  { claim: "Server-side search", a: yes("Yes, using unencrypted search words. You can turn this off. Semantic search, where a deployment enables it, uses encrypted vectors that the server opens in memory"), b: part("Sealed messages can't be searched on the server"), c: part("Inside the boundary") },
  { claim: "A hosted AI model sees content", a: part("Only if you turn it on"), b: part("Only if you act on one message"), c: part("Disclosed if outside the boundary") },
];

function ClaimCell({ c }: { c: Cell }) {
  const I = c.v === "yes" ? Check : c.v === "no" ? CircleSlash : Minus;
  const color = c.v === "yes" ? "text-safe" : c.v === "no" ? "text-danger" : "text-muted";
  return <span className="flex items-start gap-1.5"><I className={`mt-0.5 size-3.5 shrink-0 ${color}`} aria-hidden /><span>{c.text}</span></span>;
}

function DeleteAccount({ onClose, email }: { onClose: () => void; email: string }) {
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const { data: me } = useMe();
  const [deleted, setDeleted] = useState(false);
  const del = useAction<void>(() => api("/privacy/delete-account", { body: { confirmEmail: typed.trim(), password, totp: me?.mfaEnabled ? totp : undefined } }), { refresh: false, onDone: () => setDeleted(true) });
  const match = typed.trim().toLowerCase() === email.toLowerCase();
  const leave = () => { window.location.href = "/sign-in"; };
  if (deleted) return (
    <Modal title="Your account was deleted" onClose={leave} footer={<Button variant="primary" onClick={leave}>Done</Button>}>
      <div className="space-y-2 text-sm" data-testid="account-deleted">
        <p>You've been signed out everywhere, and your mailboxes are disconnected. Credentials, cached mail and analyses here are gone.</p>
        <p className="text-[13px] text-muted">Backups expire on the deployment's schedule. Your mail at your provider wasn't touched, and a provider that can't be revoked from here keeps its app password until you delete it there.</p>
      </div>
    </Modal>
  );
  return (
    <Modal title="Delete your account" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" icon={Trash2} disabled={!match || (!!me?.mfaEnabled && totp.length !== 6)} loading={del.isPending} onClick={() => del.mutate()}>Delete my account</Button></>}>
      <div className="space-y-3 text-sm">
        <p>This signs you out everywhere and disconnects all your mailboxes. It can't be undone.</p>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
          <li>Deleted now: stored credentials, cached mail, search words and vectors, tasks, drafts and analyses.</li>
          <li>In a personal workspace, its encryption keys are destroyed too.</li>
          <li>Kept: audit events, which hold no message content and have your identity removed.</li>
          <li>Backups taken before now aren't changed. They stay recoverable until they expire on the deployment's schedule.</li>
          <li>Your mail at your provider isn't touched.</li>
        </ul>
        <Field label={`Type ${email} to confirm`}><input className={inputClass} value={typed} autoComplete="off" onChange={e => setTyped(e.target.value)} /></Field>
        {del.error && <Banner tone="danger">{del.error.message}</Banner>}
        <Field label="Your password" hint="If you sign in through your organization, leave this empty. You'll need to have signed in during the last ten minutes."><input type="password" autoComplete="current-password" className={inputClass} value={password} onChange={e => setPassword(e.target.value)} /></Field>
        {me?.mfaEnabled && <Field label="Code from your authenticator app"><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} className={inputClass} value={totp} onChange={e => setTotp(e.target.value.replace(/\D/g, ""))} /></Field>}
        {del.error && <Banner tone="danger">{del.error.message}</Banner>}
      </div>
    </Modal>
  );
}

function Controls({ d }: { d: Privacy }) {
  const patch = usePrefPatch("Saved.");
  const [confirmSearch, setConfirmSearch] = useState(false);
  const policy = useApi<{ policy: { hostedModelsDisabled?: boolean } }>(["org", "policy"], "/org/policy", { retry: false });
  const blocked = policy.data?.policy.hostedModelsDisabled === true;
  const c = d.controls;
  return (
    <Card title="Your controls" description="These apply to your own mail and take effect right away.">
      <div className="divide-y divide-line">
        <Toggle label="AI features" checked={c.aiEnabled} onChange={aiEnabled => patch.mutate({ aiEnabled })} description="Summaries, suggested drafts and Focus. Security scanning keeps running when this is off, because it doesn't depend on AI." />
        <Toggle label="Summaries" checked={c.summariesEnabled} disabled={!c.aiEnabled} onChange={summariesEnabled => patch.mutate({ summariesEnabled })} description={c.aiEnabled ? "Short summaries of a conversation in the intelligence panel. Off means none are made, and no text is processed for one." : "Off while AI features are off."} />
        <Toggle label="Topics" checked={c.topicsEnabled} onChange={topicsEnabled => patch.mutate({ topicsEnabled })} description={<>Tags new mail with topics like invoices or meetings. Off means new mail gets none, and rules and search can't use them. Topics already on messages stay. <Link href="/app/settings/topics" className={linkClass}>Manage topics</Link></>} />
        <Toggle label="Keep attachments" checked={c.storeAttachments} onChange={storeAttachments => patch.mutate({ storeAttachments })} description="Stores an encrypted copy of attachments on new mail so you can download them here. Off means they're still scanned on arrival but not kept, so open them at your mail provider. Attachments already here stay." />
        <Toggle label="Personalization" checked={c.personalizationEnabled} onChange={personalizationEnabled => patch.mutate({ personalizationEnabled })} description="Uses how often you write to and reply to a sender, plus your important and ignore choices, to rank Focus. It's kept to your account." />
        {d.model.hostedConfigured
          ? <Toggle label="Hosted AI model" checked={c.hostedModelConsent && !blocked} disabled={blocked} onChange={hostedModelConsent => patch.mutate({ hostedModelConsent })} description={blocked ? "Your organization has turned hosted models off." : `When on, ${d.model.model} reviews each incoming message for attacks, along with what the inspector found inside its attachments (structure and embedded code, not document text), and writes summaries and drafts. When off, rules on this deployment do that work instead.`} />
          : <div className="py-2.5"><div className="text-sm font-medium">Hosted AI model</div><p className="mt-0.5 text-[13px] text-muted">Summaries and drafts are made on this server, so no content is sent to a model provider.</p></div>}
        <Toggle label="Server search" checked={c.serverSearchEnabled} onChange={v => { if (v) patch.mutate({ serverSearchEnabled: true }); else setConfirmSearch(true); }} description={c.serverSearchEnabled ? "Words from subjects and bodies, and sender and recipient addresses, are stored unencrypted in the database so search can work. Turning this off deletes them right away." : "Off. Search words aren't stored. New mail is indexed again if you turn this on, but mail already here isn't."} />
      </div>
      {confirmSearch && <ConfirmModal title="Turn off server search?" danger confirmLabel="Turn off and delete index" onConfirm={() => { patch.mutate({ serverSearchEnabled: false }); setConfirmSearch(false); }} onClose={() => setConfirmSearch(false)}><p>This deletes the search index for your mailboxes now, not later, along with any semantic search vectors. Searching your mail won't find messages until it's turned back on, and only mail that arrives after that gets indexed for words.</p></ConfirmModal>}
    </Card>
  );
}

function Incidents() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<Incident[]>(["org", "incidents"], "/org/incidents");
  const [revoking, setRevoking] = useState<Incident | null>(null);
  const revoke = useAction<string>(id => api(`/incidents/${id}/revoke`, { method: "POST" }), { refresh: false, success: "Share revoked.", onDone: () => { setRevoking(null); void qc.invalidateQueries({ queryKey: ["org", "incidents"] }); } });
  const mine = data?.filter(i => i.mine) ?? [];
  const now = Date.now();
  return (
    <Card title="Messages you've shared with security" description="Use Share with security on a message to let one analyst see it for a limited time. You can end a share here.">
      {isLoading ? <PageSkeleton blocks={1} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !mine.length ? <p className="text-sm text-muted">You haven't shared any messages.</p> : (
        <ul className="divide-y divide-line">
          {mine.map(i => {
            const active = !i.revokedAt && new Date(i.expiresAt).getTime() > now;
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2.5" data-testid="incident-share">
                <div className="min-w-0 flex-1 basis-56 text-[13px]">
                  <p className="font-medium">Shared with {i.analyst}: {i.redacted ? "redacted report" : "full message"}</p>
                  <p className="text-muted">{i.revokedAt ? `Revoked ${fmtDateTime(i.revokedAt)}` : active ? `Until ${fmtDateTime(i.expiresAt)}` : `Expired ${fmtDateTime(i.expiresAt)}`}{i.note ? `. Note: ${i.note}` : ""}</p>
                </div>
                {active ? <Button size="sm" onClick={() => setRevoking(i)} aria-label={`Revoke share with ${i.analyst}`}>Revoke</Button> : <Chip><Clock className="size-3" aria-hidden />Ended</Chip>}
              </li>
            );
          })}
        </ul>
      )}
      {revoking && <ConfirmModal title="Revoke this share?" danger confirmLabel="Revoke share" busy={revoke.isPending} onConfirm={() => revoke.mutate(revoking.id)} onClose={() => setRevoking(null)}><p>{revoking.analyst} won't be able to see this any more. Anything they already read or wrote down can't be taken back.</p></ConfirmModal>}
    </Card>
  );
}

/** The opening card: what protects your mail, each line read from the live configuration. */
function Protection({ d }: { d: Privacy }) {
  const points = [
    "Your messages travel over encrypted connections and are stored encrypted, with keys for your workspace alone.",
    "Every new message is checked for threats as it arrives.",
    "No admin screen shows your mail content, not even to your own organization's admins.",
    "Mail text is kept out of logs and telemetry.",
    d.model.training,
    d.model.hosted ? `AI review uses ${d.model.model}, a hosted model. You can turn it off in your controls below.` : "Your mail isn't sent to an AI model provider.",
  ];
  return (
    <Card title="How your mail is protected">
      <ul className="space-y-1.5 text-sm">{points.map(t => <li key={t} className="flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-safe" aria-hidden />{t}</li>)}</ul>
      <Details summary="How this works">
        <p>{d.mode.name}: your mail is decrypted in memory on the service's servers so it can be scanned and organized, and it's stored encrypted. The people who run those servers are trusted with that processing.</p>
        <p>Beyond what this mode covers: {d.mode.notClaimed.map(n => n.charAt(0).toLowerCase() + n.slice(1)).join("; ")}.</p>
        <p>{d.admins} The one exception is a message you choose to share with a named analyst, for a limited time, which you can revoke below.</p>
      </Details>
    </Card>
  );
}

export default function PrivacyPage() {
  const { data: d, isLoading, error, refetch } = useApi<Privacy>(["privacy"], "/privacy");
  const { data: me } = useMe();
  const [deleting, setDeleting] = useState(false);
  return (
    <Page width="4xl" title="Privacy Center" description="How your mail is protected, and the controls that are yours.">
      {isLoading ? <PageSkeleton blocks={4} /> : error || !d ? <ErrorState error={error ?? { message: "Privacy details aren't available." }} retry={() => refetch()} /> : (
        <div className="space-y-4">
          <Protection d={d} />
          <Controls d={d} />

          <Card title="Your data" description="Take it with you, revoke access or delete it.">
            <div className="flex flex-wrap gap-2">
              <a href="/api/v1/privacy/export" download className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-surface-2"><Download className="size-4" aria-hidden />Export my data</a>
              <Link href="/app/settings/accounts" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-surface-2"><ExternalLink className="size-4" aria-hidden />Revoke a mailbox</Link>
              <Button variant="danger" icon={Trash2} onClick={() => setDeleting(true)} disabled={!me}>Delete my account</Button>
            </div>
            <p className="mt-2 text-[13px] text-muted">The export is a JSON file of the conversations you can see. Making one is recorded in the audit log, without its contents.</p>
          </Card>
          {deleting && me && <DeleteAccount email={me.email} onClose={() => setDeleting(false)} />}

          <Incidents />

          <Card title="AI model and data use">
            <dl className="space-y-1.5">
              <TextPair term="Active provider">{d.model.hosted ? `Hosted model: ${d.model.model}` : "Runs on this server. No hosted model is in use."}</TextPair>
              <TextPair term="Training">{d.model.training}</TextPair>
              <TextPair term="Provider retention">{d.model.retention}</TextPair>
              <TextPair term="Processing region"><span data-testid="region">{d.region ?? "Depends on the deployment. This one doesn't report a region."}</span></TextPair>
              <TextPair term="Mail retention here">{d.retention.plain}</TextPair>
            </dl>
          </Card>

          <Card title="Connected mailboxes and permissions" description="The exact access each connection holds." action={<Link href="/app/settings/accounts" className={`shrink-0 text-[13px] ${linkClass}`}>Manage or revoke</Link>}>
            {!d.connections.length ? <p className="text-sm text-muted">No mailboxes are connected. <Link href="/app/connect" className={linkClass}>Connect one</Link>.</p> : (
              <ul className="divide-y divide-line">
                {d.connections.map(c => (
                  <li key={c.id} className="py-2.5 text-[13px]" data-testid="connection-row">
                    <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 font-medium break-all">{c.email}</span><Chip>{providerLabel(c.kind)}</Chip>{c.readOnly && <Chip tone="info">Read-only</Chip>}{c.simulated && <Chip tone="info">{c.simulated}</Chip>}</div>
                    <dl className="mt-1.5 space-y-1">
                      <TextPair term="Credential">{c.credential}</TextPair>
                      <TextPair term="Permissions">{c.scopes.length ? <span className="font-mono text-xs break-all">{c.scopes.join(", ")}</span> : c.credential.startsWith("App") ? "Full mailbox access through IMAP or POP3. Those protocols have no finer permissions." : "None. No real mailbox is involved."}</TextPair>
                      <TextPair term="Revoking">{c.revokeSupported ? "Disconnecting asks the provider to revoke access." : "Disconnecting removes our copy of the credential. You also need to finish at your provider. Account settings shows how."}</TextPair>
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Client-sealed storage (experimental)" description="An extra lock you can add to one message at a time.">
            <div className="space-y-2 text-sm">
              <p>Your browser encrypts one message's text with a key made from a passphrase only you know, using AES-GCM. It uploads the encrypted copy, and the server erases its readable copy and the message's search words.</p>
              <p className="text-[13px] text-muted">Lose the passphrase and the sealed copy is lost permanently. There's no recovery key, though your provider usually still has the original.</p>
              <Details className="mt-1">
                <p>This protects the message if the database or a backup is exposed. The server still holds your mailbox connection and serves the code that handles the passphrase, so it's an extra layer rather than zero-access storage.</p>
              </Details>
              <SealFlow />
            </div>
          </Card>

          {/* The full technical record, for anyone who wants it. */}
          <Card title="Technical details" description="Read from this server's live configuration.">
            <Details summary="Show technical details" className="mt-0">
              <div className="space-y-5 text-ink">
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">Which services handle your mail text</h3>
                  <p className="mb-2 text-muted">Plaintext means the readable text of your mail.</p>
                  <TableScroll label="Services that handle plaintext">
                    <table className="w-full min-w-[34rem] border-collapse">
                      <thead><tr><th scope="col" className={thClass}>Service</th><th scope="col" className={thClass}>Why</th><th scope="col" className={thClass}>Sees plaintext</th><th scope="col" className={thClass}>When</th></tr></thead>
                      <tbody>
                        {d.processors.map(p => {
                          const off = /not configured/i.test(p.condition);
                          return (
                            <tr key={p.name} data-testid="processor-row">
                              <th scope="row" className={`${tdClass} text-left font-medium`}>{p.name}</th>
                              <td className={tdClass}>{p.purpose}</td>
                              <td className={tdClass}>{off ? <Chip>Not configured</Chip> : p.plaintext ? <Chip tone="info">Yes</Chip> : <Chip>No</Chip>}</td>
                              <td className={tdClass}>{p.condition}{p.caveat && <span className="mt-1 block text-muted">{p.caveat}</span>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </TableScroll>
                </section>
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">Privacy properties by mode</h3>
                  <p className="mb-2 text-muted">Managed processing is the mode in use. Client-sealed is per message. Attested describes a future design.</p>
                  <TableScroll label="Privacy properties by mode">
                    <table className="w-full min-w-[46rem] border-collapse">
                      <thead><tr><th scope="col" className={thClass}>Property</th><th scope="col" className={thClass}>Managed (in use)</th><th scope="col" className={thClass}>Client-sealed (experimental)</th><th scope="col" className={thClass}>Attested (future)</th></tr></thead>
                      <tbody>{CLAIMS.map(r => <tr key={r.claim}><th scope="row" className={`${tdClass} text-left font-medium`}>{r.claim}</th><td className={tdClass}><ClaimCell c={r.a} /></td><td className={tdClass}><ClaimCell c={r.b} /></td><td className={tdClass}><ClaimCell c={r.c} /></td></tr>)}</tbody>
                    </table>
                  </TableScroll>
                  <p className="mt-2 text-muted">In every mode, your mail provider keeps its own access, and encrypting ordinary email end to end depends on the sender's and recipient's own tools.</p>
                </section>
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">Keys and recovery</h3>
                  <dl className="space-y-1.5">
                    <TextPair term="Who holds the keys">The service, through {d.keys.provider}.</TextPair>
                    <TextPair term="Key classes">{d.keys.classes.length ? d.keys.classes.map(k => `${KEY_NAME[k.class] ?? k.class} (version ${k.version})`).join(", ") : "None created yet"}</TextPair>
                    <TextPair term="Recovery">{d.keys.recovery}</TextPair>
                    <TextPair term="Sealed messages">{d.sealedCount === 0 ? "None. Those would use a passphrase only you hold." : `${d.sealedCount}. These use a passphrase only you hold, and it can't be recovered.`}</TextPair>
                  </dl>
                  {d.keys.warning && <div className="mt-2"><Banner tone="warn" icon={AlertTriangle}>{d.keys.warning}</Banner></div>}
                </section>
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">Your mail provider</h3>
                  <p className="text-muted">{d.origin}</p>
                </section>
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold">Independent review</h3>
                  <p className="text-muted">{d.review.status}. {d.review.note}</p>
                  {d.review.certifications.length > 0 && <ul className="mt-1 list-disc pl-5 text-[13px]">{d.review.certifications.map(c => <li key={c}>{c}</li>)}</ul>}
                </section>
              </div>
            </Details>
          </Card>
        </div>
      )}
    </Page>
  );
}
