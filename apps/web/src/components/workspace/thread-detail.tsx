"use client";
import { AlertTriangle, Archive, ArrowLeft, Check, ChevronDown, Download, ExternalLink, FileSearch, FileText, Flag, Forward, Image as ImageIcon, Lightbulb, ListChecks, Mail, MailOpen, MoreHorizontal, MoreVertical, Reply, ReplyAll, Share2, ShieldAlert, ShieldCheck, Star, Tag, ThumbsDown, ThumbsUp, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import { api, useAccounts, useAction, useApi, usePrefs, useRefreshMail, useToast, type ThreadRow } from "@/lib/client";
import { ConfirmModal } from "../settings/common";
import { Avatar, Banner, Button, Chip, ErrorState, Field, IconButton, inputClass, Menu, Modal, RISK, RiskBadge, Sheet, Skeleton, type MenuItem } from "../ui";
import { sendableAccounts, type ComposeInit } from "./composer";
import type { LabelTarget } from "./label-dialog";
import { useWorkspace } from "./shell";

export interface ThreadControls { reply: () => void; forward: () => void; labels: () => void; star: () => void }
const FLAGGED = ["suspicious", "high_risk", "malicious", "unknown_unscannable"];
const reportHref = (messageId: string) => `/app/security-report/${messageId}`;
const person = (a?: { name?: string; address: string }) => !a ? "Unknown" : a.name ? `${a.name} <${a.address}>` : a.address;

/** The original goes in as plain text, under a header, so it can be read and removed before sending. Never its HTML. */
/** "3 hours ago", "10 days ago": how long since, in words. */
function ago(iso: string) {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 6e4));
  const [n, unit] = m < 60 ? [m, "minute"] : m < 60 * 24 ? [Math.round(m / 60), "hour"] : [Math.round(m / 1440), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

function quoteForForward(m: any) {
  return ["---------- Forwarded message ---------", `From: ${person(m.from)}`, `Date: ${new Date(m.date).toLocaleString()}`, `Subject: ${m.subject}`, `To: ${m.to.map(person).join(", ")}`, ...(m.cc.length ? [`Cc: ${m.cc.map(person).join(", ")}`] : []), "", m.text].join("\n").slice(0, 190_000);
}

function MessageFrame({ html, title }: { html: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(160);
  // No allow-scripts, no allow-same-origin. The body is unreadable to us, so height uses a generous fixed estimate.
  useEffect(() => { const len = html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, "").length; setH(Math.min(1400, Math.max(120, 90 + len / 2.2))); }, [html]);
  return <iframe ref={ref} title={title} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html} className="w-full rounded border-0 bg-white" style={{ height: h }} referrerPolicy="no-referrer" />;
}

