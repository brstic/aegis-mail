"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Lock, UserMinus, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmModal, fmtDate, Head, NoAccess, PageSkeleton, ROLE_LABEL } from "@/components/settings/common";
import { Banner, Button, Card, Chip, ErrorState, Field, inputClass } from "@/components/ui";
import { api, useAction, useApi, useMe, useToast } from "@/lib/client";

interface Member { id: string; name: string; email: string; role: string; joinedAt: string; mfaEnabled: boolean }
const ROLES = ["owner", "security_admin", "workspace_manager", "member"];
const ROLE_CAN: Record<string, string> = {
  owner: "Everything below, and changing roles and removing members.",
  workspace_manager: "Invite people and see pending invitations.",
  security_admin: "Security Center, policies, domains and the workspace audit log.",
  member: "Their own mail and settings. They can't see the member list.",
};

function Invite({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState<{ url: string; email: string } | null>(null);
  const { data: me } = useMe();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const send = useAction<void, { sent: boolean; acceptUrl?: string }>(() => api("/org/invites", { body: { email: email.trim(), role } }), { refresh: false, success: "Invitation created.", onDone: r => { setLink(r.acceptUrl ? { url: r.acceptUrl, email: email.trim() } : null); setSentTo(r.acceptUrl ? null : email.trim()); setEmail(""); setRole("member"); onDone(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (email.trim()) send.mutate(); };
  const copy = async () => { try { await navigator.clipboard.writeText(link!.url); toast({ text: "Link copied." }); } catch { toast({ text: "Couldn't copy. Select the link and copy it yourself.", tone: "danger" }); } };
  return (
    <Card title="Invite someone" description={me?.demoMode ? "Demo mode: nothing is really sent, so you'll get a link here, and the mail appears in the test outbox." : "We'll email them a link. It works for 7 days and only for someone signed in with that address."}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email address"><input type="email" className={inputClass} value={email} onChange={e => setEmail(e.target.value)} autoComplete="off" /></Field>
          <Field label="Role"><select className={inputClass} value={role} onChange={e => setRole(e.target.value)}>{ROLES.filter(r => r !== "owner").map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
        </div>
        <Button type="submit" variant="primary" icon={UserPlus} loading={send.isPending} disabled={!email.trim()}>Create invitation</Button>
      </form>
      {send.error && <div className="mt-3"><Banner tone="danger">{send.error.message}</Banner></div>}
      {sentTo && <p role="status" className="mt-3 text-[13px] font-medium text-safe [overflow-wrap:anywhere]" data-testid="invite-sent">Invitation on its way to {sentTo}.</p>}
      {link && (
        <div className="mt-3 space-y-2 rounded-lg border border-line bg-surface-2 p-3" data-testid="invite-link">
          <p className="flex items-center gap-1.5 text-[13px] font-medium"><Link2 className="size-3.5" aria-hidden />Send this link to {link.email}</p>
          <div className="flex flex-wrap gap-2"><input readOnly aria-label="Invitation link" className={`${inputClass} min-w-0 flex-1 basis-60 font-mono text-xs`} value={link.url} onFocus={e => e.target.select()} /><Button icon={Copy} onClick={copy}>Copy</Button></div>
          <p className="text-xs text-muted">It works for 7 days and only for someone signed in as {link.email}. This is the only time it's shown.</p>
        </div>
      )}
    </Card>
  );
}

function Row({ m, isSelf, canChange, onDone }: { m: Member; isSelf: boolean; canChange: boolean; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const change = useAction<string>(role => api(`/org/members/${m.id}`, { method: "PATCH", body: { role } }), { refresh: false, success: "Role updated.", onDone: () => { setPendingRole(null); onDone(); } });
  const remove = useAction<void>(() => api(`/org/members/${m.id}`, { method: "DELETE" }), { refresh: false, success: `${m.name} was removed.`, onDone: () => { setConfirm(false); onDone(); } });
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0" data-testid="member-row">
      <div className="min-w-0 flex-1 basis-52 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-medium"><span className="min-w-0 break-words">{m.name}</span>{isSelf && <Chip>You</Chip>}</p>
        <p className="text-[13px] break-all text-muted">{m.email}</p>
        <p className="text-xs text-muted">Joined {fmtDate(m.joinedAt)} · Authenticator app {m.mfaEnabled ? "on" : "off"}</p>
      </div>
      {canChange ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[13px]"><span className="sr-only">Role for {m.name}</span><select className={`${inputClass} h-8 w-44`} value={m.role} disabled={change.isPending} onChange={e => setPendingRole(e.target.value)}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
          {!isSelf ? <Button size="sm" icon={UserMinus} onClick={() => setConfirm(true)} aria-label={`Remove ${m.name}`}>Remove</Button> : <span className="invisible" aria-hidden><Button size="sm" icon={UserMinus} tabIndex={-1}>Remove</Button></span>}
        </div>
      ) : <Chip>{ROLE_LABEL[m.role] ?? m.role}</Chip>}
      {pendingRole && <ConfirmModal title="Change this role?" confirmLabel="Change role" busy={change.isPending} onConfirm={() => change.mutate(pendingRole)} onClose={() => setPendingRole(null)}><p>{m.name} becomes {ROLE_LABEL[pendingRole]}. {ROLE_CAN[pendingRole]}</p><p className="text-[13px] text-muted">No role can read another person's mail.</p></ConfirmModal>}
      {confirm && <ConfirmModal title={`Remove ${m.name}?`} danger confirmLabel="Remove from workspace" busy={remove.isPending} onConfirm={() => remove.mutate()} onClose={() => setConfirm(false)}><p>They lose access to this workspace. Mailboxes they connected here are disconnected and their cached mail is deleted, along with anything they shared or had shared with them. Nobody else gains access to their mail.</p></ConfirmModal>}
    </li>
  );
}

export default function MembersPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const members = useApi<Member[]>(["org", "members"], "/org/members", { retry: false });
  const canInvite = !!me && ["owner", "workspace_manager"].includes(me.role);
  const canChange = me?.role === "owner";
  const invites = useApi<{ id: string; email: string; role: string; expiresAt: string }[]>(["org", "invites"], canInvite ? "/org/invites" : null, { retry: false });
  const changed = () => { void qc.invalidateQueries({ queryKey: ["org", "members"] }); void qc.invalidateQueries({ queryKey: ["org", "invites"] }); };
  return (
    <>
      <Head title="Members and roles" description="Who's in this workspace and what they can manage. Managing people never includes reading their mail." />
      {members.error?.status === 403 ? (
        <NoAccess title="Team access denied">Your role doesn't include the member list. A workspace owner or manager can tell you who's here.</NoAccess>
      ) : (
        <div className="space-y-4">
          {canInvite ? <Invite onDone={changed} /> : me && <Banner tone="neutral" icon={Lock}>Only owners and workspace managers can invite people. Only owners can change roles or remove members.</Banner>}
          {me?.role === "workspace_manager" && <Banner tone="neutral" icon={Lock}>You can invite people. Only owners can change roles or remove members.</Banner>}
          <section aria-labelledby="members-heading">
            <h2 id="members-heading" className="mb-2 text-[15px] font-semibold">Members{members.data ? ` (${members.data.length})` : ""}</h2>
            {members.isLoading ? <PageSkeleton blocks={2} /> : members.error ? <ErrorState error={members.error} retry={() => members.refetch()} /> : <ul className="rounded-xl bg-surface">{members.data?.map(m => <Row key={m.id} m={m} isSelf={m.id === me?.id} canChange={canChange} onDone={changed} />)}</ul>}
          </section>
          {canInvite && (
            <Card title="Pending invitations" description="Invitations stop working after 7 days, or when you withdraw them.">
              {invites.isLoading ? <PageSkeleton blocks={1} /> : invites.error ? <ErrorState error={invites.error} retry={() => invites.refetch()} /> : !invites.data?.length ? <p className="text-sm text-muted">No pending invitations.</p> : <ul className="divide-y divide-line">{invites.data.map(i => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]" data-testid="invite-row"><span className="min-w-0"><span className="font-medium break-all">{i.email}</span> <span className="text-muted">as {ROLE_LABEL[i.role] ?? i.role}, expires {fmtDate(i.expiresAt)}</span></span><Button size="sm" variant="ghost" aria-label={`Withdraw invitation for ${i.email}`} onClick={async () => { await api(`/org/invites/${i.id}`, { method: "DELETE" }); changed(); }}>Withdraw</Button></li>)}</ul>}
            </Card>
          )}
          <Card title="What each role can do">
            <dl className="space-y-1.5">{ROLES.map(r => <div key={r} className="text-[13px]"><dt className="inline font-medium">{ROLE_LABEL[r]}: </dt><dd className="inline text-muted">{ROLE_CAN[r]}</dd></div>)}</dl>
            <p className="mt-2 text-[13px] font-medium">No role can read another person's mail.</p>
          </Card>
        </div>
      )}
    </>
  );
}
