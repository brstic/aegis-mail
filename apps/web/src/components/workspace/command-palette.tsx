"use client";
import { openExplain } from "@/explain/Explain";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useAccounts, useMe, useToast } from "@/lib/client";
import { inputClass, Modal } from "../ui";
import { useWorkspace } from "./shell";

interface Cmd { id: string; label: string; hint?: string; run: () => void }

/** Cmd/Ctrl+K. Every entry is something you could click elsewhere: it's a faster route, and it never acts on mail itself. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { compose, toggleAssistant, openHelp } = useWorkspace();
  const { data: accounts } = useAccounts();
  const { data: me } = useMe();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const go = (href: string) => () => { router.push(href); onClose(); };
  const cmds = useMemo<Cmd[]>(() => {
    // Mirrors the sidebar: blocked mail and admin pages appear only for the people who can see them there.
    const isOrg = me?.workspaces.find(w => w.id === me.tenantId)?.kind === "organization";
    const canAdmin = !!me && ["owner", "security_admin"].includes(me.role);
    const nav: [string, string][] = [["Focus", "/app/focus"], ["Inbox", "/app/inbox"], ["Important", "/app/important"], ["Awaiting reply", "/app/awaiting"], ["Tasks", "/app/tasks"], ["Drafts", "/app/drafts"], ["Sent", "/app/sent"], ["Scheduled", "/app/scheduled"], ["Archive", "/app/archive"]];
    if (me && !isOrg) nav.push(["Blocked", "/app/quarantine"]);
    nav.push(["Trash", "/app/trash"], ["Labels", "/app/labels"], ["Rules", "/app/rules"], ["Insights", "/app/insights"]);
    if (isOrg) nav.push(["Team mailboxes", "/app/shared"]);
    nav.push(["Privacy Center", "/app/privacy"], ["Settings", "/app/settings"], ["Connected accounts", "/app/settings/accounts"], ["Connect a mailbox", "/app/connect"], ["Sign-in and security", "/app/settings/security"], ["People and learning", "/app/settings/people"]);
    if (canAdmin && isOrg) nav.push(["Security Center", "/app/security"]);
    if (isOrg) nav.push(["Organization", "/app/org"], ["Organization policies", "/app/org/policies"], ["Audit log", "/app/org/audit"]);
    return [
      { id: "compose", label: "Compose a message", hint: "c", run: () => { onClose(); compose(); } },
      { id: "assistant", label: "Open the assistant", hint: "a", run: () => { onClose(); toggleAssistant(); } },
      { id: "help", label: "Keyboard shortcuts", hint: "?", run: () => { onClose(); openHelp(); } },
      { id: "explain", label: "Explain this screen", hint: "Shift E", run: () => { onClose(); openExplain(); } },
      { id: "tour", label: "Take the tour of this screen", run: () => { onClose(); openExplain(true); } },
      ...nav.map(([label, href]) => ({ id: href, label: `Go to ${label}`, run: go(href) })),
      ...(accounts ?? []).map(a => ({ id: a.id, label: `Open ${a.displayName}`, hint: a.email, run: go(`/app/inbox?account=${a.id}`) })),
      { id: "signout", label: "Sign out", run: async () => { await api("/auth/signout", { method: "POST" }).catch(() => toast({ text: "Couldn't sign out.", tone: "danger" })); window.location.href = "/sign-in"; } },
    ];
  }, [accounts, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const term = q.trim().toLowerCase();
  const matches = term ? cmds.filter(c => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(term)) : cmds;
  const searchEntry: Cmd | null = term ? { id: "search", label: `Search mail for "${q.trim()}"`, run: go(`/app/search?q=${encodeURIComponent(q.trim())}`) } : null;
  const list = searchEntry ? [...matches, searchEntry] : matches;
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => setCursor(0), [q]);
  useEffect(() => { listRef.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" }); }, [cursor]);
  return (
    <Modal title="Go to or do" onClose={onClose}>
      <input role="combobox" aria-expanded aria-controls="command-list" aria-activedescendant={list[cursor] ? `cmd-${cursor}` : undefined} aria-label="Type a command or search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Type a command, or words to search for" className={inputClass}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor(c => Math.min(list.length - 1, c + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); list[cursor]?.run(); }
        }} />
      <ul ref={listRef} id="command-list" role="listbox" aria-label="Commands" className="scroll-thin mt-2 max-h-80 overflow-auto">
        {list.map((c, i) => (
          <li key={c.id} id={`cmd-${i}`} role="option" aria-selected={i === cursor} onMouseEnter={() => setCursor(i)} onClick={c.run} className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm ${i === cursor ? "bg-accent-soft text-accent" : ""}`}>
            <span className="truncate">{c.label}</span>{c.hint && <span className="shrink-0 truncate text-xs text-muted">{c.hint}</span>}
          </li>
        ))}
        {!list.length && <li className="px-2.5 py-3 text-sm text-muted">Nothing matches.</li>}
      </ul>
    </Modal>
  );
}
