import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/marketing/logo";
import { AuthShieldSlot } from "./auth-shield-slot";
import { ThemeToggle } from "@/components/theme-toggle";
import { marketingSiteEnabled } from "@/components/marketing/site";

/** Footer links. The security and trust pages exist only on the marketing site, so a self-hosted instance links to its legal pages alone. */
function footerLinks(wide: boolean): [string, string][] {
  const legal: [string, string][] = [["/legal/privacy", "Privacy"], ["/legal/license", "License"]];
  if (!marketingSiteEnabled()) return legal;
  return [...(wide ? [["/privacy-architecture", "Privacy architecture"], ["/trust", "Trust center"]] : [["/security", "Security"], ["/trust", "Trust center"]]) as [string, string][], ...legal];
}

/** Page chrome for sign-up, password reset, email confirmation and invitations: the same split as sign-in. `wide` is the plain frame, for dev tools. */
export function AuthFrame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  if (!wide) return <AuthSplit visual={<AuthShieldSlot />}>{children}</AuthSplit>;
  const width = "max-w-5xl";
  return (
    <div className="flex min-h-full flex-col text-[15px]">
      <header className={`mx-auto flex h-16 w-full items-center px-4 sm:px-6 ${width}`}><Logo /></header>
      <main className={`mx-auto w-full flex-1 px-4 pt-6 pb-16 sm:px-6 sm:pt-10 ${width}`}>{children}</main>
      <footer className={`mx-auto w-full px-4 pb-6 text-[13px] text-muted sm:px-6 ${width}`}>
        <nav aria-label="Legal and trust" className="flex flex-wrap gap-x-4 gap-y-1">
          {footerLinks(true).map(([href, label]) => <Link key={href} href={href} className="inline-flex min-h-6 items-center underline-offset-2 hover:text-ink hover:underline">{label}</Link>)}
        </nav>
      </footer>
    </div>
  );
}

/**
 * Sign-in and the other account pages: one card in the middle, with the shield working behind it. Mail flies in around the card; the
 * threats are stopped at the shield. The background is dark in both themes, so the light reads; the card follows the theme.
 */
export function AuthSplit({ visual, children }: { visual: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-bg relative flex min-h-dvh flex-col overflow-hidden text-[15px]">
      <div aria-hidden="true" className="absolute inset-0">{visual}</div>
      <header className="relative z-10 flex h-16 items-center px-5 sm:px-8">
        <span className="[&_a]:!text-[var(--auth-fg)]"><Logo /></span>
        <p className="ml-auto hidden items-center gap-2 text-[13px] font-medium text-[var(--auth-muted)] sm:flex"><span className="size-1.5 rounded-full bg-[#2997ff] shadow-[0_0_8px_#2997ff]" />Every message checked for threats</p>
        <ThemeToggle className="ml-auto text-[var(--auth-muted)] hover:bg-[var(--auth-hover)] hover:text-[var(--auth-fg)] sm:ml-4" />
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-8">
        <div className="auth-card w-full max-w-[420px] rounded-[28px] bg-surface p-7 shadow-[0_30px_80px_-24px_rgba(0,30,80,.35)] ring-1 ring-black/5 backdrop-blur-xl sm:p-9">{children}</div>
      </main>
      <footer className="relative z-10 px-5 pb-5 text-[13px] text-[var(--auth-muted)] sm:px-8">
        <nav aria-label="Legal and trust" className="mx-auto flex w-fit flex-wrap justify-center gap-x-4 gap-y-1 rounded-full bg-[var(--auth-chip-bg)] px-4 py-1 backdrop-blur-md">
          {footerLinks(false).map(([href, label]) => <Link key={href} href={href} className="inline-flex min-h-6 items-center underline-offset-2 hover:text-[var(--auth-fg)] hover:underline">{label}</Link>)}
        </nav>
      </footer>
    </div>
  );
}

export function AuthTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-[2rem] leading-[1.1] font-semibold tracking-tight">{title}</h1>
      {children && <div className="mt-2 leading-relaxed text-muted [&_a]:font-medium [&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2">{children}</div>}
    </div>
  );
}

/** Only same-site paths into the app or an invitation. Anything else falls back, so `next` can't become an open redirect. */
export function safeNext(next: string | string[] | undefined): string | null {
  if (typeof next !== "string") return null;
  return /^\/(app(\/|$)|invite\/)[^\\]*$/.test(next) && !next.startsWith("//") ? next : null;
}
