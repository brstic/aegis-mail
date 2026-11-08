"use client";
import Link from "next/link";
import { useState } from "react";
import { ConfirmModal, Details, Head, linkClass, PageSkeleton, usePageTitle, usePrefPatch } from "@/components/settings/common";
import { Card, ErrorState, Toggle } from "@/components/ui";
import type { SemanticStatus } from "@/components/workspace/search-panel";
import { useApi, useMe } from "@/lib/client";

export default function SearchSettings() {
  usePageTitle("Search");
  const status = useApi<SemanticStatus & { model: string | null }>(["semantic-status"], "/search/semantic", { staleTime: 15_000 });
  const patch = usePrefPatch();
  const { data: me } = useMe();
  // Same rule as the sidebar: blocked mail is yours to see only outside an organization.
  const seesBlocked = !!me && me.workspaces.find(w => w.id === me.tenantId)?.kind !== "organization";
  const [confirmOff, setConfirmOff] = useState(false);
  if (status.error) return <ErrorState error={status.error} retry={() => status.refetch()} />;
  const s = status.data;
  if (!s) return <PageSkeleton blocks={2} />;
  return (
    <>
      <Head title="Search" description="Find mail by its words, or by what it means." />
      <div className="space-y-4">
        <Card title="Semantic search">
          <div data-testid="semantic-setting">
            {!s.available
              ? <p className="text-[13px] text-muted">{s.reason === "privacy_mode" ? "Not available with this workspace's privacy mode." : "Not available on this server yet."} Word search works as usual.</p>
              : <Toggle label="Semantic search" checked={s.enabled && s.serverSearchEnabled} disabled={!s.serverSearchEnabled} onChange={v => { if (v) patch.mutate({ semanticSearchEnabled: true }, { onSuccess: () => void status.refetch() }); else setConfirmOff(true); }} description={s.serverSearchEnabled ? (s.enabled ? "On. Finds mail close in meaning to your words, so \"the supplier who wanted a bank detail change\" can find a message about updating a beneficiary account." : "Off. Turn it on to find mail by meaning, not only by its exact words.") : "Off, because server search is off in the Privacy Center. It needs that on."} />}
            {s.available && s.enabled && s.serverSearchEnabled && <p className="mt-2 text-[13px]" data-testid="semantic-coverage">{s.indexed.toLocaleString()} of {s.eligible.toLocaleString()} messages you can search are indexed. Older mail is indexed in the background.</p>}
            <Details>
              <p>A small model runs on this server, so your mail isn't sent to a model provider. Results are ranked by closeness in meaning and can include near misses.</p>
              <p>Each message's subject and opening text become a vector, stored encrypted like the message itself. Turning semantic search off deletes your vectors right away.</p>
              <p>Each search compares your {s.candidateLimit.toLocaleString()} most recent indexed messages. Older mail is found by its words.</p>
              <p>Sealed messages are never indexed.{seesBlocked ? " Blocked mail stays out of results unless you use is:flagged or risk:, the same as word search." : ""}</p>
            </Details>
          </div>
        </Card>
        <Card title="Word index">
          <p className="text-[13px] text-muted">{s.serverSearchEnabled ? "On. Search words are stored unencrypted in the database, which is what makes word search work." : "Off. Search words aren't stored, so word searches find nothing."} You can change this in the <Link href="/app/privacy" className={linkClass}>Privacy Center</Link>.</p>
        </Card>
        <Card title="Related words">
          <p className="text-[13px] text-muted">An option on each search. It widens your words using a short built-in list, so payment also finds invoice. It stores nothing.</p>
        </Card>
      </div>
      {confirmOff && <ConfirmModal title="Turn off semantic search?" danger confirmLabel="Turn off and delete vectors" onConfirm={() => { patch.mutate({ semanticSearchEnabled: false }, { onSuccess: () => void status.refetch() }); setConfirmOff(false); }} onClose={() => setConfirmOff(false)}><p>This deletes the vectors for your mailboxes now, not later. Word search isn't affected. If you turn it back on, they're rebuilt from your stored mail in the background.</p></ConfirmModal>}
    </>
  );
}
