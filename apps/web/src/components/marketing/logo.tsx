import Link from "next/link";

/** Original mark: a shield whose top is an envelope flap. Uses tokens, so it follows the theme. */
export function LogoMark({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M12 2.6 20 5.4V12c0 4.6-3.2 7.9-8 9.4-4.8-1.5-8-4.8-8-9.4V5.4l8-2.8Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="m4.4 6.2 7.6 6.3 7.6-6.3" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 rounded text-ink" aria-label="Aegis Mail home">
      <LogoMark className="size-[22px]" />
      <span className="text-[1.0625rem] leading-none font-semibold tracking-[-.015em]">Aegis Mail</span>
    </Link>
  );
}
