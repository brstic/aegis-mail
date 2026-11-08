"use client";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarPlus, Check, CheckSquare, Circle, ExternalLink, Plus, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { fmtDate, Page, PageSkeleton } from "@/components/settings/common";
import { Banner, Button, Card, Chip, EmptyState, ErrorState, Field, IconButton, inputClass } from "@/components/ui";
import { api, useAccounts, useAction, useApi } from "@/lib/client";

interface Task { id: string; threadId: string | null; accountId: string; status: string; dueAt: string | null; dueUncertain: boolean; remindAt: string | null; source: string; text: string; kind?: string; due?: { text: string; evidence: string } }

function Due({ t }: { t: Task }) {
  // Vague language is never upgraded to a date, even if a best guess was stored.
  if (t.dueUncertain) return <span className="text-[13px] text-warn">Timing unclear{t.due?.evidence && !t.text.includes(t.due.evidence) ? <span className="text-muted">. From the message: &ldquo;{t.due.evidence}&rdquo;</span> : null}</span>;
  if (t.dueAt) {
    const overdue = t.status === "open" && new Date(t.dueAt).getTime() < Date.now();
    return <span className="text-[13px] text-muted">Due <time dateTime={t.dueAt}>{fmtDate(t.dueAt)}</time>{overdue && <strong className="ml-1 font-medium text-danger">Overdue</strong>}</span>;
  }
  // No date is the usual case, so it says nothing rather than repeat "No due date" on most rows.
  return null;
}

