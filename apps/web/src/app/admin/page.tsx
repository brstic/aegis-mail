"use client";
import type { ReactNode } from "react";
import { Head, PageSkeleton, PROVIDER_LABEL, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Stat } from "@/components/admin/shell";
import { ErrorState } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Overview {
  tenants: { kind: string; tenants: number; suspended: number }[];
  users: { total: number; active: number };
  mailboxes: { provider: string; status: string; count: number }[];
  queue: { kind: string; state: string; errorCode: string | null; count: number }[];
  sync: { mailboxes: number; failing: number };
}
const MAILBOX_STATUS: Record<string, string> = { connecting: "Connecting", active: "Active", paused: "Paused", reconnect_required: "Needs reconnecting", disconnected: "Disconnected", error: "Error" };
const Empty = ({ children }: { children: ReactNode }) => <p className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-muted">{children}</p>;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export default function OverviewPage() {
  const { data, isLoading, error, refetch } = useApi<Overview>(["operator", "overview"], "/operator/overview", { refetchInterval: 30_000 });
  return (
    <>
      <Head title="Overview" description="Counts across the service. Aggregates only." />
      {isLoading ? <PageSkeleton blocks={3} /> : error || !data ? <ErrorState error={error ?? { message: "This didn't load." }} retry={() => refetch()} /> : (() => {
        const queued = sum(data.queue.filter(q => q.state === "queued").map(q => q.count));
        const dead = data.queue.filter(q => q.state === "dead");
        const rate = data.sync.mailboxes ? Math.round((data.sync.failing / data.sync.mailboxes) * 1000) / 10 : 0;
        return (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="overview-stats">
              <Stat label="Tenants" value={sum(data.tenants.map(t => t.tenants)).toLocaleString()} note={`${sum(data.tenants.map(t => t.suspended))} suspended`} />
              <Stat label="Active users, last 30 days" value={data.users.active.toLocaleString()} note={`of ${data.users.total.toLocaleString()}`} />
              <Stat label="Queue depth" value={queued.toLocaleString()} note={`${sum(dead.map(d => d.count))} dead`} />
              <Stat label="Sync failure rate" value={`${rate}%`} note={`${data.sync.failing} of ${data.sync.mailboxes} mailboxes`} />
            </div>

            <section aria-labelledby="mb"><h2 id="mb" className="mb-2 text-[15px] font-semibold">Connected mailboxes</h2>
              {!data.mailboxes.length ? <Empty>None yet.</Empty> : <TableScroll label="Mailboxes by provider and status"><table className="w-full min-w-[22rem] border-collapse bg-surface"><thead><tr><th scope="col" className={thClass}>Provider</th><th scope="col" className={thClass}>Status</th><th scope="col" className={thClass}>Count</th></tr></thead>
                <tbody>{data.mailboxes.map(m => <tr key={`${m.provider}-${m.status}`}><td className={tdClass}>{PROVIDER_LABEL[m.provider] ?? m.provider}</td><td className={tdClass}>{MAILBOX_STATUS[m.status] ?? m.status.replace(/_/g, " ")}</td><td className={`${tdClass} tabular-nums`}>{m.count.toLocaleString()}</td></tr>)}</tbody></table></TableScroll>}
            </section>

            <section aria-labelledby="dj"><h2 id="dj" className="mb-2 text-[15px] font-semibold">Dead jobs by kind and error code</h2>
              {!dead.length ? <Empty>No dead jobs. Everything that ran either finished or will be retried.</Empty> : <TableScroll label="Dead jobs"><table className="w-full min-w-[22rem] border-collapse bg-surface"><thead><tr><th scope="col" className={thClass}>Kind</th><th scope="col" className={thClass}>Error code</th><th scope="col" className={thClass}>Count</th></tr></thead>
                <tbody>{dead.map(d => <tr key={`${d.kind}-${d.errorCode}`}><td className={`${tdClass} font-mono text-xs`}>{d.kind}</td><td className={`${tdClass} font-mono text-xs`}>{d.errorCode ?? "none recorded"}</td><td className={`${tdClass} tabular-nums`}>{d.count.toLocaleString()}</td></tr>)}</tbody></table></TableScroll>}
            </section>
          </div>
        );
      })()}
    </>
  );
}
