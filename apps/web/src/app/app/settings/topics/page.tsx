"use client";
import { Pencil, Plus, Save, Tags, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ConfirmModal, Head, linkClass, PageSkeleton, textareaClass, TOPIC_LABEL, usePrefPatch } from "@/components/settings/common";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Field, IconButton, inputClass } from "@/components/ui";
import { usePrefs } from "@/lib/client";

interface Topic { name: string; terms: string[] }
// The topics classifyTopics assigns in @aegis/ai-core. They use fixed patterns, so they're listed but not editable.
const BUILT_IN: [string, string][] = [
  ["invoices", "Invoices, receipts, statements, purchase orders"],
  ["finance", "Budgets, banking, payroll, tax, funding"],
  ["legal", "Contracts, NDAs, agreements, redlines"],
  ["meetings", "Meetings, calls, calendars, agendas"],
  ["travel", "Flights, hotels, itineraries, bookings"],
  ["hr", "Offers, onboarding, benefits, recruiting"],
  ["sales", "Proposals, quotes, renewals, deals"],
  ["support", "Tickets, bugs, outages"],
  ["alerts", "Sign-ins, build failures, verification codes"],
  ["newsletter", "Newsletters, digests, unsubscribe links"],
];
const MAX_TOPICS = 30, MAX_TERMS = 30;
const parseTerms = (s: string) => [...new Set(s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean))];

function TopicForm({ initial, existing, onSave, onCancel, busy }: { initial?: Topic; existing: Topic[]; onSave: (t: Topic) => void; onCancel?: () => void; busy: boolean }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [terms, setTerms] = useState(initial?.terms.join(", ") ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim(), list = parseTerms(terms);
    if (!n) return setError("Give this topic a name.");
    if (!list.length) return setError("Add at least one word or phrase.");
    if (list.length > MAX_TERMS) return setError(`A topic can have at most ${MAX_TERMS} words or phrases.`);
    if (list.some(t => t.length > 60)) return setError("Each word or phrase can be at most 60 characters.");
    const lower = n.toLowerCase();
    if (lower !== initial?.name.toLowerCase() && (existing.some(t => t.name.toLowerCase() === lower) || BUILT_IN.some(([b]) => b === lower))) return setError("There's already a topic with that name.");
    setError(null);
    onSave({ name: n, terms: list });
    if (!initial) { setName(""); setTerms(""); }
  };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label="Topic name"><input className={inputClass} value={name} maxLength={40} onChange={e => setName(e.target.value)} placeholder="Oakridge project" /></Field>
      <Field label="Words and phrases" hint="Separate them with commas or new lines. A message gets this topic if its subject or text contains any of them."><textarea className={textareaClass} rows={2} value={terms} onChange={e => setTerms(e.target.value)} /></Field>
      {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
      <div className="flex gap-2"><Button type="submit" variant={initial ? "secondary" : "primary"} icon={initial ? Save : Plus} loading={busy} disabled={!name.trim() || !terms.trim()}>{initial ? "Save topic" : "Add topic"}</Button>{onCancel && <Button icon={X} onClick={onCancel}>Cancel</Button>}</div>
    </form>
  );
}

export default function TopicsPage() {
  const { data: prefs, isLoading, error, refetch } = usePrefs();
  const patch = usePrefPatch("Topics saved. They apply to new mail.");
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Topic | null>(null);
  const topics: Topic[] = prefs?.customTopics ?? [];
  const save = (next: Topic[]) => patch.mutate({ customTopics: next });
  return (
    <>
      <Head title="Topics" description="Your own topics sit alongside the built-in ones, in Focus, search and rules." />
      {isLoading ? <PageSkeleton blocks={3} /> : error || !prefs ? <ErrorState error={error ?? { message: "Preferences aren't available." }} retry={() => refetch()} /> : (
        <div className="space-y-4">
          <Banner tone="neutral" icon={Tags}>Topics apply to new mail as it arrives.</Banner>
          {prefs.topicsEnabled === false && <Banner tone="warn">Topics are turned off, so new mail won't get any until you turn them back on in the <Link href="/app/privacy" className={linkClass}>Privacy Center</Link>.</Banner>}
          <Card title="Add a topic">
            {topics.length >= MAX_TOPICS ? <p className="text-sm text-muted">You've reached the limit of {MAX_TOPICS} topics. Delete one to add another.</p> : <TopicForm existing={topics} busy={patch.isPending} onSave={t => save([...topics, t])} />}
          </Card>
          <section aria-labelledby="custom-topics">
            <h2 id="custom-topics" className="mb-2 text-[15px] font-semibold">Your topics ({topics.length})</h2>
            {!topics.length ? <div className="rounded-xl bg-surface"><EmptyState icon={Tags} title="No topics of your own yet">Add one for a client, a project or anything else you want to find or route.</EmptyState></div> : (
              <ul className="rounded-xl bg-surface">
                {topics.map(t => (
                  <li key={t.name} className="border-b border-line p-3 last:border-b-0" data-testid="topic-row">
                    {editing === t.name ? <TopicForm initial={t} existing={topics} busy={patch.isPending} onCancel={() => setEditing(null)} onSave={n => { save(topics.map(x => x.name === t.name ? n : x)); setEditing(null); }} /> : (
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 text-sm"><p className="font-medium break-words">{t.name}</p><p className="mt-0.5 text-[13px] break-words text-muted">{t.terms.join(", ")}</p></div>
                        <IconButton icon={Pencil} label={`Edit topic ${t.name}`} onClick={() => setEditing(t.name)} />
                        <IconButton icon={Trash2} label={`Delete topic ${t.name}`} onClick={() => setDeleting(t)} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Card title="Built-in topics" description="Always on while topics are enabled. They use fixed patterns, so they can't be edited here.">
            <ul className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">{BUILT_IN.map(([n, d]) => <li key={n} className="text-[13px]" data-testid="builtin-topic"><Chip>{TOPIC_LABEL[n] ?? n}</Chip> <span className="text-muted">{d}</span></li>)}</ul>
          </Card>
          {deleting && <ConfirmModal title={`Delete ${deleting.name}?`} danger confirmLabel="Delete topic" onConfirm={() => { save(topics.filter(t => t.name !== deleting.name)); setDeleting(null); }} onClose={() => setDeleting(null)}><p>New mail won't get this topic. Messages that already have it keep it, and a rule that uses it stops matching new mail.</p></ConfirmModal>}
        </div>
      )}
    </>
  );
}
