"use client";
import { leaveRows } from "@/lib/motion";
import { Mini } from "@/film/mini/Mini";
import { FOCUS_SECTION_LABELS, type FocusSection } from "@aegis/domain";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Bot, CheckCheck, ChevronDown, ChevronRight, Copy, Crosshair, EyeOff, Inbox as InboxIcon, Mail, MailOpen, Paperclip, Pin, PinOff, RefreshCw, ShieldAlert, Star, Tag, Trash2, Search as SearchIcon, Send, Reply as ReplyIcon, Wifi, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, ApiError, isGoChord, onInteractive, relTime, useAccounts, useAction, useApi, useEscape, useKeyboard, usePrefs, useRefreshMail, useToast, type Account, type ThreadRow } from "@/lib/client";
import { latencyLabel, usePrefPatch } from "../settings/common";
import { Avatar, Banner, Button, Chip, EmptyState, ErrorState, IconButton, ListSkeleton, RiskBadge } from "../ui";
import { LabelDialog, type LabelTarget } from "./label-dialog";
import { DEFAULT_LAYOUT, LayoutSwitcher, type MailLayout } from "./layout-switcher";
import { SearchPanel, type SemanticOutcome } from "./search-panel";
import { ThreadDetail, type ThreadControls } from "./thread-detail";
import { useWorkspace } from "./shell";

/** The preview reads like a sentence: raw links and leftover spacing are taken out. */
function cleanSnippet(s: string) {
  let t = s.replace(/\bhttps?:\/\/\S+/g, "").replace(/\b(Unsubscribe|View in browser):?\s*(?=[-.,]|$)/gi, "").replace(/\s{2,}/g, " ").replace(/\s+([.,])/g, "$1").trim();
  // A removed link leaves its lead-in hanging ("View:", "review at"). Drop that last clause, back to the end of the previous sentence.
  // A long sentence that ends in a colon keeps its words and loses only the colon.
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  const tail = end > 0 ? t.slice(end + 2) : t;
  if (/\b(at|here|via|visit|see|click)$/i.test(t) || (/:$/.test(t) && tail.split(/\s+/).length <= 3)) t = end > 0 ? t.slice(0, end + 1) : t.replace(/[\s:]*$/, "");
  else t = t.replace(/\s*:$/, "");
  return t;
}

const VIEW_META: Record<string, { title: string; empty: string; emptyBody: string; icon: any }> = {
  inbox: { title: "Inbox", empty: "You're all caught up", emptyBody: "New mail from your connected accounts will appear here in order of arrival.", icon: InboxIcon },
  focus: { title: "Focus", empty: "Nothing needs you right now", emptyBody: "Focus ranks what needs action. When something does, it'll be here with the reason why.", icon: Crosshair },
  important: { title: "Important", empty: "Nothing marked important", emptyBody: "Mail from people you work with and requests for you land here.", icon: Star },
  starred: { title: "Starred", empty: "Nothing starred", emptyBody: "Conversations you star stay easy to find here.", icon: Star },
  awaiting: { title: "Awaiting reply", empty: "Nothing outstanding", emptyBody: "Conversations where you sent the last message show up here.", icon: ReplyIcon },
  sent: { title: "Sent", empty: "No sent mail yet", emptyBody: "Messages you send will appear here.", icon: Send },
  archive: { title: "Archive", empty: "Nothing archived", emptyBody: "Archived mail stays searchable.", icon: Archive },
  spam: { title: "Spam", empty: "No spam", emptyBody: "Mail marked as spam appears here, out of your inbox.", icon: ShieldAlert },
  trash: { title: "Trash", empty: "Trash is empty", emptyBody: "Conversations you delete appear here.", icon: Trash2 },
  quarantine: { title: "Blocked", empty: "Nothing blocked", emptyBody: "Mail the AI stops waits here, out of your way. Release one if it was a mistake.", icon: ShieldAlert },
  search: { title: "Search", empty: "No results", emptyBody: "Try fewer words, or remove a filter.", icon: SearchIcon },
};

type RowAction = (ids: string[], action: string) => void;
interface Group { key: string; label: string; items: ThreadRow[]; section?: FocusSection }
interface Page { items: ThreadRow[]; nextCursor: string | null; semantic?: SemanticOutcome }

function dueLabel(d?: ThreadRow["due"]) {
  if (!d) return null;
  if (d.uncertain) return `Maybe ${d.text}`;
  return d.iso ? `Due ${new Date(d.iso).toLocaleDateString([], { month: "short", day: "numeric" })}` : null;
}

