"use client";
import { CalendarClock, PenSquare, X } from "lucide-react";
import { useState } from "react";
import { ConfirmModal, fmtDateTime, MailPanel, PageSkeleton } from "@/components/settings/common";
import { Button, EmptyState, ErrorState } from "@/components/ui";
import { useWorkspace } from "@/components/workspace/shell";
import { api, useAction, useApi } from "@/lib/client";

interface Scheduled { id: string; accountEmail: string; scheduledFor: string | null; to: string[]; subject: string; text: string }

export default function ScheduledPage() {
  const { data, isLoading, error, refetch } = useApi<Scheduled[]>(["drafts", "scheduled"], "/drafts?state=scheduled");
  const [cancelling, setCancelling] = useState<Scheduled | null>(null);
  const { compose } = useWorkspace();
  const cancel = useAction<string>(id => api(`/drafts/${id}/cancel`, { method: "POST" }), { success: "Cancelled. The message is back in Drafts.", onDone: () => setCancelling(null) });
  return (
    <MailPanel title="Scheduled" action={<Button size="sm" icon={PenSquare} onClick={() => compose()}>New message</Button>}>
      {isLoading ? <div className="p-4"><PageSkeleton /></div> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? (
        <EmptyState icon={CalendarClock} title="Nothing scheduled">Use Schedule in the composer to send a message later. You can cancel until it sends.</EmptyState>
      ) : (
        <ul className="border-t border-line">
          {data.map(d => (
            <li key={d.id} className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-2.5" data-testid="scheduled-row">
              <div className="min-w-0 flex-1 basis-56 text-sm">
                <div className="truncate font-medium">{d.subject || "(no subject)"}</div>
                <div className="mt-0.5 truncate text-[13px] text-muted">From {d.accountEmail}</div>
                <div className="mt-0.5 truncate text-[13px] text-muted">To {d.to.join(", ")}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[13px] font-medium"><CalendarClock className="size-3.5 shrink-0 text-muted" aria-hidden />{d.scheduledFor ? <>Sends around <time dateTime={d.scheduledFor}>{fmtDateTime(d.scheduledFor)}</time></> : "Send time not available"}</div>
              </div>
              <Button size="sm" icon={X} onClick={() => setCancelling(d)} aria-label={`Cancel scheduled send: ${d.subject || "no subject"}`}>Cancel send</Button>
            </li>
          ))}
        </ul>
      )}
      {cancelling && <ConfirmModal title="Cancel this scheduled send?" confirmLabel="Cancel send" busy={cancel.isPending} onConfirm={() => cancel.mutate(cancelling.id)} onClose={() => setCancelling(null)}><p>"{cancelling.subject || "No subject"}" won't send. It moves back to Drafts, where you can edit it or delete it.</p></ConfirmModal>}
    </MailPanel>
  );
}
