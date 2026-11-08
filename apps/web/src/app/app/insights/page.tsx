"use client";
import { BarChart3, Clock, Lock, MailCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { linkClass, Page, PageSkeleton, TableScroll, tdClass, thClass, TOPIC_LABEL } from "@/components/settings/common";
import { Banner, Card, EmptyState, ErrorState, Field, inputClass } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Insights { days: number; perAccount: { accountId: string; displayName: string; received: number; sent: number; flagged: number }[]; medianReplyHours: number | null; topicCounts: { topic: string; count: number }[]; busiestHours: { hour: number; count: number }[] }

const hourLabel = (h: number) => new Date(2026, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
const hoursText = (h: number) => h < 1 ? `about ${Math.max(1, Math.round(h * 60))} minutes` : h < 48 ? `about ${h >= 10 ? Math.round(h) : Math.round(h * 10) / 10} hours` : `about ${Math.round(h / 24)} days`;
// Built-in topics are stored as lowercase keys; your own topics keep the name you gave them.
const topicLabel = (t: string) => TOPIC_LABEL[t] ?? t;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return <div className="rounded-xl bg-surface p-3"><dt className="text-[13px] text-muted">{label}</dt><dd className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</dd>{note && <dd className="mt-0.5 text-xs text-muted">{note}</dd>}</div>;
}

/** Horizontal bars, one series on one scale. Values are printed beside each bar, so nothing depends on reading its length. */
function BarList({ rows, label, valueLabel, fill = "var(--accent)" }: { rows: { key: string; label: string; value: number }[]; label: string; valueLabel: string; fill?: string }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <ul className="space-y-1.5" role="img" aria-label={label} data-testid="bar-list">
      {rows.map(r => (
        <li key={r.key} aria-hidden className={`grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_3ch] items-center gap-2 rounded text-[13px] ${hover === r.key ? "bg-surface-2" : ""}`} title={`${r.label}: ${r.value} ${valueLabel}`} onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)}>
          <span className="truncate">{r.label}</span>
          <svg className="block h-3 w-full" preserveAspectRatio="none" viewBox="0 0 100 12"><rect x={0} y={1} width={r.value ? Math.max(1.5, (r.value / max) * 100) : 0} height={10} rx={2} fill={fill} /></svg>
          <span className="text-right text-xs tabular-nums text-muted">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** 24 slots, always, so quiet hours are visible as gaps and the time axis never shifts between periods. */
function HourChart({ hours, summary }: { hours: { hour: number; count: number }[]; summary: string }) {
  const series = useMemo(() => Array.from({ length: 24 }, (_, hour) => ({ hour, count: hours.find(h => h.hour === hour)?.count ?? 0 })), [hours]);
  const max = Math.max(1, ...series.map(s => s.count));
  const [hover, setHover] = useState<number | null>(null);
  const H = 120, W = 480, slot = W / 24, barW = slot - 4;
  const active = hover !== null ? series[hover] : null;
  return (
    <div>
      <p className="h-5 text-[13px] text-muted" aria-hidden>{active ? `${hourLabel(active.hour)}: ${plural(active.count, "message")}` : `Most in one hour: ${max}`}</p>
      <svg role="img" aria-label={`Column chart of messages by hour of day. ${summary}`} viewBox={`0 0 ${W} ${H + 2}`} className="mt-1 block h-32 w-full" preserveAspectRatio="none" onMouseLeave={() => setHover(null)} data-testid="hour-chart">
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--border-strong)" vectorEffect="non-scaling-stroke" />
        {series.map((s, i) => {
          const h = s.count ? Math.max(3, (s.count / max) * (H - 4)) : 0;
          const x = i * slot + 2, y = H - h, r = Math.min(3, barW / 2, h);
          return (
            <g key={s.hour} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y={0} width={slot} height={H} fill={hover === i ? "var(--surface-2)" : "transparent"} />
              {h > 0 && <path d={`M${x} ${H}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + barW - r}Q${x + barW} ${y} ${x + barW} ${y + r}V${H}Z`} fill="var(--accent)" />}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted" aria-hidden><span>{hourLabel(0)}</span><span>{hourLabel(6)}</span><span>{hourLabel(12)}</span><span>{hourLabel(18)}</span><span>{hourLabel(23)}</span></div>
    </div>
  );
}

function TableToggle({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="mt-3 text-[13px]"><summary className="cursor-pointer font-medium">Show as a table</summary><div className="mt-2"><TableScroll label={label}>{children}</TableScroll></div></details>;
}

function summarize(d: Insights) {
  const received = d.perAccount.reduce((s, a) => s + a.received, 0), sent = d.perAccount.reduce((s, a) => s + a.sent, 0), flagged = d.perAccount.reduce((s, a) => s + a.flagged, 0);
  const parts = [`In the last ${d.days} days you received ${plural(received, "message")} and sent ${sent}.`];
  if (flagged) parts.push(`${plural(flagged, "message")} ${flagged === 1 ? "was" : "were"} flagged.`);
  if (d.medianReplyHours !== null) parts.push(`You usually reply in ${hoursText(d.medianReplyHours)}.`);
  const busiest = [...d.busiestHours].sort((a, b) => b.count - a.count)[0];
  if (busiest?.count) parts.push(`Most mail arrives around ${hourLabel(busiest.hour)}.`);
  if (d.topicCounts[0]) parts.push(`The most common topic is ${topicLabel(d.topicCounts[0].topic)}.`);
  return { text: parts.join(" "), received, sent, flagged, busiest };
}

export default function InsightsPage() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useApi<Insights>(["insights", days], `/insights?days=${days}`, { retry: false });
  const sum = data ? summarize(data) : null;
  const notAvailable = error?.status === 404;
  return (
    <Page width="4xl" title="Insights" description="Your own mail habits, across your mailboxes. Counts and times only." action={!notAvailable && <select aria-label="Period" className={`${inputClass} !h-8 !w-40`} value={days} onChange={e => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>}>
      {notAvailable ? (
        <div className="rounded-xl bg-surface"><EmptyState icon={BarChart3} title="Insights aren't available on this deployment yet">Nothing is wrong with your mail. This page needs a server update to work.</EmptyState></div>
      ) : isLoading ? <PageSkeleton blocks={3} /> : error || !data || !sum ? <ErrorState error={error ?? { message: "Insights aren't available." }} retry={() => refetch()} /> : !data.perAccount.length ? (
        <div className="rounded-xl bg-surface"><EmptyState icon={BarChart3} title="No mailbox to report on" action={<Link href="/app/connect" className={linkClass}>Connect a mailbox</Link>}>Insights cover mailboxes you own.</EmptyState></div>
      ) : (
        <div className="space-y-4">
          <Banner tone="info" icon={Lock}>Only you can see this. It's counted from your own mailboxes, with no subjects, senders or message text. Shared mailboxes aren't included.</Banner>
          <p className="text-sm" data-testid="insights-summary">{sum.text}</p>
          {!sum.received && !sum.sent ? <div className="rounded-xl bg-surface"><EmptyState icon={MailCheck} title="No mail in this period">Try a longer period.</EmptyState></div> : (
            <>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Received" value={sum.received} />
                <Stat label="Sent" value={sum.sent} />
                <Stat label="Flagged" value={sum.flagged} note="Suspicious or worse" />
                <Stat label="Typical reply time" value={data.medianReplyHours === null ? "Not enough data" : data.medianReplyHours < 1 ? `${Math.max(1, Math.round(data.medianReplyHours * 60))} min` : `${Math.round(data.medianReplyHours * 10) / 10} h`} note={data.medianReplyHours === null ? "No replies from you in this period" : "Median, in conversations you answered"} />
              </dl>
              <Card title="By mailbox" description="Each column has its own scale.">
                <div className="grid gap-4 md:grid-cols-3">
                  {(["received", "sent", "flagged"] as const).map(k => (
                    <div key={k}>
                      <h3 className="mb-1.5 text-[13px] font-semibold capitalize">{k}</h3>
                      <BarList label={`${k} per mailbox: ${data.perAccount.map(a => `${a.displayName} ${a[k]}`).join(", ")}`} valueLabel={k === "flagged" ? "flagged" : k} fill={k === "flagged" ? "var(--warn)" : "var(--accent)"} rows={data.perAccount.map(a => ({ key: a.accountId, label: a.displayName, value: a[k] }))} />
                    </div>
                  ))}
                </div>
                <TableToggle label="Messages per mailbox">
                  <table className="w-full border-collapse"><thead><tr><th scope="col" className={thClass}>Mailbox</th><th scope="col" className={thClass}>Received</th><th scope="col" className={thClass}>Sent</th><th scope="col" className={thClass}>Flagged</th></tr></thead><tbody>{data.perAccount.map(a => <tr key={a.accountId}><th scope="row" className={`${tdClass} text-left font-normal`}>{a.displayName}</th><td className={`${tdClass} tabular-nums`}>{a.received}</td><td className={`${tdClass} tabular-nums`}>{a.sent}</td><td className={`${tdClass} tabular-nums`}>{a.flagged}</td></tr>)}</tbody></table>
                </TableToggle>
              </Card>
              <div className="grid gap-4 md:grid-cols-2">
                <Card title="When mail arrives" description="Messages received, by hour of day.">
                  {data.busiestHours.some(h => h.count) ? <HourChart hours={data.busiestHours} summary={sum.busiest ? `The busiest hour is ${hourLabel(sum.busiest.hour)} with ${plural(sum.busiest.count, "message")}.` : ""} /> : <p className="flex items-center gap-2 text-sm text-muted"><Clock className="size-4" aria-hidden />Nothing received in this period.</p>}
                  <TableToggle label="Messages by hour">
                    <table className="w-full border-collapse"><thead><tr><th scope="col" className={thClass}>Hour</th><th scope="col" className={thClass}>Messages</th></tr></thead><tbody>{data.busiestHours.filter(h => h.count).map(h => <tr key={h.hour}><th scope="row" className={`${tdClass} text-left font-normal`}>{hourLabel(h.hour)}</th><td className={`${tdClass} tabular-nums`}>{h.count}</td></tr>)}</tbody></table>
                  </TableToggle>
                </Card>
                <Card title="Topics" description="Messages received, by topic. A message can have more than one.">
                  {data.topicCounts.length ? <BarList label={`Messages per topic: ${data.topicCounts.slice(0, 10).map(t => `${topicLabel(t.topic)} ${t.count}`).join(", ")}`} valueLabel="messages" rows={data.topicCounts.slice(0, 10).map(t => ({ key: t.topic, label: topicLabel(t.topic), value: t.count }))} /> : <p className="text-sm text-muted">No topics in this period. <Link href="/app/settings/topics" className={linkClass}>Manage topics</Link></p>}
                  {data.topicCounts.length > 0 && <TableToggle label="Messages per topic"><table className="w-full border-collapse"><thead><tr><th scope="col" className={thClass}>Topic</th><th scope="col" className={thClass}>Messages</th></tr></thead><tbody>{data.topicCounts.map(t => <tr key={t.topic}><th scope="row" className={`${tdClass} text-left font-normal`}>{topicLabel(t.topic)}</th><td className={`${tdClass} tabular-nums`}>{t.count}</td></tr>)}</tbody></table></TableToggle>}
                </Card>
              </div>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
