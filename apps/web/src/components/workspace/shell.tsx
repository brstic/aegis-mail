"use client";
import { applyTheme, savedTheme, ThemeToggle } from "@/components/theme-toggle";
import { Explain, ExplainButton } from "@/explain/Explain";
import { Archive, CheckSquare, ChevronDown, Clock, FileEdit, Inbox, Keyboard, LogOut, Menu, MessagesSquare, PanelLeft, PenSquare, Reply, Search, Send, Settings, Shield, ShieldAlert, Star, Tag, Trash2, Users, X, AlertOctagon, type LucideIcon, EyeOff, Building2, Workflow, RefreshCcw, Sun, Moon, Monitor, FlaskConical } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, BarChart3, Bot, Crosshair, Layers, Pause, RefreshCw, Unplug } from "lucide-react";
import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, isGoChord, relTime, useAccounts, useAction, useApi, useKeyboard, useMe, useMediaQuery, useOnline, usePrefs, useRefreshMail, useToast, type Account } from "@/lib/client";
import { GO_TO, SHORTCUT_GROUPS } from "@/lib/shortcuts";
import { Banner, Button, IconButton, Kbd, Menu as ActionMenu, Modal, Sheet } from "../ui";
import { AsyncStatus } from "./async-status";
import { Composer, type ComposeInit } from "./composer";
import { AssistantPane } from "./assistant";
import { CommandPalette } from "./command-palette";
import { NotificationCenter, SuspendedWorkspacesBanner, VerifyEmailBanner } from "./notifications";

const WorkspaceCtx = createContext<{ compose: (i?: ComposeInit) => void; assistantOpen: boolean; toggleAssistant: () => void; intelOpen: boolean; intelWide: boolean; toggleIntel: () => void; closeIntel: () => void; currentThread: string | null; setCurrentThread: (t: string | null) => void; openHelp: () => void }>({ compose: () => {}, assistantOpen: false, toggleAssistant: () => {}, intelOpen: true, intelWide: true, toggleIntel: () => {}, closeIntel: () => {}, currentThread: null, setCurrentThread: () => {}, openHelp: () => {} });
export const useWorkspace = () => useContext(WorkspaceCtx);

function NavItem({ href, icon: Icon, label, count, tone, active, onClick, countNote }: { href: string; icon: LucideIcon; label: string; count?: number; tone?: "danger"; active?: boolean; onClick?: () => void; countNote?: string }) {
  return (
    <Link href={href} onClick={onClick} aria-current={active ? "page" : undefined} className={`flex h-8 items-center gap-3 rounded-full px-3 text-sm transition-colors ${active ? "bg-accent-soft font-semibold text-accent" : "text-ink hover:bg-surface-3"}`}>
      <Icon className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate">{label}</span>
      {!!count && <span className={`text-xs tabular-nums ${tone === "danger" ? "font-semibold text-danger" : "text-muted"}`}>{count}<span className="sr-only"> {countNote ?? (tone === "danger" ? "need review" : "unread")}</span></span>}
    </Link>
  );
}

/** Plain-language sync state for one mailbox. Color never carries this alone: trouble also gets an icon and words. */
export function syncState(a: Account): { text: string; short: string; icon?: LucideIcon; bad?: boolean } {
  if (a.status === "reconnect_required" || a.status === "error") return { text: "Needs reconnecting. Nothing new is arriving.", short: "Reconnect", icon: AlertTriangle, bad: true };
  if (a.status === "disconnected") return { text: "Disconnected. Mail already here is kept.", short: "Disconnected", icon: Unplug };
  if (a.status === "paused") return { text: "Paused. New mail isn't being fetched.", short: "Paused", icon: Pause };
  if (a.sync.phase === "initial") return { text: `First sync in progress. ${a.sync.messagesSynced} messages so far.`, short: "Syncing", icon: RefreshCw };
  if (a.sync.lastError) return { text: "Having trouble syncing. Retrying.", short: "Retrying", icon: AlertTriangle };
  return { text: a.sync.lastSuccessAt ? `Synced ${relTime(a.sync.lastSuccessAt)}` : "Connected", short: a.sync.lastSuccessAt ? relTime(a.sync.lastSuccessAt) : "Connected" };
}

