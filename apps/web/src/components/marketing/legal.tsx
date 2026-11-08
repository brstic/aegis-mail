import type { ReactNode } from "react";
import { Container, proseClass } from "./primitives";

/**
 * The frame for a legal page: a readable measure, the title, the date it last changed, and a short list of sections.
 * `updated` is an ISO date (2026-11-07). Keep it in step with real edits to the text.
 */
export function LegalPage({ title, updated, intro, sections, children }: { title: string; updated: string; intro?: ReactNode; sections?: { id: string; label: string }[]; children: ReactNode }) {
  return (
    <Container className="py-16 sm:py-24">
      <article className="mx-auto max-w-[42rem]">
        <header className="border-b border-line pb-8">
          <p className="text-[13px] font-medium text-muted">Legal</p>
          <h1 className="mt-2 font-display text-[2.5rem] leading-[1.08] tracking-tight sm:text-[3.25rem]">{title}</h1>
          <p className="mt-3 text-[15px] text-muted">Last updated <time dateTime={updated}>{new Date(`${updated}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}</time></p>
          {intro && <div className="mt-6 text-[17px] leading-[1.6] text-ink">{intro}</div>}
        </header>
        {sections && (
          <nav aria-label="On this page" className="border-b border-line py-6">
            <ol className="grid gap-x-8 gap-y-1.5 text-[15px] sm:grid-cols-2">
              {sections.map((s, i) => <li key={s.id} className="flex gap-2"><span className="w-5 shrink-0 text-muted tabular-nums">{i + 1}.</span><a href={`#${s.id}`} className="text-muted underline-offset-2 hover:text-ink hover:underline">{s.label}</a></li>)}
            </ol>
          </nav>
        )}
        <div className={`${proseClass} text-[16px] leading-[1.7] [&>h2]:mt-14 [&>h2:first-child]:mt-10 [&>h3]:mt-8`}>{children}</div>
      </article>
    </Container>
  );
}