const Row = memo(function Row({ t, account, selected, focused, checked, selecting, onCheck, onAction, href, showReason, repeatReason, toLine }: { t: ThreadRow; account?: Account; selected: boolean; focused: boolean; checked: boolean; selecting: boolean; onCheck: (id: string) => void; onAction: RowAction; href: string; showReason?: boolean; repeatReason?: boolean; toLine?: boolean }) {
  // In Sent and Awaiting reply the sender is always you, so the row names who it went to, as Gmail does.
  const firstTo = t.to?.[0];
  const recipients = toLine && t.to?.length ? `To: ${t.to.map(r => r.name || r.address).join(", ")}` : null;
  const name = recipients ?? (t.from?.name || t.from?.address || "Unknown sender");
  const who = recipients && firstTo ? firstTo : t.from;
  const due = dueLabel(t.due);
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: "nearest" }); }, [focused]);
  const act = (action: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onAction([t.id], action); };
  return (
    <li className="group thread-row relative" data-row-id={t.id}>
      <Link ref={ref} href={href} aria-current={selected ? "true" : undefined} data-testid="thread-row" title={showReason ? t.reasons?.join(" ") : undefined} className={`relative flex items-start gap-3 border-b border-line px-3 py-[var(--row-py)] text-[length:var(--row-text)] transition-shadow hover:z-[1] hover:shadow-[0_1px_5px_rgb(0_0_0/.14)] @3xl:h-[var(--row-line)] @3xl:items-center @3xl:py-0 @3xl:pr-4 @3xl:pl-[4.75rem] ${selected ? "bg-accent-soft" : t.isRead ? "bg-surface-2/60" : "bg-surface"} ${focused ? "shadow-[inset_3px_0_0_var(--accent)]" : ""}`}>
        <span className="relative mt-0.5 @3xl:hidden"><Avatar name={who?.name} address={who?.address} size={32} /></span>
        <span className="min-w-0 flex-1 @3xl:flex @3xl:items-center @3xl:gap-3">
          <span className={`block truncate pr-14 @3xl:w-44 @3xl:shrink-0 @3xl:pr-0 ${t.isRead ? "" : "font-semibold"}`}>{name}{t.count > 1 && <span className="ml-1 text-xs font-normal text-muted">{t.count}</span>}{account && <span className="sr-only">, in {account.displayName}</span>}</span>
          <span className="block truncate @3xl:min-w-0 @3xl:flex-1"><span className={t.isRead ? "" : "font-semibold"}>{t.subject || "(no subject)"}</span><span className="text-muted"> - {cleanSnippet(t.snippet)}</span></span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden @3xl:mt-0 @3xl:shrink-0 @3xl:flex-nowrap">
            {/* Unsure mail gets one plain word. The kind of doubt is in the message itself. */}
            {t.risk === "suspicious" || t.risk === "unknown_unscannable" ? <Chip tone="warn"><AlertTriangle className="size-3" aria-hidden />Be careful</Chip> : <RiskBadge risk={t.risk} quiet />}
            {t.held && <Chip tone="danger">Held</Chip>}
            {t.match === "meaning" && <Chip title="None of your words matched this. It's here because a model on this server rated it close in meaning, which can be wrong.">Similar meaning</Chip>}
            {/* Focus says why in a few words, once for a run of rows with the same reason; the full list is on hover and in the message. */}
            {showReason && !repeatReason && t.reasons?.[0] && !(due && /^It mentions a date/.test(t.reasons[0])) && !/^Nothing here needs you/.test(t.reasons[0]) && t.risk !== "suspicious" && t.risk !== "unknown_unscannable" && <span className="max-w-[18rem] truncate text-xs text-muted">{t.reasons[0].replace(/\.$/, "")}</span>}
            {due && showReason && <span className="text-xs text-muted">{due}</span>}
            {t.hasAttachments && <Paperclip className="size-3.5 text-muted" aria-label="Has attachment" />}
            {t.labels.map(l => <Chip key={l.id}><Tag className="size-3" style={{ color: l.color ?? undefined }} aria-hidden />{l.name}</Chip>)}
            {account && <span className="hidden items-center gap-1 text-xs text-muted @3xl:inline-flex" title={`${account.displayName}, ${account.email}`} aria-hidden="true"><span className="size-2 rounded-full" style={{ background: account.color }} /></span>}
          </span>
        </span>
        <time className={`absolute top-[calc(var(--row-py)+1px)] right-3 shrink-0 text-xs tabular-nums @3xl:static @3xl:w-16 @3xl:text-right ${t.isRead ? "text-muted" : "font-semibold"}`} dateTime={t.date}>{relTime(t.date)}</time>
      </Link>
      {/* On touch this is an invisible target over the avatar, like tapping a contact photo. It shows once something is selected. */}
      <label className={`absolute top-[calc(var(--row-py)+2px)] left-3 z-[2] size-8 cursor-pointer items-center justify-center rounded-full bg-surface group-focus-within:flex group-hover:flex has-checked:flex pointer-coarse:flex @3xl:top-0 @3xl:bottom-0 @3xl:my-auto @3xl:flex @3xl:bg-transparent ${selecting ? "flex" : "hidden pointer-coarse:opacity-0"} has-checked:opacity-100 @3xl:opacity-100`} title="Select">
        <input type="checkbox" checked={checked} onChange={() => onCheck(t.id)} aria-label={`Select ${t.subject}`} className="size-4 accent-[var(--accent)]" />
      </label>
      <span className="absolute top-0 bottom-0 left-11 z-[2] my-auto hidden size-8 @3xl:block">
        <IconButton icon={Star} label={t.isStarred ? "Unstar" : "Star"} active={t.isStarred} onClick={act(t.isStarred ? "unstar" : "star")} className={t.isStarred ? "!bg-transparent !text-warn [&_svg]:fill-current" : ""} />
      </span>
      <span className="absolute top-1.5 right-2 z-[2] hidden gap-0.5 rounded-lg bg-surface group-focus-within:flex group-hover:flex @3xl:top-0 @3xl:bottom-0 @3xl:my-auto @3xl:h-8 pointer-coarse:group-focus-within:hidden pointer-coarse:group-hover:hidden">
        <span className="@3xl:hidden"><IconButton icon={Star} label={t.isStarred ? "Unstar" : "Star"} active={t.isStarred} onClick={act(t.isStarred ? "unstar" : "star")} /></span>
        {!t.held && t.folder === "inbox" && <IconButton icon={Archive} label="Archive" onClick={act("archive")} />}
        {!t.held && <IconButton icon={Trash2} label="Move to Trash" onClick={act("trash")} />}
        <IconButton icon={t.isRead ? Mail : MailOpen} label={t.isRead ? "Mark unread" : "Mark read"} onClick={act(t.isRead ? "unread" : "read")} />
      </span>
    </li>
  );
});

