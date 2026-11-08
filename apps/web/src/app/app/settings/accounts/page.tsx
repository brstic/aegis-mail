"use client";
import { AlertTriangle, Eye, Pause, Play, Plug, Plus, RefreshCw, Star, Trash2, Unplug } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { fmtDateTime, Head, latencyLabel, PageSkeleton, providerLabel, TextPair } from "@/components/settings/common";
import { Banner, Button, Chip, EmptyState, ErrorState, Field, inputClass, Modal } from "@/components/ui";
import { api, relTime, useAccounts, useAction, type Account } from "@/lib/client";

const SYNC_ERROR: Record<string, string> = { auth_failed: "The server rejected the saved password.", oauth_revoked: "Access was revoked at the provider.", tls_failed: "A secure connection couldn't be made.", host_unreachable: "The mail server couldn't be reached.", host_blocked: "That server address isn't allowed.", timeout: "The server took too long to respond.", rate_limited: "The provider is rate limiting requests.", protocol_error: "The server sent a response we couldn't understand." };

function reconnectHref(a: Account) {
  if (a.kind === "gmail" || a.kind === "microsoft") return `/api/v1/oauth/${a.kind}/start?readOnly=${a.readOnly}&loginHint=${encodeURIComponent(a.email)}`;
  return `/app/connect/manual?provider=${a.kind === "pop3" ? "pop3" : "imap"}&email=${encodeURIComponent(a.email)}`;
}

/** Where to finish revoking when the provider has no API for it. */
function manualRevoke(kind: string, email: string) {
  if (kind === "microsoft") return "Go to myaccount.microsoft.com, open privacy or app permissions, and remove Aegis Mail. Microsoft has no way for us to do this for you.";
  if (/@(icloud|me|mac)\.com$/i.test(email)) return "Go to account.apple.com, open Sign-In and Security, then App-Specific Passwords, and delete the one you made for this app.";
  return "Sign in to your mail provider's security settings and delete the app password you made for this app. If you used your regular password, change it.";
}

