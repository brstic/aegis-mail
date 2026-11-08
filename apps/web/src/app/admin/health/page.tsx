"use client";
import { AlertTriangle, Check, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { fmtDateTime, Head, PageSkeleton } from "@/components/settings/common";
import { Card, ErrorState } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Health {
  database: { ok: boolean };
  worker: { ok: boolean; lastSeenAt: string | null };
  scanner: { configured: boolean; kind: string };
  kms: { type: string };
  hostedAi: { configured: boolean };
  limits: { instanceDefaults: Record<string, number | null> };
  mail: { configured: boolean };
  deletionLog: { configured: boolean; ok: boolean; lastSeenAt: string | null };
  demoMode: boolean;
}

const Row = ({ state, label, children }: { state: "ok" | "bad" | "off"; label: string; children: ReactNode }) => (
  <li className="flex items-start gap-2 py-2 text-[13px]" data-testid="health-row">
    {state === "ok" ? <Check className="mt-0.5 size-4 shrink-0 text-safe" aria-hidden /> : state === "bad" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden /> : <Minus className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
    <div className="min-w-0"><p className="font-medium">{label}<span className="sr-only">: {state === "ok" ? "healthy" : state === "bad" ? "problem" : "not configured"}</span></p><p className="text-muted">{children}</p></div>
  </li>
);

const KMS_LABEL: Record<string, string> = { "local-dev": "Local development key", "aws-kms": "AWS KMS" };
const LIMIT_LABEL: Record<string, (n: number) => string> = {
  accounts: n => `${n.toLocaleString()} connected ${n === 1 ? "account" : "accounts"} per person`, aiActionsPerMonth: n => `${n.toLocaleString()} hosted AI ${n === 1 ? "action" : "actions"} a month`,
  automations: n => `${n.toLocaleString()} ${n === 1 ? "rule" : "rules"} per person`, seats: n => `${n.toLocaleString()} ${n === 1 ? "member" : "members"}`, indexBytes: n => `${(n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB of search storage`,
};
const limitsText = (d: Record<string, number | null>) => Object.entries(d).flatMap(([k, v]) => v === null ? [] : [LIMIT_LABEL[k]?.(v) ?? `${k}: ${v}`]);

export default function HealthPage() {
  const { data, isLoading, error, refetch } = useApi<Health>(["operator", "health"], "/operator/health", { refetchInterval: 15_000 });
  return (
    <>
      <Head title="System health" description="Whether each part is running and configured. Secret values aren't shown." />
      {isLoading ? <PageSkeleton blocks={2} /> : error || !data ? <ErrorState error={error ?? { message: "This didn't load." }} retry={() => refetch()} /> : (
        <div className="space-y-4">
          <Card>
            <ul className="divide-y divide-line">
              <Row state={data.database.ok ? "ok" : "bad"} label="Database">{data.database.ok ? "Answering." : "Not answering."}</Row>
              <Row state={data.worker.ok ? "ok" : "bad"} label="Worker">{data.worker.lastSeenAt ? `Last heartbeat ${fmtDateTime(data.worker.lastSeenAt)}.` : "No heartbeat recorded. Is the worker running?"}</Row>
              <Row state={data.scanner.configured ? "ok" : "off"} label="Malware scanner">{data.scanner.configured ? "ClamAV is connected and scanning attachments." : "Built-in file checks only. ClamAV isn't connected."}</Row>
              <Row state={!data.kms.type.includes("dev") ? "ok" : data.demoMode ? "off" : "bad"} label="Key management">{KMS_LABEL[data.kms.type] ?? data.kms.type}.{data.kms.type.includes("dev") ? (data.demoMode ? " Expected in demo mode. Not for real data." : " Not for real data: connect a key management service.") : ""}</Row>
              <Row state={data.hostedAi.configured ? "ok" : "off"} label="Hosted AI">{data.hostedAi.configured ? "API key set. People still opt in individually." : "Not configured. On-device features only."}</Row>
              {(() => { const set = limitsText(data.limits.instanceDefaults); return <Row state={set.length ? "ok" : "off"} label="Limits">{set.length ? `Server defaults: ${set.join(", ")}. Each tenant's page can change them.` : "None. Server-wide defaults can be set with AEGIS_LIMIT_* settings."}</Row>; })()}
              <Row state={data.mail.configured ? "ok" : "off"} label="Transactional mail">{data.mail.configured ? "Configured." : "Not configured."}</Row>
              <Row state={!data.deletionLog.configured ? "off" : data.deletionLog.ok ? "ok" : "bad"} label="Deletion log">{!data.deletionLog.configured ? "Not reported by a worker. A restore wouldn't re-apply deletions." : data.deletionLog.ok ? "Shipping. Only counts as outside the database if it's on separate storage." : `Falling behind or stopped. Last healthy ${fmtDateTime(data.deletionLog.lastSeenAt!)}.`}</Row>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
