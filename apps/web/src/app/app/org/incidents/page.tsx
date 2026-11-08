"use client";
import { Eye, Siren } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { fmtDateTime, Head, linkClass, PageSkeleton, textareaClass } from "@/components/settings/common";
import { Banner, Button, Chip, EmptyState, ErrorState, Modal, RiskBadge } from "@/components/ui";
import { useApi } from "@/lib/client";

interface Incident { id: string; sharedBy: string; analyst: string; mine: boolean; redacted: boolean; note: string | null; expiresAt: string; revokedAt: string | null; snapshot: { riskLabel?: string | null; reasonCodes?: string[]; senderDomain?: string | null; redacted?: boolean; subject?: string; from?: { name?: string; address: string }; text?: string } }

/** The only place a person sees someone else's message: its owner picked this analyst and this message, for a limited time. */
function SharedMessage({ i, onClose }: { i: Incident; onClose: () => void }) {
  return (
    <Modal wide title="Message shared with you" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Banner tone="info" icon={Eye}>{i.sharedBy} chose to share this with you until {fmtDateTime(i.expiresAt)}. They can revoke it at any time. Keep it out of tickets and chat.</Banner>
        <p><span className="text-muted">Subject: </span>{i.snapshot.subject ?? "(none)"}</p>
        <p className="break-all"><span className="text-muted">From: </span>{i.snapshot.from?.address ?? "Unknown"}</p>
        <label className="block"><span className="mb-1 block text-[13px] font-medium">Text, with links not clickable</span><textarea readOnly rows={12} className={`${textareaClass} font-mono text-xs`} value={i.snapshot.text ?? ""} /></label>
      </div>
    </Modal>
  );
}

export default function IncidentsPage() {
  const { data, isLoading, error, refetch } = useApi<Incident[]>(["org", "incidents"], "/org/incidents");
  const [viewing, setViewing] = useState<Incident | null>(null);
  const now = Date.now();
  return (
    <>
      <Head title="Incidents" description={<>Messages people chose to share with a named security analyst. Only the person who shared and the analyst can see each one, for a limited time, and every share is logged. Revoke your own in the <Link href="/app/privacy" className={linkClass}>Privacy Center</Link>.</>} />
      {isLoading ? <PageSkeleton blocks={2} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? (
        <div className="rounded-xl bg-surface"><EmptyState icon={Siren} title="No incidents">Someone can share a report using Share with security on a message.</EmptyState></div>
      ) : (
        <ul className="rounded-xl bg-surface">
          {data.map(i => {
            const active = !i.revokedAt && new Date(i.expiresAt).getTime() > now;
            return (
              <li key={i.id} className="border-b border-line p-3 text-[13px] last:border-b-0" data-testid="incident-row">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{i.mine ? `You shared with ${i.analyst}` : `${i.sharedBy} shared with you`}</span>
                  <RiskBadge risk={i.snapshot.riskLabel} />
                  <Chip>{i.redacted ? "Redacted" : "Full message"}</Chip>
                  {i.revokedAt ? <Chip>Revoked</Chip> : !active ? <Chip>Expired</Chip> : <Chip tone="accent">Active</Chip>}
                </div>
                <p className="mt-1 text-muted">{i.revokedAt ? `Revoked ${fmtDateTime(i.revokedAt)}` : `${active ? "Until" : "Ended"} ${fmtDateTime(i.expiresAt)}`}</p>
                {i.note && <p className="mt-1 break-words">Note: {i.note}</p>}
                {!!i.snapshot.reasonCodes?.length && <p className="mt-1 break-words text-muted">Reason codes: <span className="font-mono text-xs">{i.snapshot.reasonCodes.join(", ")}</span></p>}
                {i.snapshot.senderDomain && <p className="mt-1 break-all text-muted">Sender domain: {i.snapshot.senderDomain}</p>}
                {!i.mine && !i.redacted && active && <div className="mt-2"><Button size="sm" icon={Eye} onClick={() => setViewing(i)}>View shared message</Button></div>}
                {i.mine && <p className="mt-1"><Link href="/app/privacy" className={linkClass}>Manage in Privacy Center</Link></p>}
              </li>
            );
          })}
        </ul>
      )}
      {viewing && <SharedMessage i={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
