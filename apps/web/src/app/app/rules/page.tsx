"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, Pencil, Play, Save, ShieldAlert, Trash2, Wand2, Workflow, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ChoiceGroup, ConfirmModal, Page, PageSkeleton, textareaClass, usePrefPatch } from "@/components/settings/common";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Field, inputClass, Modal, Skeleton, Toggle } from "@/components/ui";
import { api, ApiError, useAccounts, useAction, useApi, usePrefs } from "@/lib/client";

type Condition = { type: string; domains?: string[]; addresses?: string[]; terms?: string[]; value?: boolean; topic?: string; label?: string; section?: string };
type RuleAction = { type: string; name?: string; section?: string; hours?: number };
interface Definition { trigger: string; match: "all" | "any"; conditions: Condition[]; actions: RuleAction[]; accountIds?: string[]; notify?: "none" | "each" }
interface Rule { id: string; name: string; definition: Definition; riskClass: string; enabled: boolean; hourlyBudget: number; runs: number }
interface RuleRun { outcome: string; actions: string[]; at: string }
const RUN_ACTION: Record<string, string> = { archive: "archived", mark_read: "marked read", star: "starred", label: "labelled", set_section: "placed in Focus", hold: "held for review", remind: "reminder set", add_to_digest: "added to the digest" };

const SECTION: Record<string, string> = { needs_attention: "Needs your attention", important_people: "Important people", read_later: "Read later", low_priority: "Low priority", waiting_on_someone: "Waiting on someone", security_review: "Security review", todays_commitments: "Today's commitments" };
const RISK: Record<string, string> = { suspicious: "suspicious", high_risk: "high risk", malicious: "malicious" };
const list = (x: string[] = []) => x.map(v => `"${v}"`).join(" or ");

function condText(c: Condition) {
  switch (c.type) {
    case "from_domain": return `The sender's domain is ${list(c.domains)}`;
    case "from_address": return `The sender's address is ${list(c.addresses)}`;
    case "subject_contains": return `The subject contains ${list(c.terms)}`;
    case "body_contains": return `The message text contains ${list(c.terms)}`;
    case "is_bulk": return c.value ? "It's a newsletter or bulk mail" : "It isn't a newsletter or bulk mail";
    case "topic": return `The topic is "${c.topic}"`;
    case "risk_at_least": return `It's rated ${RISK[c.label ?? ""] ?? c.label} or worse`;
    case "section": return `Focus put it in ${SECTION[c.section ?? ""] ?? c.section}`;
    default: return c.type;
  }
}
function actionText(a: RuleAction) {
  switch (a.type) {
    case "archive": return "Archive it";
    case "mark_read": return "Mark it as read";
    case "star": return "Star it";
    case "label": return `Add the label "${a.name}"`;
    case "set_section": return `Move it to ${SECTION[a.section ?? ""] ?? a.section} in Focus`;
    case "hold": return "Block it, out of the inbox";
    case "remind": return `Remind me after ${a.hours} hours`;
    case "add_to_digest": return "Add it to the digest instead of surfacing it";
    default: return a.type;
  }
}

function RuleReadable({ d }: { d: Definition }) {
  return (
    <div className="space-y-2 text-[13px]">
      <div><h4 className="font-semibold">When new mail is classified and {d.match === "any" ? "any" : "all"} of these match</h4><ul className="mt-1 list-disc space-y-0.5 pl-5">{d.conditions.map((c, i) => <li key={i}>{condText(c)}</li>)}</ul></div>
      <div><h4 className="font-semibold">Then</h4><ul className="mt-1 list-disc space-y-0.5 pl-5">{d.actions.map((a, i) => <li key={i}>{actionText(a)}</li>)}{d.notify === "each" && <li>Notify you</li>}</ul></div>
    </div>
  );
}

