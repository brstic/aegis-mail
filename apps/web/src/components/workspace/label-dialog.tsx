"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Tag } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { api, ApiError, useAccounts, useApi, useRefreshMail, useToast, type Account } from "@/lib/client";
import { Banner, Button, Field, inputClass, Modal } from "../ui";

export interface LabelRow { id: string; name: string; color: string | null; accountId: string; count?: number }
export interface LabelTarget { id: string; accountId: string; labels: { id: string; name: string }[] }

/** What a label does at this kind of mailbox. Shown where people choose one, so nobody assumes it reached their provider. */
export function labelReach(a: Pick<Account, "kind">) {
  if (a.kind === "gmail") return "Also applied as a Gmail label.";
  if (a.kind === "microsoft") return "Also applied as an Outlook category.";
  // The demo mailbox has no provider, so there is nothing extra to say.
  if (a.kind === "demo") return "";
  return "Stays in Aegis Mail. IMAP servers have folders, not labels.";
}
export const canLabel = (a?: Account) => !!a && a.owned && !a.readOnly && a.capabilities.labels !== "none";

/**
 * Labels belong to one mailbox, so a mixed selection is matched by name. A conversation in a mailbox without that label
 * is left alone, and the result says so rather than creating labels nobody asked for.
 */
export function LabelDialog({ targets, onClose }: { targets: LabelTarget[]; onClose: () => void }) {
  const { data: accounts } = useAccounts();
  const { data: labels, isLoading } = useApi<LabelRow[]>(["labels"], "/labels");
  const toast = useToast();
  const refresh = useRefreshMail();
  const qc = useQueryClient();
  const [state, setState] = useState(() => targets.map(t => ({ ...t, labels: [...t.labels] })));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accountIds = useMemo(() => [...new Set(targets.map(t => t.accountId))], [targets]);
  const editable = accountIds.filter(id => canLabel(accounts?.find(a => a.id === id)));
  const blocked = accountIds.filter(id => !editable.includes(id));
  const names = useMemo(() => [...new Set((labels ?? []).filter(l => editable.includes(l.accountId)).map(l => l.name))].sort((a, b) => a.localeCompare(b)), [labels, editable]);
  const inScope = state.filter(t => editable.includes(t.accountId));
  const labelFor = (labelName: string, accountId: string) => labels?.find(l => l.name === labelName && l.accountId === accountId);
  const applied = (labelName: string) => { const on = inScope.filter(t => t.labels.some(l => l.name === labelName)).length; return on === 0 ? "none" : on === inScope.length ? "all" : "some"; };

  const setOn = async (labelName: string, on: boolean, list = labels) => {
    setError(null); setBusy(true);
    const lookup = (accountId: string) => list?.find(l => l.name === labelName && l.accountId === accountId);
    const work = inScope.filter(t => t.labels.some(l => l.name === labelName) !== on);
    const skipped = work.filter(t => !lookup(t.accountId));
    const runnable = work.filter(t => lookup(t.accountId));
    const apply = (ids: Set<string>, value: boolean) => setState(s => s.map(t => {
      if (!ids.has(t.id)) return t;
      const l = lookup(t.accountId)!;
      return { ...t, labels: value ? [...t.labels.filter(x => x.name !== labelName), { id: l.id, name: l.name }] : t.labels.filter(x => x.name !== labelName) };
    }));
    // The box answers the click at once. Anything the server refuses goes back, with the reason shown below.
    apply(new Set(runnable.map(t => t.id)), on);
    const results = await Promise.allSettled(runnable.map(t => api(`/threads/${t.id}/actions`, { body: { action: on ? "label" : "unlabel", labelId: lookup(t.accountId)!.id } })));
    const done = new Set(runnable.filter((_, i) => results[i]!.status === "fulfilled").map(t => t.id));
    apply(new Set(runnable.filter(t => !done.has(t.id)).map(t => t.id)), !on);
    setBusy(false);
    refresh();
    const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) setError(failed.reason instanceof ApiError ? failed.reason.message : "That label couldn't be changed.");
    if (done.size) {
      const ids = [...done];
      toast({ text: `${on ? "Added" : "Removed"} ${labelName}${ids.length > 1 ? ` on ${ids.length} conversations` : ""}.${skipped.length ? ` Skipped ${skipped.length}: that mailbox has no such label.` : ""}`, action: { label: "Undo", run: () => { void Promise.all(runnable.filter(t => done.has(t.id)).map(t => api(`/threads/${t.id}/actions`, { body: { action: on ? "unlabel" : "label", labelId: lookup(t.accountId)!.id } }))).then(refresh); } } });
    } else if (skipped.length) setError(`None of the selected mailboxes have the label ${labelName}.`);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || !editable.length) return;
    setError(null); setBusy(true);
    try {
      // A new label goes in every mailbox in the selection, so applying it can't half work.
      const created = await Promise.all(editable.map(async accountId => ({ ...(await api<{ id: string; name: string; color: string | null }>("/labels", { body: { accountId, name: n } })), accountId })));
      const next = [...(labels ?? []).filter(l => !(l.name === n && editable.includes(l.accountId))), ...created];
      qc.setQueryData(["labels"], next);
      setName("");
      await setOn(n, true, next);
    } catch (err) { setError(err instanceof ApiError ? err.message : "That label couldn't be created."); }
    finally { setBusy(false); }
  };

  const reach = editable.length === 1 ? accounts?.find(a => a.id === editable[0]) : undefined;
  return (
    <Modal title={targets.length > 1 ? `Labels for ${targets.length} conversations` : "Labels"} onClose={onClose} footer={<><Link href="/app/labels" onClick={onClose} className="mr-auto self-center text-[13px] font-medium text-accent underline underline-offset-2">Manage labels</Link><Button variant="primary" onClick={onClose}>Done</Button></>}>
      <div className="space-y-3 text-sm" data-testid="label-dialog">
        {blocked.length > 0 && <Banner tone="neutral">{editable.length ? "Some of these are" : "This is"} in a shared, read-only or POP3 mailbox, where labels can't be changed from here.</Banner>}
        {reach && labelReach(reach) && <p className="text-[13px] text-muted">{labelReach(reach)}</p>}
        {editable.length > 1 && <p className="text-[13px] text-muted">These are in {editable.length} mailboxes. Each mailbox has its own labels, matched here by name.</p>}
        {isLoading ? <p className="text-[13px] text-muted">Loading labels</p> : !names.length ? <p className="text-[13px] text-muted">No labels here yet. Name one below to create and apply it.</p> : (
          <fieldset className="min-w-0">
            <legend className="sr-only">Apply labels</legend>
            <ul className="max-h-64 overflow-auto rounded-lg border border-line">
              {names.map(n => {
                const a = applied(n);
                const c = editable.map(id => labelFor(n, id)).find(Boolean)?.color;
                return (
                  <li key={n} className="border-b border-line last:border-b-0">
                    <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-2 hover:bg-surface-2">
                      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={a === "all"} ref={el => { if (el) el.indeterminate = a === "some"; }} onChange={e => void setOn(n, e.target.checked)} />
                      <Tag className="size-3.5 shrink-0" style={{ color: c ?? undefined }} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{n}</span>
                      {a === "some" && <span className="text-xs text-muted">On some</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {editable.length > 0 && (
          <form onSubmit={create} className="flex items-end gap-2">
            <div className="min-w-0 flex-1"><Field label="New label"><input className={inputClass} value={name} maxLength={64} onChange={e => setName(e.target.value)} /></Field></div>
            <Button type="submit" icon={Plus} disabled={!name.trim() || busy}>Create and apply</Button>
          </form>
        )}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}
