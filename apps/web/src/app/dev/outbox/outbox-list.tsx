"use client";
import { useState } from "react";
import { fmtDateTime } from "@/components/settings/common";

export interface OutboxMail { id: string; to: string; subject: string; text: string; createdAt: string }

const LINK = /(https?:\/\/[^\s]+)/g;
const PAGE = 20;

/** What a link in the mail is for, read from its path. Anything unrecognized keeps a plain "Open link". */
function linkLabel(href: string) {
  let path = href;
  try { path = new URL(href).pathname; } catch { /* keep the raw text */ }
  if (path.startsWith("/verify-email/")) return "Confirm email";
  if (path.startsWith("/reset-password/")) return "Reset password";
  if (path.startsWith("/invite/")) return "Accept invitation";
  return "Open link";
}

/**
 * Newest first, 20 at a time. The older ones stay in the page, hidden, so scripts that look for a recent mail by its link still
 * find it whether or not someone pressed "Show more".
 */
export function OutboxList({ mail }: { mail: OutboxMail[] }) {
  const [shown, setShown] = useState(PAGE);
  const rest = mail.length - shown;
  return (
    <>
      <ul className="space-y-3" data-testid="outbox">
        {mail.map((m, i) => (
          <li key={m.id} hidden={i >= shown} className="min-w-0 rounded-xl border border-line bg-surface p-4" data-testid="outbox-mail">
            <p className="font-semibold break-words">{m.subject}</p>
            <p className="mb-2 text-[13px] break-all text-muted">To {m.to} · <time dateTime={m.createdAt} suppressHydrationWarning>{fmtDateTime(m.createdAt)}</time></p>
            <div className="text-sm leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
              {m.text.trim().split(LINK).map((part, j) => j % 2 === 1
                ? <a key={j} href={part} className="my-1 inline-flex h-9 items-center rounded-lg bg-accent px-3.5 text-sm font-medium whitespace-nowrap text-on-accent hover:bg-accent-hover">{linkLabel(part)}</a>
                : part)}
            </div>
          </li>
        ))}
      </ul>
      {rest > 0 && <button type="button" onClick={() => setShown(s => s + PAGE)} className="mt-4 inline-flex h-9 items-center rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-surface-2">Show {Math.min(rest, PAGE)} more</button>}
    </>
  );
}