function DisconnectModal({ a, onClose }: { a: Account; onClose: () => void }) {
  const [choice, setChoice] = useState<"keep" | "delete">("delete");
  const [result, setResult] = useState<{ revokeSupported: boolean; manualRevokeNeeded: boolean } | null>(null);
  const run = useAction<void, { revokeSupported: boolean; manualRevokeNeeded: boolean }>(() => api(`/accounts/${a.id}/disconnect`, { body: { deleteData: choice === "delete" } }), { success: `${a.displayName} was disconnected.`, onDone: setResult });
  if (result) return (
    <Modal title="Disconnected" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-3 text-sm" data-testid="disconnect-result">
        <p>Sync has stopped for {a.email}, and our copy of its credential is being deleted. {choice === "delete" ? "Its cached mail here has been deleted." : "Cached mail already here is kept and won't update."}</p>
        {result.manualRevokeNeeded ? <Banner tone="warn" icon={AlertTriangle}><strong className="font-semibold">One more step at your provider. </strong>{manualRevoke(a.kind, a.email)}</Banner> : <p className="text-muted">We asked the provider to revoke access. You can confirm it in your provider's security settings.</p>}
        <p className="text-[13px] text-muted">Your mail at the provider isn't touched.</p>
      </div>
    </Modal>
  );
  return (
    <Modal title={`Disconnect ${a.displayName}?`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" icon={Unplug} loading={run.isPending} onClick={() => run.mutate()}>Disconnect</Button></>}>
      <div className="space-y-3 text-sm">
        <p>This stops sync for {a.email}. Your mail at the provider isn't touched.</p>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium">What about mail cached here?</legend>
          {([["delete", "Delete cached data", "Cached messages, search words and vectors, tasks, drafts and analyses for this mailbox are deleted now. Backups expire on the deployment's schedule."], ["keep", "Keep cached data", "Mail already here stays encrypted and readable here, but stops updating. Reconnect this address and disconnect again to delete it later."]] as const).map(([v, label, d]) => (
            <label key={v} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 ${choice === v ? "border-accent bg-accent-soft" : "border-line-strong"}`}>
              <input type="radio" name="disconnect-data" className="mt-0.5 accent-[var(--accent)]" checked={choice === v} onChange={() => setChoice(v)} />
              <span><span className="block font-medium">{label}</span><span className="block text-[13px] text-muted">{d}</span></span>
            </label>
          ))}
        </fieldset>
        {!a.capabilities.revokeSupported && <p className="text-[13px] text-muted">This provider can't be revoked from here. We'll show you how to finish there.</p>}
        {run.error && <Banner tone="danger">{run.error.message}</Banner>}
      </div>
    </Modal>
  );
}

function AccountCard({ a, onDisconnect }: { a: Account; onDisconnect: () => void }) {
  const [name, setName] = useState(a.displayName);
  const [color, setColor] = useState(a.color);
  useEffect(() => { setName(a.displayName); setColor(a.color); }, [a.displayName, a.color]);
  const patch = useAction<Record<string, unknown>>(body => api(`/accounts/${a.id}`, { method: "PATCH", body }), { success: "Saved." });
  const sync = useAction<void>(() => api(`/accounts/${a.id}/sync`, { method: "POST" }), { success: `Sync requested for ${a.displayName}.` });
  const gone = a.status === "disconnected", paused = a.status === "paused", broken = a.status === "reconnect_required" || a.status === "error", initial = a.sync.phase === "initial";
  const save = (e: FormEvent) => { e.preventDefault(); const body: Record<string, unknown> = {}; if (name.trim() && name.trim() !== a.displayName) body.displayName = name.trim(); if (color.toLowerCase() !== a.color.toLowerCase()) body.color = color; if (Object.keys(body).length) patch.mutate(body); };
  const dirty = (name.trim() && name.trim() !== a.displayName) || color.toLowerCase() !== a.color.toLowerCase();
  return (
    <li className="rounded-xl bg-surface p-4" data-testid="account-card">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: a.color }} />
        <h2 className="min-w-0 text-[15px] font-semibold break-words">{a.displayName}</h2>
        {a.isPrimary && <Chip tone="accent"><Star className="size-3" aria-hidden />Primary</Chip>}
        <Chip>{providerLabel(a.kind)}</Chip>
        {a.readOnly && <Chip tone="info"><Eye className="size-3" aria-hidden />Read-only</Chip>}
        {paused && <Chip tone="warn"><Pause className="size-3" aria-hidden />Paused</Chip>}
        {gone && <Chip>Disconnected, mail kept</Chip>}
        {broken && <Chip tone="danger"><AlertTriangle className="size-3" aria-hidden />Needs reconnecting</Chip>}
        {!a.owned && <Chip>Shared with you</Chip>}
        {a.simulated && <Chip tone="info">{a.simulated}</Chip>}
      </div>
      <p className="mt-0.5 text-[13px] break-all text-muted">{a.email}</p>

      {broken && (
        <div className="mt-3"><Banner tone="danger" icon={AlertTriangle} action={a.owned ? <a href={reconnectHref(a)} className="font-semibold underline underline-offset-2">Reconnect</a> : undefined}>
          {a.statusDetail ?? "We lost access to this mailbox, so it has stopped syncing."} {a.owned ? "Mail already here stays, but nothing new arrives until you reconnect." : "Its owner needs to reconnect it."}
        </Banner></div>
      )}

      <h3 className="mt-3 text-[13px] font-semibold">Sync</h3>
      <dl className="mt-1 space-y-1">
        <TextPair term="Status">{gone ? "Disconnected. Nothing syncs or sends, and the access credential is gone. Mail already here stays until you delete it." : paused ? "Paused. New mail isn't being fetched, and that means it isn't being scanned here either." : broken ? "Stopped" : initial ? "First sync in progress, starting with the last 30 days." : "Up to date, as of the last successful check."}</TextPair>
        <TextPair term="Last successful sync">{a.sync.lastSuccessAt ? <time dateTime={a.sync.lastSuccessAt} title={fmtDateTime(a.sync.lastSuccessAt)}>{fmtDateTime(a.sync.lastSuccessAt)} ({relTime(a.sync.lastSuccessAt)})</time> : "Not yet"}</TextPair>
        <TextPair term="How quickly mail appears">{latencyLabel(a.capabilities)}</TextPair>
        <TextPair term="Messages">{a.sync.messagesSynced}</TextPair>
        {a.sync.lastError && <TextPair term="Last problem"><span className="text-warn">{SYNC_ERROR[a.sync.lastError] ?? "The last sync attempt failed."}</span></TextPair>}
      </dl>

      {!!a.capabilities.limitations.length && (
        <details className="mt-3 text-[13px]" open={a.readOnly || a.kind === "pop3"}>
          <summary className="cursor-pointer font-semibold">Connection details</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{a.capabilities.limitations.map(l => <li key={l}>{l}</li>)}{a.readOnly && <li>Connected read-only, so it can't send and changes here don't reach your mailbox.</li>}</ul>
        </details>
      )}

      {a.owned ? (
        <>
          <form onSubmit={save} className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
            <div className="min-w-0 flex-1 basis-48"><Field label="Name in the sidebar"><input className={inputClass} value={name} maxLength={100} onChange={e => setName(e.target.value)} /></Field></div>
            <Field label="Color"><input type="color" className="h-9 w-14 cursor-pointer rounded-lg border border-line-strong bg-surface p-1" value={color} onChange={e => setColor(e.target.value)} /></Field>
            <Button type="submit" disabled={!dirty} loading={patch.isPending}>Save</Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {!gone && !paused && !broken && <Button size="sm" icon={RefreshCw} loading={sync.isPending} onClick={() => sync.mutate()} aria-label={`Sync now: ${a.displayName}`}>Sync now</Button>}
            {!gone && !broken && <Button size="sm" icon={paused ? Play : Pause} disabled={patch.isPending} onClick={() => patch.mutate({ paused: !paused })} aria-label={`${paused ? "Resume" : "Pause"} ${a.displayName}`}>{paused ? "Resume" : "Pause"}</Button>}
            {!a.isPrimary && <Button size="sm" icon={Star} disabled={patch.isPending} onClick={() => patch.mutate({ isPrimary: true })} aria-label={`Make ${a.displayName} primary`}>Make primary</Button>}
            <Button size="sm" variant="danger" icon={Trash2} onClick={onDisconnect} aria-label={`${gone ? "Delete cached mail for" : "Disconnect"} ${a.displayName}`}>{gone ? "Delete cached mail" : "Disconnect"}</Button>
          </div>
        </>
      ) : <p className="mt-3 border-t border-line pt-3 text-[13px] text-muted">Only this mailbox's owner can rename, pause or disconnect it. You can remove your own access in <Link href="/app/shared" className="font-medium text-accent underline underline-offset-2">Team mailboxes</Link>.</p>}
    </li>
  );
}

export default function AccountsPage() {
  const { data, isLoading, error, refetch } = useAccounts();
  // Held here, not in the card: the card disappears as soon as the disconnect succeeds, but the finishing steps must stay on screen.
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);
  return (
    <>
      <Head title="Accounts" description="The mailboxes connected to this workspace." action={<Link href="/app/connect" className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-on-accent hover:bg-accent-hover"><Plus className="size-4" aria-hidden />Connect a mailbox</Link>} />
      {isLoading ? <PageSkeleton blocks={2} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? (
        <div className="rounded-xl bg-surface"><EmptyState icon={Plug} title="No mailboxes connected" action={<Link href="/app/connect" className="font-medium text-accent underline underline-offset-2">Connect your first mailbox</Link>}>Connect one and we'll start with its last 30 days of mail.</EmptyState></div>
      ) : <ul className="space-y-3">{data.map(a => <AccountCard key={a.id} a={a} onDisconnect={() => setDisconnecting(a)} />)}</ul>}
      {disconnecting && <DisconnectModal a={disconnecting} onClose={() => setDisconnecting(null)} />}
    </>
  );
}
