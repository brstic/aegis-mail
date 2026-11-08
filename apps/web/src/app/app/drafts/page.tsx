"use client";
import { AlertTriangle, FileEdit, Loader2, PenSquare, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmModal, MailPanel, PageSkeleton } from "@/components/settings/common";
import { Banner, Button, Chip, EmptyState, ErrorState, IconButton } from "@/components/ui";
import { useWorkspace } from "@/components/workspace/shell";
import { api, relTime, useAccounts, useAction, useApi } from "@/lib/client";

interface Draft { id: string; accountId: string; accountEmail: string; threadId: string | null; state: string; aiGenerated: boolean; updatedAt: string; errorCode: string | null; to: string[]; cc: string[]; bcc?: string[]; subject: string; text: string; fromAlias?: string; attachments?: { id: string; filename: string; contentType: string; size: number }[] }

function Row({ d, onDiscard }: { d: Draft; onDiscard: (d: Draft) => void }) {
  const { compose } = useWorkspace();
  const { data: accounts } = useAccounts();
  const account = accounts?.find(a => a.id === d.accountId);
  const open = () => compose({ draftId: d.id, accountId: d.accountId, threadId: d.threadId ?? undefined, mode: d.threadId ? "reply" : undefined, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text, aiGenerated: d.aiGenerated, fromAlias: d.fromAlias, attachments: d.attachments });
  // The API returns a failed draft to editing here. It doesn't send, so the person still has to press Send in the composer.
  const retry = useAction<void>(() => api(`/drafts/${d.id}/retry`, { method: "POST" }), { success: "Back to editing. Nothing has been sent. Press Send when you're ready.", onDone: open });
  const failed = d.state === "failed", unknown = d.state === "unknown", unconfirmed = failed && d.errorCode === "outcome_unconfirmed";
  // Two lines, like Gmail: who it's for, then subject and the start of the text. The sending account is its color dot.
  const from = account?.displayName ? `${account.displayName} (${d.fromAlias ?? d.accountEmail})` : d.fromAlias ?? d.accountEmail;
  const summary = (
    <>
      <span className="flex items-center gap-2">
        {account && <span aria-hidden title={`From ${from}`} className="size-2 shrink-0 rounded-full" style={{ background: account.color }} />}
        <span className="text-[13px] font-medium text-danger">Draft</span>
        <span className="min-w-0 truncate font-medium">{d.to.length ? d.to.join(", ") : <span className="font-normal text-muted">No recipients yet</span>}</span>
        {d.aiGenerated && <Chip tone="accent">Suggested draft</Chip>}{d.threadId && <Chip>Reply</Chip>}
        <span className="sr-only">, from {from}</span>
      </span>
      <span className="mt-0.5 block truncate text-[13px]"><span className="text-ink">{d.subject || "(no subject)"}</span>{d.text ? <span className="text-muted"> - {d.text.slice(0, 120)}</span> : null}</span>
    </>
  );
  return (
    <li className="border-b border-line" data-testid="draft-row">
      <div className="flex items-start gap-2 px-4 py-2.5 hover:shadow-[0_1px_5px_rgb(0_0_0/.1)]">
        {/* A failed or in-doubt draft is locked by the API: edits wouldn't save and Send would be refused, so it doesn't open until Retry. */}
        {failed || unknown ? <div className="min-w-0 flex-1 text-sm">{summary}</div> : <button onClick={open} className="min-w-0 flex-1 rounded text-left text-sm hover:opacity-80"><span className="sr-only">Open draft: </span>{summary}</button>}
        <span className="flex shrink-0 items-center gap-1"><time className="text-xs text-muted" dateTime={d.updatedAt}>{relTime(d.updatedAt)}</time>{!failed && !unknown && <IconButton icon={Trash2} label={`Delete draft: ${d.subject || "no subject"}`} onClick={() => onDiscard(d)} />}</span>
      </div>
      {unknown && <div className="px-3 pb-2.5"><Banner tone="info" icon={Loader2}>Checking whether this was delivered. Don't send it again yet.</Banner></div>}
      {unconfirmed && <div className="px-3 pb-2.5"><Banner tone="warn" icon={AlertTriangle} action={<Button size="sm" icon={RotateCcw} loading={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>}>We couldn't confirm whether this was delivered. It may have gone out. Check with the recipient before retrying.</Banner></div>}
      {failed && !unconfirmed && <div className="px-3 pb-2.5"><Banner tone="danger" icon={AlertTriangle} action={<Button size="sm" icon={RotateCcw} loading={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>}>This didn't send. Your mail provider refused it. Retry reopens it so you can check it and send again.</Banner></div>}
    </li>
  );
}

export default function DraftsPage() {
  const { compose } = useWorkspace();
  const { data, isLoading, error, refetch } = useApi<Draft[]>(["drafts"], "/drafts");
  const [discarding, setDiscarding] = useState<Draft | null>(null);
  const discard = useAction<string>(id => api(`/drafts/${id}`, { method: "DELETE" }), { success: "Draft deleted.", onDone: () => setDiscarding(null) });
  return (
    <MailPanel title="Drafts" action={<Button size="sm" icon={PenSquare} onClick={() => compose()}>New message</Button>}>
      {isLoading ? <div className="p-4"><PageSkeleton /></div> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? (
        <EmptyState icon={FileEdit} title="No drafts">Messages you start and don't send are kept here. Nothing sends until you press Send.</EmptyState>
      ) : <ul className="border-t border-line">{data.map(d => <Row key={d.id} d={d} onDiscard={setDiscarding} />)}</ul>}
      {discarding && <ConfirmModal title="Delete this draft?" confirmLabel="Delete draft" danger busy={discard.isPending} onConfirm={() => discard.mutate(discarding.id)} onClose={() => setDiscarding(null)}><p>"{discarding.subject || "No subject"}" from {discarding.accountEmail} will be deleted. This can't be undone.</p></ConfirmModal>}
    </MailPanel>
  );
}