function useMailKeys(items: ThreadRow[], selected: string | null, go: (id: string | null) => void, opts: { toggleCheck: (id: string) => void; actOn: (id: string, action: string, row?: ThreadRow) => void; thread: RefObject<ThreadControls | null>; labels: (cur?: ThreadRow) => void }) {
  const [cursor, setCursor] = useState(0);
  useEffect(() => { if (selected) { const i = items.findIndex(x => x.id === selected); if (i >= 0) setCursor(i); } }, [selected, items]);
  useEffect(() => { if (cursor >= items.length && items.length) setCursor(items.length - 1); }, [cursor, items.length]);
  useKeyboard(e => {
    if (isGoChord()) return;
    const cur = items[cursor];
    const openThread = selected ? opts.thread.current : null;
    const target = selected ?? cur?.id;
    const next = (d: number) => { const n = Math.max(0, Math.min(items.length - 1, cursor + d)); setCursor(n); if (selected && items[n]) go(items[n]!.id); };
    if (e.key === "j") { e.preventDefault(); next(1); }
    else if (e.key === "k") { e.preventDefault(); next(-1); }
    // Enter and the arrows keep their own meaning on a focused link, button or scroll area.
    else if (e.key === "ArrowDown" && !onInteractive(e)) { e.preventDefault(); next(1); }
    else if (e.key === "ArrowUp" && !onInteractive(e)) { e.preventDefault(); next(-1); }
    else if (e.key === "o" && cur) { e.preventDefault(); go(cur.id); }
    else if (e.key === "Enter" && cur && !onInteractive(e)) { e.preventDefault(); go(cur.id); }
    else if (e.key === "u") go(null);
    else if (e.key === "U" && target) opts.actOn(target, "unread");
    else if (e.key === "x" && cur) opts.toggleCheck(cur.id);
    else if (e.key === "e" && target) opts.actOn(target, "archive");
    else if (e.key === "#" && target) opts.actOn(target, "trash");
    else if (e.key === "s" && target) { if (openThread) openThread.star(); else if (cur) opts.actOn(cur.id, cur.isStarred ? "unstar" : "star"); }
    else if (e.key === "r" && openThread) { e.preventDefault(); openThread.reply(); }
    else if (e.key === "f" && openThread) { e.preventDefault(); openThread.forward(); }
    else if (e.key === "l") { e.preventDefault(); if (openThread) openThread.labels(); else opts.labels(cur); }
  }, [items, cursor, selected, go, opts]);
  return { cursor, setCursor };
}

function SyncStatus({ accounts }: { accounts: Account[] }) {
  // A first sync that keeps failing is trouble, not progress: say so rather than "still syncing" for ever.
  const syncing = accounts.filter(a => a.status === "active" && a.sync.phase === "initial" && !a.sync.lastError);
  if (syncing.length) return <div className="px-3 pt-2"><Banner tone="info" icon={Wifi}>Still syncing {syncing.map(a => a.displayName).join(", ")}. {syncing.reduce((s, a) => s + a.sync.messagesSynced, 0)} messages so far. Results here may be partial.</Banner></div>;
  const failing = accounts.filter(a => a.sync.lastError && a.status === "active");
  if (failing.length) return <div className="px-3 pt-2"><Banner tone="warn">Having trouble syncing {failing.map(a => a.displayName).join(", ")}. We'll keep retrying. What's shown may be out of date.</Banner></div>;
  return null;
}

