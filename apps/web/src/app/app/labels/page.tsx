"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Tag, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ConfirmModal, linkClass, Page, PageSkeleton } from "@/components/settings/common";
import { Banner, Button, Card, EmptyState, ErrorState, Field, IconButton, inputClass } from "@/components/ui";
import { canLabel, labelReach, type LabelRow } from "@/components/workspace/label-dialog";
import { api, useAccounts, useAction, useApi, type Account } from "@/lib/client";

const DEFAULT_COLOR = "#2f6f5e";

function CreateLabel({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  useEffect(() => { if (!accountId && accounts.length) setAccountId((accounts.find(a => a.isPrimary) ?? accounts[0])!.id); }, [accountId, accounts]);
  const create = useAction<void>(() => api("/labels", { body: { accountId, name: name.trim(), color } }), { success: "Label created.", onDone: () => { setName(""); onDone(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (name.trim() && accountId) create.mutate(); };
  const account = accounts.find(a => a.id === accountId);
  return (
    <Card title="Create a label" description="Labels belong to one mailbox. Use the same name in two mailboxes to apply it across a selection.">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Name"><input className={inputClass} value={name} maxLength={64} onChange={e => setName(e.target.value)} /></Field>
          <Field label="Mailbox"><select className={inputClass} value={accountId} onChange={e => setAccountId(e.target.value)}>{accounts.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select></Field>
          <Field label="Color"><input type="color" className="h-9 w-14 cursor-pointer rounded-lg border border-line-strong bg-surface p-1" value={color} onChange={e => setColor(e.target.value)} /></Field>
        </div>
        {account && labelReach(account) && <p className="text-[13px] text-muted">{labelReach(account)}</p>}
        <Button type="submit" variant="primary" icon={Plus} disabled={!name.trim() || !accountId} loading={create.isPending}>Create label</Button>
      </form>
    </Card>
  );
}

function LabelItem({ l, account, onChange }: { l: LabelRow; account?: Account; onChange: () => void }) {
  const [color, setColor] = useState(l.color ?? DEFAULT_COLOR);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setColor(l.color ?? DEFAULT_COLOR), [l.color]);
  const editable = canLabel(account);
  // Creating with the same name in the same mailbox updates its color. That's the API's upsert.
  const save = useAction<string>(c => api("/labels", { body: { accountId: l.accountId, name: l.name, color: c } }), { success: "Color saved.", onDone: onChange });
  const del = useAction<void>(() => api(`/labels/${l.id}`, { method: "DELETE" }), { success: `Deleted ${l.name}.`, onDone: () => { setConfirm(false); onChange(); } });
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0" data-testid="label-row">
      <Tag className="size-4 shrink-0" style={{ color: l.color ?? undefined }} aria-hidden />
      <div className="min-w-0 flex-1 basis-40 text-sm">
        <Link href={`/app/inbox?label=${l.id}`} className="font-medium break-words underline-offset-2 hover:underline">{l.name}</Link>
        <p className="text-[13px] text-muted">{account?.displayName ?? "A mailbox"} · {l.count ?? 0} {l.count === 1 ? "message" : "messages"}</p>
      </div>
      {editable && (
        <span className="flex items-center gap-1">
          <input type="color" aria-label={`Color for ${l.name}`} className="h-8 w-10 cursor-pointer rounded-lg border border-line-strong bg-surface p-0.5" value={color} onChange={e => setColor(e.target.value)} onBlur={() => { if (color.toLowerCase() !== (l.color ?? "").toLowerCase()) save.mutate(color); }} />
          <IconButton icon={Trash2} label={`Delete label ${l.name}`} onClick={() => setConfirm(true)} />
        </span>
      )}
      {confirm && <ConfirmModal title={`Delete ${l.name}?`} danger confirmLabel="Delete label" busy={del.isPending} onConfirm={() => del.mutate()} onClose={() => setConfirm(false)}><p>It comes off {l.count ?? 0} {l.count === 1 ? "message" : "messages"} here. The mail itself isn't touched.</p><p className="text-muted">A label at your provider stays there, because this app can't delete those. A rule that adds this label creates it again.</p></ConfirmModal>}
    </li>
  );
}

export default function LabelsPage() {
  const qc = useQueryClient();
  const { data: labels, isLoading, error, refetch } = useApi<LabelRow[]>(["labels"], "/labels");
  const { data: accounts } = useAccounts();
  const editable = accounts?.filter(canLabel) ?? [];
  const changed = () => void qc.invalidateQueries({ queryKey: ["labels"] });
  return (
    <Page width="4xl" title="Labels" description="Your own way of sorting mail. Apply them from a conversation or a selection, or press l.">
      <div className="space-y-4">
        {accounts && !editable.length ? <Banner tone="neutral">None of your mailboxes can hold labels here. Shared, read-only and POP3 connections can't. <Link href="/app/connect" className={linkClass}>Connect a mailbox</Link></Banner> : <CreateLabel accounts={editable} onDone={changed} />}
        <section aria-labelledby="your-labels">
          <h2 id="your-labels" className="mb-2 text-[15px] font-semibold">Your labels{labels ? ` (${labels.length})` : ""}</h2>
          {isLoading ? <PageSkeleton blocks={2} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !labels?.length ? (
            <div className="rounded-xl bg-surface"><EmptyState icon={Tag} title="No labels yet">Create one above. Rules can add labels too.</EmptyState></div>
          ) : <ul className="rounded-xl bg-surface">{labels.map(l => <LabelItem key={l.id} l={l} account={accounts?.find(a => a.id === l.accountId)} onChange={changed} />)}</ul>}
        </section>
      </div>
    </Page>
  );
}
