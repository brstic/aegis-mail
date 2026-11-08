"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, MessagesSquare, Share2, UserMinus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ConfirmModal, fmtDate, Page, PageSkeleton } from "@/components/settings/common";
import { Banner, Button, Card, ErrorState, Field, inputClass } from "@/components/ui";
import { api, useAccounts, useAction, useApi, useMe } from "@/lib/client";

interface Grant { accountId: string; account: string | null; granteeUserId: string; grantee: string; mine: boolean; at: string; canSend?: boolean }

function ShareForm({ grants, onDone }: { grants: Grant[]; onDone: () => void }) {
  const { data: me } = useMe();
  const { data: accounts, isLoading: loadingAccounts } = useAccounts();
  const members = useApi<{ id: string; name: string; email?: string; role: string }[]>(["org", "members"], "/org/members", { retry: false });
  const [accountId, setAccountId] = useState("");
  const [grantee, setGrantee] = useState("");
  const [canSend, setCanSend] = useState(false);
  const owned = accounts?.filter(a => a.owned) ?? [];
  const candidates = members.data?.filter(m => m.id !== me?.id && !grants.some(g => g.accountId === accountId && g.granteeUserId === m.id)) ?? [];
  const share = useAction<void>(() => api("/org/grants", { body: { accountId, granteeUserId: grantee, canSend } }), { success: canSend ? "Shared. They can read this mailbox and send from it as you. They can't change or delete anything." : "Shared. They can now read this mailbox. They can't send from it or change anything.", onDone: () => { setGrantee(""); setCanSend(false); onDone(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (accountId && grantee) share.mutate(); };
  if (members.error?.status === 403) return <Banner tone="neutral" icon={Lock}>Your role can't see the workspace member list, so you can't pick someone to share with here. Ask a workspace owner or manager for a role that can.</Banner>;
  if (members.error) return <ErrorState error={members.error} retry={() => members.refetch()} />;
  if (members.isLoading || loadingAccounts) return <PageSkeleton blocks={1} />;
  if (!owned.length) return <p className="text-sm text-muted">You don't own a connected mailbox yet. <Link href="/app/connect" className="font-medium text-accent underline underline-offset-2">Connect one</Link> to share it.</p>;
  if ((members.data?.length ?? 0) <= 1) return <p className="text-sm text-muted">Nobody else is in this workspace yet. Invite someone from <Link href="/app/org" className="font-medium text-accent underline underline-offset-2">Organization</Link> first.</p>;
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mailbox to share"><select className={inputClass} value={accountId} onChange={e => { setAccountId(e.target.value); setGrantee(""); }}><option value="">Choose a mailbox</option>{owned.map(a => <option key={a.id} value={a.id}>{a.displayName} ({a.email})</option>)}</select></Field>
        <Field label="Share with"><select className={inputClass} value={grantee} disabled={!accountId} onChange={e => setGrantee(e.target.value)}><option value="">Choose a person</option>{candidates.map(m => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}</select></Field>
      </div>
      {accountId && !candidates.length && <p className="text-[13px] text-muted">Everyone in this workspace already has access to that mailbox.</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={canSend} onChange={e => setCanSend(e.target.checked)} /><span>Can send<span className="block text-[13px] text-muted">They can send mail from this address, under your name. Recipients won't see that it was them.</span></span></label>
      <p className="text-xs text-muted">They'll be able to read this mailbox's mail in this app until you revoke access. Sharing it, and every send, is recorded in the audit log.</p>
      <Button type="submit" variant="primary" icon={Share2} disabled={!accountId || !grantee} loading={share.isPending}>Share mailbox</Button>
    </form>
  );
}

function GrantRow({ g, withMe, onDone }: { g: Grant; withMe: boolean; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const revoke = useAction<void>(() => api("/org/grants/revoke", { body: { accountId: g.accountId, granteeUserId: g.granteeUserId } }), { success: withMe ? "You no longer have access." : "Access revoked.", onDone: () => { setConfirm(false); onDone(); } });
  const mailbox = g.account ?? "A mailbox";
  // The box answers the click at once. A refused save puts it back.
  const [sendOn, setSendOn] = useState(!!g.canSend);
  useEffect(() => setSendOn(!!g.canSend), [g.canSend]);
  const setSend = useAction<boolean>(canSend => api("/org/grants", { body: { accountId: g.accountId, granteeUserId: g.granteeUserId, canSend } }).catch(e => { setSendOn(!canSend); throw e; }), { success: "Sending permission updated.", onDone });
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0" data-testid="grant-row">
      <div className="min-w-0 flex-1 basis-52 text-sm"><p className="truncate font-medium">{mailbox}</p><p className="text-[13px] text-muted">{withMe ? `Shared with you on ${fmtDate(g.at)}` : `Shared with ${g.grantee} on ${fmtDate(g.at)}`}. {g.canSend ? (withMe ? "You can read it and send as its owner." : "They can read it and send as you.") : "Read only."}</p></div>
      {!withMe && <label className="flex items-center gap-1.5 text-[13px]"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={sendOn} onChange={e => { setSendOn(e.target.checked); setSend.mutate(e.target.checked); }} aria-label={`Let ${g.grantee} send from ${mailbox}`} />Can send</label>}
      <Button size="sm" icon={UserMinus} onClick={() => setConfirm(true)} aria-label={withMe ? `Remove my access to ${mailbox}` : `Revoke ${g.grantee}'s access to ${mailbox}`}>{withMe ? "Remove my access" : "Revoke"}</Button>
      {confirm && <ConfirmModal title={withMe ? "Remove your access?" : "Revoke access?"} danger confirmLabel={withMe ? "Remove my access" : "Revoke access"} busy={revoke.isPending} onConfirm={() => revoke.mutate()} onClose={() => setConfirm(false)}><p>{withMe ? `You won't be able to open ${mailbox} here until its owner shares it again.` : `${g.grantee} won't be able to open ${mailbox} here any more.`}</p></ConfirmModal>}
    </li>
  );
}

export default function SharedPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useApi<Grant[]>(["org", "grants"], "/org/grants");
  const changed = () => { void qc.invalidateQueries({ queryKey: ["org", "grants"] }); void qc.invalidateQueries({ queryKey: ["accounts"] }); };
  const withMe = data?.filter(g => g.granteeUserId === me?.id) ?? [];
  const byMe = data?.filter(g => g.granteeUserId !== me?.id) ?? [];
  return (
    <Page width="4xl" title="Team mailboxes" description="Mailboxes people in this workspace have chosen to share with each other.">
      <div className="space-y-4">
        <Banner tone="info" icon={Lock}><strong className="font-semibold">Only a mailbox's owner can share it.</strong> Admins can't grant themselves or anyone else access to your mail, and no role gets it by default. You can revoke a share at any time.</Banner>
        {error?.status === 403 ? <ErrorState error={error} /> : (
          <>
            <Card title="Share one of your mailboxes"><ShareForm grants={data ?? []} onDone={changed} /></Card>
            <section aria-labelledby="shared-with-me">
              <h2 id="shared-with-me" className="mb-2 text-[15px] font-semibold">Shared with you</h2>
              {isLoading ? <PageSkeleton blocks={1} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !withMe.length ? <p className="flex items-center gap-2 rounded-xl bg-surface p-4 text-sm text-muted"><MessagesSquare className="size-4 shrink-0" aria-hidden />Nobody has shared a mailbox with you.</p> : <ul className="rounded-xl bg-surface">{withMe.map(g => <GrantRow key={`${g.accountId}:${g.granteeUserId}`} g={g} withMe onDone={changed} />)}</ul>}
            </section>
            <section aria-labelledby="shared-by-me">
              <h2 id="shared-by-me" className="mb-2 text-[15px] font-semibold">Shared by you</h2>
              {isLoading ? <PageSkeleton blocks={1} /> : error ? null : !byMe.length ? <p className="flex items-center gap-2 rounded-xl bg-surface p-4 text-sm text-muted"><MessagesSquare className="size-4 shrink-0" aria-hidden />You haven't shared a mailbox.</p> : <ul className="rounded-xl bg-surface">{byMe.map(g => <GrantRow key={`${g.accountId}:${g.granteeUserId}`} g={g} withMe={false} onDone={changed} />)}</ul>}
            </section>
          </>
        )}
      </div>
    </Page>
  );
}