/** One mailbox's state, shown when you're looking at that mailbox. */
function AccountStatus({ a }: { a: Account }) {
  const sync = useAction<void>(() => api(`/accounts/${a.id}/sync`, { method: "POST" }), { success: `Sync requested for ${a.displayName}.` });
  if (a.status === "reconnect_required" || a.status === "error") return <div className="px-3 pt-2"><Banner tone="danger" action={a.owned ? <Link href="/app/settings/accounts" className="font-semibold underline underline-offset-2">Reconnect</Link> : undefined}>{a.statusDetail ?? "We lost access to this mailbox."} Nothing new arrives or gets scanned here until {a.owned ? "you reconnect it" : "its owner reconnects it"}.</Banner></div>;
  if (a.status === "disconnected") return <div className="px-3 pt-2"><Banner tone="neutral" action={a.owned ? <Link href="/app/settings/accounts" className="font-semibold underline underline-offset-2">Manage</Link> : undefined}>This mailbox is disconnected. Nothing syncs or sends. Mail already here stays until it's deleted.</Banner></div>;
  if (a.status === "paused") return <div className="px-3 pt-2"><Banner tone="warn" action={a.owned ? <Link href="/app/settings/accounts" className="font-semibold underline underline-offset-2">Resume</Link> : undefined}>Paused. New mail isn't being fetched, so it isn't being scanned here either.</Banner></div>;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-line px-3 py-1 text-xs text-muted" data-testid="account-sync">
      <span>{a.sync.lastSuccessAt ? <>Last synced <time dateTime={a.sync.lastSuccessAt}>{relTime(a.sync.lastSuccessAt)}</time>.</> : "Not synced yet."} {latencyLabel(a.capabilities)}.</span>
      {a.owned && <button type="button" className="inline-flex items-center gap-1 font-medium text-accent underline-offset-2 hover:underline" disabled={sync.isPending} onClick={() => sync.mutate()}><RefreshCw className="size-3" aria-hidden />Sync now</button>}
    </p>
  );
}

const DAY = 864e5;
function dateBucket(iso: string, now: number) {
  const d = new Date(iso), start = new Date(now); start.setHours(0, 0, 0, 0);
  const diff = start.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (diff <= 0) return "Today";
  if (diff <= DAY) return "Yesterday";
  if (diff < 7 * DAY) return "Earlier this week";
  if (diff < 31 * DAY) return "Earlier this month";
  return "Older";
}
const ACTION_ORDER = ["Needs reply", "Flagged", "Everything else", "Newsletters"];
function actionBucket(t: ThreadRow) { return t.risk && !["safe", "bulk_low_priority"].includes(t.risk) ? "Flagged" : t.needsReply && !t.lastFromMe ? "Needs reply" : t.topics.includes("newsletter") || t.risk === "bulk_low_priority" ? "Newsletters" : "Everything else"; }
function groupBy(rows: ThreadRow[], bucket: (t: ThreadRow) => string, order?: string[]): Group[] {
  const g = new Map<string, ThreadRow[]>();
  for (const t of rows) { const k = bucket(t); g.set(k, [...(g.get(k) ?? []), t]); }
  const entries = [...g.entries()];
  if (order) entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return entries.map(([label, items]) => ({ key: label, label, items }));
}
function groupRows(rows: ThreadRow[], layout: MailLayout, accountName: (id: string) => string): Group[] | null {
  if (layout === "by_account") return groupBy(rows, t => accountName(t.accountId));
  if (layout === "by_action") return groupBy(rows, actionBucket, ACTION_ORDER);
  if (layout === "chronological") { const now = Date.now(); return groupBy(rows, t => dateBucket(t.date, now)); }
  return null;
}
/** Focus always keeps Security review apart, whatever the layout: flagged mail is never mixed in with the rest. */
function arrangeFocus(sections: { key: string; label: string; items: ThreadRow[] }[], layout: MailLayout, accountName: (id: string) => string): Group[] {
  const asSections = sections.filter(s => s.items.length).map(s => ({ ...s, section: s.key as FocusSection }));
  if (layout !== "by_account" && layout !== "chronological") return asSections;
  const security = asSections.filter(s => s.key === "security_review");
  const seen = new Set<string>();
  const rest = asSections.filter(s => s.key !== "security_review").flatMap(s => s.items).filter(t => !seen.has(t.id) && !!seen.add(t.id)).sort((a, b) => b.date.localeCompare(a.date));
  return [...security, ...(groupRows(rest, layout, accountName) ?? [])];
}

