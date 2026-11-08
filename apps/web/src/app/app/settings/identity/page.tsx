"use client";
import { AtSign, Pencil, Plus, Save, Signature as SignatureIcon, Star, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ConfirmModal, Details, Head, linkClass, PageSkeleton, textareaClass, usePrefPatch } from "@/components/settings/common";
import { Button, Chip, EmptyState, ErrorState, Field, IconButton, inputClass } from "@/components/ui";
import { sendableAccounts } from "@/components/workspace/composer";
import { api, useAccounts, useAction, usePrefs, type Account } from "@/lib/client";

interface Signature { id: string; accountId: string; name: string; text: string; isDefault: boolean }

function SignatureForm({ initial, onSave, onCancel, busy }: { initial?: Signature; onSave: (s: { name: string; text: string }) => void; onCancel?: () => void; busy: boolean }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [text, setText] = useState(initial?.text ?? "");
  const submit = (e: FormEvent) => { e.preventDefault(); if (!name.trim() || !text.trim()) return; onSave({ name: name.trim(), text: text.trim() }); if (!initial) { setName(""); setText(""); } };
  return (
    <form onSubmit={submit} className="space-y-2">
      <Field label="Signature name"><input className={inputClass} maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="Work" /></Field>
      <Field label="Text" hint="Plain text. It's added below your message."><textarea className={textareaClass} rows={3} maxLength={2000} value={text} onChange={e => setText(e.target.value)} /></Field>
      <div className="flex gap-2"><Button type="submit" size="sm" icon={initial ? Save : Plus} disabled={!name.trim() || !text.trim()} loading={busy}>{initial ? "Save signature" : "Add signature"}</Button>{onCancel && <Button size="sm" icon={X} onClick={onCancel}>Cancel</Button>}</div>
    </form>
  );
}

