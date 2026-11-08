import { Check, ChevronDown, Minus, X } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { REPO_URL } from "./site";

/** Shared building blocks for the public pages. Server components unless noted. */

export function Container({ children, className = "", narrow }: { children: ReactNode; className?: string; narrow?: boolean }) {
  return <div className={`mx-auto w-full px-4 sm:px-6 lg:px-8 ${narrow ? "max-w-3xl" : "max-w-6xl"} ${className}`}>{children}</div>;
}

const CTA = "inline-flex h-11 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-medium whitespace-nowrap transition-colors";
export function CtaLink({ href, children, variant = "primary", className = "" }: { href: string; children: ReactNode; variant?: "primary" | "secondary"; className?: string }) {
  const v = variant === "primary" ? "bg-accent text-on-accent hover:bg-accent-hover" : "bg-surface-3 text-ink hover:bg-line-strong";
  if (/^https?:/.test(href)) return <a href={href} className={`${CTA} ${v} ${className}`}>{children}</a>;
  return <Link href={href} className={`${CTA} ${v} ${className}`}>{children}</Link>;
}

/** The primary action everywhere on the site: the repository, where it's downloaded and self-hosted. */
export function GitHubCta({ className = "", children = "Get it on GitHub" }: { className?: string; children?: ReactNode }) {
  return <CtaLink href={REPO_URL} className={className}>{children}</CtaLink>;
}