function GroupHeader({ g, collapsed, onToggle, onPin, onHide, pinned }: { g: Group; collapsed: boolean; onToggle: () => void; onPin?: () => void; onHide?: () => void; pinned?: boolean }) {
  const I = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="group/sec sticky top-0 z-10 flex min-h-11 items-center justify-between gap-2 border-b border-line bg-surface px-3">
      <button type="button" aria-expanded={!collapsed} onClick={onToggle} className={`inline-flex min-h-6 min-w-0 items-center gap-1.5 text-[15px] font-medium ${g.section === "security_review" ? "text-warn" : "text-muted"}`}><I className="size-3 shrink-0" aria-hidden /><span className="truncate">{g.label} · {g.items.length}</span></button>
      <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted opacity-0 transition-opacity group-hover/sec:opacity-100 focus-within:opacity-100">
        {onPin && <button type="button" aria-pressed={pinned} aria-label={`${pinned ? "Pinned" : "Pin to top"}: ${g.label}`} className="inline-flex h-6 items-center gap-1 hover:text-ink" onClick={onPin}>{pinned ? <PinOff className="size-3" aria-hidden /> : <Pin className="size-3" aria-hidden />}{pinned ? "Pinned" : "Pin to top"}</button>}
        {onHide && <button type="button" aria-label={`Hide ${g.label}`} className="inline-flex h-6 items-center gap-1 hover:text-ink" onClick={onHide}><EyeOff className="size-3" aria-hidden />Hide</button>}
      </span>
    </div>
  );
}

