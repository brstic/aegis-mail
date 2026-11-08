"use client";
import { ScrollText } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { fmtDateTime, Head, linkClass, PageSkeleton, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Button, EmptyState, ErrorState } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Row { id: number; at: string; operator: string | null; action: string; tenantId: string | null; tenant: string | null; target: string | null; reason: string | null; meta: Record<string, unknown> | null }

const ACTION: Record<string, string> = {
  "tenant.viewed": "Viewed tenant", "tenant.override_set": "Set a limit", "tenant.override_cleared": "Removed a limit", "tenant.suspended": "Suspended tenant", "tenant.unsuspended": "Lifted suspension",
  "tenant.owner_contact_viewed": "Viewed owner contact", "job.retried": "Retried job", "job.retry_skipped": "Retry skipped: already queued", "operator.granted": "Operator access granted", "operator.revoked": "Operator access revoked",
};

export default function OperatorAuditPage() {
  const [before, setBefore] = useState<number | null>(null);
  const { data, isLoading, error, refetch } = useApi<Row[]>(["operator", "audit", before], `/operator/audit?limit=100${before ? `&before=${before}` : ""}`);
  return (
    <>
      <Head title="Operator audit log" description="Every operator action. Nobody can change or remove an entry from here, or with an operator's database access." />
      {isLoading ? <PageSkeleton blocks={2} /> : error || !data ? <ErrorState error={error ?? { message: "This didn't load." }} retry={() => refetch()} /> : !data.length ? <div className="rounded-xl border border-line bg-surface"><EmptyState icon={ScrollText} title="No entries" /></div> : (
        (() => { const anyReason = data.some(r => r.reason); return <>
          <TableScroll label="Operator audit log">
            <table className="w-full min-w-[46rem] border-collapse bg-surface">
              <thead><tr>{["When", "Operator", "Action", "Tenant", ...(anyReason ? ["Reason"] : [])].map(h => <th key={h} scope="col" className={thClass}>{h}</th>)}</tr></thead>
              <tbody>{data.map(r => (
                <tr key={r.id} data-testid="op-audit-row">
                  <td className={`${tdClass} whitespace-nowrap`}>{fmtDateTime(r.at)}</td>
                  <td className={tdClass}>{r.operator ?? "Command line"}</td>
                  <td className={tdClass}>{ACTION[r.action] ?? r.action}{r.target && !r.tenantId ? <span className="block text-xs text-muted">User <span className="font-mono">{r.target.slice(0, 8)}</span></span> : r.target ? <span className="block text-xs text-muted">{r.target}</span> : null}</td>
                  <td className={tdClass}>{r.tenantId ? <Link className={linkClass} href={`/admin/tenants/${r.tenantId}`}>{r.tenant ?? r.tenantId.slice(0, 8)}</Link> : <span className="text-muted">—</span>}</td>
                  {anyReason && <td className={tdClass}>{r.reason ?? ""}</td>}
                </tr>
              ))}</tbody>
            </table>
          </TableScroll>
          <div className="mt-3 flex gap-2">
            {before && <Button size="sm" onClick={() => setBefore(null)}>Newest</Button>}
            {data.length === 100 && <Button size="sm" onClick={() => setBefore(data[data.length - 1]!.id)}>Older</Button>}
          </div>
        </>; })()
      )}
    </>
  );
}