/** The pair every page ends on: get it from GitHub, or try it first on made-up mail (the demo on the home page runs in the browser). */
export function CtaPair({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap justify-center gap-3 ${className}`}>
      <GitHubCta />
      <CtaLink href="/#focus-demo" variant="secondary">Try the demo</CtaLink>
    </div>
  );
}

/** One quiet line under a closing call to action. Every word of it is true of the repository. */
export function OpenSourceLine({ className = "" }: { className?: string }) {
  return <p className={`text-center text-[15px] text-muted ${className}`}>Free and open source under the AGPL-3.0. Runs on your own server.</p>;
}

/** A page's last word: one line and the same two buttons. */
export function ClosingCta({ title, tone = "plain" }: { title: string; tone?: "plain" | "surface" }) {
  return (
    <section aria-labelledby="closing-title" className={tone === "surface" ? "bg-surface" : ""}>
      <Container className="py-20 sm:py-28">
        <h2 id="closing-title" className="mx-auto max-w-2xl text-center font-display text-[2rem] leading-[1.1] text-balance sm:text-[2.75rem]">{title}</h2>
        <CtaPair className="mt-8" />
        <OpenSourceLine className="mt-5" />
      </Container>
    </section>
  );
}

/** The one card style on public pages: a soft white surface, no border. */
export const cardClass = "rounded-xl bg-surface p-6 sm:p-7";

/** Page opener: the only h1 on a public page. */
export function PageIntro({ title, children, visual }: { title: string; children?: ReactNode; visual?: ReactNode }) {
  const text = (
    <>
      <h1 className={`font-display text-[2.75rem] leading-[1.05] text-balance sm:text-[3.75rem] ${visual ? "" : "mx-auto max-w-4xl"}`}>{title}</h1>
      {children && <div className={`mt-5 text-[19px] leading-[1.45] text-muted sm:text-[21px] [&_a]:text-accent ${visual ? "" : "mx-auto max-w-2xl"}`}>{children}</div>}
    </>
  );
  return (
    <Container className="pt-16 pb-14 sm:pt-28 sm:pb-20">
      {visual ? <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]"><div>{text}</div>{visual}</div> : <div className="text-center">{text}</div>}
    </Container>
  );
}

export function Section({ id, title, lead, children, tone = "plain" }: { id?: string; title: string; lead?: ReactNode; children: ReactNode; tone?: "plain" | "surface" }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={`scroll-mt-20 ${tone === "surface" ? "bg-surface" : ""}`}>
      <Container className="py-20 sm:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 id={id ? `${id}-title` : undefined} className="font-display text-[2rem] leading-[1.1] text-balance sm:text-[3rem]">{title}</h2>
          {lead && <div className="mt-4 text-[17px] leading-[1.5] text-muted sm:text-[19px] [&_a]:text-accent">{lead}</div>}
        </div>
        <div className="mt-12 sm:mt-16">{children}</div>
      </Container>
    </section>
  );
}

/** Long-form text for legal and docs pages. */
export const proseClass = "text-base leading-relaxed text-ink [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&>div]:mt-5 [&>h2]:mt-12 [&>h2]:scroll-mt-20 [&>h2]:font-display [&>h2]:text-[1.625rem] [&>h2]:leading-tight [&>h2]:tracking-tight [&>h3]:mt-8 [&>h3]:scroll-mt-20 [&>h3]:text-[17px] [&>h3]:font-semibold [&>ol]:mt-4 [&>ol]:list-decimal [&>ol]:pl-5 [&>ol>li]:mt-2 [&>p]:mt-4 [&>ul]:mt-4 [&>ul]:list-disc [&>ul]:pl-5 [&>ul>li]:mt-2";

/** A small stack of feature text: title, then body. */
export function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-[1.0625rem] font-semibold tracking-[-.012em]">{title}</h3>
      <div className="mt-1.5 text-[15px] leading-relaxed text-muted [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2">{children}</div>
    </div>
  );
}

/** Everything a page could say beyond its main point: kept, and one click away. */
export function More({ label = "More detail", children, align = "center" }: { label?: string; children: ReactNode; align?: "center" | "start" }) {
  return (
    <details className="group">
      <summary className={`${align === "center" ? "mx-auto mb-14" : "mt-5 mb-6"} flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-full bg-surface-3 px-5 py-2.5 text-sm font-medium hover:bg-line-strong [&::-webkit-details-marker]:hidden`}>{label}<ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden /></summary>
      {children}
    </details>
  );
}

export type Verdict = "yes" | "no" | "partial";
const VERDICT: Record<Verdict, { icon: typeof Check; label: string; className: string }> = {
  yes: { icon: Check, label: "Yes", className: "text-safe" },
  no: { icon: X, label: "No", className: "text-ink" },
  partial: { icon: Minus, label: "Partly", className: "text-warn" },
};

/** Icon plus a word, so meaning never rests on color. */
export function VerdictTag({ verdict, label }: { verdict: Verdict; label?: string }) {
  const v = VERDICT[verdict];
  const I = v.icon;
  return <span className={`inline-flex items-start gap-1 font-medium ${v.className}`}><I className="mt-[3px] size-3.5 shrink-0" aria-hidden />{label ?? v.label}</span>;
}

export interface Cell { verdict?: Verdict; verdictLabel?: string; text?: ReactNode }
export type CellLike = Cell | string;
function renderCell(c: CellLike) {
  if (typeof c === "string") return c;
  return <>{c.verdict && <VerdictTag verdict={c.verdict} label={c.verdictLabel} />}{c.verdict && c.text ? <span className="mt-0.5 block text-muted">{c.text}</span> : c.text}</>;
}

/**
 * The same data as a real table on wider screens and as stacked cards on phones,
 * so a 360px viewport never scrolls sideways. `emphasis` highlights one column.
 */
export function ResponsiveTable({ caption, corner, columns, rows, emphasis }: { caption: string; corner: string; columns: string[]; rows: { label: ReactNode; cells: CellLike[] }[]; emphasis?: number }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl bg-surface shadow-soft md:block">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-[26%] px-4 py-3 font-medium text-muted">{corner}</th>
              {columns.map((c, i) => <th key={c} scope="col" className={`px-4 py-3 font-semibold `}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line align-top last:border-b-0">
                <th scope="row" className="px-4 py-3.5 font-medium">{r.label}</th>
                {r.cells.map((c, j) => <td key={j} className={`px-4 py-3.5 leading-relaxed text-muted`}>{renderCell(c)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden" aria-label={caption}>
        {rows.map((r, i) => (
          <li key={i} className="rounded-xl bg-surface p-4 shadow-soft">
            <div className="text-[15px] font-semibold">{r.label}</div>
            <dl className="mt-2 space-y-2.5 text-sm">
              {r.cells.map((c, j) => (
                <Fragment key={j}>
                  <div>
                    <dt className={`text-[13px] font-medium text-muted`}>{columns[j]}</dt>
                    <dd className="mt-0.5 leading-relaxed">{renderCell(c)}</dd>
                  </div>
                </Fragment>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A plainly labelled aside. */
export function Note({ title, children, tone = "neutral" }: { title?: string; children: ReactNode; tone?: "neutral" | "warn" }) {
  const t = tone === "warn" ? "border-transparent bg-warn-soft" : "border-transparent bg-surface-2";
  return (
    <div className={`rounded-xl border p-4 text-[15px] leading-relaxed sm:p-5 ${t}`}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-1" : ""}>{children}</div>
    </div>
  );
}
