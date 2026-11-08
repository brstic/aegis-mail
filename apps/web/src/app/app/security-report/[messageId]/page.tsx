"use client";
import { hoverEvidence, MessageAutopsy } from "@/film/mini/hosts";
import { ArrowLeft, Check, FileSearch, Lock, Printer, ShieldAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { fmtDateTime, linkClass, PageSkeleton, TableScroll, tdClass, TextPair, thClass, usePageTitle } from "@/components/settings/common";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, RISK, RiskBadge } from "@/components/ui";
import { useApi } from "@/lib/client";

const CATEGORY: Record<string, string> = { spam: "Spam", credential_phish: "Password phishing", bec: "Business email compromise", invoice_fraud: "Invoice fraud", brand_spoof: "Brand impersonation", malware: "Malware", malicious_link: "Malicious link", qr_phish: "QR code phishing", reply_chain_hijack: "Hijacked reply chain", callback_phish: "Callback phishing", lure_recruiting_tax_shipping: "Recruiting, tax or shipping lure", tracking: "Tracking", prompt_injection: "Prompt injection" };
const ACTION: Record<string, string> = { allow: "Delivered normally", annotate: "Delivered with a note", warn: "Delivered with a warning", move_to_spam: "Moved to Spam", quarantine: "Blocked before the inbox" };
const QUARANTINE: Record<string, string> = { held: "Held, waiting for your decision", released: "Released by you", deleted: "Deleted from quarantine", pending_approval: "Waiting for an admin to approve release" };

/** What each detector looked at. Anything reported as unavailable or cut short is why a rating can be incomplete. */
function provenanceText(p: string) {
  const known: Record<string, string> = { headers: "Message headers", auth: "Sender authentication (SPF, DKIM, DMARC)", url: "Links in the message", content: "Text of the message", relationship: "Your history with this sender", attachment: "Attachments", "clamd:unavailable": "Malware scanner wasn't available", "clamd:clean": "Malware scanner ran" };
  if (known[p]) return known[p]!;
  if (p.startsWith("limits:")) return `Part of the message wasn't analyzed: ${p.slice(7).replace(/_/g, " ").replace(/,/g, ", ")}`;
  if (p.startsWith("clamd:")) return `Malware scanner: ${p.slice(6).replace(/_/g, " ")}`;
  if (p.startsWith("inspect:")) return `Opened and read: ${({ pdf: "PDF", office: "Office document", rtf: "RTF document", web: "web page or SVG", script: "script" } as Record<string, string>)[p.slice(8)] ?? p.slice(8)}`;
  if (p.startsWith("llm:")) return p.endsWith(":unavailable") ? "AI review: unavailable this time" : "AI review";
  return p.replace(/[_:]/g, " ");
}
const scanText = (s: string) => s === "clean" ? "Scanned, no threats found" : s === "infected" ? "Malware detected" : s === "not_scanned" ? "Baseline checks only: not scanned by an antivirus engine" : "Couldn't be scanned";