function Reminder({ t, onChange }: { t: Task; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const save = useAction<string | null>(remindAt => api(`/tasks/${t.id}/remind`, { body: { remindAt } }), { refresh: false, success: v => v ? "Reminder set." : "Reminder removed.", onDone: () => { setEditing(false); onChange(); } });
  if (t.status !== "open") return null;
  if (!editing) return <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-accent"><Bell className="size-3" aria-hidden />{t.remindAt ? <>Reminder <time dateTime={t.remindAt}>{fmtDate(t.remindAt)}</time></> : "Remind me"}</button>;
  return (
    <span className="flex w-full flex-wrap items-center gap-2">
      <input type="datetime-local" aria-label={`Reminder time for: ${t.text}`} className={`${inputClass} min-w-0 flex-1 basis-44`} value={value} onChange={e => setValue(e.target.value)} />
      <Button size="sm" variant="primary" disabled={!value} loading={save.isPending} onClick={() => save.mutate(new Date(value).toISOString())}>Save</Button>
      {t.remindAt && <Button size="sm" variant="ghost" onClick={() => save.mutate(null)}>Remove</Button>}
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </span>
  );
}

function TaskRow({ t, accountName, onChange }: { t: Task; accountName?: string; onChange: () => void }) {
  const set = useAction<string>(status => api(`/tasks/${t.id}`, { method: "PATCH", body: { status } }), { refresh: false, success: "Task updated.", onDone: onChange });
  const open = t.status === "open";
  return (
    <li className="flex items-start gap-2 border-b border-line px-3 py-2.5 last:border-b-0" data-testid="task-row">
      {open ? <IconButton icon={Circle} label={`Mark done: ${t.text}`} disabled={set.isPending} onClick={() => set.mutate("done")} /> : <span className="grid size-8 shrink-0 place-items-center text-safe"><Check className="size-4" aria-hidden /></span>}
      <div className="min-w-0 flex-1 py-1 text-sm">
        <p className={`break-words ${open ? "" : "text-muted line-through"}`}>{t.text}{!open && <span className="sr-only"> (done)</span>}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Due t={t} />
          <Reminder t={t} onChange={onChange} />
          {accountName && <span className="text-[13px] text-muted">{accountName}</span>}
          {t.source === "automation" && <Chip>From a rule</Chip>}
          {t.threadId && <Link href={`/app/inbox?t=${t.threadId}`} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-accent"><ExternalLink className="size-3" aria-hidden />Open conversation</Link>}
        </p>
      </div>
      {open ? <IconButton icon={X} label={`Dismiss: ${t.text}`} disabled={set.isPending} onClick={() => set.mutate("dismissed")} /> : <IconButton icon={RotateCcw} label={`Reopen: ${t.text}`} disabled={set.isPending} onClick={() => set.mutate("open")} />}
    </li>
  );
}

function AddTask({ onAdded }: { onAdded: () => void }) {
  const { data: accounts } = useAccounts();
  const owned = accounts?.filter(a => a.owned) ?? [];
  const [text, setText] = useState("");
  const [accountId, setAccountId] = useState("");
  const [due, setDue] = useState("");
  useEffect(() => { if (!accountId && owned.length) setAccountId((owned.find(a => a.isPrimary) ?? owned[0])!.id); }, [accountId, owned]);
  const add = useAction<void>(() => api("/tasks", { body: { text: text.trim(), accountId, dueAt: due ? new Date(`${due}T12:00:00`).toISOString() : undefined } }), { refresh: false, success: "Task added.", onDone: () => { setText(""); setDue(""); onAdded(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim() && accountId) add.mutate(); };
  if (accounts && !owned.length) return <Banner tone="neutral">Tasks belong to a mailbox. <Link href="/app/connect" className="font-semibold underline underline-offset-2">Connect one</Link> to add a task.</Banner>;
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Task"><input className={inputClass} value={text} maxLength={500} onChange={e => setText(e.target.value)} placeholder="What needs doing?" /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Due date (optional)"><input type="date" className={inputClass} value={due} onChange={e => setDue(e.target.value)} /></Field>
        <Field label="Mailbox"><select className={inputClass} value={accountId} onChange={e => setAccountId(e.target.value)}>{owned.map(a => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select></Field>
      </div>
      <Button type="submit" variant="primary" icon={Plus} loading={add.isPending} disabled={!text.trim() || !accountId}>Add task</Button>
    </form>
  );
}

const DAY = 86_400_000;

/**
 * What to do next, in a fixed order you can read off the labels: overdue, then due within two days, then promises you
 * made. A vague date is left out, because it can't be ordered honestly. Nothing here is done for you.
 */
function upNext(tasks: Task[], now = Date.now()): { task: Task; why: string }[] {
  const firm = tasks.filter(t => t.dueAt && !t.dueUncertain).sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());
  const overdue = firm.filter(t => new Date(t.dueAt!).getTime() < now).map(task => ({ task, why: "Overdue" }));
  const soon = firm.filter(t => { const d = new Date(t.dueAt!).getTime(); return d >= now && d < now + 2 * DAY; }).map(task => ({ task, why: "Due soon" }));
  const taken = new Set([...overdue, ...soon].map(x => x.task.id));
  const promises = tasks.filter(t => t.kind === "promise" && !taken.has(t.id)).map(task => ({ task, why: "You promised this" }));
  return [...overdue, ...soon, ...promises].slice(0, 5);
}

export default function TasksPage() {
  const qc = useQueryClient();
  const [showDone, setShowDone] = useState(false);
  const [view, setView] = useState<"all" | "promises">("all");
  const open = useApi<Task[]>(["tasks", "open"], "/tasks");
  const done = useApi<Task[]>(["tasks", "done"], showDone ? "/tasks?status=done" : null);
  const { data: accounts } = useAccounts();
  const name = (id: string) => accounts?.find(a => a.id === id)?.displayName;
  const changed = () => void qc.invalidateQueries({ queryKey: ["tasks"] });
  return (
    <Page width="4xl" title="Tasks" description="Requests found in your mail, and things you've added.">
      <div className="space-y-4">
        <Card title="Add a task"><AddTask onAdded={changed} /></Card>
        <Card title="Add to your calendar" description="Download open tasks as a calendar file, to import into any calendar app.">
          <a href="/api/v1/tasks/export.ics" download="aegis-tasks.ics" className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium hover:bg-surface-2"><CalendarPlus className="size-4" aria-hidden />Download calendar file</a>
          <p className="mt-2 text-[13px] text-muted">Tasks with a firm due date. Tasks marked "Timing unclear" are left out.</p>
        </Card>
        {!!open.data && upNext(open.data).length > 0 && (
          <section aria-labelledby="up-next" data-testid="up-next">
            <h2 id="up-next" className="mb-2 text-[15px] font-semibold">Up next</h2>
            <ol className="rounded-xl bg-surface">{upNext(open.data).map(({ task, why }) => (
              <li key={task.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
                {task.threadId ? <Link href={`/app/inbox?t=${task.threadId}`} className="min-w-0 flex-1 basis-48 truncate underline-offset-2 hover:underline">{task.text}</Link> : <span className="min-w-0 flex-1 basis-48 truncate">{task.text}</span>}
                {/* The reason sits at the end, so every task's text starts in the same column. */}
                <Chip tone={why === "Overdue" ? "danger" : why === "Due soon" ? "warn" : "neutral"}>{why}</Chip>
              </li>))}</ol>
          </section>
        )}
        <section aria-labelledby="open-tasks">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 id="open-tasks" className="text-[15px] font-semibold">{view === "promises" ? "Promises I made" : "Open"}{open.data ? ` (${(view === "promises" ? open.data.filter(t => t.kind === "promise") : open.data).length})` : ""}</h2>
            <div role="group" aria-label="Which tasks to show" className="flex gap-1">
              <Button size="sm" variant={view === "all" ? "primary" : undefined} aria-pressed={view === "all"} onClick={() => setView("all")}>All open</Button>
              <Button size="sm" variant={view === "promises" ? "primary" : undefined} aria-pressed={view === "promises"} onClick={() => setView("promises")}>Promises I made</Button>
            </div>
          </div>
          {open.isLoading ? <PageSkeleton blocks={2} /> : open.error ? <ErrorState error={open.error} retry={() => open.refetch()} /> : !(view === "promises" ? open.data?.filter(t => t.kind === "promise") : open.data)?.length ? (
            <div className="rounded-xl bg-surface"><EmptyState icon={CheckSquare} title={view === "promises" ? "No open promises" : "No open tasks"}>{view === "promises" ? "Commitments you make in sent mail, like \u201cI'll send it Monday\u201d, appear here." : "Things people ask of you will appear here with the message they came from."}</EmptyState></div>
          ) : <ul className="rounded-xl bg-surface">{(view === "promises" ? open.data!.filter(t => t.kind === "promise") : open.data!).map(t => <TaskRow key={t.id} t={t} accountName={name(t.accountId)} onChange={changed} />)}</ul>}
        </section>
        <section aria-labelledby="done-tasks">
          <div className="mb-2 flex items-center justify-between gap-2"><h2 id="done-tasks" className="text-[15px] font-semibold">Done</h2><Button size="sm" aria-expanded={showDone} onClick={() => setShowDone(v => !v)}>{showDone ? "Hide done tasks" : "Show done tasks"}</Button></div>
          {showDone && (done.isLoading ? <PageSkeleton blocks={1} /> : done.error ? <ErrorState error={done.error} retry={() => done.refetch()} /> : !done.data?.length ? <p className="text-sm text-muted">Nothing marked done yet.</p> : <ul className="rounded-xl bg-surface">{done.data.map(t => <TaskRow key={t.id} t={t} accountName={name(t.accountId)} onChange={changed} />)}</ul>)}
        </section>
      </div>
    </Page>
  );
}
