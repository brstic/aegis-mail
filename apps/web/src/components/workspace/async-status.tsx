"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useApi, useRefreshMail, useToast } from "@/lib/client";

/**
 * Tells people about things that finish after the screen has moved on: a change the provider refused and that was rolled
 * back, and a send that failed. Nothing here does any work. It watches and says what happened.
 */
export function AsyncStatus() {
  const toast = useToast();
  const router = useRouter();
  const refresh = useRefreshMail();
  const qc = useQueryClient();
  const [since] = useState(() => new Date().toISOString());
  const seenRefusals = useRef(new Set<string>());
  const seenDrafts = useRef<Map<string, string> | null>(null);
  const refusals = useApi<{ messageId: string; threadId: string | null; at: string; code: string | null }[]>(["mail-refusals"], `/mail/refusals?since=${encodeURIComponent(since)}`, { refetchInterval: 30_000, retry: false });
  const drafts = useApi<{ id: string; state: string; subject: string; accountEmail: string }[]>(["drafts"], "/drafts", { refetchInterval: 30_000 });

  useEffect(() => {
    const fresh = (refusals.data ?? []).filter(r => !seenRefusals.current.has(`${r.messageId}:${r.at}`));
    if (!fresh.length) return;
    for (const r of fresh) seenRefusals.current.add(`${r.messageId}:${r.at}`);
    refresh();
    const threadId = fresh[0]!.threadId;
    toast({ tone: "danger", text: `Your mail provider refused a change, so ${fresh.length === 1 ? "that conversation is back how it was" : `${fresh.length} messages are back how they were`}.`, action: threadId ? { label: "Open", run: () => router.push(`/app/inbox?t=${threadId}`) } : undefined });
  }, [refusals.data, refresh, router, toast]);

  useEffect(() => {
    if (!drafts.data) return;
    const now = new Map(drafts.data.map(d => [d.id, d.state]));
    const before = seenDrafts.current;
    seenDrafts.current = now;
    if (!before) return;
    for (const d of drafts.data) {
      if (d.state === "failed" && before.get(d.id) !== "failed") {
        toast({ tone: "danger", text: `"${d.subject || "No subject"}" didn't send from ${d.accountEmail}.`, action: { label: "See Drafts", run: () => router.push("/app/drafts") } });
        void qc.invalidateQueries({ queryKey: ["threads"] });
      }
    }
  }, [drafts.data, qc, router, toast]);
  return null;
}
