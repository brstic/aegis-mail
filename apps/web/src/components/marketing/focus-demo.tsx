"use client";
import { FlaskConical, ShieldAlert, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Chip, RiskBadge } from "@/components/ui";
import { EvidenceList } from "./evidence-list";
import { FOCUS_MESSAGES, SECTIONS, type FocusMessage } from "./demo-data";

type HoldState = "held" | "released" | "approval_requested";

function holdOf(m: FocusMessage, holds: Record<string, HoldState>): HoldState | null {
  return m.held ? (holds[m.id] ?? "held") : null;
}

function Detail({ m, hold, onRelease, onHoldAgain }: { m: FocusMessage; hold: HoldState | null; onRelease: () => void; onHoldAgain: () => void }) {
  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-[17px] leading-snug font-semibold [overflow-wrap:anywhere]">{m.subject}</h4>
        <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">{m.fromName} &lt;{m.fromAddress}&gt;</p>
        <p className="mt-0.5 text-sm text-muted">To your {m.account.toLowerCase()} account · {m.time}</p>
      </div>

      <div>
        <h5 className="text-[13px] font-semibold">Why it ranked here</h5>
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-sm leading-snug">
          {m.reasons.map(r => <li key={r}>{r}</li>)}
        </ul>
      </div>

      <div>
        <h5 className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">Security checks <RiskBadge risk={m.risk} /></h5>
        <p className="mt-1.5 text-sm leading-snug text-muted [overflow-wrap:anywhere]">{m.summary}</p>
        <div className="mt-3"><EvidenceList items={m.evidence} label={`Evidence for ${m.subject}`} /></div>
      </div>

      {hold === null && <p className="border-t border-line pt-3 text-sm text-muted">{m.rationale}</p>}

      {hold === "held" && (
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <p className="flex items-start gap-1.5 text-sm font-medium"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{m.rationale}</p>
          <p className="mt-1 text-sm text-muted">Held in this app only. It&apos;s still in your provider&apos;s mailbox, and it can still be opened in another mail client.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onRelease}>{m.risk === "malicious" ? "Request release" : "Not a threat: release"}</Button>
          </div>
        </div>
      )}

      {hold === "released" && (
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <p className="text-sm font-medium">Released to Inbox.</p>
          <p className="mt-1 text-sm text-muted">The warning stays on the message, and the release is recorded in the audit log. In this simulation, nothing was changed anywhere.</p>
          <div className="mt-3"><Button icon={Undo2} onClick={onHoldAgain}>Report phishing and hold it again</Button></div>
        </div>
      )}

      {hold === "approval_requested" && (
        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <p className="text-sm font-medium">Waiting for approval.</p>
          <p className="mt-1 text-sm text-muted">This message was rated malicious, so a security admin needs to approve its release. Your request was recorded. In this simulation, nobody was notified.</p>
        </div>
      )}
    </div>
  );
}

/** A simulated Focus view. All local state: it makes no network calls and touches no account. */
export function FocusDemo() {
  const [selected, setSelected] = useState("tallow");
  const [inlineOpen, setInlineOpen] = useState(false);
  const [holds, setHolds] = useState<Record<string, HoldState>>({});
  const [status, setStatus] = useState("");
  const rowRef = useRef<HTMLButtonElement>(null);

  // On narrow screens a detail opens under its row, and closing another can shift the row out of view.
  useEffect(() => {
    if (inlineOpen && window.matchMedia("(max-width: 1023px)").matches) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected, inlineOpen]);

  const select = (id: string) => {
    setInlineOpen(open => (id === selected ? !open : true));
    setSelected(id);
    const m = FOCUS_MESSAGES.find(x => x.id === id)!;
    setStatus(`Showing why ${m.subject} ranked here.`);
  };

  const release = (m: FocusMessage) => {
    const next: HoldState = m.risk === "malicious" ? "approval_requested" : "released";
    setHolds(h => ({ ...h, [m.id]: next }));
    setStatus(next === "released" ? `${m.subject} was released to Inbox in this simulation.` : `Release of ${m.subject} needs a security admin's approval.`);
  };
  const holdAgain = (m: FocusMessage) => {
    setHolds(h => ({ ...h, [m.id]: "held" }));
    setStatus(`${m.subject} is held again in this simulation.`);
  };

  const current = FOCUS_MESSAGES.find(x => x.id === selected)!;

  return (
    <div className="overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-surface-2 px-4 py-2.5">
        <p className="text-sm font-semibold">Focus</p>
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted"><FlaskConical className="size-3.5 shrink-0" aria-hidden />Synthetic example. Fictional people, no real mail.</p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{status}</p>

      <div className="grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="min-w-0 lg:border-r lg:border-line">
          {SECTIONS.map(s => {
            const rows = FOCUS_MESSAGES.filter(m => m.section === s.key);
            return (
              <div key={s.key}>
                <h3 className={`border-b border-line bg-surface px-4 pt-3 pb-1.5 text-xs font-semibold ${s.key === "security_review" ? "text-danger" : "text-muted"}`}>{s.label} · {rows.length}</h3>
                <ul>
                  {rows.map(m => {
                    const hold = holdOf(m, holds);
                    const isCurrent = m.id === selected;
                    return (
                      <li key={m.id} className="border-b border-line">
                        <button
                          ref={isCurrent ? rowRef : undefined}
                          type="button"
                          aria-current={isCurrent ? "true" : undefined}
                          onClick={() => select(m.id)}
                          className={`block w-full scroll-mt-20 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2 ${isCurrent ? "bg-accent-soft/60 shadow-[inset_3px_0_0_var(--accent)]" : ""}`}
                        >
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="truncate text-sm font-semibold">{m.fromName}</span>
                            <span className="shrink-0 text-xs text-muted">{m.time}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-sm">{m.subject}</span>
                          <span className="mt-0.5 block truncate text-[13px] text-muted">{m.snippet}</span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Chip>{m.account}</Chip>
                            <RiskBadge risk={m.risk} quiet />
                            {hold === "held" && <Chip tone="neutral">Held</Chip>}
                            {hold === "released" && <Chip tone="accent">Released</Chip>}
                            {hold === "approval_requested" && <Chip tone="neutral">Awaiting approval</Chip>}
                          </span>
                        </button>
                        {isCurrent && inlineOpen && (
                          <div className="border-t border-line bg-bg p-4 lg:hidden">
                            <Detail m={m} hold={hold} onRelease={() => release(m)} onHoldAgain={() => holdAgain(m)} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="hidden min-w-0 bg-bg p-6 lg:block">
          <Detail m={current} hold={holdOf(current, holds)} onRelease={() => release(current)} onHoldAgain={() => holdAgain(current)} />
        </div>
      </div>
    </div>
  );
}
