"use client";
import { ShieldCheck, Star, UserMinus, Users } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Head } from "@/components/settings/common";
import { Avatar, Banner, Button, Chip, EmptyState, ErrorState, ListSkeleton, Modal } from "@/components/ui";
import { api, relTime, useAccounts, useAction, useApi, usePrefs } from "@/lib/client";

interface Contact { id: string; name?: string; address: string; account: string; received: number; sentTo: number; replied: number; dismissed: number; vip: boolean; ignored: boolean; lastSeenAt: string; exception: { scope: "sender" | "domain"; by: "ai" | "user" } | null }

function AccountRanking() {
  const { data: accounts } = useAccounts();
  const { data: prefs } = usePrefs();
  const qc = useQueryClient();
  const save = useAction<Record<string, number>>(accountRanking => api("/preferences", { method: "PATCH", body: { accountRanking } }), { refresh: false, success: "Saved. This applies to new mail.", onDone: () => void qc.invalidateQueries({ queryKey: ["prefs"] }) });
  const ranking: Record<string, number> = prefs?.accountRanking ?? {};
  const owned = accounts?.filter(a => a.owned && a.status !== "disconnected") ?? [];
  if (owned.length < 2) return null;
  return (
    <section className="mb-4 rounded-xl bg-surface p-4">
      <h2 className="text-[15px] font-semibold">Rank whole accounts</h2>
      <p className="mt-0.5 text-[13px] text-muted">Applies to new mail in Focus. Security checks work the same for every account.</p>
      <ul className="mt-2 divide-y divide-line">{owned.map(a => (
        <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <label htmlFor={`rank-${a.id}`} className="min-w-0 truncate">{a.displayName}</label>
          <select id={`rank-${a.id}`} className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px]" value={String(ranking[a.id] ?? 0)} onChange={e => save.mutate({ ...ranking, [a.id]: Number(e.target.value) })}>
            <option value="0.5">Raise</option><option value="0">Normal</option><option value="-0.5">Lower</option>
          </select>
        </li>))}</ul>
    </section>
  );
}

export default function PeoplePage() {
  const { data, isLoading, error, refetch } = useApi<Contact[]>(["contacts"], "/contacts");
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["contacts"] });
  const set = useAction<{ id: string; vip?: boolean; ignored?: boolean; exception?: false }>(({ id, ...body }) => api(`/contacts/${id}`, { method: "PATCH", body }), { refresh: false, onDone: refresh });
  const reset = useAction<void, { reset: number }>(() => api("/contacts/reset-learning", { method: "POST" }), { refresh: false, success: "Learned preferences were reset.", onDone: () => { setConfirm(false); refresh(); } });
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <Head title="People and learning" description="What Focus has learned about who you correspond with. It's built only from your own mail and never shared with anyone else." action={<Button onClick={() => setConfirm(true)}>Reset what's learned</Button>} />
      <div className="mb-4"><Banner tone="neutral">People you know rise in Focus. Their mail is still fully checked for threats, because a familiar account can be taken over.</Banner></div>
      <AccountRanking />
      {isLoading ? <ListSkeleton /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? <EmptyState icon={Users} title="Nothing learned yet">People appear here as mail arrives.</EmptyState> : (
        <ul className="rounded-xl bg-surface">
          {data.map(c => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 border-b border-line p-3 last:border-b-0">
              <Avatar name={c.name} address={c.address} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5"><span className="truncate font-medium">{c.name || c.address}</span>{c.vip && <Chip tone="accent">Important</Chip>}{c.ignored && <Chip>Ignored</Chip>}{c.exception && <Chip>Cleared sender</Chip>}</div>
                <div className="truncate text-xs text-muted">{c.address} · {c.account}</div>
                <div className="mt-0.5 text-xs text-muted">Received {c.received} · You sent {c.sentTo} · Replies {c.replied}{c.dismissed ? ` · Marked not important ${c.dismissed}` : ""} · Last seen {relTime(c.lastSeenAt)}</div>
                {c.exception && <div className="mt-0.5 text-xs text-muted">{c.exception.by === "ai" ? "AI review cleared flagged mail from" : "You released flagged mail from"} {c.exception.scope === "domain" ? `everyone at ${c.address.split("@")[1]}` : "this address"}, so it isn't flagged for looking unfamiliar. Malware and forged mail are still stopped.</div>}
              </div>
              <div className="flex gap-1">
                {c.exception && <Button size="sm" icon={ShieldCheck} onClick={() => set.mutate({ id: c.id, exception: false })}>Remove exception</Button>}
                <Button size="sm" variant={c.vip ? "primary" : "secondary"} icon={Star} aria-pressed={c.vip} onClick={() => set.mutate({ id: c.id, vip: !c.vip, ignored: false })}>Important</Button>
                <Button size="sm" variant={c.ignored ? "primary" : "secondary"} icon={UserMinus} aria-pressed={c.ignored} onClick={() => set.mutate({ id: c.id, ignored: !c.ignored, vip: false })}>Ignore</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirm && <Modal title="Reset what's learned?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" loading={reset.isPending} onClick={() => reset.mutate()}>Reset</Button></>}><p className="text-sm">This clears important and ignored marks and reply history. Mail, rules and message counts stay. Focus relearns as mail arrives.</p></Modal>}
    </>
  );
}