export function MailView({ view, query, concepts = false, semantic = false }: { view: string; query?: string; concepts?: boolean; semantic?: boolean }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const qc = useQueryClient();
  const accountId = sp.get("account") ?? undefined;
  const labelId = sp.get("label") ?? undefined;
  const selected = sp.get("t");
  const { data: accounts } = useAccounts();
  const { data: prefs } = usePrefs();
  const prefPatch = usePrefPatch();
  const { compose, setCurrentThread } = useWorkspace();
  const toast = useToast();
  const refresh = useRefreshMail();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [labelTargets, setLabelTargets] = useState<LabelTarget[] | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ low_priority: true });
  const layout: MailLayout = prefs?.layout ?? DEFAULT_LAYOUT;
  const hiddenSections: string[] = prefs?.hiddenSections ?? [];
  const pinnedSections: string[] = prefs?.pinnedSections ?? [];

  const isFocus = view === "focus";
  const isSearch = view === "search";
  const q = query?.trim() ?? "";
  const params = new URLSearchParams();
  if (!isFocus) { params.set("view", isSearch ? "inbox" : view); params.set("limit", "50"); if (q) params.set("q", q); if (concepts && q) params.set("concepts", "true"); if (semantic && q) params.set("semantic", "true"); }
  if (accountId) params.set("accountId", accountId);
  if (labelId && !isFocus) params.set("labelId", labelId);
  const listKey = useMemo(() => ["threads", view, q, accountId, labelId, concepts && !!q, semantic && !!q], [view, q, accountId, labelId, concepts, semantic]);
  const list = useInfiniteQuery<Page, ApiError>({
    queryKey: listKey,
    enabled: !isFocus && !(isSearch && !q),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => { const p = new URLSearchParams(params); if (pageParam) p.set("cursor", pageParam as string); return api<Page>(`/threads?${p}`); },
    getNextPageParam: last => last.nextCursor,
    // Every loaded page is refetched, so a long scroll polls less often.
    // Except semantic results, each of which embeds the query and opens thousands of records. Those refresh when asked.
    refetchInterval: query => semantic && !!q ? false : (query.state.data?.pages.length ?? 1) > 3 ? 60_000 : 15_000,
    retry: (n, e) => e.status === 0 ? false : e.status >= 500 && n < 2,
  });
  const focus = useApi<{ sections: { key: string; label: string; items: ThreadRow[] }[] }>(["focus", accountId], isFocus ? `/focus${accountId ? `?accountId=${accountId}` : ""}` : null, { refetchInterval: 15_000 });
  const listItems = useMemo(() => { const seen = new Set<string>(); return (list.data?.pages.flatMap(pg => pg.items) ?? []).filter(t => !seen.has(t.id) && !!seen.add(t.id)); }, [list.data]);
  const byId = useMemo(() => new Map(accounts?.map(a => [a.id, a])), [accounts]);
  const accountName = useCallback((id: string) => byId.get(id)?.displayName ?? "Unknown", [byId]);
  const groups = useMemo(() => isFocus ? arrangeFocus(focus.data?.sections ?? [], layout, accountName) : groupRows(listItems, layout, accountName), [isFocus, focus.data, layout, accountName, listItems]);
  const allItems = useMemo(() => groups ? groups.flatMap(g => g.items) : listItems, [groups, listItems]);
  // The keyboard walks what's on screen, in the order it's on screen.
  const items = useMemo(() => groups ? groups.flatMap(g => collapsed[g.key] ? [] : g.items) : listItems, [groups, collapsed, listItems]);
  const loading = isFocus ? focus.isLoading : list.isLoading;
  const error = isFocus ? focus.error : list.error;

  const hrefFor = useCallback((id: string | null) => { const n = new URLSearchParams(sp.toString()); if (id) n.set("t", id); else n.delete("t"); const s = n.toString(); return s ? `${path}?${s}` : path; }, [sp, path]);
  const go = useCallback((id: string | null) => router.push(hrefFor(id), { scroll: false }), [router, hrefFor]);
  useEffect(() => { setCurrentThread(selected); return () => setCurrentThread(null); }, [selected, setCurrentThread]);

  const rowsRef = useRef(allItems);
  useEffect(() => { rowsRef.current = allItems; }, [allItems]);
  // Changes the rows on screen before the server answers. Anything that fails is put right by the refresh that follows.
  const patchRows = useCallback((fn: (r: ThreadRow) => ThreadRow | null) => {
    const patchItems = (rows: ThreadRow[]) => rows.flatMap(r => { const n = fn(r); return n ? [n] : []; });
    qc.setQueriesData({ queryKey: listKey, exact: true }, (old: any) => old?.pages ? { ...old, pages: old.pages.map((pg: Page) => ({ ...pg, items: patchItems(pg.items) })) } : old);
    qc.setQueriesData({ queryKey: ["focus"] }, (old: any) => old?.sections ? { ...old, sections: old.sections.map((s: any) => ({ ...s, items: patchItems(s.items) })) } : old);
  }, [qc, listKey]);

  const doAction = useCallback(async (ids: string[], action: string) => {
    const FOLDER_ACTION: Record<string, string> = { inbox: "inbox", archive: "archive", spam: "spam", trash: "trash" };
    const INVERSE: Record<string, string> = { read: "unread", unread: "read", star: "unstar", unstar: "star" };
    const LABEL: Record<string, string> = { archive: "Archived", trash: "Moved to Trash", read: "Marked read", unread: "Marked unread", star: "Starred", unstar: "Unstarred", spam: "Moved to Spam", inbox: "Moved to Inbox" };
    const moves = ["archive", "trash", "spam", "inbox", "not_spam"].includes(action);
    const before = new Map(rowsRef.current.filter(r => ids.includes(r.id)).map(r => [r.id, r]));
    if (moves) await leaveRows(ids, action);
    patchRows(r => !ids.includes(r.id) ? r : moves ? null : action === "read" ? { ...r, isRead: true } : action === "unread" ? { ...r, isRead: false } : action === "star" ? { ...r, isStarred: true } : action === "unstar" ? { ...r, isStarred: false } : r);
    if (selected && ids.includes(selected) && ["archive", "trash", "spam"].includes(action)) go(null);
    const results = await Promise.allSettled(ids.map(id => api(`/threads/${id}/actions`, { body: { action } })));
    refresh();
    const done = ids.filter((_, i) => results[i]!.status === "fulfilled");
    const failure = results.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
    const reason = failure?.reason instanceof ApiError ? failure.reason.message : "It couldn't be changed.";
    const undo = () => {
      // Back where each one came from, not always the Inbox.
      const steps = done.flatMap(id => { const inv = moves ? FOLDER_ACTION[before.get(id)?.folder ?? "inbox"] : INVERSE[action]; return inv ? [{ id, inv }] : []; });
      if (!steps.length) return;
      void Promise.allSettled(steps.map(s => api(`/threads/${s.id}/actions`, { body: { action: s.inv } }))).then(rs => {
        refresh();
        const bad = rs.find(r => r.status === "rejected") as PromiseRejectedResult | undefined;
        if (bad) toast({ tone: "danger", text: bad.reason instanceof ApiError ? bad.reason.message : "That couldn't be undone." });
      });
    };
    const canUndo = done.some(id => moves ? !!FOLDER_ACTION[before.get(id)?.folder ?? "inbox"] : !!INVERSE[action]);
    if (!done.length) { toast({ tone: "danger", text: `${reason} ${ids.length > 1 ? "They're" : "It's"} back how ${ids.length > 1 ? "they were" : "it was"}.` }); return; }
    if (failure) { toast({ tone: "danger", text: `${LABEL[action] ?? "Changed"} ${done.length} of ${ids.length}. The rest are back how they were: ${reason}`, action: canUndo ? { label: "Undo", run: undo } : undefined }); return; }
    toast({ text: `${LABEL[action] ?? "Done"}${ids.length > 1 ? `: ${ids.length} conversations` : ""}.`, action: canUndo ? { label: "Undo", run: undo } : undefined });
  }, [patchRows, refresh, selected, go, toast]);

  const toggleCheck = useCallback((id: string) => setChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const threadControls = useRef<ThreadControls | null>(null);
  const openLabelsFor = useCallback((rows: ThreadRow[]) => { if (rows.length) setLabelTargets(rows.map(r => ({ id: r.id, accountId: r.accountId, labels: r.labels }))); }, []);
  const keyOpts = useMemo(() => ({
    toggleCheck,
    actOn: (id: string, action: string) => void doAction([id], action),
    thread: threadControls,
    labels: (cur?: ThreadRow) => { const picked = allItems.filter(r => checked.has(r.id)); openLabelsFor(picked.length ? picked : cur ? [cur] : []); },
  }), [toggleCheck, doAction, allItems, checked, openLabelsFor]);
  const { cursor, setCursor } = useMailKeys(items, selected, go, keyOpts);
  useEscape(() => { if (selected) go(null); else setChecked(new Set()); }, !!selected || checked.size > 0);
  useEffect(() => setChecked(new Set()), [view, q, accountId, labelId]);

  const sentinel = useRef<HTMLDivElement>(null);
  const hasNext = !isFocus && list.hasNextPage, fetchingNext = list.isFetchingNextPage, fetchNext = list.fetchNextPage;
  useEffect(() => {
    if (!hasNext || !sentinel.current) return;
    const io = new IntersectionObserver(es => { if (es.some(x => x.isIntersecting) && !fetchingNext) void fetchNext(); }, { rootMargin: "600px" });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [hasNext, fetchingNext, fetchNext]);

  const meta = VIEW_META[view] ?? VIEW_META.inbox!;
  const acct = accountId ? byId.get(accountId) : undefined;
  const labelRow = useApi<{ id: string; name: string }[]>(["labels"], labelId ? "/labels" : null);
  const labelName = labelId ? labelRow.data?.find(l => l.id === labelId)?.name : undefined;
  const title = isSearch ? (q ? `Results for "${q}"` : "Search") : isFocus && acct ? `Focus: ${acct.displayName}` : acct ? acct.displayName : labelName ? `Label: ${labelName}` : meta.title;
  useEffect(() => { document.title = `${title} · Aegis Mail`; }, [title]);
  const replaces = layout === "full";
  const flat = allItems.length;

  const renderRows = (rows: ThreadRow[], reason?: boolean) => (
    <ul onFocusCapture={e => { const id = (e.target as HTMLElement).closest<HTMLElement>("[data-row-id]")?.dataset.rowId; if (id) { const i = items.findIndex(x => x.id === id); if (i >= 0) setCursor(i); } }}>
      {rows.map((t, i) => <Row key={t.id} t={t} account={byId.get(t.accountId)} selected={selected === t.id} focused={items[cursor]?.id === t.id} checked={checked.has(t.id)} selecting={checked.size > 0} onCheck={toggleCheck} onAction={doAction as RowAction} href={hrefFor(t.id)} showReason={reason} repeatReason={i > 0 && rows[i - 1]!.reasons?.[0] === t.reasons?.[0]} toLine={view === "sent" || view === "awaiting" || view === "scheduled" || (isFocus && t.lastFromMe)} />)}
    </ul>
  );
  const bulk = (action: string) => { void doAction([...checked], action); setChecked(new Set()); };
  const hideSection = (k: string) => prefPatch.mutate({ hiddenSections: [...new Set([...hiddenSections, k])] });
  const showSection = (k: string) => prefPatch.mutate({ hiddenSections: hiddenSections.filter(x => x !== k) });
  const hiddenList = hiddenSections.filter(k => k !== "security_review");
  const hiddenLabel = (k: string) => k === "digest" ? "Digest" : FOCUS_SECTION_LABELS[k as FocusSection] ?? k;

  return (
    // The mail itself stays on white paper in both themes, as in Gmail: the list and the open conversation. Only the frame around it goes dark.
    <div data-preview-theme="light" className="flex h-full min-h-0 gap-2 pr-2 pb-2 text-ink max-lg:p-0">
      <section aria-label={title} className={`min-w-0 flex-col overflow-hidden rounded-2xl bg-surface max-lg:rounded-none ${selected ? (replaces ? "hidden" : "hidden lg:flex lg:w-80 lg:shrink-0 xl:w-[26rem]") : "flex w-full"}`}>
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1">
          <h1 className="min-w-0 flex-1 basis-32 truncate text-[17px] font-semibold tracking-[-.012em]">{title}</h1>
          {!isSearch && <LayoutSwitcher />}
        </div>
        {checked.size > 0 && (
          <div role="toolbar" aria-label="Selected conversations" data-testid="bulk-bar" className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line bg-surface-2 px-2 py-1">
            <span className="mr-1 text-xs font-medium" aria-live="polite">{checked.size} selected</span>
            {checked.size < flat && <Button size="sm" variant="ghost" onClick={() => setChecked(new Set(allItems.map(t => t.id)))}>Select all {flat}</Button>}
            <IconButton icon={Archive} label="Archive selected" onClick={() => bulk("archive")} />
            <IconButton icon={Trash2} label="Move selected to Trash" onClick={() => bulk("trash")} />
            <IconButton icon={CheckCheck} label="Mark selected read" onClick={() => bulk("read")} />
            <IconButton icon={Mail} label="Mark selected unread" onClick={() => bulk("unread")} />
            <IconButton icon={Tag} label="Label selected" onClick={() => openLabelsFor(allItems.filter(r => checked.has(r.id)))} />
            <span className="flex-1" />
            <IconButton icon={X} label="Clear selection" onClick={() => setChecked(new Set())} />
          </div>
        )}
        {isSearch && <SearchPanel query={q} concepts={concepts} semantic={semantic} outcome={list.data?.pages[0]?.semantic} />}
        {view === "quarantine" && <div className="p-2"><Banner tone="neutral">Connector mode: these reached your provider before being held here. They can still be opened in other mail apps. Moving them to Spam at the provider is reversible.</Banner></div>}
        {acct && <AccountStatus a={acct} />}
        {accounts && !acct && <SyncStatus accounts={accounts} />}
        {acct?.simulated && <div className="px-3 pt-2"><Chip tone="info">{acct.simulated}: synthetic demo data</Chip></div>}
        <div className="@container scroll-thin min-h-0 flex-1 overflow-auto max-lg:pb-24">
          {isSearch && !q ? <EmptyState icon={SearchIcon} title="Search your mail">Type in the search box at the top, or press <kbd className="font-mono">/</kbd> to go there. Use the filters above to narrow results.</EmptyState> :
            loading ? <ListSkeleton /> : error ? <ErrorState error={error} retry={() => (isFocus ? focus.refetch() : list.refetch())} /> :
            accounts && accounts.length === 0 ? <EmptyState icon={InboxIcon} title="Connect your email" action={<Link href="/app/connect"><Button variant="primary">Connect email</Button></Link>}>Bring in the mailbox you already use.</EmptyState> : (
              <>
                {!flat && (isFocus || view === "inbox") && <Mini scene="desk" className="mx-auto mt-6 h-44 max-w-sm" props={{ letters: 8 }} />}
                {isFocus && !flat && <EmptyState icon={Crosshair} title="Nothing needs you right now">Focus ranks what needs action. When something does, it'll be here with the reason why.</EmptyState>}
                {!isFocus && !flat && <EmptyState icon={meta.icon} title={meta.empty}>{meta.emptyBody}</EmptyState>}
                {groups ? groups.map(g => {
                  const isSection = !!g.section;
                  const pinned = isSection && pinnedSections.includes(g.key);
                  return (
                    <section key={g.key} aria-label={g.label} data-section={g.section ?? undefined} data-group={g.key}>
                      <GroupHeader g={g} collapsed={!!collapsed[g.key]} onToggle={() => setCollapsed(c => ({ ...c, [g.key]: !c[g.key] }))} pinned={pinned}
                        onPin={isFocus && isSection && (layout === "split" || layout === "full" || layout === "by_action") ? () => prefPatch.mutate({ pinnedSections: pinned ? pinnedSections.filter(x => x !== g.key) : [...pinnedSections, g.key] }) : undefined}
                        onHide={isFocus && isSection && g.key !== "security_review" ? () => hideSection(g.key) : undefined} />
                      {!collapsed[g.key] && renderRows(g.items, isFocus && g.key !== "low_priority")}
                    </section>
                  );
                }) : renderRows(listItems)}
                {isFocus && hiddenList.length > 0 && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted" data-testid="hidden-sections">
                    <span>Hidden from Focus:</span>
                    {hiddenList.map(k => <button key={k} type="button" className="inline-flex min-h-6 items-center font-medium text-accent underline underline-offset-2" aria-label={`Show ${hiddenLabel(k)} again`} onClick={() => showSection(k)}>{hiddenLabel(k)}</button>)}
                    <span>The mail stays in your inbox.</span>
                  </p>
                )}
                {hasNext && <div ref={sentinel} className="p-3 text-center"><Button size="sm" loading={fetchingNext} onClick={() => void fetchNext()}>Load more</Button></div>}
              </>
            )}
        </div>
      </section>
      {selected && (
        <section aria-label="Conversation" className="min-w-0 flex-1 overflow-hidden rounded-2xl bg-surface max-lg:rounded-none">
          <ThreadDetail key={selected} threadId={selected} controls={threadControls} onBack={() => go(null)} onAction={a => void doAction([selected], a)} compose={compose} onLabels={t => setLabelTargets([t])} fullWidth={replaces} />
        </section>
      )}
      {labelTargets && <LabelDialog targets={labelTargets} onClose={() => { setLabelTargets(null); setChecked(new Set()); }} />}
    </div>
  );
}