function SyncDot({ a }: { a: Account }) {
  const s = syncState(a);
  const I = s.icon;
  if (I) return <span title={s.text} className={`inline-flex shrink-0 ${s.bad ? "text-danger" : "text-muted"}`}><I className="size-3" aria-hidden /><span className="sr-only">{s.text}</span></span>;
  return <span title={s.text} className="size-2 shrink-0 rounded-full" style={{ background: a.color }}><span className="sr-only">{s.text}</span></span>;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  const sp = useSearchParams();
  const { compose } = useWorkspace();
  const { data: accounts } = useAccounts();
  const { data: labels } = useApi<any[]>(["labels"], "/labels");
  const { data: me } = useMe();
  const { data: drafts } = useApi<{ state: string }[]>(["drafts"], "/drafts");
  const stuckDrafts = drafts?.filter(d => d.state === "failed" || d.state === "unknown").length ?? 0;
  const accountId = sp.get("account");
  const at = (p: string) => path === p && !accountId && !sp.get("label");
  const canAdmin = me && ["owner", "security_admin"].includes(me.role);
  const orgKind = me?.workspaces.find(w => w.id === me.tenantId)?.kind;
  // More opens by itself only on a page that lives in it, not on setup or settings screens.
  const moreHrefs = ["/app/archive", "/app/tasks", "/app/important", "/app/awaiting", "/app/scheduled", "/app/spam", "/app/quarantine", "/app/labels", "/app/rules", "/app/insights", "/app/shared", "/app/privacy", "/app/security", "/app/org"];
  const inMore = !!accountId || !!sp.get("label") || moreHrefs.some(h => path === h || path.startsWith(h + "/"));
  const [more, setMore] = useState(false);
  const moreOpen = more || inMore;
  return (
    // Settings sits in a fixed footer, so a long open More list never pushes it, or the page you're on, out of sight.
    <div className="flex h-full flex-col">
    <nav aria-label="Mailboxes" className="scroll-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto p-2.5 [&>*]:shrink-0">
      <Button icon={PenSquare} className="mb-4 !h-13 w-fit !rounded-2xl !border-0 !bg-surface !px-6 !text-[15px] shadow-soft hover:!bg-surface-2" onClick={() => { compose(); onNavigate?.(); }}>Compose</Button>
      {/* What an ordinary inbox has, and nothing else. Mail that was blocked stays out of sight, under More. */}
      <NavItem href="/app/inbox" icon={Inbox} label="Inbox" count={accounts?.reduce((s, a) => s + a.unread, 0)} active={at("/app/inbox")} onClick={onNavigate} />
      <NavItem href="/app/focus" icon={Crosshair} label="Focus" active={at("/app/focus")} onClick={onNavigate} />
      <NavItem href="/app/sent" icon={Send} label="Sent" active={at("/app/sent")} onClick={onNavigate} />
      <NavItem href="/app/drafts" icon={FileEdit} label="Drafts" count={stuckDrafts} tone="danger" countNote="didn't send" active={at("/app/drafts")} onClick={onNavigate} />
      <NavItem href="/app/trash" icon={Trash2} label="Trash" active={at("/app/trash")} onClick={onNavigate} />
      {/* Everything else, one click away. It opens by itself when you're on one of these. */}
      <details className="group mt-3" open={moreOpen} onToggle={e => setMore(e.currentTarget.open)}>
        <summary data-testid="nav-more" className="flex h-8 cursor-pointer list-none items-center gap-2.5 rounded-full px-3 text-sm text-muted hover:bg-surface-3 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform group-open:rotate-0" aria-hidden />More
        </summary>
        <div className="mt-1 flex flex-col gap-0.5">
          {/* Grouped, and every row on the same indent: a dot, an icon or a tag all take the same 16px slot. */}
          {!!accounts?.length && <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Mailboxes</p>}
          {accounts?.map(a => (
            <Link key={a.id} href={`/app/inbox?account=${a.id}`} onClick={onNavigate} aria-current={accountId === a.id ? "page" : undefined} className={`flex h-8 items-center gap-3 rounded-full px-3 text-sm transition-colors ${accountId === a.id ? "bg-accent-soft font-semibold text-accent" : "hover:bg-surface-3"}`}>
              <span className="grid size-4 shrink-0 place-items-center"><SyncDot a={a} /></span><span className="min-w-0 flex-1 truncate" title={a.email}>{a.displayName}</span>{a.unread > 0 && <span className="text-xs text-muted tabular-nums">{a.unread}</span>}
            </Link>
          ))}
          <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Folders</p>
          <NavItem href="/app/archive" icon={Archive} label="Archive" active={at("/app/archive")} onClick={onNavigate} />
          <NavItem href="/app/important" icon={Star} label="Important" active={at("/app/important")} onClick={onNavigate} />
          <NavItem href="/app/awaiting" icon={Reply} label="Awaiting reply" active={at("/app/awaiting")} onClick={onNavigate} />
          <NavItem href="/app/scheduled" icon={Clock} label="Scheduled" active={at("/app/scheduled")} onClick={onNavigate} />
          <NavItem href="/app/tasks" icon={CheckSquare} label="Tasks" active={at("/app/tasks")} onClick={onNavigate} />
          {/* In an organization, blocked mail is the admins' to handle, in Organization. Members never see it. */}
          {orgKind !== "organization" && <NavItem href="/app/quarantine" icon={ShieldAlert} label="Blocked" active={at("/app/quarantine")} onClick={onNavigate} />}
          <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Labels</p>
          {labels?.map(l => <Link key={l.id} href={`/app/inbox?label=${l.id}`} onClick={onNavigate} aria-current={sp.get("label") === l.id ? "page" : undefined} className={`flex h-8 items-center gap-3 rounded-full px-3 text-sm transition-colors ${sp.get("label") === l.id ? "bg-accent-soft font-semibold text-accent" : "hover:bg-surface-3"}`}><Tag className="size-4 shrink-0" style={{ color: l.color ?? undefined }} aria-hidden /><span className="min-w-0 flex-1 truncate">{l.name}</span></Link>)}
          <NavItem href="/app/labels" icon={Tag} label="Manage labels" active={path.startsWith("/app/labels")} onClick={onNavigate} />
          <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">Tools</p>
          <NavItem href="/app/rules" icon={Workflow} label="Rules" active={path.startsWith("/app/rules")} onClick={onNavigate} />
          <NavItem href="/app/insights" icon={BarChart3} label="Insights" active={path.startsWith("/app/insights")} onClick={onNavigate} />
          {orgKind === "organization" && <NavItem href="/app/shared" icon={MessagesSquare} label="Team mailboxes" active={path.startsWith("/app/shared")} onClick={onNavigate} />}
          <NavItem href="/app/privacy" icon={EyeOff} label="Privacy" active={path.startsWith("/app/privacy")} onClick={onNavigate} />
          {canAdmin && orgKind === "organization" && <NavItem href="/app/security" icon={Shield} label="Security Center" active={path.startsWith("/app/security")} onClick={onNavigate} />}
          {orgKind === "organization" && <NavItem href="/app/org" icon={Building2} label="Organization" active={path.startsWith("/app/org")} onClick={onNavigate} />}
        </div>
      </details>
    </nav>
    <div className="shrink-0 px-2.5 pt-1 pb-2.5"><NavItem href="/app/settings" icon={Settings} label="Settings" active={path.startsWith("/app/settings")} onClick={onNavigate} /></div>
    </div>
  );
}