function AccountIdentity({ a, all }: { a: Account; all: Signature[] }) {
  const patch = usePrefPatch("Saved.");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Signature | null>(null);
  const [address, setAddress] = useState("");
  const [aliasName, setAliasName] = useState("");
  const saveAliases = useAction<{ address: string; name?: string }[]>(aliases => api(`/accounts/${a.id}`, { method: "PATCH", body: { aliases } }), { success: "Addresses saved.", onDone: () => { setAddress(""); setAliasName(""); } });
  const mine = all.filter(s => s.accountId === a.id);
  const write = (next: Signature[]) => patch.mutate({ signatures: next });
  const addAlias = (e: FormEvent) => {
    e.preventDefault();
    const v = address.trim().toLowerCase();
    if (!v || v === a.email.toLowerCase() || a.aliases.some(x => x.address.toLowerCase() === v)) return;
    saveAliases.mutate([...a.aliases, { address: v, ...(aliasName.trim() ? { name: aliasName.trim() } : {}) }]);
  };
  return (
    <li className="rounded-xl bg-surface p-4" data-testid="identity-account">
      <div className="flex flex-wrap items-center gap-2"><span aria-hidden className="size-3 shrink-0 rounded-full" style={{ background: a.color }} /><h2 className="min-w-0 text-[15px] font-semibold break-words">{a.displayName}</h2>{!a.owned && <Chip>Shared, sends as owner</Chip>}</div>
      <p className="mt-0.5 text-[13px] break-all text-muted">{a.email}</p>

      <h3 className="mt-3 flex items-center gap-1.5 text-[13px] font-semibold"><SignatureIcon className="size-3.5" aria-hidden />Signatures</h3>
      {!mine.length ? <p className="mt-1 text-[13px] text-muted">None yet.</p> : (
        <ul className="mt-1 divide-y divide-line">
          {mine.map(s => (
            <li key={s.id} className="py-2" data-testid="signature-row">
              {editing === s.id ? <SignatureForm initial={s} busy={patch.isPending} onCancel={() => setEditing(null)} onSave={v => { write(all.map(x => x.id === s.id ? { ...x, ...v } : x)); setEditing(null); }} /> : (
                <div className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1 text-[13px]"><p className="flex flex-wrap items-center gap-1.5 font-medium">{s.name}{s.isDefault && <Chip tone="accent"><Star className="size-3" aria-hidden />Default</Chip>}</p><p className="mt-0.5 break-words whitespace-pre-wrap text-muted">{s.text}</p></div>
                  {!s.isDefault && <Button size="sm" variant="ghost" onClick={() => write(all.map(x => x.accountId === a.id ? { ...x, isDefault: x.id === s.id } : x))} aria-label={`Make ${s.name} the default`}>Make default</Button>}
                  <IconButton icon={Pencil} label={`Edit signature ${s.name}`} onClick={() => setEditing(s.id)} />
                  <IconButton icon={Trash2} label={`Delete signature ${s.name}`} onClick={() => setRemoving(s)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding ? <div className="mt-2"><SignatureForm busy={patch.isPending} onCancel={() => setAdding(false)} onSave={v => { write([...all, { id: crypto.randomUUID(), accountId: a.id, ...v, isDefault: !mine.length }]); setAdding(false); }} /></div> : <Button size="sm" className="mt-2" icon={Plus} onClick={() => setAdding(true)}>Add a signature</Button>}

      <h3 className="mt-4 flex items-center gap-1.5 border-t border-line pt-3 text-[13px] font-semibold"><AtSign className="size-3.5" aria-hidden />Other addresses it can send as</h3>
      {a.owned ? (
        <>
          {!a.aliases.length ? <p className="mt-1 text-[13px] text-muted">None. Mail sends from {a.email}.</p> : (
            <ul className="mt-1 divide-y divide-line">{a.aliases.map(al => <li key={al.address} className="flex items-center gap-2 py-1.5 text-[13px]" data-testid="alias-row"><span className="min-w-0 flex-1 break-all">{al.name ? `${al.name} ` : ""}&lt;{al.address}&gt;</span><IconButton icon={Trash2} label={`Remove address ${al.address}`} onClick={() => saveAliases.mutate(a.aliases.filter(x => x.address !== al.address))} /></li>)}</ul>
          )}
          <form onSubmit={addAlias} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Address"><input type="email" className={inputClass} value={address} onChange={e => setAddress(e.target.value)} placeholder="sales@example.com" /></Field>
            <Field label="Name shown (optional)"><input className={inputClass} maxLength={100} value={aliasName} onChange={e => setAliasName(e.target.value)} /></Field>
            <Button type="submit" size="md" disabled={!address.trim()} loading={saveAliases.isPending}>Add address</Button>
          </form>
        </>
      ) : <p className="mt-1 text-[13px] text-muted">{a.aliases.length ? a.aliases.map(x => x.address).join(", ") : "None."} Only this mailbox's owner can change these.</p>}
      {removing && <ConfirmModal title={`Delete ${removing.name}?`} danger confirmLabel="Delete signature" onConfirm={() => { const left = all.filter(x => x.id !== removing.id); if (removing.isDefault) { const next = left.find(x => x.accountId === a.id); if (next) next.isDefault = true; } write(left); setRemoving(null); }} onClose={() => setRemoving(null)}><p>Drafts that already include it keep their text.</p></ConfirmModal>}
    </li>
  );
}

export default function IdentityPage() {
  const { data: prefs, isLoading: loadingPrefs, error: prefsError, refetch } = usePrefs();
  const { data: accounts, isLoading } = useAccounts();
  const list = sendableAccounts(accounts);
  return (
    <>
      <Head title="Signatures and addresses" description="What your mail says at the end, and which addresses it can come from." />
      {isLoading || loadingPrefs ? <PageSkeleton blocks={2} /> : prefsError ? <ErrorState error={prefsError} retry={() => refetch()} /> : !list.length ? (
        <div className="rounded-xl bg-surface"><EmptyState icon={AtSign} title="No mailbox can send yet">Read-only and POP3 connections can't send. <Link href="/app/connect" className={linkClass}>Connect a mailbox</Link></EmptyState></div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-[13px] text-muted">Each person keeps their own signature, even in a shared mailbox. The composer always shows which address a message sends from.</p>
            <Details summary="Learn more about extra addresses" className="mt-1.5">
              <p>Set up an extra address at your mail provider first, as a send-as address or alias. If the provider doesn't accept it, it may refuse the message or use your main address instead, and a refused message comes back to Drafts.</p>
              <p>Mail only goes out from addresses listed here, so a reply can't be sent under one you didn't add.</p>
            </Details>
          </div>
          <ul className="space-y-3">{list.map(a => <AccountIdentity key={a.id} a={a} all={prefs?.signatures ?? []} />)}</ul>
        </div>
      )}
    </>
  );
}
