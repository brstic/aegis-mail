"use client";
import { BarChart3, EyeOff, Layers, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDate, NoAccess, Page, PageSkeleton, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Banner, Card, Chip, EmptyState, ErrorState, Field, inputClass, RISK } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Overview { coverage?: { status: string; count: number }[]; days: number; byLabel: { label: string; count: number }[]; byCategory: { category: string; count: number }[]; trend: { day: string; flagged: number | null; total: number }[]; reports: { kind: string; count: number }[]; actions: { action: string; count: number }[]; members: number; campaigns?: { count: number; messages: number } }
const CATEGORY: Record<string, string> = { spam: "Spam", credential_phish: "Password phishing", bec: "Business email compromise", invoice_fraud: "Invoice fraud", brand_spoof: "Brand impersonation", malware: "Malware", malicious_link: "Malicious link", qr_phish: "QR code phishing", reply_chain_hijack: "Hijacked reply chain", callback_phish: "Callback phishing", lure_recruiting_tax_shipping: "Recruiting, tax or shipping lure", tracking: "Tracking", prompt_injection: "Prompt injection" };
const ACTION: Record<string, string> = { allow: "Delivered normally", annotate: "Delivered with a note", warn: "Delivered with a warning", move_to_spam: "Moved to Spam", quarantine: "Blocked" };
const REPORT: Record<string, string> = { report_phishing: "Reported as phishing by people", not_a_threat: "False positives: marked not a threat by people" };
const human = (s: string) => s.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });

