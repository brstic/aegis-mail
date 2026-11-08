"use client";
import { Bookmark, CircleHelp, SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { usePrefPatch } from "../settings/common";
import { Button, Field, IconButton, inputClass, Modal } from "../ui";
import { useAccounts, useApi, useMe, usePrefs } from "@/lib/client";

interface Token { key: string; value: string; raw: string }
const TOKEN = /(\w+):("[^"]*"|\S+)|"[^"]+"|\S+/g;

/** Mirrors parseSearch on the server, so a chip only ever stands for an operator that really filters. */
export function parseOperators(q: string) {
  const ops: Token[] = [];
  const words: string[] = [];
  for (const m of q.matchAll(TOKEN)) {
    const key = m[1]?.toLowerCase();
    if (key && OPERATORS.has(key)) ops.push({ key, value: m[2]!.replace(/^"|"$/g, ""), raw: m[0] });
    else words.push(m[0]);
  }
  return { ops, words };
}
const OPERATORS = new Set(["from", "to", "subject", "after", "before", "has", "is", "risk", "priority", "label", "account"]);
const quote = (v: string) => /\s/.test(v) ? `"${v}"` : v;
const FIELD_OPS = new Set(["from", "to", "subject"]);
const RISKS = [["suspicious", "Suspicious"], ["high_risk", "High risk"], ["malicious", "Malicious"], ["unknown_unscannable", "Couldn't verify"], ["safe", "No concerns found"], ["bulk_low_priority", "Bulk"]] as const;
const SECTIONS = [["needs_attention", "Needs your attention"], ["important_people", "Important people"], ["todays_commitments", "Today's commitments"], ["read_later", "Read later"], ["low_priority", "Low priority"]] as const;
const TOGGLES = [{ key: "has", value: "attachment", label: "Has attachment" }, { key: "is", value: "unread", label: "Unread" }, { key: "is", value: "flagged", label: "Flagged" }];

/** What the server did with this search, from /threads. */
export type SemanticOutcome = { status: "used"; candidates: number; limit: number; capped: boolean; latencyMs: number } | { status: "unavailable" | "no_index" | "failed" | "rate_limited" | "not_applicable" };
export interface SemanticStatus { available: boolean; reason: "deployment" | "privacy_mode" | null; enabled: boolean; serverSearchEnabled: boolean; indexed: number; eligible: number; candidateLimit: number; topK: number }

function chipLabel(t: Token) {
  if (t.key === "has") return "Has attachment";
  if (t.key === "is") return t.value === "unread" ? "Unread" : t.value === "read" ? "Read" : t.value === "flagged" ? "Flagged" : `Is ${t.value}`;
  if (t.key === "risk") return `Risk: ${RISKS.find(r => r[0] === t.value)?.[1] ?? t.value}`;
  if (t.key === "priority") return `Focus: ${SECTIONS.find(r => r[0] === t.value)?.[1] ?? t.value}`;
  return `${t.key[0]!.toUpperCase()}${t.key.slice(1)}: ${t.value}`;
}

export const OPERATOR_HELP: [string, string][] = [
  ["from:priya", "Sender's name or address"],
  ["to:morgan", "Recipient's name or address"],
  ["subject:invoice", "Words in the subject"],
  ["has:attachment", "Has a file attached"],
  ["is:unread, is:read", "Read state"],
  ["is:flagged", "Rated suspicious or worse, or couldn't be verified. Includes held mail"],
  ["risk:high_risk", "One rating: suspicious, high_risk, malicious, unknown_unscannable, safe or bulk_low_priority. Includes held mail"],
  ["after:2026-01-31", "On or after a date"],
  ["before:2026-03-01", "Before a date"],
  ["account:personal", "Part of a mailbox's name or address"],
  ["label:clients", "A label's exact name"],
  ["priority:needs_attention", "A Focus section"],
  ['"exact phrase"', "Words kept together, in quotes"],
];

export function SearchHelp({ onClose, serverOff }: { onClose: () => void; serverOff: boolean }) {
  // Same rule as the sidebar: blocked mail is only mentioned where it's yours to see, outside an organization.
  const { data: me } = useMe();
  const seesBlocked = !!me && me.workspaces.find(w => w.id === me.tenantId)?.kind !== "organization";
  return (
    <Modal wide title="Search help" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="space-y-3 text-sm">
        <p>Type words, or add any of these to the search box. They can be combined.</p>
        <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[auto_1fr]">{OPERATOR_HELP.map(([k, d]) => <div key={k} className="contents"><dt className="font-mono text-xs break-all">{k}</dt><dd className="mb-1.5 text-muted sm:mb-0">{d}</dd></div>)}</dl>
        <h3 className="text-[13px] font-semibold">What search covers</h3>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
          <li>Every mailbox you can open, including ones shared with you. Never anyone else's.</li>
          {seesBlocked && <li>Blocked mail is left out unless you use is:flagged or risk:, so it can't appear as a normal result.</li>}
          <li>Search runs on the server, using a word index stored unencrypted in the database. {serverOff ? "It's off for your account, so word searches find nothing right now." : "You can turn it off in the Privacy Center."}</li>
          <li>"Related words" uses a short built-in list, such as payment finding invoice. It isn't semantic search and it can't find ideas outside that list. It doesn't apply when you use from:, to: or subject:.</li>
          <li>"Semantic search" finds mail close in meaning to your words, using a small model that runs on this server and isn't sent anything outside it. Where a deployment has it on, it reads each message's subject and opening text, compares your most recent mail only, and can be wrong. It's separate from the word index, and its vectors are stored encrypted.</li>
        </ul>
      </div>
    </Modal>
  );
}

/** Says what this search actually did, because a meaning match with nothing to show for itself looks like a bug. */
function SemanticNote({ outcome, status }: { outcome?: SemanticOutcome; status: SemanticStatus }) {
  if (!outcome) return null;
  const coverage = `${status.indexed.toLocaleString()} of ${status.eligible.toLocaleString()} messages you can search are indexed.`;
  const text = outcome.status === "used" ? `Showing word matches and mail close in meaning, using a model on this server. It can be wrong, so check what it finds. Compared your ${outcome.candidates.toLocaleString()} most recent indexed messages${outcome.capped ? `, the most it looks at. Older mail can only be found by words` : ""}. ${coverage}`
    : outcome.status === "no_index" ? `Nothing here is indexed for semantic search yet, so these are word matches only. ${coverage}`
    : outcome.status === "failed" ? "The model didn't answer in time, so these are word matches only. Try again in a moment."
    : outcome.status === "rate_limited" ? "That's a lot of semantic searches in a short time, so these are word matches only. Try again in a minute."
    : outcome.status === "not_applicable" ? "Add some words to compare by meaning. Filters on their own only narrow results."
    : "Semantic search is unavailable, so these are word matches only.";
  return <p className="text-xs text-muted" data-testid="semantic-note">{text}</p>;
}

/** Filters, related words, saved searches and help for /app/search. The URL holds the query, so results can be linked and reloaded. */
export function SearchPanel({ query, concepts, semantic = false, outcome }: { query: string; concepts: boolean; semantic?: boolean; outcome?: SemanticOutcome }) {
  const router = useRouter();
  const { data: prefs } = usePrefs();
  const { data: accounts } = useAccounts();
  const { data: labels } = useApi<{ id: string; name: string }[]>(["labels"], "/labels");
  const { data: semanticStatus } = useApi<SemanticStatus>(["semantic-status"], "/search/semantic", { staleTime: 60_000 });
  const patch = usePrefPatch();
  const [more, setMore] = useState(false);
  const [help, setHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const { ops, words } = useMemo(() => parseOperators(query), [query]);
  const go = (q: string, c = concepts, sem = semantic) => {
    const n = new URLSearchParams();
    if (q.trim()) n.set("q", q.trim());
    if (c) n.set("concepts", "true");
    if (sem) n.set("semantic", "true");
    const s = n.toString();
    router.push(s ? `/app/search?${s}` : "/app/search");
  };
  const without = (raw: string) => [...words, ...ops.filter(o => o.raw !== raw).map(o => o.raw)].join(" ");
  const has = (key: string, value: string) => ops.some(o => o.key === key && o.value === value);
  const toggle = (key: string, value: string) => has(key, value) ? go(without(`${key}:${value}`)) : go(`${query} ${key}:${value}`);
  const setOp = (key: string, value: string) => { const rest = [...words, ...ops.filter(o => o.key !== key).map(o => o.raw)]; go([...rest, ...(value.trim() ? [`${key}:${quote(value.trim())}`] : [])].join(" ")); };
  const opValue = (key: string) => ops.find(o => o.key === key)?.value ?? "";
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft({}), [query]);
  const text = (key: string) => draft[key] ?? opValue(key);
  const commit = (e: FormEvent) => {
    e.preventDefault();
    const entries = Object.entries(draft);
    if (!entries.length) return;
    const keys = new Set(entries.map(([k]) => k));
    const rest = [...words, ...ops.filter(o => !keys.has(o.key)).map(o => o.raw)];
    go([...rest, ...entries.filter(([, v]) => v.trim()).map(([k, v]) => `${k}:${quote(v.trim())}`)].join(" "));
  };
  const saved: { name: string; q: string; concepts: boolean; semantic?: boolean }[] = prefs?.savedSearches ?? [];
  const canUseSemantic = !!semanticStatus?.available && semanticStatus.enabled && semanticStatus.serverSearchEnabled;
  const semanticOn = semantic && canUseSemantic && words.length > 0;
  const fieldOps = ops.some(o => FIELD_OPS.has(o.key));
  const save = (e: FormEvent) => { e.preventDefault(); if (!name.trim()) return; patch.mutate({ savedSearches: [...saved.filter(s => s.name !== name.trim()), { name: name.trim(), q: query, concepts, semantic: semanticOn }] }); setName(""); setSaving(false); };
  const chipClass = (on: boolean) => `inline-flex h-7 items-center gap-1 rounded-lg border px-2 text-xs font-medium transition-colors ${on ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-ink hover:bg-surface-2"}`;
  return (
    <div className="shrink-0 space-y-2 border-b border-line px-4 py-2" data-testid="search-panel">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Search filters">
        {TOGGLES.map(t => <button key={t.label} type="button" aria-pressed={has(t.key, t.value)} className={chipClass(has(t.key, t.value))} onClick={() => toggle(t.key, t.value)}>{t.label}</button>)}
        <button type="button" aria-pressed={concepts && !fieldOps} disabled={fieldOps || !query.trim()} title={fieldOps ? "Off while you're using from:, to: or subject:, which match exactly." : "Also match a short built-in list of related words"} className={`${chipClass(concepts && !fieldOps)} disabled:opacity-50`} onClick={() => go(query, !concepts)}>Related words</button>
        {canUseSemantic && <button type="button" aria-pressed={semanticOn} disabled={!words.length} title={words.length ? "Also find mail close in meaning, using a model on this server" : "Add some words: filters on their own have no meaning to compare."} className={`${chipClass(semanticOn)} disabled:opacity-50`} onClick={() => go(query, concepts, !semantic)}>Semantic search</button>}
        <button type="button" aria-expanded={more} className={chipClass(more)} onClick={() => setMore(v => !v)}><SlidersHorizontal className="size-3" aria-hidden />More filters</button>
        <button type="button" className={chipClass(false)} onClick={() => setHelp(true)}><CircleHelp className="size-3" aria-hidden />Search help</button>
        {/* With nothing saved yet, saving sits with the filters instead of alone on a row of its own. */}
        {!saved.length && query.trim() && !saving && <button type="button" className={chipClass(false)} onClick={() => setSaving(true)}><Bookmark className="size-3" aria-hidden />Save this search</button>}
      </div>
      {ops.filter(o => !(o.key === "has" && o.value === "attachment") && !(o.key === "is" && ["unread", "flagged"].includes(o.value))).length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {ops.filter(o => !(o.key === "has" && o.value === "attachment") && !(o.key === "is" && ["unread", "flagged"].includes(o.value))).map(o => (
            <li key={o.raw} className="inline-flex items-center gap-0.5 rounded-lg bg-accent-soft py-0.5 pr-0.5 pl-2 text-xs font-medium text-accent" data-testid="search-chip">
              {chipLabel(o)}
              <button type="button" aria-label={`Remove filter ${chipLabel(o)}`} className="grid size-6 place-items-center rounded hover:bg-surface-2" onClick={() => go(without(o.raw))}><X className="size-3" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      {more && (
        <form onSubmit={commit} className="space-y-2 rounded-lg bg-surface-2 p-2.5">
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="From"><input className={inputClass} value={text("from")} onChange={e => setDraft(d => ({ ...d, from: e.target.value }))} /></Field>
            <Field label="To"><input className={inputClass} value={text("to")} onChange={e => setDraft(d => ({ ...d, to: e.target.value }))} /></Field>
            <Field label="Subject"><input className={inputClass} value={text("subject")} onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))} /></Field>
            <Field label="On or after"><input type="date" className={inputClass} value={text("after")} onChange={e => setDraft(d => ({ ...d, after: e.target.value }))} /></Field>
            <Field label="Before"><input type="date" className={inputClass} value={text("before")} onChange={e => setDraft(d => ({ ...d, before: e.target.value }))} /></Field>
            <Field label="Account"><select className={inputClass} value={opValue("account")} onChange={e => setOp("account", e.target.value)}><option value="">Any account</option>{accounts?.map(a => <option key={a.id} value={a.email}>{a.displayName}</option>)}</select></Field>
            <Field label="Risk"><select className={inputClass} value={opValue("risk")} onChange={e => setOp("risk", e.target.value)}><option value="">Any rating</option>{RISKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Label"><select className={inputClass} value={opValue("label")} onChange={e => setOp("label", e.target.value)}><option value="">Any label</option>{[...new Set(labels?.map(l => l.name))].map(n => <option key={n} value={n}>{n}</option>)}</select></Field>
            <Field label="Focus section"><select className={inputClass} value={opValue("priority")} onChange={e => setOp("priority", e.target.value)}><option value="">Any section</option>{SECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          </div>
          <Button type="submit" size="sm" disabled={!Object.keys(draft).length}>Apply filters</Button>
        </form>
      )}
      {semanticStatus && !semanticStatus.available && semanticStatus.reason === "privacy_mode" && <p className="text-xs text-muted" data-testid="semantic-unavailable">Semantic search is unavailable: {semanticStatus.reason === "privacy_mode" ? "this workspace's privacy mode doesn't allow it." : "this deployment hasn't enabled it."} Word search isn't affected.</p>}
      {semanticStatus?.available && !canUseSemantic && <p className="text-xs text-muted" data-testid="semantic-off">Semantic search is off for your account. <Link href="/app/settings/search" className="font-medium underline underline-offset-2">Search settings</Link></p>}
      {semanticOn && <SemanticNote outcome={outcome} status={semanticStatus!} />}
      {concepts && !fieldOps && <p className="text-xs text-muted" data-testid="related-note">Also matching a short built-in list of related words, so payment finds invoice and remittance. This isn't semantic search.</p>}
      {concepts && fieldOps && <p className="text-xs text-muted">Related words are off while you're using from:, to: or subject:, which match exactly.</p>}
      {prefs?.serverSearchEnabled === false && <p className="text-xs text-warn">Server search is off for your account, so words won't match anything. Filters like Unread still work. <Link href="/app/privacy" className="font-medium underline underline-offset-2">Privacy Center</Link></p>}
      <div className="flex flex-wrap items-center gap-1.5 text-xs empty:hidden">
        {saved.length > 0 && <span className="font-medium text-muted">Saved:</span>}
        {saved.map(s => (
          <span key={s.name} className="inline-flex items-center rounded-lg border border-line-strong pl-2 text-ink" data-testid="saved-search">
            <Link href={`/app/search?q=${encodeURIComponent(s.q)}${s.concepts ? "&concepts=true" : ""}${s.semantic ? "&semantic=true" : ""}`} className="font-medium hover:underline">{s.name}</Link>
            <button type="button" aria-label={`Delete saved search ${s.name}`} className="grid size-6 place-items-center rounded hover:bg-surface-2" onClick={() => patch.mutate({ savedSearches: saved.filter(x => x.name !== s.name) })}><X className="size-3" aria-hidden /></button>
          </span>
        ))}
        {!!saved.length && query.trim() && !saving && <button type="button" className={chipClass(false)} onClick={() => setSaving(true)}><Bookmark className="size-3" aria-hidden />Save this search</button>}
        {saving && (
          <form onSubmit={save} className="flex items-center gap-1">
            <input aria-label="Name for this search" autoFocus maxLength={60} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); setSaving(false); } }} placeholder="Name" className={`${inputClass} h-7 w-36 text-xs`} />
            <Button type="submit" size="sm" disabled={!name.trim()}>Save</Button>
            <IconButton icon={X} label="Cancel" type="button" onClick={() => setSaving(false)} />
          </form>
        )}
      </div>
      {help && <SearchHelp serverOff={prefs?.serverSearchEnabled === false} onClose={() => setHelp(false)} />}
    </div>
  );
}
