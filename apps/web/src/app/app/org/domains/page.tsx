"use client";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, Globe, Lock, Plus, RefreshCw } from "lucide-react";
import { useState, type FormEvent } from "react";
import { fmtDate, Head, PageSkeleton } from "@/components/settings/common";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Field, inputClass } from "@/components/ui";
import { api, useAction, useApi, useMe } from "@/lib/client";

interface Domain { domain: string; token: string; verifiedAt: string | null; lapsedAt: string | null; lapsesAt: string | null }

function DomainRow({ d, canEdit, onDone }: { d: Domain; canEdit: boolean; onDone: () => void }) {
  const verify = useAction<void>(() => api("/org/domains/verify", { body: { domain: d.domain } }), { refresh: false, success: `${d.domain} is verified.`, onDone });
  return (
    <li className="border-b border-line p-3 last:border-b-0" data-testid="domain-row">
      <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 font-medium break-all">{d.domain}</span>{d.verifiedAt ? <Chip tone={d.lapsesAt ? "warn" : "safe"}>{d.lapsesAt ? <Clock className="size-3" aria-hidden /> : <CheckCircle2 className="size-3" aria-hidden />}Verified {fmtDate(d.verifiedAt)}</Chip> : <Chip tone="warn"><Clock className="size-3" aria-hidden />{d.lapsedAt ? "Lapsed" : "Not verified"}</Chip>}</div>
      {d.lapsedAt && !d.verifiedAt && <div className="mt-2"><Banner tone="warn">Its TXT record went missing, so this domain stopped counting as verified on {fmtDate(d.lapsedAt)}. Single sign-on and provisioning for it have stopped. If you still own it, add the record again.</Banner></div>}
      {d.verifiedAt && d.lapsesAt && <div className="mt-2"><Banner tone="warn">We can't find this domain's TXT record. If it isn't back by {fmtDate(d.lapsesAt)}, the domain stops counting as verified, and single sign-on and provisioning for it stop.</Banner></div>}
      {(!d.verifiedAt || d.lapsesAt) && (
        <div className="mt-2 space-y-2">
          <p className="text-[13px] text-muted">Add this TXT record at your DNS provider, then check it here. DNS changes can take a while to appear.</p>
          <dl className="grid gap-x-3 gap-y-1 rounded-lg bg-surface-2 p-2.5 text-[13px] sm:grid-cols-[auto_1fr]">
            <dt className="text-muted">Type</dt><dd className="font-mono text-xs">TXT</dd>
            <dt className="text-muted">Name</dt><dd className="font-mono text-xs break-all">{d.domain}</dd>
            <dt className="text-muted">Value</dt><dd className="font-mono text-xs break-all" data-testid="txt-value">{d.token}</dd>
          </dl>
          {verify.error && <Banner tone="warn">{verify.error.message}</Banner>}
          {canEdit && <Button size="sm" icon={RefreshCw} loading={verify.isPending} onClick={() => verify.mutate()} aria-label={`Check DNS for ${d.domain}`}>Check DNS now</Button>}
        </div>
      )}
    </li>
  );
}

export default function DomainsPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data, isLoading, error, refetch } = useApi<Domain[]>(["org", "domains"], "/org/domains", { retry: false });
  const canEdit = !!me && ["owner", "security_admin"].includes(me.role);
  const [domain, setDomain] = useState("");
  const changed = () => void qc.invalidateQueries({ queryKey: ["org", "domains"] });
  const add = useAction<void>(() => api("/org/domains", { body: { domain: domain.trim() } }), { refresh: false, success: "Domain added. Add the TXT record to verify it.", onDone: () => { setDomain(""); changed(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (domain.trim()) add.mutate(); };
  return (
    <>
      <Head title="Domains" description="Prove your organization controls a domain by adding a DNS record." />
      <div className="space-y-4">
        {canEdit ? (
          <Card title="Add a domain">
            <form onSubmit={submit} className="space-y-3">
              <Field label="Domain" hint="A domain you control, such as example.org. Public mail domains aren't accepted."><input className={inputClass} value={domain} onChange={e => setDomain(e.target.value)} spellCheck={false} autoCapitalize="off" /></Field>
              {add.error && <Banner tone="danger">{add.error.message}</Banner>}
              <Button type="submit" variant="primary" icon={Plus} loading={add.isPending} disabled={!domain.trim()}>Add domain</Button>
            </form>
          </Card>
        ) : me && <Banner tone="neutral" icon={Lock}>Only owners and security admins can add or verify domains.</Banner>}
        <section aria-labelledby="domains-heading">
          <h2 id="domains-heading" className="mb-2 text-[15px] font-semibold">Your domains</h2>
          {isLoading ? <PageSkeleton blocks={1} /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? <div className="rounded-xl bg-surface"><EmptyState icon={Globe} title="No domains yet">Nothing has been added for this workspace.</EmptyState></div> : <ul className="rounded-xl bg-surface">{data.map(d => <DomainRow key={d.domain} d={d} canEdit={canEdit} onDone={changed} />)}</ul>}
        </section>
      </div>
    </>
  );
}
