"use client";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Lock, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { fmtDateTime } from "@/components/settings/common";
import { Banner, Button, ErrorState, Field, inputClass, Modal, Skeleton } from "@/components/ui";
import { api, ApiError, useApi, useToast, type ThreadRow } from "@/lib/client";

const MIN_PASSPHRASE = 12;

function SealModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messageId, setMessageId] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const threads = useApi<{ items: ThreadRow[] }>(["threads", "seal-search", query], `/threads?limit=15${query ? `&q=${encodeURIComponent(query)}` : ""}`);
  const thread = useApi<{ subject: string; messages: { id: string; from?: { name?: string; address: string }; date: string; text: string; sealed: boolean; fromMe: boolean }[] }>(["thread", threadId, "seal"], threadId ? `/threads/${threadId}` : null);
  const sealable = thread.data?.messages.filter(m => !m.sealed && m.text) ?? [];
  const selected = sealable.find(m => m.id === messageId);
  const passProblem = pass && pass.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters.` : pass2 && pass !== pass2 ? "Those passphrases don't match." : undefined;
  const ready = !!selected && pass.length >= MIN_PASSPHRASE && pass === pass2 && ack;

  const seal = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !selected) return;
    setBusy(true); setFailure(null);
    try {
      const { sealText, unsealText } = await import("@/lib/seal");
      const { ciphertext, meta } = await sealText(selected.text, pass);
      // Prove the passphrase opens it before the server discards its own copy.
      if (await unsealText(ciphertext, meta, pass) !== selected.text) throw new Error("verify");
      await api(`/messages/${selected.id}/seal`, { body: { ciphertext, meta } });
      toast({ text: "Message sealed. You'll need your passphrase to read it here." });
      for (const key of ["privacy", "thread", "threads"]) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "This message couldn't be sealed in this browser, so nothing was changed.");
    } finally { setBusy(false); setPass(""); setPass2(""); }
  };

  return (
    <Modal wide title="Seal a message" onClose={onClose}>
      <div className="space-y-4 text-sm">
        <Banner tone="warn" icon={KeyRound}><strong className="font-semibold">If you forget this passphrase, the sealed copy is gone for good.</strong> There's no recovery key and we can't reset it. Your mail provider usually still has the original.</Banner>
        <form onSubmit={e => { e.preventDefault(); setQuery(q.trim()); setThreadId(null); setMessageId(""); }} className="flex items-end gap-2">
          <div className="min-w-0 flex-1"><Field label="Find a conversation"><input className={inputClass} value={q} onChange={e => setQ(e.target.value)} placeholder="Words in the message, or leave empty for recent mail" /></Field></div>
          <Button type="submit" icon={Search}>Search</Button>
        </form>
        {threads.isLoading ? <Skeleton className="h-16" /> : threads.error ? <ErrorState error={threads.error} retry={() => threads.refetch()} /> : !threads.data?.items.length ? <p className="text-muted">No conversations found.</p> : (
          <Field label="Conversation"><select className={inputClass} value={threadId ?? ""} onChange={e => { setThreadId(e.target.value || null); setMessageId(""); }}><option value="">Choose a conversation</option>{threads.data.items.map(t => <option key={t.id} value={t.id}>{t.subject || "(no subject)"} · {t.from?.name ?? t.from?.address ?? "unknown"}</option>)}</select></Field>
        )}
        {threadId && (thread.isLoading ? <Skeleton className="h-10" /> : thread.error ? <ErrorState error={thread.error} /> : !sealable.length ? <p className="text-muted">Every message here is already sealed or has no text to seal.</p> : (
          <Field label="Message"><select className={inputClass} value={messageId} onChange={e => setMessageId(e.target.value)}><option value="">Choose a message</option>{sealable.map(m => <option key={m.id} value={m.id}>{m.fromMe ? "You" : m.from?.name ?? m.from?.address ?? "Unknown"}, {fmtDateTime(m.date)}</option>)}</select></Field>
        ))}
        {selected && (
          <form onSubmit={seal} className="space-y-3 border-t border-line pt-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Passphrase" hint={`At least ${MIN_PASSPHRASE} characters. It stays in this browser and is never sent.`} error={passProblem}><input type="password" autoComplete="new-password" className={inputClass} value={pass} onChange={e => setPass(e.target.value)} /></Field>
              <Field label="Type it again"><input type="password" autoComplete="new-password" className={inputClass} value={pass2} onChange={e => setPass2(e.target.value)} /></Field>
            </div>
            <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
              <li>Only the text is kept. The HTML version and its formatting are erased.</li>
              <li>This message's search words are deleted, and it can't be scanned again or summarized.</li>
              <li>Attachments aren't sealed.</li>
              <li>Your mailbox connection stays in place, so the service could still fetch this message from your provider. That's why this isn't zero-access.</li>
            </ul>
            <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={ack} onChange={e => setAck(e.target.checked)} /><span>I understand this can't be undone and a lost passphrase means losing this sealed copy.</span></label>
            {failure && <Banner tone="danger">{failure}</Banner>}
            <Button type="submit" variant="primary" icon={Lock} loading={busy} disabled={!ready}>Seal this message</Button>
          </form>
        )}
      </div>
    </Modal>
  );
}

export function SealFlow() {
  const [open, setOpen] = useState(false);
  return <><Button icon={Lock} onClick={() => setOpen(true)}>Seal a message</Button>{open && <SealModal onClose={() => setOpen(false)} />}</>;
}
