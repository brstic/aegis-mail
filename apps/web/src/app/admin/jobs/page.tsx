"use client";
import { useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { useState } from "react";
import { fmtDateTime, Head, PageSkeleton, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Button, EmptyState, ErrorState } from "@/components/ui";
import { api, useAction, useApi } from "@/lib/client";

interface Job { id: string; kind: string; state: string; attempts: number; maxAttempts: number; errorCode: string | null; createdAt: string; finishedAt: string | null }
type State = "dead" | "queued" | "running";

export default function JobsPage() {
  const qc = useQueryClient();
  const [state, setState] = useState<State>("dead");
  const { data, isLoading, error, refetch } = useApi<Job[]>(["operator", "jobs", state], `/operator/jobs?state=${state}`, { refetchInterval: 15_000 });
  // Counts for the switch above the list.
  const queued = useApi<Job[]>(["operator", "jobs", "queued"], "/operator/jobs?state=queued", { refetchInterval: 15_000 });
  const running = useApi<Job[]>(["operator", "jobs", "running"], "/operator/jobs?state=running", { refetchInterval: 15_000 });
  const dead = useApi<Job[]>(["operator", "jobs", "dead"], "/operator/jobs?state=dead", { refetchInterval: 15_000 });
  const retry = useAction<string>(id => api(`/operator/jobs/${id}/retry`, { method: "POST" }), { refresh: false, success: "Job queued again.", onDone: () => void qc.invalidateQueries({ queryKey: ["operator", "jobs"] }) });
  return (
    <>
      <Head title="Job queue" description="Kind and error code only. Payloads and tenants aren't shown here and can't be." />
      <fieldset className="mb-4">
        <legend className="sr-only">Show</legend>
        <div className="inline-flex rounded-xl bg-surface-2 p-1">
          {([["dead", "Dead", dead.data], ["queued", "Queued", queued.data], ["running", "Running", running.data]] as const).map(([v, label, list]) => (
            <label key={v} className={`relative inline-flex h-8 cursor-pointer items-center gap-2 rounded-lg px-3.5 text-[13px] font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${state === v ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
              <input type="radio" name="job-state" className="absolute inset-0 cursor-pointer opacity-0" checked={state === v} onChange={() => setState(v)} />
              {label}<span className={`min-w-5 rounded-full px-1.5 text-center text-xs tabular-nums ${v === "dead" && list?.length ? "bg-danger-soft text-danger" : "bg-surface-2 text-muted"}`}>{list?.length ?? "–"}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {isLoading ? <PageSkeleton blocks={2} /> : error || !data ? <ErrorState error={error ?? { message: "This didn't load." }} retry={() => refetch()} /> : !data.length ? <div className="rounded-xl border border-line bg-surface"><EmptyState icon={ListChecks} title={`No ${state} jobs`}>{state === "dead" ? "Nothing has failed for good." : state === "queued" ? "The queue is empty." : "Nothing is running right now."}</EmptyState></div> : (
        <TableScroll label="Jobs">
          <table className="w-full min-w-[42rem] border-collapse bg-surface">
            <thead><tr>{["Kind", "Error code", "Attempts", "Created", "Finished", ...(state === "dead" ? ["Action"] : [])].map(h => <th key={h} scope="col" className={thClass}>{h}</th>)}</tr></thead>
            <tbody>{data.map(j => (
              <tr key={j.id} data-testid="job-row">
                <td className={`${tdClass} font-mono text-xs`}>{j.kind}</td>
                <td className={`${tdClass} font-mono text-xs`}>{j.errorCode ?? <span className="font-sans text-muted">—</span>}</td>
                <td className={`${tdClass} tabular-nums`}>{j.attempts} of {j.maxAttempts}</td>
                <td className={`${tdClass} whitespace-nowrap`}>{fmtDateTime(j.createdAt)}</td>
                <td className={`${tdClass} whitespace-nowrap`}>{j.finishedAt ? fmtDateTime(j.finishedAt) : "Not yet"}</td>
                {state === "dead" && <td className={tdClass}><Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate(j.id)} aria-label={`Retry ${j.kind} job ${j.id.slice(0, 8)}`}>Retry</Button></td>}
              </tr>
            ))}</tbody>
          </table>
        </TableScroll>
      )}
    </>
  );
}