function Builder({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<{ definition: Definition; notes: string[] } | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dry, setDry] = useState<{ scanned: number; matches: { messageId: string; subject: string; from?: string }[]; riskClass: string } | null>(null);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const parse = useAction<void, any>(() => api("/automations/parse", { body: { text: text.trim() } }), { refresh: false, onDone: r => {
    setDry(null); setSaveError(null);
    if (r.error) { setParsed(null); setParseError(r.error); } else { setParseError(null); setParsed(r); setName(text.trim().slice(0, 60)); }
  } });
  const dryRun = useAction<void, any>(() => api("/automations/dry-run", { body: { definition: parsed!.definition } }), { refresh: false, onDone: setDry });
  const save = useAction<boolean, any>(enabled => api("/automations", { body: { name: name.trim(), definition: parsed!.definition, enabled } }).catch((e: ApiError) => { setSaveError(e.message); throw e; }), {
    refresh: false, success: "Rule saved.", onDone: () => { setText(""); setParsed(null); setDry(null); setName(""); onSaved(); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) parse.mutate(); };
  return (
    <Card title="Build a rule" description="Describe what you want in plain English. It's turned into a fixed rule you can read, test and approve. A rule never consults an AI model when it runs.">
      <form onSubmit={submit} className="space-y-2">
        <Field label="What should happen?" hint={'For example: archive newsletters from example.com, or label invoices as "accounts"'}><textarea className={textareaClass} rows={2} maxLength={1000} value={text} onChange={e => setText(e.target.value)} /></Field>
        <Button type="submit" icon={Wand2} loading={parse.isPending} disabled={!text.trim()}>Turn into a rule</Button>
      </form>
      {parseError && <div className="mt-3"><Banner tone="warn">{parseError}</Banner></div>}
      {parsed && (
        <div className="mt-4 space-y-3 border-t border-line pt-3">
          <h3 className="text-sm font-semibold">Step 2: check the rule</h3>
          <RuleReadable d={parsed.definition} />
          {parsed.notes.map(n => <Banner key={n} tone="neutral">{n}</Banner>)}
          <details className="text-[13px]"><summary className="cursor-pointer font-medium">Show raw rule (JSON)</summary><pre tabIndex={0} data-testid="rule-json" className="scroll-thin mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-xs">{JSON.stringify(parsed.definition, null, 2)}</pre></details>
          <h3 className="text-sm font-semibold">Step 3: test it on recent mail</h3>
          <Button icon={Play} onClick={() => dryRun.mutate()} loading={dryRun.isPending}>Run a dry run</Button>
          {dry && (
            <div data-testid="dry-run" className="rounded-lg border border-line p-2.5 text-[13px]">
              <p className="font-medium">{dry.matches.length} of the last {dry.scanned} messages would match. Nothing was changed.</p>
              {dry.matches.length > 0 && <ul className="mt-1.5 space-y-1">{dry.matches.slice(0, 20).map(m => <li key={m.messageId} className="min-w-0 truncate"><span className="font-medium">{m.subject || "(no subject)"}</span> <span className="text-muted">from {m.from ?? "unknown sender"}</span></li>)}</ul>}
              {dry.matches.length > 20 && <p className="mt-1 text-muted">And {dry.matches.length - 20} more.</p>}
            </div>
          )}
          <h3 className="text-sm font-semibold">Step 4: save</h3>
          <Field label="Rule name"><input className={inputClass} maxLength={100} value={name} onChange={e => setName(e.target.value)} /></Field>
          <Toggle label="Notify me when this rule matches" description="Follows your quiet hours. The notification doesn't include the message's subject or sender." checked={parsed.definition.notify === "each"} onChange={v => setParsed({ ...parsed, definition: { ...parsed.definition, notify: v ? "each" : "none" } })} />
          {saveError && <Banner tone="danger">{saveError}</Banner>}
          <div className="flex flex-wrap gap-2">
            <Button icon={Save} disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate(false)}>Save, turned off</Button>
            <Button variant="primary" icon={Check} disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate(true)}>Save and turn on</Button>
          </div>
          {!dry && <p className="text-xs text-muted">You can save without a dry run, but running one first shows you what the rule would touch.</p>}
        </div>
      )}
    </Card>
  );
}

