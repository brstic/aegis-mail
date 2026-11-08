/** Simplified marks for the mail services this connects to, at icon size. The names belong to their owners. Decorative: each sits beside its name. */
export function ProviderIcon({ kind, className = "size-4" }: { kind: "gmail" | "outlook" | "icloud" | "imap"; className?: string }) {
  if (kind === "gmail") return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M2 6.5v11.3C2 18.5 2.5 19 3.2 19H6.6V10.8L12 14.6l5.4-3.8V19h3.4c.7 0 1.2-.5 1.2-1.2V6.5" fill="none" />
      <path d="M2 7.2V18c0 .6.5 1 1 1h3.4v-8.6L2 7.2Z" fill="#4285F4" />
      <path d="M17.6 19H21c.6 0 1-.4 1-1V7.2l-4.4 3.2V19Z" fill="#34A853" />
      <path d="M17.6 4.8v5.6L22 7.2V5.6c0-1.6-1.8-2.5-3.1-1.6l-1.3.8Z" fill="#FBBC04" />
      <path d="M6.4 10.4V4.8L12 9l5.6-4.2v5.6L12 14.6l-5.6-4.2Z" fill="#EA4335" />
      <path d="M2 5.6v1.6l4.4 3.2V4.8L5.1 4C3.8 3.1 2 4 2 5.6Z" fill="#C5221F" />
    </svg>
  );
  if (kind === "outlook") return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="8" y="4" width="14" height="16" rx="1.6" fill="#28A8EA" />
      <path d="M8.5 6.5 15 11l6.5-4.5" stroke="#fff" strokeOpacity=".85" strokeWidth="1.2" fill="none" />
      <rect x="2" y="6" width="12" height="12" rx="1.6" fill="#0F6CBD" />
      <ellipse cx="8" cy="12" rx="2.6" ry="3.2" stroke="#fff" strokeWidth="1.6" fill="none" />
    </svg>
  );
  if (kind === "icloud") return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs><linearGradient id="icloud-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5AB3FF" /><stop offset="1" stopColor="#1F7AE8" /></linearGradient></defs>
      <path d="M6.5 18.5h11a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.3 4.6 4.6 0 0 0 6.5 18.5Z" fill="url(#icloud-g)" />
    </svg>
  );
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="m3.5 6.5 8.5 6 8.5-6" />
    </svg>
  );
}
