"use client";
import { FlaskConical, Link2 } from "lucide-react";
import { useState } from "react";
import { RiskBadge } from "@/components/ui";
import { EvidenceList } from "./evidence-list";
import { PHISH_SAMPLES } from "./demo-data";

function Header({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 py-0.5">
      <dt className="text-muted">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** Pick a synthetic message and read the evidence the engine produced for it. Static data, no API. */
export function PhishingDemo() {
  const [id, setId] = useState(PHISH_SAMPLES[0]!.id);
  const s = PHISH_SAMPLES.find(x => x.id === id)!;

  return (
    <div>
      <div role="group" aria-label="Choose a synthetic email" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {PHISH_SAMPLES.map(x => {
          const on = x.id === id;
          return (
            <button
              key={x.id}
              type="button"
              aria-pressed={on}
              onClick={() => setId(x.id)}
              className={`rounded-xl border p-3.5 text-left transition-colors ${on ? "border-accent bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]" : "border-line-strong bg-surface hover:bg-surface-2"}`}
            >
              <span className="block text-[15px] font-semibold">{x.pick}</span>
              <span className="mt-0.5 block text-[13px] text-muted">{x.pickDetail}</span>
            </button>
          );
        })}
      </div>

      <p role="status" className="sr-only">Showing the {s.pick.toLowerCase()} example. Result: {s.action.toLowerCase()}, with {s.evidence.length} pieces of evidence.</p>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <article aria-label={`Synthetic email: ${s.subject}`} className="min-w-0 rounded-xl border border-line-strong bg-surface">
          <p className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-4 py-2.5 text-[13px] font-semibold text-ink"><FlaskConical className="size-3.5 shrink-0" aria-hidden />Synthetic example. Not a real message.</p>
          <dl className="border-b border-line px-4 py-3 text-sm">
            <Header label="From">{s.fromName} &lt;{s.fromAddress}&gt;</Header>
            {s.replyTo && <Header label="Reply-To">{s.replyTo}</Header>}
            <Header label="To">{s.to}</Header>
            <Header label="Subject"><strong className="font-semibold">{s.subject}</strong></Header>
          </dl>
          <div className="space-y-3 px-4 py-4 text-[15px] leading-relaxed">
            {s.body.map((p, i) => <p key={i} className="whitespace-pre-line">{p}</p>)}
            {s.link && (
              <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
                <p className="flex items-center gap-1.5 font-medium [overflow-wrap:anywhere]"><Link2 className="size-3.5 shrink-0" aria-hidden />Link shows: {s.link.shown}</p>
                <p className="mt-1 text-muted [overflow-wrap:anywhere]">Link really goes to: {s.link.actual}</p>
                <p className="mt-1 text-xs text-muted">Shown as text here. This page has no live link.</p>
              </div>
            )}
          </div>
        </article>

        <section aria-label="Detection result" className="min-w-0 rounded-xl border border-line-strong bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <RiskBadge risk={s.risk} />
            <span className="text-sm font-semibold">{s.action}</span>
          </div>
          <p className="mt-2 text-sm leading-snug text-muted">{s.rationale}</p>
          <h3 className="mt-5 text-[13px] font-semibold">Evidence</h3>
          <div className="mt-2"><EvidenceList items={s.evidence} label={`Evidence for the ${s.pick.toLowerCase()} example`} /></div>
          <p className="mt-5 border-t border-line pt-3 text-sm leading-snug text-muted">{s.context}</p>
        </section>
      </div>

      <p className="mt-5 max-w-3xl text-sm leading-relaxed text-muted">
        This is the evidence the engine produced when these synthetic messages were run through it, word for word.
      </p>
    </div>
  );
}
