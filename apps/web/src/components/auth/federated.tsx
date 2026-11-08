"use client";
import { Building2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client";

interface Options { sso: boolean; google: boolean; microsoft: boolean }

const linkClass = "inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-4 text-[15px] font-medium transition-colors hover:bg-surface-2";

/**
 * Full page navigations, because each one ends at an identity provider. Nothing renders until this deployment says the
 * option exists, so these never appear as buttons that can't work. Separate from connecting a mailbox.
 */
export function FederatedButtons({ next, email, verb = "Continue" }: { next: string | null; email?: string; verb?: "Continue" | "Sign up" }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [ssoEmail, setSsoEmail] = useState(email ?? "");
  useEffect(() => {
    let live = true;
    api<{ signIn?: Options }>("/public/config").then(c => { if (live) setOpts(c.signIn ?? null); }).catch(() => { /* Buttons stay hidden if config can't load. */ });
    return () => { live = false; };
  }, []);
  if (!opts || (!opts.sso && !opts.google && !opts.microsoft)) return null;
  const nextQuery = next ? `next=${encodeURIComponent(next)}` : "";
  const startSso = (e: FormEvent) => { e.preventDefault(); window.location.assign(`/api/v1/auth/sso/start?email=${encodeURIComponent(ssoEmail.trim())}${nextQuery ? `&${nextQuery}` : ""}`); };
  return (
    <div className="mt-3 space-y-2" data-testid="federated-signin">
      {opts.google && <a className={linkClass} href={`/api/v1/auth/social/google/start${nextQuery ? `?${nextQuery}` : ""}`}>{verb} with Google</a>}
      {opts.microsoft && <a className={linkClass} href={`/api/v1/auth/social/microsoft/start${nextQuery ? `?${nextQuery}` : ""}`}>{verb} with Microsoft</a>}
      {opts.sso && (ssoOpen ? (
        <form onSubmit={startSso} className="space-y-2 rounded-lg border border-line p-3">
          <Field label="Work email"><input type="email" required autoComplete="username" spellCheck={false} value={ssoEmail} onChange={e => setSsoEmail(e.target.value)} className={`${inputClass} !h-12 !rounded-xl !px-4 !text-base`} /></Field>
          <Button type="submit" variant="primary" className="!h-12 w-full !rounded-full !text-[15px]">Continue to your organization</Button>
        </form>
      ) : <Button type="button" icon={Building2} className="!h-12 w-full !rounded-full !text-[15px]" onClick={() => setSsoOpen(true)}>Use single sign-on</Button>)}
      {(opts.google || opts.microsoft) && <p className="text-[13px] leading-relaxed text-muted">This signs you in to the product. It doesn&apos;t connect your mailbox or give us access to your mail.</p>}
    </div>
  );
}
