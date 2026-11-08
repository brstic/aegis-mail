import Link from "next/link";
import { REPO_URL } from "./site";

/** Named the same as the sign-in and sign-up footers, so a page is called one thing everywhere. */
const PRODUCT = [["/features", "Features"], ["/security", "Security"], ["/privacy-architecture", "Privacy architecture"], ["/trust", "Trust center"], ["/docs", "Docs"]] as const;
export const LEGAL_LINKS = [["/legal/privacy", "Privacy"], ["/legal/license", "License"]] as const;

const link = "inline-flex min-h-6 items-center underline-offset-2 hover:text-ink hover:underline";

/** `marketing` is false on a self-hosted instance, where only the legal pages are served. */
export function SiteFooter({ marketing = true }: { marketing?: boolean }) {
  return (
    <footer className="bg-bg">
      <div className="mx-auto w-full max-w-6xl border-t border-line px-4 py-10 text-xs text-muted sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-3">
          <nav aria-label="Site" className="flex flex-wrap gap-x-5 gap-y-1">
            {marketing && PRODUCT.map(([href, label]) => <Link key={href} href={href} className={link}>{label}</Link>)}
            <a href={REPO_URL} className={link}>GitHub</a>
          </nav>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-5 gap-y-1">
            {LEGAL_LINKS.map(([href, label]) => <Link key={href} href={href} className={link}>{label}</Link>)}
          </nav>
        </div>
        {marketing && <p className="mt-4 leading-relaxed">All people, companies and messages shown here are synthetic. Gmail, Outlook, iCloud and other names belong to their owners.</p>}
      </div>
    </footer>
  );
}
