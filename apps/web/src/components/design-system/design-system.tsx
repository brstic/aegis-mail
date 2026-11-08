"use client";
import { AlertTriangle, Archive, Forward, Inbox, MoreHorizontal, Reply, Search, Shield, ShieldAlert, Star, Tag, Trash2, Users, WifiOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { accountLimitMessage, ChoiceGroup, LimitBanner, PageSkeleton, TableScroll, tdClass, thClass } from "@/components/settings/common";
import { Avatar, Banner, Button, Card, Chip, EmptyState, ErrorState, Field, IconButton, inputClass, Kbd, ListSkeleton, Menu, Modal, RISK, RiskBadge, Sheet, Skeleton, Toggle } from "@/components/ui";
import { Providers, useToast } from "@/lib/client";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";

const NAV = [["tokens", "Tokens"], ["type", "Type"], ["actions", "Actions"], ["chips", "Chips"], ["risk", "Risk states"], ["density", "Density"], ["forms", "Forms"], ["overlays", "Overlays"], ["states", "Screen states"], ["system", "System states"], ["keyboard", "Keyboard map"]] as const;
const TOKENS: { group: string; items: [string, string][] }[] = [
  { group: "Surfaces", items: [["--bg", "Page"], ["--surface", "Card and list"], ["--surface-2", "Hover and headers"], ["--surface-3", "Skeleton sheen"], ["--border", "Separators"], ["--border-strong", "Control edges"]] },
  { group: "Text", items: [["--text", "Primary"], ["--muted", "Secondary"], ["--faint", "Placeholders"]] },
  { group: "Accent", items: [["--accent", "Primary action"], ["--accent-hover", "Hover"], ["--accent-soft", "Selected"], ["--on-accent", "Text on accent"]] },
  { group: "Risk and status", items: [["--danger", "High risk"], ["--danger-soft", "Behind danger"], ["--warn", "Warning"], ["--warn-soft", "Behind warning"], ["--info", "Information"], ["--info-soft", "Behind information"], ["--safe", "No concerns"], ["--safe-soft", "Behind no concerns"]] },
];
const CONTRAST: [string, string][] = [["--text", "--surface"], ["--muted", "--surface"], ["--muted", "--surface-2"], ["--accent", "--surface"], ["--on-accent", "--accent"], ["--danger", "--danger-soft"], ["--warn", "--warn-soft"], ["--info", "--info-soft"], ["--safe", "--safe-soft"]];

function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4"><h2 id={`${id}-h`} className="text-lg font-semibold tracking-tight">{title}</h2>{intro && <p className="mt-1 max-w-2xl text-sm text-muted">{intro}</p>}<div className="mt-3">{children}</div></section>;
}

