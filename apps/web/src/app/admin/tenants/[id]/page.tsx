"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ConfirmModal, fmtDate, fmtDateTime, Head, PageSkeleton, PROVIDER_LABEL, TableScroll, tdClass, textareaClass, TextPair, thClass } from "@/components/settings/common";
import { Banner, Button, Card, Chip, ErrorState, Field, inputClass } from "@/components/ui";
import { api, useAction, useApi } from "@/lib/client";

interface Detail {
  tenant: { id: string; name: string; kind: string; members: number; mailboxes: number; createdAt: string; suspendedAt: string | null; suspendedReason: string | null };
  mailboxes: { provider: string; status: string; count: number }[];
  usage: { period: string; metric: string; value: number }[];
  overrides: { key: string; value: number | null; reason: string; expiresAt: string | null; updatedAt: string }[];
  /** What applies now. Null is no limit. */
  limits: { key: string; value: number | null; instanceDefault: number | null; source: "override" | "instance" | "none" }[];
}

const KEYS: { key: string; label: string }[] = [
  { key: "accounts", label: "Connected accounts per person" }, { key: "aiActionsPerMonth", label: "Hosted AI actions a month" }, { key: "automations", label: "Rules per person" },
  { key: "seats", label: "Members" }, { key: "indexBytes", label: "Search storage, in bytes" },
];
const MAILBOX_STATUS: Record<string, string> = { connecting: "Connecting", active: "Active", paused: "Paused", reconnect_required: "Needs reconnecting", disconnected: "Disconnected", error: "Error" };
const METRIC: Record<string, string> = { ai_actions: "AI actions", aiActions: "AI actions", messages_analyzed: "Messages analyzed", index_bytes: "Search storage", indexBytes: "Search storage" };
const monthName = (p: string) => { const [y, m] = p.split("-").map(Number); return y && m ? new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) : p; };
const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;
const fmtValue = (k: string, v: number | null) => v === null ? "No limit" : k === "indexBytes" ? fmtBytes(v) : v.toLocaleString();
const keyLabel = (k: string) => KEYS.find(x => x.key === k)?.label ?? k;
const REASON_HINT = "Required. The tenant's owner sees this in their audit log, so don't include anything sensitive.";

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<Detail>(["operator", "tenant", id], `/operator/tenants/${id}`, { retry: false });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["operator"] }); };

  const [oKey, setOKey] = useState("accounts");
  const [oValue, setOValue] = useState("");
  const [oNone, setONone] = useState(false);
  const [oReason, setOReason] = useState("");
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [contactReason, setContactReason] = useState("");
  const [contact, setContact] = useState<{ name: string; email: string } | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const [clearReason, setClearReason] = useState("");

  const setOverride = useAction<void>(() => api(`/operator/tenants/${id}/overrides`, { body: { key: oKey, value: oNone ? null : Number(oValue), reason: oReason } }), { refresh: false, success: "Limit saved. The tenant's owner can see it.", onDone: () => { setOReason(""); setOValue(""); setONone(false); refresh(); } });
  const clearOverride = useAction<void>(() => api(`/operator/tenants/${id}/overrides/clear`, { body: { key: clearing, reason: clearReason } }), { refresh: false, success: "Back to the server default.", onDone: () => { setClearing(null); setClearReason(""); refresh(); } });
  const suspend = useAction<void>(() => api(`/operator/tenants/${id}/suspend`, { body: { reason: suspendReason } }), { refresh: false, success: "Tenant suspended. Nothing was deleted.", onDone: () => { setSuspendOpen(false); setSuspendReason(""); refresh(); } });
  const unsuspend = useAction<void>(() => api(`/operator/tenants/${id}/unsuspend`, { body: { reason: suspendReason } }), { refresh: false, success: "Suspension lifted.", onDone: () => { setSuspendOpen(false); setSuspendReason(""); refresh(); } });
  const reveal = useAction<void, { name: string; email: string }>(() => api(`/operator/tenants/${id}/owner-contact`, { body: { reason: contactReason } }), { refresh: false, onDone: r => { setContact(r); setContactReason(""); refresh(); } });

  if (isLoading) return <PageSkeleton blocks={3} />;
  if (error || !data) return <ErrorState error={error ?? { message: "This didn't load." }} retry={() => refetch()} />;
  const t = data.tenant;
  const suspended = !!t.suspendedAt;
  const reasonOk = (s: string) => s.trim().length >= 3;

  return (
    <>
      <Head title={t.name} back={{ href: "/admin/tenants", label: "All tenants" }} description={<>{t.kind === "personal" ? "Personal workspace" : "Organization"}, created {fmtDate(t.createdAt)}.<span className="mt-0.5 block font-mono text-xs select-all">{t.id}</span></>} action={<Chip tone={suspended ? "danger" : "neutral"}>{suspended ? "Suspended" : "Active"}</Chip>} />
      <div className="space-y-4">
        {suspended && <Banner tone="danger">Suspended {fmtDateTime(t.suspendedAt!)}. Reason given: {t.suspendedReason}</Banner>}
        <Card title="Usage">
          <dl className="space-y-1">
            <TextPair term="Members">{t.members.toLocaleString()}</TextPair>
            <TextPair term="Active mailboxes">{t.mailboxes.toLocaleString()}</TextPair>
          </dl>
          {!!data.mailboxes.length && <div className="mt-3"><TableScroll label="Mailboxes by provider and status"><table className="w-full min-w-[20rem] border-collapse bg-surface"><thead><tr><th scope="col" className={thClass}>Provider</th><th scope="col" className={thClass}>Status</th><th scope="col" className={thClass}>Count</th></tr></thead><tbody>{data.mailboxes.map(m => <tr key={`${m.provider}-${m.status}`}><td className={tdClass}>{PROVIDER_LABEL[m.provider] ?? m.provider}</td><td className={tdClass}>{MAILBOX_STATUS[m.status] ?? m.status.replace(/_/g, " ")}</td><td className={`${tdClass} tabular-nums`}>{m.count}</td></tr>)}</tbody></table></TableScroll></div>}
          {!!data.usage.length && <div className="mt-3"><TableScroll label="Usage by month"><table className="w-full min-w-[20rem] border-collapse bg-surface"><thead><tr><th scope="col" className={thClass}>Month</th><th scope="col" className={thClass}>Metric</th><th scope="col" className={thClass}>Value</th></tr></thead><tbody>{data.usage.map(u => <tr key={`${u.period}-${u.metric}`}><td className={`${tdClass} whitespace-nowrap`}>{monthName(u.period)}</td><td className={tdClass}>{METRIC[u.metric] ?? u.metric}</td><td className={`${tdClass} tabular-nums`}>{u.metric.toLowerCase().includes("bytes") ? fmtBytes(u.value) : u.value.toLocaleString()}</td></tr>)}</tbody></table></TableScroll></div>}
        </Card>

        <Card title="Limits" description="None unless someone sets one. A limit set here applies to this tenant only, over the server's default. Safety features aren't limits and can't be turned off.">
          <ul className="mb-3 divide-y divide-line rounded-lg border border-line" data-testid="limit-list">
            {data.limits.map(l => {
              const o = data.overrides.find(x => x.key === l.key);
              return (
                <li key={l.key} className="flex flex-wrap items-start justify-between gap-2 p-2.5 text-[13px]">
                  <div className="min-w-0">
                    <p><span className="font-medium">{keyLabel(l.key)}:</span> {fmtValue(l.key, l.value)}{l.source === "instance" && <span className="text-muted"> (server default)</span>}</p>
                    {l.source === "override" && o && <><p className="text-muted">{o.reason}</p><p className="text-xs text-muted">Set here {fmtDateTime(o.updatedAt)}{o.expiresAt ? `, until ${fmtDate(o.expiresAt)}` : ""}. Server default: {fmtValue(l.key, l.instanceDefault)}.</p></>}
                  </div>
                  {o && <Button size="sm" onClick={() => setClearing(l.key)} aria-label={`Use the server default for ${keyLabel(l.key)}`}>Use default</Button>}
                </li>
              );
            })}
          </ul>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); setOverride.mutate(); }}>
            <Field label="Limit"><select className={inputClass} value={oKey} onChange={e => setOKey(e.target.value)}>{KEYS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}</select></Field>
            <Field label="Value"><input className={inputClass} type="number" min={0} step={1} required={!oNone} disabled={oNone} value={oNone ? "" : oValue} onChange={e => setOValue(e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-[13px] sm:col-span-2"><input type="checkbox" className="size-4 accent-[var(--accent)]" checked={oNone} onChange={e => setONone(e.target.checked)} />No limit for this tenant, whatever the server default is</label>
            <div className="sm:col-span-2"><Field label="Reason" hint={REASON_HINT}><textarea className={textareaClass} rows={2} required minLength={3} maxLength={500} value={oReason} onChange={e => setOReason(e.target.value)} /></Field></div>
            <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={setOverride.isPending} disabled={!reasonOk(oReason) || (!oNone && oValue === "")}>Save limit</Button></div>
          </form>
        </Card>

        <Card title="Owner contact" description="Only for a support need. Viewing it is logged here and in the tenant's own audit log.">
          {contact ? <p className="text-sm" data-testid="owner-contact">{contact.name}, <span className="font-medium">{contact.email}</span></p> : (
            <form className="grid gap-3" onSubmit={e => { e.preventDefault(); reveal.mutate(); }}>
              <Field label="Reason" hint={REASON_HINT}><textarea className={textareaClass} rows={2} required minLength={3} maxLength={500} value={contactReason} onChange={e => setContactReason(e.target.value)} /></Field>
              <div><Button type="submit" loading={reveal.isPending} disabled={!reasonOk(contactReason)}>Show owner contact</Button></div>
            </form>
          )}
        </Card>

        <Card title={suspended ? "Lift suspension" : "Suspend for abuse"} description="Suspending blocks sign-in and stops sync. Nothing is deleted, and pending deletions wait. The tenant sees this in its audit log, and the reason at sign-in.">
          <Button variant={suspended ? "secondary" : "danger"} onClick={() => setSuspendOpen(true)}>{suspended ? "Lift suspension" : "Suspend this tenant"}</Button>
        </Card>
      </div>

      {suspendOpen && (
        <ConfirmModal title={suspended ? "Lift this suspension?" : `Suspend ${t.name}?`} confirmLabel={suspended ? "Lift suspension" : "Suspend tenant"} danger={!suspended} busy={suspend.isPending || unsuspend.isPending} onConfirm={() => { if (reasonOk(suspendReason)) (suspended ? unsuspend : suspend).mutate(); }} onClose={() => setSuspendOpen(false)}>
          <p>{suspended ? "Members can sign in again, and sync resumes on the next schedule." : "Members can't sign in and sync stops, until someone lifts this. No mail or settings are deleted."}</p>
          <Field label="Reason" hint={suspended ? REASON_HINT : "Required. Shown to the tenant's members when they try to sign in, and in their audit log."}><textarea className={textareaClass} rows={2} required minLength={3} maxLength={500} value={suspendReason} onChange={e => setSuspendReason(e.target.value)} /></Field>
          {!reasonOk(suspendReason) && <p className="text-[13px] text-muted">Enter a reason to continue.</p>}
        </ConfirmModal>
      )}
      {clearing && (
        <ConfirmModal title={`Use the server default for ${keyLabel(clearing)}?`} confirmLabel="Use default" busy={clearOverride.isPending} onConfirm={() => { if (reasonOk(clearReason)) clearOverride.mutate(); }} onClose={() => setClearing(null)}>
          <Field label="Reason" hint={REASON_HINT}><textarea className={textareaClass} rows={2} required minLength={3} maxLength={500} value={clearReason} onChange={e => setClearReason(e.target.value)} /></Field>
        </ConfirmModal>
      )}
    </>
  );
}
