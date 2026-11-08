"use client";
import { ThemeToggle } from "@/components/theme-toggle";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { GitHubCta } from "./primitives";
import { Logo } from "./logo";

const NAV = [
  { href: "/features", label: "Features" },
  { href: "/security", label: "Security" },
  { href: "/docs", label: "Docs" },
];

/** `marketing` is false on a self-hosted instance: its only public pages are legal ones, so the header is the logo and sign-in. */
export function SiteHeader({ marketing = true }: { marketing?: boolean }) {
  const nav = marketing ? NAV : [];
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 bg-[color-mix(in_srgb,var(--bg)_80%,transparent)] backdrop-blur-xl">
      <a href="#main" className="sr-only rounded-lg bg-surface px-3 py-2 text-sm font-medium focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-40">Skip to content</a>
      <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-6 px-4 sm:px-6 lg:px-8">
        <Logo />
        <nav aria-label="Main" className="hidden flex-1 items-center gap-1 lg:flex">
          {nav.map(n => {
            const active = path === n.href;
            return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={`rounded-lg px-3 py-2 text-[13px] transition-colors hover:text-ink ${active ? "font-medium text-ink" : "text-muted"}`}>{n.label}</Link>;
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle className="text-muted hover:bg-surface-2 hover:text-ink" />
          <Link href="/sign-in" className={`rounded-lg px-3 py-2 text-[13px] hover:bg-surface-2 ${marketing ? "hidden sm:block" : "block"}`}>Sign in</Link>
          {marketing && <GitHubCta className="!h-8 !px-3.5 !text-[13px]">GitHub</GitHubCta>}
          {nav.length > 0 && <button
            type="button"
            aria-expanded={open}
            aria-controls="site-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen(v => !v)}
            className="grid size-10 place-items-center rounded-lg text-ink hover:bg-surface-2 lg:hidden"
          >
            {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>}
        </div>
      </div>
      {open && (
        <nav id="site-menu" aria-label="Main, mobile" className="border-t border-line bg-bg lg:hidden">
          <ul className="mx-auto max-w-6xl px-2 py-2 sm:px-4">
            {nav.map(n => <li key={n.href}><Link href={n.href} aria-current={path === n.href ? "page" : undefined} className={`block rounded-lg px-3 py-3 text-base hover:bg-surface-2 ${path === n.href ? "font-medium text-ink" : "text-muted"}`}>{n.label}</Link></li>)}
            <li className="sm:hidden"><Link href="/sign-in" className="block rounded-lg px-3 py-3 text-base font-medium hover:bg-surface-2">Sign in</Link></li>
          </ul>
        </nav>
      )}
    </header>
  );
}