/** The plain-English route and the raw rule both end up as the same fixed definition, which the server validates. */
function EditRule({ r, onClose, onSaved }: { r: Rule; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(r.name);
  const [json, setJson] = useState(JSON.stringify(r.definition, null, 2));
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dry, setDry] = useState<{ scanned: number; matches: unknown[] } | null>(null);
  let parsed: Definition | null = null;
  try { parsed = JSON.parse(json); } catch { /* shown below */ }
  const reparse = useAction<void, any>(() => api("/automations/parse", { body: { text: text.trim() } }), { refresh: false, onDone: v => { if (v.error) { setNote(v.error); return; } setNote(null); setJson(JSON.stringify(v.definition, null, 2)); setDry(null); } });
  const dryRun = useAction<void, any>(() => api("/automations/dry-run", { body: { definition: parsed } }), { refresh: false, onDone: setDry });
  const save = useAction<void>(() => api(`/automations/${r.id}`, { method: "PATCH", body: { name: name.trim(), definition: parsed } }).catch((e: ApiError) => { setError(e.message); throw e; }), { refresh: false, success: "Rule saved.", onDone: () => { onSaved(); onClose(); } });
  return (
    <Modal wide title={`Edit rule: ${r.name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={Save} disabled={!name.trim() || !parsed} loading={save.isPending} onClick={() => { setError(null); save.mutate(); }}>Save rule</Button></>}>
      <div className="space-y-3 text-sm" data-testid="edit-rule">
        <Field label="Rule name"><input className={inputClass} maxLength={100} value={name} onChange={e => setName(e.target.value)} /></Field>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-60"><Field label="Describe it again in plain English (optional)"><input className={inputClass} maxLength={1000} value={text} onChange={e => setText(e.target.value)} /></Field></div>
          <Button icon={Wand2} disabled={!text.trim()} loading={reparse.isPending} onClick={() => reparse.mutate()}>Turn into a rule</Button>
        </div>
        {note && <Banner tone="warn">{note}</Banner>}
        <Field label="The rule" hint="This fixed form is what runs. It's checked when you save."><textarea className={`${textareaClass} font-mono text-xs`} rows={9} spellCheck={false} value={json} onChange={e => { setJson(e.target.value); setDry(null); }} aria-invalid={!parsed || undefined} /></Field>
        {!parsed ? <p role="alert" className="text-xs font-medium text-danger">That isn't valid JSON yet, so it can't be saved or tested.</p> : parsed.conditions && parsed.actions ? <RuleReadable d={parsed} /> : null}
        <div className="flex flex-wrap items-center gap-2"><Button icon={Play} disabled={!parsed} loading={dryRun.isPending} onClick={() => dryRun.mutate()}>Run a dry run</Button>{dry && <span className="text-[13px] text-muted" data-testid="edit-dry-run">{dry.matches.length} of the last {dry.scanned} messages would match. Nothing was changed.</span>}</div>
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  );
}

function RuleHistory({ r }: { r: Rule }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useApi<RuleRun[]>(["automations", r.id, "runs"], open ? `/automations/${r.id}/runs` : null);
  return (
    <details className="mt-2 text-[13px]" onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer font-medium">What it has done</summary>
      {isLoading ? <Skeleton className="mt-1 h-8" /> : error ? <p className="mt-1 text-muted">{error.message}</p> : !data?.length ? <p className="mt-1 text-muted">It hasn't run yet.</p> : (
        <ul className="mt-1 space-y-0.5" data-testid="rule-runs">{data.map((x, i) => <li key={i} className="text-muted"><time dateTime={x.at}>{new Date(x.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>: {x.outcome.replace(/_/g, " ")}{x.actions.length ? `: ${x.actions.map(a => RUN_ACTION[a] ?? a.replace(/_/g, " ")).join(", ")}` : ""}</li>)}</ul>
      )}
      {!!data?.length && <p className="mt-1 text-xs text-muted">The most recent 25. Message details aren't kept here.</p>}
    </details>
  );
}

function RuleRow({ r, onChange }: { r: Rule; onChange: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const toggle = useAction<boolean>(enabled => api(`/automations/${r.id}`, { method: "PATCH", body: { enabled } }), { refresh: false, success: "Rule updated.", onDone: onChange });
  const del = useAction<void>(() => api(`/automations/${r.id}`, { method: "DELETE" }), { refresh: false, success: "Rule deleted.", onDone: () => { setConfirm(false); onChange(); } });
  const { data: accounts } = useAccounts();
  const scoped = r.definition.accountIds?.map(id => accounts?.find(a => a.id === id)?.displayName).filter(Boolean);
  return (
    <li className="border-b border-line p-3 last:border-b-0" data-testid="rule-row">
      <Toggle checked={r.enabled} disabled={toggle.isPending} onChange={v => toggle.mutate(v)} label={r.name} description={<>{r.enabled ? "On" : "Off"}. Has run {r.runs} {r.runs === 1 ? "time" : "times"}. At most {r.hourlyBudget} runs an hour.</>} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60"><RuleReadable d={r.definition} />{!!scoped?.length && <p className="mt-1 text-xs text-muted">Only for: {scoped.join(", ")}</p>}</div>
        <div className="flex shrink-0 items-center gap-2"><Chip tone={r.riskClass === "low" ? "neutral" : "warn"}>{r.riskClass === "low" ? "Lower impact" : "Moves mail"}</Chip><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)} aria-label={`Edit rule: ${r.name}`}>Edit</Button><Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirm(true)} aria-label={`Delete rule: ${r.name}`}>Delete</Button></div>
      </div>
      <RuleHistory r={r} />
      {editing && <EditRule r={r} onClose={() => setEditing(false)} onSaved={onChange} />}
      {confirm && <ConfirmModal title="Delete this rule?" danger confirmLabel="Delete rule" busy={del.isPending} onConfirm={() => del.mutate()} onClose={() => setConfirm(false)}><p>"{r.name}" stops running. Mail it already changed stays as it is.</p></ConfirmModal>}
    </li>
  );
}

function Proposals() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<{ id: string; ruleName: string; action: RuleAction; subject: string; from: string }[]>(["proposals"], "/proposals");
  const decide = useAction<{ id: string; approve: boolean }>(({ id, approve }) => api(`/proposals/${id}`, { body: { approve } }), { success: "Done.", onDone: () => void qc.invalidateQueries({ queryKey: ["proposals"] }) });
  return (
    <Card title="Waiting for your approval" description="Depending on the automation level, rules propose changes here instead of making them.">
      {isLoading ? <Skeleton className="h-16" /> : error ? <ErrorState error={error} retry={() => refetch()} /> : !data?.length ? <p className="flex items-center gap-2 text-sm text-muted"><Inbox className="size-4 shrink-0" aria-hidden />Nothing to approve. When a rule proposes a change, it'll wait here.</p> : (
        <ul className="divide-y divide-line">
          {data.map(p => (
            <li key={p.id} className="flex flex-wrap items-start gap-3 py-2.5" data-testid="proposal-row">
              <div className="min-w-0 flex-1 basis-56 text-[13px]"><p className="font-medium">{actionText(p.action)}</p><p className="truncate text-muted">{p.subject || "(no subject)"}, from {p.from || "unknown sender"}</p><p className="text-muted">Rule: {p.ruleName}</p></div>
              <div className="flex gap-2"><Button size="sm" icon={Check} disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, approve: true })} aria-label={`Approve: ${actionText(p.action)}, ${p.subject}`}>Approve</Button><Button size="sm" variant="ghost" icon={X} disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, approve: false })} aria-label={`Reject: ${actionText(p.action)}, ${p.subject}`}>Reject</Button></div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Level() {
  const { data: prefs, isLoading } = usePrefs();
  const patch = usePrefPatch("Automation level updated.");
  if (isLoading) return <Skeleton className="h-32" />;
  return (
    <Card title="Automation level" description="This decides what a matching rule may do on its own. It applies to all your rules.">
      <ChoiceGroup legend="How much can rules do?" value={prefs?.automationLevel ?? "assist"} onChange={automationLevel => patch.mutate({ automationLevel })} options={[
        { value: "observe", label: "Observe", description: "Rules change nothing on their own. What they would do is listed above for you to review." },
        { value: "assist", label: "Assist", description: "Everything except archiving runs on its own. Archiving waits for your approval." },
        { value: "approve", label: "Approve", description: "Every action waits above until you approve or reject it." },
        { value: "limited", label: "Limited autopilot", description: "All rule actions run without asking, within each rule's hourly limit." },
      ]} />
      <p className="mt-3 text-xs text-muted">At every level, a rule never archives or marks read a message that's been flagged.</p>
    </Card>
  );
}

export default function RulesPage() {
  const qc = useQueryClient();
  const rules = useApi<Rule[]>(["automations"], "/automations");
  const changed = () => void qc.invalidateQueries({ queryKey: ["automations"] });
  return (
    <Page width="4xl" title="Rules" description="Fixed rules that sort your mail as it arrives. They run once per new message and don't touch mail that's already here.">
      <div className="space-y-4">
        <Banner tone="info" icon={ShieldAlert}><strong className="font-semibold">Rules can't send, forward or delete mail.</strong> Those actions don't exist in the rule format, however a rule is written. A rule can archive, mark read, star, label, place in Focus, hold for review, remind you or add to the digest.</Banner>
        <Builder onSaved={changed} />
        <Proposals />
        <Level />
        <section aria-labelledby="your-rules">
          <h2 id="your-rules" className="mb-2 text-[15px] font-semibold">Your rules</h2>
          {rules.isLoading ? <PageSkeleton blocks={1} /> : rules.error ? <ErrorState error={rules.error} retry={() => rules.refetch()} /> : !rules.data?.length ? <div className="rounded-xl bg-surface"><EmptyState icon={Workflow} title="No rules yet">Build one above. It stays off until you turn it on.</EmptyState></div> : <ul className="rounded-xl bg-surface">{rules.data.map(r => <RuleRow key={r.id} r={r} onChange={changed} />)}</ul>}
        </section>
      </div>
    </Page>
  );
}
