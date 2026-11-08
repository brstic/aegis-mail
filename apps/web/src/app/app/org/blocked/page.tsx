"use client";
import { ShieldCheck } from "lucide-react";
import { fmtDateTime, Head, PageSkeleton } from "@/components/settings/common";
import { Button, EmptyState, ErrorState, RiskBadge } from "@/components/ui";
import { api, useAction, useApi } from "@/lib/client";

interface Item { messageId: string; mailbox: string; ownerName: string | null; received: string; risk: string | null; categories: string[]; state: string }

const WHY: Record<string, string> = {
  malware: "Malware", credential_phish: "Password phishing", bec: "Business email scam", invoice_fraud: "Invoice fraud", brand_spoof: "Brand impersonation",
  malicious_link: "Malicious link", qr_phish: "QR phishing", reply_chain_hijack: "Hijacked thread", callback_phish: "Callback scam",
  lure_recruiting_tax_shipping: "Lure", prompt_injection: "AI manipulation", spam: "Spam",
};

/** "Password phishing and brand impersonation": the reasons as one plain phrase. */
function why(categories: string[]) {
  const names = [...new Set(categories.map(c => WHY[c] ?? c.replace(/_/g, " ")))];
  if (!names.length) return "Dangerous message";
  const list = names.map((n, k) => k && !/^[A-Z]{2}/.test(n) ? n[0]!.toLowerCase() + n.slice(1) : n);
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * Mail blocked across the workspace. Only owners and security admins see this page, and the people whose mail was blocked don't see it
 * at all. It never shows content: which mailbox, when, how it was rated and why.
 */
export default function BlockedPage() {
  const { data, isLoading, error, refetch } = useApi<{ items: Item[] }>(["org", "blocked"], "/org/blocked");
  const decide = useAction<{ id: string; decision: "release" | "delete" }>(({ id, decision }) => api(`/org/blocked/${id}`, { body: { decision } }), { success: "Done.", onDone: () => refetch() });
  return (
    <>
      <Head title="Blocked mail" description="Mail the AI stopped before it reached anyone. The people it was sent to don't see it. You see who it was for and why, never what it said. Release one if it was a mistake." />
      {isLoading ? <PageSkeleton blocks={2} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.items.length ? (
        <div className="rounded-xl bg-surface"><EmptyState icon={ShieldCheck} title="Nothing blocked">When something is stopped, it waits here for you.</EmptyState></div>
      ) : (
        <ul className="rounded-xl bg-surface" aria-label="Blocked mail">
          {[...data.items].sort((a, b) => b.received.localeCompare(a.received)).map(i => (
            <li key={i.messageId} data-testid="blocked-row" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 text-sm last:border-b-0">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{why(i.categories)}{i.state === "pending_approval" && <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">Release requested</span>}</p>
                <p className="mt-0.5 truncate text-[13px] text-muted">To {i.ownerName ? <>{i.ownerName} <span>({i.mailbox})</span></> : i.mailbox} · {fmtDateTime(i.received)}</p>
              </div>
              <RiskBadge risk={i.risk ?? undefined} />
              <div className="flex gap-2">
                <Button size="sm" className="!rounded-full" disabled={decide.isPending} onClick={() => decide.mutate({ id: i.messageId, decision: "release" })}>Release</Button>
                <Button size="sm" variant="ghost" className="!rounded-full" disabled={decide.isPending} onClick={() => decide.mutate({ id: i.messageId, decision: "delete" })}>Delete</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