function SecurityStrip({ m, onDecision, onGone }: { m: any; onDecision: () => void; onGone?: () => void }) {
  const s = m.security;
  const r = s && RISK[s.label];
  const toast = useToast();
  const refresh = useRefreshMail();
  const [open, setOpen] = useState(false);
  const report = useAction<"report_phishing" | "not_a_threat">(kind => api(`/messages/${m.id}/feedback`, { body: { kind } }).then(() => kind), { onDone: kind => { onDecision(); refresh(); if (kind === "report_phishing") onGone?.(); }, success: k => k === "report_phishing" ? "Reported and removed from your inbox." : "Marked as safe." });
  const decide = useAction<"release" | "delete", any>(decision => api(`/messages/${m.id}/quarantine`, { body: { decision } }), { onDone: r2 => { toast({ text: r2.restoredTo === "trash" ? "Moved to Trash." : `Released to ${r2.restoredTo}.` }); onDecision(); refresh(); } });
  if (!s || ["safe", "bulk_low_priority"].includes(s.label)) return null;
  const I = r?.icon ?? ShieldAlert;
  const tone = r?.tone === "danger" ? "bg-danger-soft text-danger border-danger/30" : r?.tone === "warn" ? "bg-warn-soft text-warn border-warn/30" : "bg-info-soft text-info border-info/30";
  return (
    <div data-testid="security-strip" className={`rounded-xl p-4 ${tone.replace(/border-\S+/g, "")}`}>
      <div className="flex items-start gap-2">
        <I className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          {m.held ? <>
            <div className="text-sm font-semibold">{r?.label}: held for your review</div>
            <p className="mt-0.5 text-[13px] text-ink">{s.summary}</p>
            {s.rationale && <p className="mt-1 text-xs text-muted">{s.rationale}</p>}
          </> : <>
            {/* Mail we aren't sure about: one plain sentence, and the detail one click away. */}
            <div className="text-sm font-semibold">{s.label === "unknown_unscannable" ? "We couldn't check all of this message." : "Be careful with this message."}</div>
            <p className="mt-0.5 text-[13px] text-ink">{s.evidence.find((e: any) => e.weight > 0)?.explanation ?? s.summary} Check who sent it before you click, reply or pay.</p>
          </>}
        </div>
      </div>
      <button className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDown className={`size-3 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />Why this rating</button>
      {open && (
        <div className="mt-1.5 space-y-1 text-[13px] text-ink">
          {s.evidence.filter((e: any) => e.weight > 0).map((e: any) => <div key={e.code} className="flex gap-2"><AlertTriangle className="mt-0.5 size-3 shrink-0 text-muted" aria-hidden /><span>{e.explanation}</span></div>)}
          {s.evidence.filter((e: any) => e.weight < 0).map((e: any) => <div key={e.code} className="flex gap-2 text-muted"><Check className="mt-0.5 size-3 shrink-0" aria-hidden /><span>{e.explanation}</span></div>)}
          <p className="pt-1 text-xs"><Link href={reportHref(m.id)} className="inline-flex items-center gap-1 font-medium text-accent underline underline-offset-2"><FileSearch className="size-3" aria-hidden />Full security report</Link></p>
        </div>
      )}
      {/* Mail we weren't sure about: two plain choices, right where the warning is. */}
      {!m.held && !m.fromMe && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="danger" icon={Trash2} className="!rounded-full" loading={report.isPending && report.variables === "report_phishing"} disabled={report.isPending} onClick={() => report.mutate("report_phishing")}>Report and delete</Button>
          {s.label !== "unknown_unscannable" && <Button size="sm" icon={Check} className="!rounded-full" loading={report.isPending && report.variables === "not_a_threat"} disabled={report.isPending} onClick={() => report.mutate("not_a_threat")}>It&apos;s safe</Button>}
        </div>
      )}
      {m.held && m.quarantine && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => decide.mutate("release")} loading={decide.isPending}>Not a threat: release</Button>
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => decide.mutate("delete")}>Delete</Button>
          <span className="self-center text-xs text-muted">{m.quarantine.providerMoved ? "Also moved to Spam at your provider; release puts it back." : "Held in this app only. It's still in your provider's mailbox."}</span>
        </div>
      )}
    </div>
  );
}

function Message({ m, last, isOnly, refetchWithImages, accountReadOnly, onForward, onReply, onReplyAll, onStar, onGone, shared, cited }: { m: any; last: boolean; isOnly: boolean; refetchWithImages: (id: string) => void; accountReadOnly: boolean; onForward?: () => void; onReply?: () => void; onReplyAll?: () => void; onStar?: () => void; onGone?: () => void; shared: boolean; cited: { id: string; at: number } | null }) {
  const [expanded, setExpanded] = useState(last || isOnly || !m.isRead);
  const refresh = useRefreshMail();
  const box = useRef<HTMLElement>(null);
  useEffect(() => { if (cited?.id === m.id) { setExpanded(true); box.current?.scrollIntoView({ block: "start" }); box.current?.focus(); } }, [cited, m.id]);
  const from = m.from?.name || m.from?.address || "Unknown sender";
  const mismatch = m.replyTo && m.from && m.replyTo.address.split("@")[1] !== m.from.address.split("@")[1];
  return (
    <article ref={box} tabIndex={-1} className="border-b border-line pb-5 outline-none last-of-type:border-b-0" aria-label={`Message from ${from}`}>
      <div className="flex items-start gap-2 pt-5 pb-3">
        <button type="button" className="flex min-w-0 flex-1 items-start gap-4 text-left" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <Avatar name={m.from?.name} address={m.from?.address} size={40} />
          <span className="min-w-0 flex-1 pt-0.5">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"><span className="font-semibold">{from}</span>{m.from?.name && <span className="truncate text-[13px] text-muted max-sm:hidden">&lt;{m.from.address}&gt;</span>}</span>
            <span className="block truncate text-[13px] text-muted">{expanded ? `to ${m.to.map((a: any) => a.name || a.address).join(", ")}${m.cc.length ? `, cc ${m.cc.map((a: any) => a.name || a.address).join(", ")}` : ""}` : m.text.slice(0, 160)}</span>
            {expanded && mismatch && <span className="mt-0.5 block text-xs font-medium text-warn">Replies go to {m.replyTo.address}</span>}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          {m.security?.label === "suspicious" || m.security?.label === "unknown_unscannable" ? <Chip tone="warn"><AlertTriangle className="size-3" aria-hidden />Be careful</Chip> : <RiskBadge risk={m.security?.label} quiet />}
          <time className="mr-1 text-xs whitespace-nowrap text-muted" dateTime={m.date}>{new Date(m.date).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} <span className="max-md:hidden">({ago(m.date)})</span></time>
          {onStar && <IconButton icon={Star} className={`max-sm:hidden${m.isStarred ? " !bg-transparent !text-warn [&_svg]:fill-current" : ""}`} label={m.isStarred ? "Unstar" : "Star"} active={m.isStarred} onClick={onStar} />}
          {onReply && <IconButton icon={Reply} label="Reply" onClick={onReply} />}
          <MessageMenu m={m} onForward={onForward} onReplyAll={onReplyAll} shared={shared} feedback={!accountReadOnly} />
        </div>
      </div>
      {expanded && (
        <div className="space-y-5 sm:pl-14">
          <SecurityStrip m={m} onDecision={refresh} onGone={onGone} />
          {m.failed && <Banner tone="info">This message couldn't be read or analyzed, so it hasn't been rated safe. You can open it at your mail provider.</Banner>}
          {m.sealed ? <SealedBody m={m} /> : m.html ? <MessageFrame html={m.html} title={`Message body from ${from}`} /> : <div data-testid="plain-body" className="max-w-[75ch] text-[15px] leading-[1.65] whitespace-pre-wrap break-words">{m.safeTextOnly && <Banner tone="neutral">Shown as plain text for safety. Links aren't clickable here.</Banner>}<div className={m.safeTextOnly ? "mt-2" : ""}>{m.text || <span className="text-muted">(No text content)</span>}</div></div>}
          {(m.blockedRemote > 0 || m.trackingPixels > 0) && !m.imagesAllowed && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted"><ImageIcon className="size-3.5" aria-hidden />
              {m.blockedRemote - m.trackingPixels > 0 && <span>{m.blockedRemote - m.trackingPixels} remote image{m.blockedRemote - m.trackingPixels === 1 ? "" : "s"} blocked.</span>}
              {m.trackingPixels > 0 && <span>{m.trackingPixels} tracking pixel{m.trackingPixels === 1 ? "" : "s"} blocked.</span>}
              {m.blockedRemote - m.trackingPixels > 0 && !m.safeTextOnly && <button className="font-medium text-accent underline underline-offset-2" onClick={() => refetchWithImages(m.id)}>Load images (reveals your IP to the sender)</button>}
            </div>
          )}
          {m.attachments.length > 0 && <ul className="flex flex-wrap gap-2">{m.attachments.filter((a: any) => a.disposition === "attachment").map((a: any) => <li key={a.id}><Attachment a={a} messageRisk={m.security?.label} /></li>)}</ul>}
        </div>
      )}
    </article>
  );
}

function Attachment({ a, messageRisk }: { a: any; messageRisk?: string }) {
  const blocked = ["high_risk", "malicious"].includes(messageRisk ?? "");
  const scan = a.scan === "clean" ? "Scanned, no threats found" : a.scan === "infected" ? "Malware detected" : a.scan === "not_scanned" ? "Baseline checks only: not scanned by an antivirus engine" : "Couldn't be scanned";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5" title={scan}>
      <FileText className="size-4 shrink-0 text-muted" aria-hidden />
      <span className="min-w-0"><span className="block max-w-52 truncate text-[13px] font-medium">{a.filename}</span><span className="block text-[11px] text-muted">{(a.size / 1024).toFixed(0)} KB · {scan}</span></span>
      {blocked ? <Chip tone="danger">Blocked</Chip> : <a href={`/api/v1/attachments/${a.id}`} download aria-label={`Download ${a.filename}`} className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface-2"><Download className="size-4" aria-hidden /></a>}
    </div>
  );
}

/** The ⋮ on each message, as in Gmail: what you can do with this one message, and how you rate it. */
function MessageMenu({ m, onForward, onReplyAll, shared, feedback }: { m: any; onForward?: () => void; onReplyAll?: () => void; shared: boolean; feedback: boolean }) {
  const toast = useToast();
  const fb = useAction<string>(kind => api(`/messages/${m.id}/feedback`, { body: { kind } }), { onDone: () => toast({ text: "Thanks. This only affects your own mail." }) });
  const contact = useAction<string>(pref => api(`/messages/${m.id}/contact`, { body: { pref } }), { success: "Updated." });
  const [share, setShare] = useState(false);
  const rate = feedback && !m.fromMe;
  const items: MenuItem[] = [
    ...(onReplyAll ? [{ label: "Reply all", icon: ReplyAll, onSelect: onReplyAll }] : []),
    ...(onForward ? [{ label: "Forward this message", icon: Forward, onSelect: onForward }] : []),
    ...(m.security && !m.fromMe && !shared ? [{ label: "Security report", icon: FileSearch, href: reportHref(m.id) }] : []),
    ...(rate ? [
      { label: "Important", icon: ThumbsUp, onSelect: () => fb.mutate("important") },
      { label: "Not important", icon: ThumbsDown, onSelect: () => fb.mutate("not_important") },
      { label: "Star sender", icon: UserPlus, onSelect: () => contact.mutate("vip") },
      { label: "Ignore sender", icon: UserMinus, onSelect: () => contact.mutate("ignore") },
      ...(["suspicious", "unknown_unscannable"].includes(m.security?.label) && !m.held ? [{ label: "Not a threat", icon: ShieldCheck, onSelect: () => fb.mutate("not_a_threat") }] : []),
      ...(!m.held ? [{ label: "Report phishing", icon: Flag, onSelect: () => fb.mutate("report_phishing") }] : []),
      { label: "Share with security", icon: Share2, onSelect: () => setShare(true) },
    ] : []),
  ];
  if (!items.length) return null;
  return (
    <>
      <Menu label="About this message" items={items} trigger={({ ref, ...p }) => <button ref={ref} type="button" aria-label="More for this message" title="More" className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink" {...p}><MoreVertical className="size-4" aria-hidden /></button>} />
      {share && <ShareIncident messageId={m.id} onClose={() => setShare(false)} />}
    </>
  );
}

function ShareIncident({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const { data: members } = useApi<any[]>(["members"], "/org/members", { retry: false });
  const [analyst, setAnalyst] = useState("");
  const [redact, setRedact] = useState(true);
  const [hours, setHours] = useState(24);
  const send = useAction<void>(() => api("/incidents", { body: { messageId, analystUserId: analyst, redact, hours } }), { success: "Shared. You can revoke this any time in Privacy Center.", onDone: onClose });
  const analysts = members?.filter(m => ["owner", "security_admin"].includes(m.role)) ?? [];
  return (
    <Modal title="Share with a security analyst" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!analyst} onClick={() => send.mutate()}>Share</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Admins can't see your mail. This lets one person see this one message, for a limited time. It's logged and you can revoke it.</p>
        <Field label="Analyst"><select className={inputClass} value={analyst} onChange={e => setAnalyst(e.target.value)}><option value="">Choose…</option>{analysts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role.replace("_", " ")})</option>)}</select></Field>
        <Field label="What to share"><select className={inputClass} value={redact ? "r" : "f"} onChange={e => setRedact(e.target.value === "r")}><option value="r">Redacted: rating, reason codes and sender domain only</option><option value="f">Full message: subject, sender and text</option></select></Field>
        <Field label="Expires after"><select className={inputClass} value={hours} onChange={e => setHours(Number(e.target.value))}><option value={4}>4 hours</option><option value={24}>24 hours</option><option value={72}>3 days</option><option value={168}>7 days</option></select></Field>
        {!analysts.length && <Banner tone="neutral">Nobody in this workspace has a security role.</Banner>}
      </div>
    </Modal>
  );
}

function SealedBody({ m }: { m: any }) {
  const [pw, setPw] = useState("");
  const [plain, setPlain] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const open = async () => {
    setErr(null);
    try { const { unsealText } = await import("@/lib/seal"); setPlain(await unsealText(m.sealedBlob, m.sealedMeta, pw)); }
    catch { setErr("That passphrase didn't open this message."); }
  };
  if (plain !== null) return <div className="text-[13.5px] whitespace-pre-wrap">{plain}</div>;
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-[13px]">This body is sealed with your passphrase. The server stores only ciphertext it can't open.</p>
      <div className="flex gap-2"><input type="password" aria-label="Passphrase" className={inputClass} value={pw} onChange={e => setPw(e.target.value)} /><Button onClick={open}>Unlock</Button></div>
      {err && <p className="text-xs text-danger" role="alert">{err}</p>}
    </div>
  );
}

function IntelligencePane({ thread, onCite }: { thread: any; onCite: (messageId: string) => void }) {
  const { data: prefs } = usePrefs();
  const { compose } = useWorkspace();
  const last = thread.messages[thread.messages.length - 1];
  const incoming = [...thread.messages].reverse().find((m: any) => !m.fromMe) ?? last;
  const ai = prefs?.aiEnabled !== false;
  const summaries = ai && prefs?.summariesEnabled !== false;
  const [sum, setSum] = useState<any>(null);
  const [sumError, setSumError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!summaries) return;
    let stop = false;
    setLoading(true); setSumError(null);
    api(`/threads/${thread.id}/summary`, { method: "POST" }).then(r => { if (!stop) setSum(r); }).catch(e => { if (!stop) setSumError(e.message); }).finally(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
  }, [thread.id, thread.messages.length, summaries]);
  const draft = useAction<string, any>(kind => api(`/threads/${thread.id}/draft`, { body: { kind } }), { refresh: false, onDone: d => compose({ draftId: d.draftId, accountId: d.accountId, threadId: thread.id, mode: "reply", to: d.to, subject: d.subject, text: d.text, aiGenerated: true, assumptions: d.assumptions, issues: d.issues, flaggedThread: d.flaggedThread, unfamiliarRecipients: d.unfamiliarRecipients, provider: d.provider, hosted: d.hosted }) });
  const addTask = useAction<string>(text => api("/tasks", { body: { text, accountId: thread.accountId, threadId: thread.id } }), { success: "Added to Tasks." });
  const p = incoming?.priority;
  const risk = incoming?.security?.label;
  const flagged = ["suspicious", "high_risk", "malicious"].includes(risk);
  const canDraft = thread.account.canSend && thread.account.kind !== "pop3";
  // A flagged sender's other mail isn't context worth offering: the address itself may be forged.
  const sender = !incoming?.fromMe && !flagged ? incoming?.from?.address : undefined;
  const related = useApi<{ items: ThreadRow[] }>(["threads", "related", thread.id, sender], sender ? `/threads?q=${encodeURIComponent(`from:${sender}`)}&limit=6` : null, { staleTime: 60_000 });
  const others = related.data?.items.filter(r => r.id !== thread.id).slice(0, 4) ?? [];
  const tasks = useApi<{ id: string; threadId: string | null; text: string; dueAt: string | null; dueUncertain: boolean }[]>(["tasks", "open"], "/tasks");
  const myTasks = tasks.data?.filter(t => t.threadId === thread.id) ?? [];
  return (
    <div className="space-y-4 p-3" data-testid="intelligence">
      {!ai && <Banner tone="neutral">AI features are off. You can turn them on in Settings.</Banner>}
      {incoming?.security && !incoming.fromMe && (
        <section><h3 className="mb-1 text-xs font-semibold text-muted">Risk</h3>
          <div className="flex flex-wrap items-center gap-1"><RiskBadge risk={risk} />{incoming.held && <Chip tone="danger">Held</Chip>}</div>
          {RISK[risk] && <p className="mt-1 text-[13px]">{RISK[risk]!.describe}.</p>}
          {!thread.account.shared && <p className="mt-1 text-xs"><Link href={reportHref(incoming.id)} className="font-medium text-accent underline underline-offset-2">Security report</Link></p>}
        </section>
      )}
      {ai && (
        <section><h3 className="mb-1 text-xs font-semibold text-muted">Summary</h3>
          {!summaries ? <p className="text-[13px] text-muted">Summaries are off. You can turn them on in the <Link href="/app/privacy" className="font-medium text-accent underline underline-offset-2">Privacy Center</Link>.</p>
            : loading && !sum ? <div className="space-y-1.5" role="status" aria-label="Summarizing"><Skeleton className="h-3" /><Skeleton className="h-3 w-4/5" /></div>
            : sumError ? <p className="text-[13px] text-muted">{sumError}</p>
            : sum?.bullets?.length ? (
              <ul className="space-y-1.5 text-[13px]">{sum.bullets.map((b: any, i: number) => (
                <li key={i} className="leading-snug">{b.text}{(b.messageIds ?? []).slice(0, 3).map((id: string) => { const n = thread.messages.findIndex((m: any) => m.id === id); return n < 0 ? null : <button key={id} type="button" aria-label={`Go to the message this comes from, message ${n + 1} of ${thread.messages.length}`} className="ml-1 rounded px-0.5 text-xs font-medium text-accent underline underline-offset-2" onClick={() => onCite(id)}>{n + 1}</button>; })}</li>
              ))}</ul>
            ) : <p className="text-[13px] text-muted">Nothing to summarize.</p>}
          {summaries && sum && <p className="mt-1.5 text-[11px] text-muted">{sum.hosted ? `By ${sum.model}. Content was sent to this hosted model.` : "Extracted by on-device rules. Nothing left this deployment."} Numbers link to the message each point comes from.</p>}
        </section>
      )}
      {p && !incoming.fromMe && (
        <section><h3 className="mb-1 text-xs font-semibold text-muted">Why you're seeing this</h3>
          <div className="mb-1 flex flex-wrap gap-1"><Chip tone={p.section === "security_review" ? "danger" : "accent"}>{p.sectionLabel}</Chip><Chip>{p.confidence >= 0.75 ? "Fairly confident" : "Some evidence"}</Chip></div>
          <ul className="space-y-1 text-[13px]">{p.reasons.map((r: string) => <li key={r}>{r}</li>)}</ul>
          {p.due && <p className="mt-1.5 text-[13px]"><strong className="font-medium">{p.due.uncertain ? "Timing is unclear: " : "Date mentioned: "}</strong>{p.due.text}<span className="mt-0.5 block text-xs text-muted">"{p.due.evidence}"</span>{p.due.uncertain && <span className="block text-xs text-muted">Confirm this before adding it to a calendar.</span>}</p>}
          <details className="mt-1.5 text-xs text-muted"><summary className="cursor-pointer">Scoring detail</summary><dl className="mt-1 grid grid-cols-2 gap-x-2">{Object.entries(p.features).filter(([, v]) => (v as number) > 0).map(([k, v]) => <div key={k} className="contents"><dt className="capitalize">{k.replace(/_/g, " ")}</dt><dd className="text-right tabular-nums">{(v as number).toFixed(2)}</dd></div>)}</dl></details>
        </section>
      )}
      {ai && !incoming.fromMe && (
        <section><h3 className="mb-1 text-xs font-semibold text-muted">Suggested replies</h3>
          {flagged ? <Banner tone="warn">Replies aren't suggested for flagged conversations. Verify the sender another way first.</Banner> : !canDraft ? <p className="text-[13px] text-muted">{thread.account.shared ? "This mailbox was shared with you for reading only." : "This mailbox is read-only."}</p> : (
            <div className="flex flex-col gap-1">
              {[["acknowledge", "Short acknowledgment"], ["detailed", "Detailed answer"], ["clarify", "Ask for clarification"], ["follow_up", "Follow up"], ["decline", "Polite decline"], ["meeting", "Meeting response"], ["payment_inquiry", "Payment inquiry"]].map(([k, l]) => <Button key={k} size="sm" variant="secondary" className="justify-start" onClick={() => draft.mutate(k!)} disabled={draft.isPending}>{l}</Button>)}
              <p className="text-[11px] text-muted">Creates an editable draft. Nothing sends without you.</p>
            </div>
          )}
        </section>
      )}
      {ai && sum?.ask && !flagged && !thread.account.shared && <section><h3 className="mb-1 text-xs font-semibold text-muted">Asked of you</h3><p className="text-[13px]">{sum.ask}</p><Button size="sm" className="mt-1.5" icon={ListChecks} onClick={() => addTask.mutate(sum.ask.slice(0, 400))}>Add to Tasks</Button></section>}
      {myTasks.length > 0 && <section><h3 className="mb-1 text-xs font-semibold text-muted">Tasks from this conversation</h3><ul className="space-y-1 text-[13px]">{myTasks.map(t => <li key={t.id}>{t.text}{t.dueUncertain ? <span className="block text-xs text-muted">Timing unclear</span> : t.dueAt ? <span className="block text-xs text-muted">Due {new Date(t.dueAt).toLocaleDateString([], { month: "short", day: "numeric" })}</span> : null}</li>)}</ul><p className="mt-1 text-xs"><Link href="/app/tasks" className="font-medium text-accent underline underline-offset-2">All tasks</Link></p></section>}
      {others.length > 0 && <section><h3 className="mb-1 text-xs font-semibold text-muted">Other mail from this sender</h3><ul className="space-y-1 text-[13px]">{others.map(o => <li key={o.id} className="truncate"><Link href={`/app/inbox?t=${o.id}`} className="underline-offset-2 hover:underline">{o.subject || "(no subject)"}</Link></li>)}</ul></section>}
      <section><h3 className="mb-1 text-xs font-semibold text-muted">Account</h3><p className="text-[13px] break-all">{thread.account.displayName}<span className="block text-xs text-muted">{thread.account.email}</span></p></section>
    </div>
  );
}

export function ThreadDetail({ threadId, controls, onBack, onAction, compose, onLabels, fullWidth }: { threadId: string; controls: RefObject<ThreadControls | null>; onBack: () => void; onAction: (a: string) => void; compose: (i?: ComposeInit) => void; onLabels: (t: LabelTarget) => void; fullWidth?: boolean }) {
  const { intelOpen, intelWide, toggleIntel, closeIntel } = useWorkspace();
  const { data: accounts } = useAccounts();
  const [showImagesFor, setShowImages] = useState<string | undefined>();
  const [confirmForward, setConfirmForward] = useState<any>(null);
  const [cited, setCited] = useState<{ id: string; at: number } | null>(null);
  // The conversation is always on white, as mail is meant to be read, so its HTML is never re-coloured for a dark page.
  const q = new URLSearchParams();
  if (showImagesFor) q.set("showImagesFor", showImagesFor);
  const { data: t, isLoading, error, refetch } = useApi<any>(["thread", threadId, showImagesFor], `/threads/${threadId}?${q}`);
  const [olderOpen, setOlderOpen] = useState(false);
  const refresh = useRefreshMail();
  const marked = useRef(false);
  useEffect(() => {
    if (!t || marked.current) return;
    marked.current = true;
    if (t.messages.some((m: any) => !m.isRead) && !t.account.readOnly) void api(`/threads/${threadId}/actions`, { body: { action: "read" } }).then(refresh).catch(() => {});
  }, [t, threadId, refresh]);
  // The sheet belongs to this conversation. The side panel stays as the person left it.
  useEffect(() => () => closeIntel(), []); // eslint-disable-line
  const sendable = sendableAccounts(accounts);
  const reply = (all = false) => {
    if (!t) return;
    const m = [...t.messages].reverse().find((x: any) => !x.fromMe) ?? t.messages[t.messages.length - 1];
    const to = m.fromMe ? m.to.map((a: any) => a.address) : [m.replyTo?.address ?? m.from?.address].filter(Boolean);
    const cc = all ? [...m.to, ...m.cc].map((a: any) => a.address).filter((a: string) => a !== t.account.email && !to.includes(a)) : [];
    const subj = /^\s*re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
    const flagged = t.messages.some((x: any) => !x.fromMe && ["suspicious", "high_risk", "malicious"].includes(x.security?.label));
    compose({ accountId: t.accountId, threadId, mode: "reply", to, cc, subject: subj, flaggedThread: flagged });
  };
  const openForward = (m: any) => {
    const label = m.security?.label;
    compose({
      mode: "forward", accountId: sendable.some(a => a.id === t.accountId) ? t.accountId : undefined,
      subject: /^\s*(fwd?|fw):/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`, quoted: quoteForForward(m),
      flaggedLabel: FLAGGED.includes(label) ? (RISK[label]?.label ?? label).toLowerCase() : undefined,
      original: { messageId: m.id, label, files: m.attachments.filter((a: any) => a.disposition === "attachment").map((a: any) => ({ id: a.id, filename: a.filename, size: a.size, scan: a.scan, stored: a.stored })) },
    });
  };
  // Warn first. A flagged message is often what someone is about to pass along to a colleague to ask about.
  const forward = (m: any) => { if (FLAGGED.includes(m.security?.label)) setConfirmForward(m); else openForward(m); };
  const canForwardMsg = (m: any) => !!sendable.length && !m.held && !m.sealed && !m.failed && !!m.text;
  const lastForwardable = t ? [...t.messages].reverse().find(canForwardMsg) : undefined;
  const labelTarget = (): LabelTarget => ({ id: threadId, accountId: t.accountId, labels: t.labels ?? [] });
  const last = t?.messages[t.messages.length - 1];
  controls.current = t ? { reply: () => { if (t.account.canSend && t.account.kind !== "pop3") reply(false); }, forward: () => { if (lastForwardable) forward(lastForwardable); }, labels: () => onLabels(labelTarget()), star: () => { if (!t.account.readOnly) onAction(last.isStarred ? "unstar" : "star"); } } : null;
  if (isLoading) return <div className="space-y-3 p-4" role="status" aria-label="Loading conversation"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-40" /></div>;
  if (error || !t) return <div><div className="p-2"><IconButton icon={ArrowLeft} label="Back to list" onClick={onBack} /></div><ErrorState error={error ?? { message: "Not found", status: 404 }} retry={() => refetch()} /></div>;
  const held = t.messages.some((m: any) => m.held);
  const canReply = t.account.canSend && t.account.kind !== "pop3";
  const canAct = !t.account.readOnly;
  const replyAll = t.messages.some((m: any) => m.to.length + m.cc.length > 1);
  const accountRow = accounts?.find(a => a.id === t.accountId);
  const canLabelHere = canAct && accountRow?.capabilities.labels !== "none";
  const overflow: MenuItem[] = [
    ...(canAct && !held && last.folder !== "spam" ? [{ label: "Move to Spam", icon: ShieldAlert, onSelect: () => onAction("spam") }] : []),
    ...(canAct ? [{ label: last.isStarred ? "Unstar" : "Star", icon: Star, hint: "s", onSelect: () => onAction(last.isStarred ? "unstar" : "star") }] : []),
    ...(canLabelHere ? [{ label: "Labels", icon: Tag, hint: "l", onSelect: () => onLabels(labelTarget()) }] : []),
    ...(canAct ? [{ label: "Mark unread", icon: MailOpen, onSelect: () => onAction("unread") }] : []),
    ...(canReply && replyAll ? [{ label: "Reply all", icon: ReplyAll, onSelect: () => reply(true) }] : []),
    ...(lastForwardable ? [{ label: "Forward", icon: Forward, hint: "f", onSelect: () => forward(lastForwardable) }] : []),
    ...(!t.account.shared && last.security ? [{ label: "Security report", icon: FileSearch, href: reportHref(([...t.messages].reverse().find((m: any) => !m.fromMe) ?? last).id) }] : []),
  ];
  const pane = <IntelligencePane thread={t} onCite={id => { setCited({ id, at: Date.now() }); if (!intelWide) closeIntel(); }} />;
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 shrink-0 items-center gap-1 bg-surface px-3 sm:px-5" role="toolbar" aria-label="Conversation actions">
          <IconButton icon={ArrowLeft} label="Back to list (u)" onClick={onBack} />
          {canAct && !held && last.folder === "inbox" && <IconButton icon={Archive} label="Archive (e)" onClick={() => onAction("archive")} />}
          {canAct && !held && last.folder !== "inbox" && last.folder !== "sent" && <IconButton icon={Mail} label="Move to Inbox" onClick={() => onAction("inbox")} />}
          {canAct && !held && <IconButton icon={Trash2} label="Move to Trash (#)" onClick={() => onAction("trash")} />}
          {canAct && <IconButton icon={Star} className={`hidden sm:grid${last.isStarred ? " !bg-transparent !text-warn [&_svg]:fill-current" : ""}`} label={last.isStarred ? "Unstar (s)" : "Star (s)"} active={last.isStarred} onClick={() => onAction(last.isStarred ? "unstar" : "star")} />}
          <span className="min-w-0 flex-1" />
          {canReply && <Button size="sm" icon={Reply} className="sm:hidden" onClick={() => reply(false)}>Reply</Button>}
          {lastForwardable && <IconButton icon={Forward} className="hidden sm:grid" label="Forward (f)" onClick={() => forward(lastForwardable)} />}
          {overflow.length > 0 && <div><Menu label="More actions" items={overflow} trigger={({ ref, ...p }) => <button ref={ref} type="button" aria-label="More actions" title="More actions" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" {...p}><MoreHorizontal className="size-4" aria-hidden /></button>} /></div>}
          <IconButton icon={Lightbulb} label={intelOpen ? "Hide summary (i)" : "Show summary (i)"} active={intelOpen} onClick={toggleIntel} />
        </div>
        <div data-preview-theme="light" className="scroll-thin min-h-0 flex-1 overflow-auto bg-surface px-5 pt-4 pb-16 text-ink sm:px-8 lg:pr-12">
          <div className="space-y-1">
            {/* Like Gmail: the subject lines up with the sender's name, with the account and labels beside it. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-3 sm:pl-14">
              <h1 className="text-[1.375rem] leading-tight font-normal tracking-[-.01em] break-words">{t.subject || "(no subject)"}</h1>
              <span className="inline-flex h-6 items-center rounded-md bg-surface-2 px-2 text-xs text-muted" title={t.account.email}>{t.account.displayName}{t.account.shared ? ` · shared${t.account.canSend ? "" : ", read-only"}` : t.account.readOnly ? " · read-only" : ""}</span>
              {!!t.labels?.length && <ul className="contents" aria-label="Labels">{t.labels.map((l: any) => <li key={l.id}><Chip><Tag className="size-3" style={{ color: l.color ?? undefined }} aria-hidden />{l.name}</Chip></li>)}</ul>}
            </div>
            {t.messages.map((m: any, i: number) => {
              // Like a long thread on paper: the first, a count of what's folded away, and the last two.
              const n = t.messages.length, fold = n > 4 && !olderOpen;
              if (fold && i > 0 && i < n - 2) return i === 1 ? <div key="older" className="relative py-1"><span className="absolute inset-x-0 top-1/2 border-t border-line" aria-hidden /><button type="button" onClick={() => setOlderOpen(true)} aria-label={`Show ${n - 3} older messages`} className="relative grid size-9 place-items-center rounded-full border border-line bg-surface text-[13px] font-medium hover:bg-surface-2">{n - 3}</button></div> : null;
              const isLast = i === t.messages.length - 1;
              return <Message key={m.id} m={m} last={isLast} isOnly={t.messages.length === 1} refetchWithImages={setShowImages} accountReadOnly={t.account.readOnly} shared={t.account.shared} cited={cited} onForward={canForwardMsg(m) ? () => forward(m) : undefined}
                onReply={isLast && canReply && !held ? () => reply(false) : undefined} onReplyAll={isLast && canReply && !held && replyAll ? () => reply(true) : undefined} onStar={isLast && canAct ? () => onAction(last.isStarred ? "unstar" : "star") : undefined} onGone={onBack} />;
            })}
            {canReply && !held && (
              <div className="flex flex-wrap gap-3 pt-7 sm:ml-14">
                <button type="button" onClick={() => reply(false)} className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong px-5 text-sm font-medium hover:bg-surface-2"><Reply className="size-4" aria-hidden />Reply<span className="sr-only"> from {t.account.email}</span></button>
                {lastForwardable && <button type="button" onClick={() => forward(lastForwardable)} aria-label="Forward the last message" className="inline-flex h-10 items-center gap-2 rounded-full border border-line-strong px-5 text-sm font-medium hover:bg-surface-2"><Forward className="size-4" aria-hidden />Forward</button>}
              </div>
            )}
            <div data-reply-slot={t.id} className="sm:ml-14" />
            {!canReply && <Banner tone="neutral">{t.account.kind === "pop3" ? "POP3 connections are import-only and can't send." : t.account.shared ? "This mailbox was shared with you for reading only, so you can't reply from it." : "This mailbox is connected read-only, so it can't reply."}</Banner>}
          </div>
        </div>
      </div>
      {intelOpen && intelWide && <aside aria-label="Summary" className="scroll-thin w-72 shrink-0 overflow-auto border-l border-line bg-surface print:hidden"><div className="flex items-center justify-between px-3 pt-2"><h2 className="flex items-center gap-1.5 text-sm font-semibold"><Lightbulb className="size-4 text-accent" aria-hidden />Summary</h2><IconButton icon={X} label="Hide summary" onClick={toggleIntel} /></div>{pane}</aside>}
      {intelOpen && !intelWide && <Sheet title="Summary" closeLabel="Hide summary" onClose={closeIntel}>{pane}</Sheet>}
      {confirmForward && <ConfirmModal title="Forward a flagged message?" danger confirmLabel="Write the forward" onConfirm={() => { const m = confirmForward; setConfirmForward(null); openForward(m); }} onClose={() => setConfirmForward(null)}><p>This message is rated <strong className="font-semibold">{(RISK[confirmForward.security.label]?.label ?? confirmForward.security.label).toLowerCase()}</strong>. Anyone you forward it to can click what's in it, and a forward from you looks trustworthy.</p><p className="text-muted">To ask your security team about it, use Share with security instead. That keeps it out of their inbox.</p></ConfirmModal>}
    </div>
  );
}
