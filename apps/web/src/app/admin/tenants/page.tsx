"use client";
import { Building2, Search, User } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { fmtDate, Head, linkClass, PageSkeleton, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Chip, EmptyState, ErrorState } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Row { id: string; name: string; kind: string; members: number; mailboxes: number; createdAt: string; suspendedAt: string | null }

// Organizations first, then the newest.
const sorted = (rows: Row[]) => [...rows].sort((a, b) => (a.kind === "personal" ? 1 : 0) - (b.kind === "personal" ? 1 : 0) || b.createdAt.localeCompare(a.createdAt));

export default function TenantsPage() {
  const [search, setSearch] = useState("");
  const q = search.trim();
  const { data, isLoading, error, refetch } = useApi<Row[]>(["operator", "tenants", q], `/operator/tenants?limit=100${q ? `&search=${encodeURIComponent(q)}` : ""}`);
  return (
    <>
      <Head title="Tenants" description="Workspaces on this service. Personal workspaces show a label instead of their name, which usually holds someone's name." />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="relative w-full max-w-sm"><span className="sr-only">Search organization names</span><Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden /><input type="search" placeholder="Search organizations" className="h-10 w-full rounded-full bg-surface-2 pr-4 pl-10 text-sm outline-none placeholder:text-muted focus:bg-surface focus:shadow-soft" value={search} onChange={e => setSearch(e.target.value)} /></label>
        {data && <p className="text-[13px] text-muted">{data.length === 100 ? "First 100" : `${data.length} ${data.length === 1 ? "workspace" : "workspaces"}`}</p>}
      </div>
      {isLoading ? <PageSkeleton blocks={2} /> : error || !data ? <ErrorState error={error ?? { message: "This didn't load." }} retry={() => refetch()} /> : !data.length ? <div className="rounded-xl border border-line bg-surface"><EmptyState icon={Building2} title="No tenants match" /></div> : (
        <TableScroll label="Tenants">
          <table className="w-full min-w-[32rem] border-collapse bg-surface">
            <thead><tr>{["Name", "Members", "Mailboxes", "Created"].map(h => <th key={h} scope="col" className={thClass}>{h}</th>)}</tr></thead>
            <tbody>{sorted(data).map(t => (
              <tr key={t.id} data-testid="tenant-row">
                <td className={tdClass}><span className="flex flex-wrap items-center gap-1.5">{t.kind === "personal" ? <User className="size-3.5 shrink-0 text-muted" aria-hidden /> : <Building2 className="size-3.5 shrink-0 text-muted" aria-hidden />}<Link className={linkClass} href={`/admin/tenants/${t.id}`}>{t.name}<span className="sr-only"> ({t.kind})</span></Link><span className="font-mono text-xs text-muted">{t.id.slice(0, 8)}</span>{t.suspendedAt && <Chip tone="danger">Suspended</Chip>}</span></td>
                <td className={`${tdClass} tabular-nums`}>{t.members.toLocaleString()}</td>
                <td className={`${tdClass} tabular-nums`}>{t.mailboxes.toLocaleString()}</td>
                <td className={`${tdClass} whitespace-nowrap`}>{fmtDate(t.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        </TableScroll>
      )}
    </>
  );
}