function ThemeMenuItem() {
  const { data: prefs } = usePrefs();
  const refresh = useAction<string>(theme => api("/preferences", { method: "PATCH", body: { theme } }), { refresh: false });
  const cur = (prefs?.theme ?? "system") as string;
  const next = cur === "system" ? "light" : cur === "light" ? "dark" : "system";
  const I = cur === "dark" ? Moon : cur === "light" ? Sun : Monitor;
  return <button role="menuitem" aria-label={`Theme: ${cur}. Switch to ${next}`} onClick={() => { applyTheme(next); refresh.mutate(next); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"><I className="size-4" aria-hidden />Theme: {cur}</button>;
}
export { applyTheme };

/** The header's theme button: switches now, and saves the choice to the account so other devices follow. */
function HeaderThemeToggle() {
  const save = useAction<string>(theme => api("/preferences", { method: "PATCH", body: { theme } }), { refresh: false });
  return <ThemeToggle className="text-muted hover:bg-surface-2 hover:text-ink" onChange={t => save.mutate(t)} />;
}

const MAIL_PATHS = /^\/app\/(focus|inbox|important|awaiting|sent|archive|spam|trash|quarantine|starred)$/;

/** Switches every mail view to one mailbox or all of them, and shows how each one is syncing. */
function AccountSwitcher() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const { data: accounts } = useAccounts();
  const current = accounts?.find(a => a.id === sp.get("account"));
  const to = (id: string | null) => {
    const n = new URLSearchParams(MAIL_PATHS.test(path) ? sp.toString() : "");
    n.delete("t"); n.delete("label");
    if (id) n.set("account", id); else n.delete("account");
    const base = MAIL_PATHS.test(path) ? path : "/app/inbox";
    const q = n.toString();
    router.push(q ? `${base}?${q}` : base);
  };
  if (!accounts?.length) return null;
  return (
    <div className="hidden md:block">
      <ActionMenu label="Accounts" align="left" items={[
        { label: "All accounts", icon: Layers, current: !current, onSelect: () => to(null) },
        ...accounts.map(a => ({ label: a.displayName, hint: syncState(a).short, current: current?.id === a.id, icon: syncState(a).icon, onSelect: () => to(a.id) })),
      ]} trigger={({ ref, ...p }) => (
        <button ref={ref} type="button" aria-label={`Account: ${current?.displayName ?? "All accounts"}`} className="flex h-8 max-w-44 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium hover:bg-surface-2" {...p}>
          {current ? <span className="size-2 shrink-0 rounded-full" style={{ background: current.color }} aria-hidden /> : <Layers className="size-3.5 shrink-0 text-muted" aria-hidden />}
          <span className="min-w-0 truncate">{current?.displayName ?? "All accounts"}</span>
          <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden />
        </button>
      )} />
    </div>
  );
}

function TopBar({ onMenu, onToggleNav, navHidden }: { onMenu: () => void; onToggleNav: () => void; navHidden: boolean }) {
  const router = useRouter();
  const sp = useSearchParams();
  const { data: me } = useMe();
  const { toggleAssistant, assistantOpen, openHelp } = useWorkspace();
  const [query, setQuery] = useState(sp.get("q") ?? "");
  const [menu, setMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setQuery(sp.get("q") ?? ""), [sp]);
  useKeyboard(e => { if (e.key === "/") { e.preventDefault(); inputRef.current?.focus(); } }, []);
  useEffect(() => {
    if (!menu) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(false); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [menu]);
  const switchTo = async (id: string) => { await api("/me/workspace", { body: { tenantId: id } }); window.location.href = "/app"; };
  const signOut = async () => { await api("/auth/signout", { method: "POST" }); window.location.href = "/sign-in"; };
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 bg-bg px-2.5 print:hidden">
      {/* As wide as the sidebar, so the search starts exactly where the mail panel below it does. */}
      <div className={`flex shrink-0 items-center gap-2 ${navHidden ? "" : "lg:w-[calc(15rem-1.125rem)]"}`}>
        <IconButton icon={Menu} label="Open navigation" className="lg:hidden" onClick={onMenu} />
        <IconButton icon={PanelLeft} label="Toggle navigation" className="hidden lg:grid" onClick={onToggleNav} />
        <Link href="/app/inbox" className="mr-1 hidden items-center gap-2 font-semibold sm:flex" aria-label="Aegis Mail home"><Shield className="size-5 text-accent" aria-hidden /><span className="hidden tracking-tight whitespace-nowrap lg:inline">Aegis Mail</span></Link>
      </div>
      <form role="search" className="flex h-11 w-full max-w-3xl min-w-0 flex-1 cursor-text items-center gap-2 rounded-full bg-surface-3 px-4 transition-[background-color,box-shadow] focus-within:bg-surface focus-within:shadow-soft" onMouseDown={e => { if (!(e.target as HTMLElement).closest("button, input")) { e.preventDefault(); inputRef.current?.focus(); } }} onSubmit={e => { e.preventDefault(); router.push(query.trim() ? `/app/search?q=${encodeURIComponent(query.trim())}${sp.get("concepts") === "true" ? "&concepts=true" : ""}${sp.get("semantic") === "true" ? "&semantic=true" : ""}` : "/app/search"); }}>
        <Search className="size-4 shrink-0 text-muted" aria-hidden />
        <input ref={inputRef} data-explain="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.blur(); } }} aria-label="Search mail" placeholder="Search mail" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
        {query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }}><X className="size-3.5 text-muted" aria-hidden /></button>}
      </form>
      <div className="ml-auto flex shrink-0 items-center"><AccountSwitcher /></div>
      <button type="button" onClick={toggleAssistant} aria-pressed={assistantOpen} title="Ask the AI about your mail" className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors max-sm:hidden ${assistantOpen ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-ink"}`}><Bot className="size-[18px]" aria-hidden /><span className="max-lg:hidden">Ask AI</span><span className="lg:hidden sr-only">Ask AI</span></button>
      <ExplainButton className="max-sm:hidden" />
      <HeaderThemeToggle />
      <NotificationCenter />
      <div className="relative">
        <button aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="flex h-8 items-center gap-1 rounded-lg px-1.5 hover:bg-surface-2">
          <span className="grid size-6 place-items-center rounded-full bg-accent text-[11px] font-semibold text-on-accent">{me?.name?.[0]?.toUpperCase() ?? "?"}</span><ChevronDown className="size-3 text-muted" aria-hidden /><span className="sr-only">Account menu</span>
        </button>
        {menu && (
          <div role="menu" onMouseLeave={() => setMenu(false)} className="absolute top-full right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-soft">
            <div className="px-2.5 py-1.5"><div className="truncate text-sm font-medium">{me?.name}</div><div className="truncate text-xs text-muted">{me?.email}</div></div>
            <div className="my-1 border-t border-line" />
            {me?.workspaces.map(w => <button key={w.id} role="menuitem" onClick={() => w.id !== me.tenantId && switchTo(w.id)} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2 ${w.id === me.tenantId ? "font-semibold" : ""}`}><span className="truncate">{w.name}</span><span className="ml-2 text-xs text-muted">{w.kind === "organization" ? w.role.replace("_", " ") : ""}</span></button>)}
            <div className="my-1 border-t border-line" />
            <Link role="menuitem" href="/app/settings" onClick={() => setMenu(false)} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-surface-2"><Settings className="size-4" aria-hidden />Settings</Link>
            <ThemeMenuItem />
            <button role="menuitem" onClick={() => { setMenu(false); openHelp(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"><Keyboard className="size-4" aria-hidden />Keyboard shortcuts</button>
            <Link role="menuitem" href="/app/settings/security" onClick={() => setMenu(false)} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-surface-2"><Shield className="size-3.5" aria-hidden />Security and sessions</Link>
            <button role="menuitem" onClick={signOut} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"><LogOut className="size-3.5" aria-hidden />Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

function DemoBar() {
  const { data: me } = useMe();
  const toast = useToast();
  const refresh = useRefreshMail();
  const run = useAction<void>(() => api("/demo/simulate", { body: {} }), { refresh: false, onDone: () => { toast({ text: "Synthetic message delivered to the demo mailbox. It's going through the real pipeline." }); setTimeout(refresh, 2500); setTimeout(refresh, 6000); } });
  if (!me?.demoMode) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5 bg-bg px-3 py-1 text-xs text-muted print:hidden" role="region" aria-label="Demo mode notice">
      <span>Demo. Synthetic mail only, and nothing is really sent.</span>
      <button onClick={() => run.mutate()} className="shrink-0 text-accent hover:underline">Send me a test email</button>
      <a href="/dev/outbox" className="shrink-0 text-accent hover:underline">Test outbox</a>
    </div>
  );
}

/** A quick settle when the view changes, so moving around has some continuity. It's short enough never to be waited on. */

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [palette, setPalette] = useState(false);
  // Works from inside inputs too, unlike the single-letter shortcuts.
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette(v => !v); } };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const router = useRouter();
  const [mobileNav, setMobileNav] = useState(false);
  const [navHidden, setNavHidden] = useState(false);
  const [composer, setComposer] = useState<(ComposeInit & { key: number }) | null>(null);
  const composeSeq = useRef(0);
  const [assistantOpen, setAssistant] = useState(false);
  // Beside the thread on wide screens, where it stays as you left it. A sheet on narrower ones, opened when you ask.
  const intelWide = useMediaQuery("(min-width: 1280px)");
  const [intelPanel, setIntelPanel] = useState(false);
  const [intelSheet, setIntelSheet] = useState(false);
  const intelOpen = intelWide ? intelPanel : intelSheet;
  const toggleIntel = useCallback(() => { if (intelWide) setIntelPanel(v => !v); else setIntelSheet(v => !v); }, [intelWide]);
  const closeIntel = useCallback(() => setIntelSheet(false), []);
  const [help, setHelp] = useState(false);
  const [currentThread, setCurrentThread] = useState<string | null>(null);
  const online = useOnline();
  const { data: prefs } = usePrefs();
  const { data: accounts } = useAccounts();
  const { data: me } = useMe();
  useEffect(() => {
    document.documentElement.dataset.density = prefs?.density ?? "comfortable";
    if (!prefs) return;
    // An account that never chose keeps what was picked on this device, such as on the site before signing in.
    if (prefs.theme === "light" || prefs.theme === "dark") applyTheme(prefs.theme);
    else if (!prefs.theme && savedTheme()) { /* keep the device's choice */ }
    else applyTheme(prefs.theme);
  }, [prefs]);
  // Blocked mail belongs to admins in an organization, so its shortcut is only for workspaces where the sidebar shows it.
  const isOrg = me?.workspaces.find(w => w.id === me.tenantId)?.kind === "organization";
  useKeyboard(e => {
    if (isGoChord()) { const to = GO_TO[e.key]; if (to && !(isOrg && e.key === "q")) router.push(to); return; }
    if (e.key === "?") setHelp(true);
    else if (e.key === "c") { e.preventDefault(); setComposer(c => c ?? { key: ++composeSeq.current }); }
    else if (e.key === "a") setAssistant(v => !v);
    else if (e.key === "i") toggleIntel();
  }, [router, toggleIntel, isOrg]);
  const trouble = accounts?.filter(a => a.status === "reconnect_required") ?? [];
  const ctx = useMemo(() => ({ compose: (i?: ComposeInit) => setComposer({ ...(i ?? {}), key: ++composeSeq.current }), assistantOpen, toggleAssistant: () => setAssistant(v => !v), intelOpen, intelWide, toggleIntel, closeIntel, currentThread, setCurrentThread, openHelp: () => setHelp(true) }), [assistantOpen, intelOpen, intelWide, toggleIntel, closeIntel, currentThread]);
  return (
    <WorkspaceCtx.Provider value={ctx}>
      <AsyncStatus />
      <div data-shell className="flex h-dvh flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded focus:bg-surface focus:p-2">Skip to content</a>
        <DemoBar />
        <Suspense><TopBar onMenu={() => setMobileNav(true)} onToggleNav={() => setNavHidden(v => !v)} navHidden={navHidden} /></Suspense>
        {!online && <div className="px-2 pt-2 print:hidden"><Banner tone="warn">You're offline. You can keep writing; drafts stay on this device and nothing will send until you reconnect.</Banner></div>}
        {trouble.length > 0 && <div className="px-2 pt-2 print:hidden"><Banner tone="danger" action={<Link className="font-semibold underline" href="/app/settings/accounts">Reconnect</Link>}>{trouble.map(t => t.displayName).join(", ")} lost access and stopped syncing.</Banner></div>}
        <SuspendedWorkspacesBanner items={me?.suspendedWorkspaces} />
        {me && me.emailVerified === false && <div className="px-2 pt-2 print:hidden"><VerifyEmailBanner email={me.email} mailAvailable={me.mailAvailable !== false} demo={!!me.demoMode} /></div>}
        <div data-shell-body className="flex min-h-0 flex-1">
          {!navHidden && <aside className="hidden w-60 shrink-0 bg-bg lg:block print:hidden"><Suspense><Sidebar /></Suspense></aside>}
          {mobileNav && <div className="lg:hidden"><Sheet title="Navigation" side="left" hideTitle closeLabel="Close navigation" onClose={() => setMobileNav(false)}><Suspense><Sidebar onNavigate={() => setMobileNav(false)} /></Suspense></Sheet></div>}
          <main id="main" className="min-w-0 flex-1 overflow-hidden">{children}</main>
          <Explain />
          {assistantOpen && <AssistantPane threadId={currentThread} onClose={() => setAssistant(false)} />}
        </div>
      </div>
      {/* On a phone, Compose is where a thumb expects it, as in Gmail. */}
      {!composer && !currentThread && MAIL_PATHS.test(path) && <button type="button" onClick={() => ctx.compose()} data-testid="compose-fab" className="fixed right-4 bottom-[calc(1.25rem+env(safe-area-inset-bottom))] z-30 inline-flex h-14 items-center gap-2 rounded-2xl bg-accent px-5 text-[15px] font-medium text-on-accent shadow-[0_10px_30px_-8px_rgba(0,80,200,.55)] lg:hidden print:hidden"><PenSquare className="size-5" aria-hidden />Compose</button>}
      {composer && <Composer key={composer.key} init={composer} onClose={() => setComposer(null)} />}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {help && <Modal wide title="Keyboard shortcuts" onClose={() => setHelp(false)}><div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">{SHORTCUT_GROUPS.map(g => <section key={g.title}><h3 className="mb-1.5 text-xs font-semibold text-muted">{g.title}</h3><dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-[13px]">{g.items.filter(i => !(isOrg && i.keys === "g then q")).map(i => <div key={i.keys} className="contents"><dt><Kbd>{i.keys}</Kbd></dt><dd className="text-muted">{i.does}</dd></div>)}</dl></section>)}</div><p className="mt-3 text-xs text-muted">Shortcuts don't run while you're typing or in a dialog.</p></Modal>}
    </WorkspaceCtx.Provider>
  );
}