export default function SecurityReportPage() {
  const { messageId } = useParams<{ messageId: string }>();
  usePageTitle("Security report");
  const { data: t, isLoading, error, refetch } = useApi<any>(["thread", messageId, "report"], `/threads/${messageId}`);
  const m = t?.messages.find((x: any) => x.id === messageId) ?? t?.messages[t.messages.length - 1];
  const s = m?.security;
  const raising = s?.evidence.filter((e: any) => e.weight > 0) ?? [];
  const lowering = s?.evidence.filter((e: any) => e.weight < 0) ?? [];
  const noted = s?.evidence.filter((e: any) => e.weight === 0) ?? [];
  const backHref = t ? `/app/inbox?t=${t.id}` : "/app/inbox";
  return (
    <div data-print-root className="scroll-thin h-full overflow-auto">
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Link href={backHref} className="inline-flex items-center gap-1 text-[13px] text-muted underline-offset-2 hover:text-ink hover:underline"><ArrowLeft className="size-3.5" aria-hidden />Back to the conversation</Link>
          {s && <Button icon={Printer} onClick={() => window.print()}>Print or save as PDF</Button>}
        </div>
        <header className="mb-5"><h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><FileSearch className="size-5 text-muted print:hidden" aria-hidden />Security report</h1><p className="mt-1 max-w-2xl text-sm text-muted">What was checked in one message, what was found and why it was handled this way. It never includes the message's content, except the subject and sender below.</p></header>
        {s && <MessageAutopsy evidence={s.evidence} />}
        {isLoading ? <PageSkeleton blocks={3} /> : error || !t ? <ErrorState error={error ?? { status: 404, message: "Not found" }} retry={() => refetch()} /> : t.account.shared ? (
          <EmptyState icon={Lock} title="This report is for the mailbox's owner">You can read this shared mailbox, but its security reports stay with the person who owns it. Warnings still show on the message.</EmptyState>
        ) : !s ? (
          <EmptyState icon={ShieldAlert} title="This message hasn't been analyzed">It couldn't be read or analyzed, so it hasn't been rated safe. You can open it at your mail provider. <Link href={backHref} className={linkClass}>Back to the conversation</Link></EmptyState>
        ) : (
          <div className="space-y-4" data-testid="security-report">
            <Card title="The message">
              <dl className="space-y-1">
                <TextPair term="Subject">{m.subject || "(no subject)"}</TextPair>
                <TextPair term="From">{m.from ? `${m.from.name ? `${m.from.name} ` : ""}<${m.from.address}>` : "Unknown sender"}</TextPair>
                {m.replyTo && m.from && m.replyTo.address !== m.from.address && <TextPair term="Replies go to">{m.replyTo.address}</TextPair>}
                <TextPair term="Received in">{t.account.displayName} ({t.account.email})</TextPair>
                <TextPair term="Date"><time dateTime={m.date}>{fmtDateTime(m.date)}</time></TextPair>
              </dl>
            </Card>
            <Card title="The rating" action={<RiskBadge risk={s.label} />}>
              <p className="text-sm">{s.summary}</p>
              {s.rationale && <p className="mt-1 text-[13px] text-muted">{s.rationale}</p>}
              <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[13px] sm:grid-cols-4">
                <div><dt className="text-muted">Threat estimate</dt><dd className="font-medium tabular-nums">{Math.round(s.probability * 100)}%</dd></div>
                <div><dt className="text-muted">Severity if real</dt><dd className="font-medium capitalize">{s.severity}</dd></div>
                <div><dt className="text-muted">Analysis coverage</dt><dd className="font-medium tabular-nums">{Math.round(s.completeness * 100)}%</dd></div>
                <div><dt className="text-muted">What happened</dt><dd className="font-medium">{ACTION[s.action] ?? String(s.action).replace(/_/g, " ")}</dd></div>
              </dl>
              {!!s.categories.length && <ul className="mt-3 flex flex-wrap gap-1" aria-label="Threat categories">{s.categories.map((c: string) => <li key={c}><Chip>{CATEGORY[c] ?? c.replace(/_/g, " ")}</Chip></li>)}</ul>}
              <p className="mt-3 text-xs text-muted">{RISK[s.label]?.describe}. Estimates come from rules tuned on synthetic data. They aren't a measured accuracy.</p>
            </Card>
            <Card title="Why" description="Each finding has a stable reason code, so it can be looked up or reported.">
              {!s.evidence.length ? <p className="text-sm text-muted">No findings were recorded for this message.</p> : (
                <TableScroll label="Findings and reason codes">
                  <table className="w-full min-w-[30rem] border-collapse">
                    <thead><tr><th scope="col" className={thClass}>Effect</th><th scope="col" className={thClass}>Finding</th><th scope="col" className={thClass}>Reason code</th></tr></thead>
                    <tbody>
                      {[...raising, ...lowering, ...noted].map((e: any) => (
                        <tr key={e.code} data-testid="report-evidence" onMouseEnter={() => hoverEvidence(e.code)}>
                          <td className={`${tdClass} whitespace-nowrap`}>{e.weight > 0 ? <span className="inline-flex items-center gap-1"><TriangleAlert className="size-3 text-muted" aria-hidden />Raises risk</span> : e.weight < 0 ? <span className="inline-flex items-center gap-1"><Check className="size-3 text-muted" aria-hidden />Lowers risk</span> : "Noted"}</td>
                          <td className={tdClass}>{e.explanation}</td>
                          <td className={`${tdClass} font-mono text-xs break-all`}>{e.code}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </Card>
            <Card title="What was checked" description="Where these results came from. Anything missing here wasn't checked.">
              {!s.provenance.length ? <p className="text-sm text-muted">Not recorded.</p> : <ul className="list-disc space-y-0.5 pl-5 text-[13px]" data-testid="report-provenance">{s.provenance.map((p: string) => <li key={p}>{provenanceText(p)}</li>)}</ul>}
              {m.attachments.length > 0 && <><h3 className="mt-3 text-[13px] font-semibold">Attachments</h3><ul className="mt-1 space-y-0.5 text-[13px]">{m.attachments.filter((a: any) => a.disposition === "attachment").map((a: any) => <li key={a.id} className="break-words">{a.filename}: <span className="text-muted">{scanText(a.scan)}</span></li>)}</ul></>}
            </Card>
            {(m.quarantine || m.held) && <Card title="Blocked"><dl className="space-y-1"><TextPair term="State">{QUARANTINE[m.quarantine?.state] ?? (m.held ? "Held" : m.quarantine?.state)}</TextPair>{m.quarantine?.originalFolder && <TextPair term="Original location">{m.quarantine.originalFolder}</TextPair>}<TextPair term="At your provider">{m.quarantine?.providerMoved ? "Also moved to Spam, and releasing it moves it back." : "Not moved. It can still be opened in other mail apps."}</TextPair></dl></Card>}
            {["suspicious", "high_risk", "malicious"].includes(s.label) && <Banner tone="warn" icon={ShieldAlert}>Don't pay, change bank details or enter a password because of this message. Check with the sender using a phone number you already have.</Banner>}
            <p className="text-xs text-muted">This report contains the subject and sender. Printing or saving it makes a copy this app can't track. To involve your security team without making a copy, use Share with security on the message.</p>
          </div>
        )}
      </div>
    </div>
  );
}