function luminance(hex: string) {
  const raw = hex.replace("#", "");
  const n = raw.length === 3 ? raw.split("").map(c => c + c).join("") : raw;
  const [r, g, b] = [0, 2, 4].map(i => { const c = parseInt(n.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

/** Reads the values from the stylesheet at run time, so what's shown can't drift from what's used. */
function ThemePanel({ theme }: { theme: "light" | "dark" }) {
  const box = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!box.current) return;
    const cs = getComputedStyle(box.current);
    const out: Record<string, string> = {};
    for (const g of TOKENS) for (const [t] of g.items) out[t] = cs.getPropertyValue(t).trim();
    setValues(out);
  }, []);
  return (
    <div ref={box} data-preview-theme={theme} data-testid={`theme-${theme}`} className="min-w-0 rounded-xl border border-line p-4" style={{ background: "var(--bg)", color: "var(--text)", colorScheme: theme }}>
      <h3 className="text-sm font-semibold capitalize">{theme}</h3>
      {TOKENS.map(g => (
        <div key={g.group} className="mt-3">
          <h4 className="text-xs font-semibold text-muted">{g.group}</h4>
          <ul className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2">
            {g.items.map(([t, use]) => (
              <li key={t} className="flex items-center gap-2 text-xs">
                <span aria-hidden className="size-7 shrink-0 rounded-md border border-line-strong" style={{ background: `var(${t})` }} />
                <span className="min-w-0"><span className="block truncate font-mono text-[11px]">{t}</span><span className="block truncate text-muted">{use}</span><span className="block font-mono text-[11px] text-muted">{values[t]}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <h4 className="mt-4 text-xs font-semibold text-muted">Contrast, measured now</h4>
      <ul className="mt-1 space-y-0.5 text-xs" data-testid={`contrast-${theme}`}>
        {CONTRAST.map(([fg, bg]) => {
          const a = values[fg], b = values[bg];
          const r = a && b ? ratio(a, b) : 0;
          return <li key={fg + bg} className="flex flex-wrap items-center justify-between gap-x-2"><span className="font-mono text-[11px]">{fg} on {bg}</span><span className="tabular-nums">{r ? `${r.toFixed(1)}:1 ${r >= 4.5 ? "passes AA" : "below AA"}` : ""}</span></li>;
        })}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-2"><Button variant="primary">Primary</Button><Button>Secondary</Button><RiskBadge risk="high_risk" /><RiskBadge risk="suspicious" /></div>
    </div>
  );
}

function SampleRow({ risk, unread }: { risk?: string; unread?: boolean }) {
  return (
    <div className="flex border-b border-line bg-surface px-3" style={{ paddingBlock: "var(--row-py)", fontSize: "var(--row-text)", gap: "var(--row-gap, .75rem)" }}>
      <span className="mt-0.5"><Avatar name="Priya Shah" address="priya@example.com" size={32} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2"><span className={`min-w-0 flex-1 truncate ${unread ? "font-semibold" : ""}`}>Priya Shah</span><span className="text-xs text-muted">9:41 AM</span></span>
        <span className="block truncate"><span className={unread ? "font-semibold" : ""}>Scope for phase two</span><span className="text-muted"> · Can you send the scope and budget by Wednesday?</span></span>
        <span className="mt-1 flex flex-wrap items-center gap-1"><RiskBadge risk={risk} quiet /><Chip tone="accent">Needs reply</Chip><Chip>finance</Chip></span>
      </span>
    </div>
  );
}

function Overlays() {
  const toast = useToast();
  const [modal, setModal] = useState(false);
  const [sheet, setSheet] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={() => setModal(true)}>Open a modal</Button>
      <Button onClick={() => setSheet(true)}>Open a sheet</Button>
      <Menu label="Example menu" align="left" items={[{ label: "Reply", icon: Reply, hint: "r" }, { label: "Forward", icon: Forward, hint: "f" }, { label: "Labels", icon: Tag, hint: "l" }, { label: "Move to Trash", icon: Trash2, danger: true }]} trigger={({ ref, ...p }) => <Button ref={ref} icon={MoreHorizontal} {...p}>Open a menu</Button>} />
      <Button onClick={() => toast({ text: "Archived.", action: { label: "Undo", run: () => toast({ text: "Moved back." }) } })}>Show a toast with Undo</Button>
      <Button onClick={() => toast({ tone: "danger", text: "Your mail provider refused a change, so that conversation is back how it was." })}>Show a failure toast</Button>
      {modal && <Modal title="Modal" onClose={() => setModal(false)} footer={<><Button onClick={() => setModal(false)}>Cancel</Button><Button variant="primary" onClick={() => setModal(false)}>Confirm</Button></>}><p className="text-sm">Focus moves in, stays in, and goes back to where it came from. <Kbd>Esc</Kbd> closes it.</p></Modal>}
      {sheet && <Sheet title="Sheet" onClose={() => setSheet(false)}><p className="p-3 text-sm">Used for the navigation drawer, and for the intelligence panel below 1280 pixels. <Kbd>Esc</Kbd> closes it.</p></Sheet>}
    </div>
  );
}

function Forms() {
  const [on, setOn] = useState(true);
  const [choice, setChoice] = useState<"focus" | "inbox">("focus");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Fields">
        <div className="space-y-3">
          <Field label="Display name" hint="Hints sit under the field."><input className={inputClass} defaultValue="Fernhill Studio" /></Field>
          <Field label="Address" error="That doesn't look like an email address."><input className={inputClass} defaultValue="morgan@" aria-invalid /></Field>
          <Field label="Mailbox"><select className={inputClass}><option>Fernhill Studio</option><option>Personal</option></select></Field>
        </div>
      </Card>
      <Card title="Choices">
        <Toggle label="A setting that saves at once" description="A switch has a word beside it, so color isn't the only clue." checked={on} onChange={setOn} />
        <Toggle label="A setting you can't change" description="Disabled controls say why nearby." checked={false} disabled onChange={() => {}} />
        <div className="mt-2"><ChoiceGroup legend="Pick one" value={choice} onChange={setChoice} options={[{ value: "focus", label: "Focus", description: "Every option stays visible." }, { value: "inbox", label: "Inbox" }]} /></div>
      </Card>
    </div>
  );
}

const SYSTEM_STATES: { state: string; where: string; show: ReactNode }[] = [
  { state: "Empty inbox", where: "Any mail view", show: <EmptyState title="You're all caught up">New mail from your connected accounts will appear here in order of arrival.</EmptyState> },
  { state: "Partial sync", where: "Mail views, while a first sync runs", show: <Banner tone="info">Still syncing Personal. 12 messages so far. Results here may be partial.</Banner> },
  { state: "Offline", where: "Top of the workspace, and any screen that can't load", show: <ErrorState error={{ status: 0, message: "" }} /> },
  { state: "Limit reached", where: "Connect a mailbox, only when the server admin set a limit", show: <LimitBanner message={accountLimitMessage(5)} /> },
  { state: "OAuth verification unavailable", where: "Connect a mailbox", show: <Banner tone="neutral">Google connections aren't configured on this deployment, so this option isn't available here.</Banner> },
  { state: "Unsupported provider", where: "Connect a mailbox", show: <Banner tone="neutral">Proton Mail isn't supported. Proton Mail Bridge only works on your own computer, which a hosted service can't reach.</Banner> },
  { state: "Manual connection TLS failure", where: "Manual setup, by error code", show: <Banner tone="danger" icon={AlertTriangle}>We couldn't make a secure connection. Check the port and security setting. We won't connect without encryption.</Banner> },
  { state: "SMTP rejection", where: "Drafts, a toast, and a count in the sidebar", show: <Banner tone="danger" icon={AlertTriangle}>This didn't send. Your mail provider refused it. Retry reopens it so you can check it and send again.</Banner> },
  { state: "Unscannable encrypted attachment", where: "Message and security report", show: <span className="flex flex-wrap items-center gap-2 text-[13px]"><RiskBadge risk="unknown_unscannable" /><span className="text-muted">Couldn't be scanned, so it isn't rated safe.</span></span> },
  { state: "Security scanner unavailable", where: "Attachment rows, Privacy Center, Security Center", show: <span className="text-[13px] text-muted">Baseline checks only: not scanned by an antivirus engine.</span> },
  { state: "Suspicious link preview", where: "/safe-link, before any link opens", show: <Banner tone="danger" icon={ShieldAlert}>This address looks like microsoft.com, but it isn't. Lookalike addresses are a common way to steal passwords.</Banner> },
  { state: "Account disconnected", where: "That account's inbox, sidebar and Accounts", show: <Banner tone="neutral">This mailbox is disconnected. Nothing syncs or sends. Mail already here stays until it's deleted.</Banner> },
  { state: "Team access denied", where: "Security Center, Organization, HTTP 403", show: <ErrorState error={{ status: 403, message: "The Security Center is for workspace owners and security admins." }} /> },
  { state: "User deletion", where: "Privacy Center", show: <Banner tone="warn" icon={Trash2}>This signs you out everywhere and disconnects all your mailboxes. It can't be undone.</Banner> },
];

function ThemeSwitch() {
  const [t, setT] = useState("system");
  useEffect(() => { try { setT(localStorage.getItem("aegis-theme") ?? "system"); } catch { /* storage blocked */ } }, []);
  const set = (v: string) => { setT(v); const r = document.documentElement; if (v === "system") delete r.dataset.theme; else r.dataset.theme = v; };
  return <label className="flex items-center gap-2 text-[13px] whitespace-nowrap">Page theme <select className={`${inputClass} h-8 w-auto`} value={t} onChange={e => set(e.target.value)}><option value="system">Match my device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>;
}

function Body() {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold"><Shield className="size-5 text-accent" aria-hidden /><span className="tracking-tight">Aegis Mail</span></Link>
          <ThemeSwitch />
        </div>
      </header>
      <div className="mx-auto max-w-6xl gap-8 px-4 py-6 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label="Design system sections" className="mb-6 lg:sticky lg:top-6 lg:mb-0 lg:self-start">
          <ul className="flex flex-wrap gap-1 lg:flex-col">{NAV.map(([id, l]) => <li key={id}><a href={`#${id}`} className="inline-flex min-h-7 items-center rounded-lg px-2 text-[13px] hover:bg-surface-2">{l}</a></li>)}</ul>
        </nav>
        <main className="min-w-0 space-y-10">
          <header>
            <h1 className="text-2xl font-semibold tracking-tight">Design system</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">Everything here is the real component running live, from <code className="font-mono text-xs">components/ui.tsx</code> and <code className="font-mono text-xs">components/settings/common.tsx</code>. Warm neutrals, one restrained accent, and mail as the hero.</p>
            <ul className="mt-3 max-w-2xl list-disc space-y-1 pl-5 text-sm">
              <li>Risk is never shown by color alone. It always has a word and an icon.</li>
              <li>Motion only explains a change, and it stops when reduced motion is on.</li>
              <li>The app says what it did and what it can't do. Nothing implies a capability that isn't there.</li>
            </ul>
          </header>
          <Section id="tokens" title="Tokens" intro="Both themes, side by side. Components only use these, so a theme is a change of values and nothing else.">
            <div className="grid gap-4 xl:grid-cols-2"><ThemePanel theme="light" /><ThemePanel theme="dark" /></div>
          </Section>
          <Section id="type" title="Type" intro="One family throughout: the system font on Apple devices, and Inter everywhere else. Headlines are large, tight and semibold.">
            <Card>
              <div className="space-y-2">
                <p className="text-xl font-semibold tracking-tight">Page title, 20px semibold</p>
                <p className="text-[15px] font-semibold">Section title, 15px semibold</p>
                <p className="text-sm">Body, 14px. Message text and settings descriptions.</p>
                <p className="text-[13px] text-muted">Secondary, 13px muted. Explanations and metadata.</p>
                <p className="text-xs text-muted">Small, 12px muted. Hints and timestamps.</p>
                <p className="font-mono text-xs">Mono, 12px. Reason codes, scopes and addresses.</p>
                <p className="font-display text-2xl">Display, 24px and up. The same family, semibold and tighter, for headlines.</p>
              </div>
            </Card>
          </Section>
          <Section id="actions" title="Actions" intro="One primary action per area. Destructive actions are spelled out, never hidden behind automation.">
            <Card>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={Reply}>Primary</Button><Button icon={Forward}>Secondary</Button><Button variant="ghost" icon={Archive}>Ghost</Button><Button variant="danger" icon={Trash2}>Danger</Button><Button loading>Busy</Button><Button disabled>Disabled</Button><Button size="sm">Small</Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1"><IconButton icon={Archive} label="Archive" /><IconButton icon={Star} label="Star" active /><IconButton icon={Tag} label="Labels" /><IconButton icon={Trash2} label="Delete" disabled /></div>
              <p className="mt-3 text-[13px] text-muted">Tab to any of these to see the focus ring. Icon buttons always carry a label for assistive technology and a tooltip.</p>
            </Card>
          </Section>
          <Section id="chips" title="Chips and identity">
            <Card>
              <div className="flex flex-wrap items-center gap-1.5"><Chip>Neutral</Chip><Chip tone="accent">Needs reply</Chip><Chip tone="warn">Due Nov 13</Chip><Chip tone="info">Demo</Chip><Chip tone="danger">Held</Chip><Chip tone="safe">From your mailboxes</Chip><Chip><Tag className="size-3" style={{ color: "#2f6f5e" }} aria-hidden />Clients</Chip><Chip><Users className="size-3" aria-hidden />Duplicate</Chip></div>
              <div className="mt-3 flex items-center gap-2"><Avatar name="Priya Shah" address="priya@example.com" /><Avatar name="Jordan Blake" address="jordan@example.com" /><Avatar address="billing@example.com" /><Avatar name="Dad" address="dad@example.com" size={40} /></div>
            </Card>
          </Section>
          <Section id="risk" title="Risk states" intro="Each rating has a word, an icon and a description. Ratings below say what was found. They aren't promises.">
            <TableScroll label="Risk ratings">
              <table className="w-full min-w-[32rem] border-collapse bg-surface">
                <thead><tr><th scope="col" className={thClass}>Rating</th><th scope="col" className={thClass}>Means</th><th scope="col" className={thClass}>In a list</th></tr></thead>
                <tbody>{Object.entries(RISK).map(([k, r]) => <tr key={k} data-testid="risk-row"><th scope="row" className={`${tdClass} text-left font-normal`}><RiskBadge risk={k} /></th><td className={tdClass}>{r.describe}</td><td className={tdClass}>{["safe", "bulk_low_priority"].includes(k) ? "No chip. Calm by default." : "Chip on the row"}</td></tr>)}</tbody>
              </table>
            </TableScroll>
          </Section>
          <Section id="density" title="Density" intro="Compact, comfortable and spacious change row spacing and text size. Layouts are split, full width, grouped by account, grouped by action, and chronological.">
            <div className="grid gap-4 lg:grid-cols-3">
              {["compact", "comfortable", "spacious"].map(d => <div key={d} data-density={d} data-testid={`density-${d}`} className="min-w-0 overflow-hidden rounded-xl border border-line"><h3 className="bg-surface-2 px-3 py-1 text-xs font-semibold text-muted capitalize">{d}</h3><SampleRow unread /><SampleRow risk="suspicious" /></div>)}
            </div>
          </Section>
          <Section id="forms" title="Forms"><Forms /></Section>
          <Section id="overlays" title="Overlays and feedback" intro="All of these close with Esc and return focus to what opened them."><Overlays /></Section>
          <Section id="states" title="Screen states" intro="Every screen has these. Errors say what happened and what to do, and never blame the person.">
            <div className="grid gap-4 md:grid-cols-2">
              <Card title="Loading: list"><ListSkeleton rows={2} /></Card>
              <Card title="Loading: page"><PageSkeleton blocks={1} /><Skeleton className="mt-2 h-8 w-32" /></Card>
              <Card title="Empty"><EmptyState icon={Inbox} title="Nothing held for review" action={<Button>An action, when there is one</Button>}>A plain sentence on what will appear here.</EmptyState></Card>
              <Card title="Error, with retry"><ErrorState error={{ status: 500, message: "Something went wrong on our side. Your data wasn't changed." }} retry={() => {}} /></Card>
              <Card title="Not found"><ErrorState error={{ status: 404, message: "" }} /></Card>
              <Card title="No results"><EmptyState icon={Search} title="No results">Try fewer words, or remove a filter.</EmptyState></Card>
            </div>
            <div className="mt-4 space-y-2"><Banner tone="info">Information. Still syncing.</Banner><Banner tone="safe">Success. Nothing else is needed.</Banner><Banner tone="neutral">Neutral. A limit worth knowing.</Banner><Banner tone="warn" icon={WifiOff}>Warning. You're offline.</Banner><Banner tone="danger" icon={AlertTriangle} action={<Button size="sm">Reconnect</Button>}>Danger, with the way out beside it.</Banner></div>
          </Section>
          <Section id="system" title="System states" intro="The states the product brief lists, each as people see it, and where it appears.">
            <ul className="space-y-3">{SYSTEM_STATES.map(s => <li key={s.state} className="rounded-xl border border-line bg-surface p-3" data-testid="system-state"><h3 className="text-sm font-semibold">{s.state}</h3><p className="mb-2 text-xs text-muted">{s.where}</p>{s.show}</li>)}</ul>
          </Section>
          <Section id="keyboard" title="Keyboard map" intro="This is the same list as the ? dialog in the app. Shortcuts don't run while you're typing or in a dialog.">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {SHORTCUT_GROUPS.map(g => <Card key={g.title} title={g.title}><dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-[13px]">{g.items.map(i => <div key={i.keys} className="contents"><dt><Kbd>{i.keys}</Kbd></dt><dd className="text-muted">{i.does}</dd></div>)}</dl></Card>)}
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}

export function DesignSystem() { return <Providers><Body /></Providers>; }