function Stat({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return <div className="rounded-xl bg-surface p-3"><dt className="text-[13px] text-muted">{label}</dt><dd className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</dd>{note && <dd className="mt-0.5 text-xs text-muted">{note}</dd>}</div>;
}

/** One series, one axis. Every day in the range gets a slot, so quiet days are visible. The table under it is the full text alternative. */
function TrendChart({ trend, days }: { trend: Overview["trend"]; days: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const series = useMemo(() => {
    const byDay = new Map(trend.map(t => [t.day, t]));
    const out: { day: string; flagged: number; total: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      const t = byDay.get(d);
      out.push({ day: d, flagged: t?.flagged ?? 0, total: t?.total ?? 0 });
    }
    return out;
  }, [trend, days]);
  const H = 160, top = 8, bottom = 4;
  const max = Math.max(1, ...series.map(s => s.flagged));
  const slot = width / series.length;
  const gap = slot >= 6 ? 2 : 0;
  const barW = Math.max(1, Math.min(28, slot - gap));
  const totalFlagged = series.reduce((s, x) => s + x.flagged, 0);
  const peak = series.reduce((a, b) => (b.flagged > a.flagged ? b : a), series[0]!);
  const summary = totalFlagged === 0 ? `No flagged messages in the last ${days} days.` : `${totalFlagged} flagged messages in the last ${days} days. The busiest day was ${dayLabel(peak.day)} with ${peak.flagged}.`;
  const active = hover !== null ? series[hover] : null;
  return (
    <div>
      <p className="text-sm">{summary}</p>
      <p className="mt-1 h-5 text-[13px] text-muted" aria-hidden>{active ? `${dayLabel(active.day)}: ${active.flagged} flagged of ${active.total}` : `Most on one day: ${max === 1 && totalFlagged === 0 ? 0 : max}`}</p>
      <div ref={box} className="mt-1">
        <svg role="img" aria-label={`Bar chart of flagged messages per day. ${summary}`} width={width} height={H} viewBox={`0 0 ${width} ${H}`} className="block max-w-full" onMouseLeave={() => setHover(null)}>
          <line x1={0} x2={width} y1={H - bottom + 0.5} y2={H - bottom + 0.5} stroke="var(--border-strong)" />
          {series.map((s, i) => {
            const h = s.flagged ? Math.max(3, (s.flagged / max) * (H - top - bottom)) : 0;
            const x = i * slot + (slot - barW) / 2, y = H - bottom - h, r = Math.min(4, barW / 2, h);
            return (
              <g key={s.day} onMouseEnter={() => setHover(i)}>
                <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
                {hover === i && <rect x={i * slot} y={0} width={slot} height={H} fill="var(--surface-2)" />}
                {h > 0 && <path d={`M${x} ${H - bottom}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + barW - r}Q${x + barW} ${y} ${x + barW} ${y + r}V${H - bottom}Z`} fill="var(--warn)" />}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted" aria-hidden><span>{dayLabel(series[0]!.day)}</span><span>{dayLabel(series[series.length - 1]!.day)}</span></div>
      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer font-medium">Show days as a table</summary>
        <div className="mt-2"><TableScroll label="Flagged messages per day">
          <table className="w-full border-collapse">
            <thead><tr><th scope="col" className={thClass}>Day</th><th scope="col" className={thClass}>Flagged</th><th scope="col" className={thClass}>All analyzed</th></tr></thead>
            <tbody>{trend.length ? trend.map(t => <tr key={t.day}><th scope="row" className={`${tdClass} text-left font-normal`}>{fmtDate(`${t.day}T12:00:00`)}</th><td className={`${tdClass} tabular-nums`}>{t.flagged ?? 0}</td><td className={`${tdClass} tabular-nums`}>{t.total}</td></tr>) : <tr><td colSpan={3} className={tdClass}>No data in this period.</td></tr>}</tbody>
          </table>
        </TableScroll></div>
      </details>
    </div>
  );
}

function CountList({ rows, empty }: { rows: { label: string; count: number; icon?: React.ReactNode }[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  return <ul className="divide-y divide-line">{rows.map(r => <li key={r.label} className="flex items-center justify-between gap-3 py-1.5 text-[13px]"><span className="flex min-w-0 items-center gap-1.5">{r.icon}{r.label}</span><span className="font-medium tabular-nums">{r.count}</span></li>)}</ul>;
}

export default function SecurityCenter() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useApi<Overview>(["org", "security", days], `/org/security?days=${days}`, { retry: false });
  const scanner = useApi<{ processors: { name: string; condition: string; plaintext: boolean }[] }>(["privacy"], "/privacy");
  const denied = error?.status === 403;
  const flaggedLabels = ["suspicious", "high_risk", "malicious"];
  const total = data?.byLabel.reduce((s, x) => s + x.count, 0) ?? 0;
  const flagged = data?.byLabel.filter(x => flaggedLabels.includes(x.label)).reduce((s, x) => s + x.count, 0) ?? 0;
  const held = data?.actions.find(a => a.action === "quarantine")?.count ?? 0;
  const unscannable = data?.byLabel.find(x => x.label === "unknown_unscannable")?.count ?? 0;
  const reports = data?.reports.reduce((s, x) => s + x.count, 0) ?? 0;
  const clamd = scanner.data?.processors.find(p => /scanner/i.test(p.name));
  return (
    <Page width="4xl" title="Security Center" description="How your workspace's mail is being protected." action={!denied && <select aria-label="Period" className={`${inputClass} !h-8 !w-40`} value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 365 days</option></select>}>
      {denied ? <NoAccess title="Team access denied">The Security Center is for workspace owners and security admins. Ask an owner if you need this role. Your own protection isn't affected.</NoAccess> : (
        <div className="space-y-4">
          <Banner tone="info" icon={EyeOff}><strong className="font-semibold">Aggregates only.</strong> This page shows counts by day and category. No subjects, senders or message contents are available here, and no admin screen can open someone's mail.</Banner>
          {isLoading ? <PageSkeleton blocks={3} /> : error || !data ? <ErrorState error={error ?? { message: "No data." }} retry={() => refetch()} /> : !total ? (
            <div className="rounded-xl bg-surface"><EmptyState icon={BarChart3} title="No mail analyzed in this period">Counts appear after a mailbox in this workspace is connected and has synced.</EmptyState></div>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Messages analyzed" value={total} />
                <Stat label="Flagged" value={flagged} note="Suspicious or worse" />
                <Stat label="Blocked" value={held} />
                <Stat label="Reports from people" value={reports} />
              </dl>
              {!!data.campaigns?.count && <Banner tone="warn" icon={Layers}><strong className="font-semibold">{data.campaigns.count} {data.campaigns.count === 1 ? "campaign" : "campaigns"}.</strong> The same flagged message reached several mailboxes here, {data.campaigns.messages} messages in all. Only a keyed fingerprint is compared, so this doesn't show who received what or what it said.</Banner>}
              <Card title="Flagged messages per day"><TrendChart trend={data.trend} days={days} /></Card>
              <div className="grid gap-4 md:grid-cols-2">
                <Card title="By rating"><CountList empty="No ratings in this period." rows={[...data.byLabel].sort((a, b) => b.count - a.count).map(x => { const r = RISK[x.label]; const I = r?.icon; return { label: r?.label ?? human(x.label), count: x.count, icon: I && <I className="size-3.5 shrink-0 text-muted" aria-hidden /> }; })} /></Card>
                <Card title="Blocked and flagged categories"><CountList empty="Nothing flagged in this period." rows={data.byCategory.map(x => ({ label: CATEGORY[x.category] ?? human(x.category), count: x.count }))} /></Card>
                <Card title="What happened to the mail"><CountList empty="No actions in this period." rows={[...data.actions].sort((a, b) => b.count - a.count).map(x => ({ label: ACTION[x.action] ?? human(x.action), count: x.count }))} /></Card>
                <Card title="Reports from people" description="Includes false positives, where someone marked a warning as wrong."><CountList empty="Nobody reported anything in this period." rows={[...["report_phishing", "not_a_threat"].map(k => ({ label: REPORT[k]!, count: data.reports.find(r => r.kind === k)?.count ?? 0 })), ...data.reports.filter(r => !REPORT[r.kind]).map(r => ({ label: human(r.kind), count: r.count }))]} /></Card>
              </div>
              <Card title="Coverage">
                <ul className="divide-y divide-line text-[13px]">
                  <li className="flex flex-wrap justify-between gap-2 py-1.5"><span>Workspace members</span><span className="font-medium tabular-nums">{data.members}</span></li>
                  <li className="flex flex-wrap justify-between gap-2 py-1.5"><span>Messages that couldn't be fully analyzed</span><span className="font-medium tabular-nums">{unscannable} of {total}</span></li>
                  <li className="flex flex-wrap items-center justify-between gap-2 py-1.5"><span>Attachment malware scanner</span>{clamd ? (clamd.plaintext ? <Chip tone="safe">Running</Chip> : <Chip tone="warn">Not configured</Chip>) : <span className="text-muted">Unknown</span>}</li>
                  <li className="flex flex-wrap justify-between gap-2 py-1.5"><span>Connected mailboxes</span><span className="font-medium">{(data.coverage ?? []).length ? (data.coverage ?? []).map((c: { status: string; count: number }) => `${c.count} ${c.status.replace("_", " ")}`).join(", ") : "None"}</span></li>
                  <li className="flex flex-wrap justify-between gap-2 py-1.5"><span>Campaigns: one flagged message reaching several mailboxes</span><span className="font-medium tabular-nums">{data.campaigns ? `${data.campaigns.count} ${data.campaigns.count === 1 ? "campaign" : "campaigns"}, ${data.campaigns.messages} messages` : "None"}</span></li>
                </ul>
                {clamd && !clamd.plaintext && <p className="mt-2 text-xs text-muted">{clamd.condition}</p>}
              </Card>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
