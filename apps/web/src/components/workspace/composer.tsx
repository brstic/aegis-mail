"use client";
import { createPortal } from "react-dom";
import { Clock, FileText, Lightbulb, Minus, Paperclip, Reply, ShieldAlert, Trash2, Users, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, newIdempotencyKey, uuid, useAccounts, useApi, useEscape, useOnline, usePrefs, useRefreshMail, useToast, type Account } from "@/lib/client";
import { Banner, Button, Chip, IconButton, Modal, inputClass } from "../ui";

export interface DraftFile { id: string; filename: string; contentType: string; size: number; sourceAttachmentId?: string }
/** A file on the message being forwarded. The server decides whether it can be copied; this only explains that up front. */
export interface OriginalFile { id: string; filename: string; size: number; scan: string; stored: boolean }
export interface ComposeInit { draftId?: string; accountId?: string; threadId?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; text?: string; aiGenerated?: boolean; assumptions?: string[]; issues?: { code: string; message: string }[]; flaggedThread?: boolean; unfamiliarRecipients?: string[]; provider?: string; hosted?: boolean; mode?: "reply" | "forward"; quoted?: string; flaggedLabel?: string; original?: { messageId: string; label?: string; files: OriginalFile[] }; fromAlias?: string; attachments?: DraftFile[] }
interface Signature { id: string; accountId: string; name: string; text: string; isDefault: boolean }

/** Accepts "a@b.c", "Name <a@b.c>", and any mix separated by commas, semicolons, spaces or new lines. */
export function parseAddresses(s: string) {
  return s.split(/[,;\n]+/).flatMap(part => {
    const t = part.trim();
    if (!t) return [];
    const m = t.match(/<([^<>]+)>\s*$/);
    return m ? [m[1]!.trim()] : t.split(/\s+/);
  });
}
const looksValid = (a: string) => /^[^@\s<>,;]+@[^@\s<>,;.]+(\.[^@\s<>,;.]+)+$/.test(a);
const domainOf = (a: string) => a.split("@")[1]?.toLowerCase() ?? "";
const LOCAL_KEY = "aegis-unsent-draft";
const MAX_FILES_BYTES = 3 * 1024 * 1024;
const localDateTime = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
const fmtSize = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
/** Same rules as copyAttachmentsToDraft in packages/platform/src/send.ts, which is what actually enforces them. */
function whyNotForwardable(f: OriginalFile, label?: string) {
  if (["suspicious", "high_risk", "malicious"].includes(label ?? "")) return "Can't be forwarded: this message was flagged";
  if (f.scan === "infected") return "Can't be forwarded: the malware scanner flagged it";
  if (f.scan === "unscannable" || f.scan === "error") return "Can't be forwarded: the malware scanner couldn't read it";
  if (!f.stored) return "Not stored here. Download it from your provider to attach it";
  if (f.size > MAX_FILES_BYTES) return "Over the 3 MB limit for one message";
  return null;
}
const readBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

/** Mailboxes this person may send from: their own, and shared ones whose owner allowed it. */
export function sendableAccounts(accounts: Account[] | undefined) {
  return accounts?.filter(a => a.capabilities.send && !a.readOnly && a.status === "active" && (a.owned || a.canSend)) ?? [];
}

function AddressRow({ label, value, onChange, invalid, autoFocus, action }: { label: string; value: string; onChange: (v: string) => void; invalid: string[]; autoFocus?: boolean; action?: React.ReactNode }) {
  const id = useId();
  // The whole row is the field: a click anywhere on it, not just on the text, puts the cursor in it.
  return (
    <div className="mx-4 cursor-text border-b border-line py-2.5 text-sm focus-within:border-line-strong" onMouseDown={e => { if (!(e.target as HTMLElement).closest("button, input, a")) { e.preventDefault(); document.getElementById(id)?.focus(); } }}>
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="shrink-0 text-muted">{label}</label>
        <input id={id} value={value} onChange={e => onChange(e.target.value)} autoFocus={autoFocus} autoComplete="off" spellCheck={false} aria-invalid={invalid.length > 0 || undefined} aria-describedby={invalid.length ? `${id}-err` : undefined} className="min-w-0 flex-1 bg-transparent outline-none focus-visible:outline-none" />
        {action}
      </div>
      {invalid.length > 0 && <p id={`${id}-err`} role="alert" className="mt-1 pl-16 text-xs font-medium text-danger">Check {invalid.length === 1 ? "this address" : "these addresses"}: {invalid.join(", ")}</p>}
    </div>
  );
}

export function Composer({ init, onClose }: { init: ComposeInit; onClose: () => void }) {
  // On a wide screen, a reply to the open conversation sits at the bottom of it. If the conversation closes, it floats again.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  // An inline reply opens where you can see it, not below the fold.
  useEffect(() => { if (slot) requestAnimationFrame(() => slot.scrollIntoView({ block: "nearest", behavior: "smooth" })); }, [slot]);
  useEffect(() => {
    if (!init.threadId) return;
    const find = () => {
      const el = matchMedia("(min-width: 640px)").matches ? document.querySelector<HTMLElement>(`[data-reply-slot="${CSS.escape(init.threadId!)}"]`) : null;
      setSlot(cur => (cur === el ? cur : el));
    };
    find();
    const iv = window.setInterval(find, 600);
    return () => clearInterval(iv);
  }, [init.threadId]);
  const { data: accounts } = useAccounts();
  const { data: prefs } = usePrefs();
  const online = useOnline();
  const toast = useToast();
  const refresh = useRefreshMail();
  const sendable = sendableAccounts(accounts);
  const forwarding = init.mode === "forward";
  const [accountId, setAccountId] = useState(init.accountId ?? "");
  const [fromAlias, setFromAlias] = useState(init.fromAlias ?? "");
  const [to, setTo] = useState((init.to ?? []).join(", "));
  const [cc, setCc] = useState((init.cc ?? []).join(", "));
  const [bcc, setBcc] = useState((init.bcc ?? []).join(", "));
  const [showCc, setShowCc] = useState(!!init.cc?.length || !!init.bcc?.length);
  const [subject, setSubject] = useState(init.subject ?? "");
  const [body, setBody] = useState(init.text ?? "");
  const [quoted, setQuoted] = useState(init.quoted ?? "");
  // Null means nobody chose yet, so a new message uses the account's default. A reopened draft already has its signature in the text.
  const [chosenSig, setChosenSig] = useState<string | null>(null);
  const useDefaultSig = !init.draftId || !!init.aiGenerated;
  const [files, setFiles] = useState<DraftFile[]>(init.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const originals = init.original?.files ?? [];
  const copiedDefaults = useRef(false);
  // Chosen here so a slow save and a quick second one can't each create a draft.
  const draftKey = useRef(init.draftId ?? uuid());
  const [draftId, setDraftId] = useState(init.draftId);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "local">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mini, setMini] = useState(false);
  const [confirmRisk, setConfirmRisk] = useState(false);
  const [schedule, setSchedule] = useState<string | null>(null);
  const [restorable, setRestorable] = useState<null | { to?: string[]; subject?: string; text?: string; accountId?: string }>(null);
  // One key per send intent: a double click or a retry after timeout can't produce two sends.
  const idemKey = useRef(newIdempotencyKey());
  const dirty = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!accountId && sendable.length) setAccountId((sendable.find(a => a.isPrimary && a.owned) ?? sendable[0])!.id); }, [accountId, sendable]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { if (prev?.isConnected) prev.focus(); };
  }, []);
  useEffect(() => {
    if (init.draftId || init.threadId || init.to?.length || init.text) return;
    try { const raw = sessionStorage.getItem(LOCAL_KEY); if (raw) setRestorable(JSON.parse(raw)); } catch { /* storage blocked */ }
  }, [init]);

  // A reply's account is fixed by the thread; changing it would be the cross-account mistake we're preventing.
  const locked = !!init.threadId;
  const account = accounts?.find(a => a.id === accountId);
  const shared = !!account && !account.owned;
  const fromAddress = fromAlias || account?.email || "";
  const cantSend = !!account && (!account.capabilities.send || account.readOnly || (!account.owned && !account.canSend));
  const signatures: Signature[] = (prefs?.signatures ?? []).filter((s: Signature) => s.accountId === accountId);
  const signature = chosenSig === null ? (useDefaultSig ? signatures.find(s => s.isDefault) : undefined) : signatures.find(s => s.id === chosenSig);
  const known = useApi<{ address: string }[]>(["contacts"], forwarding ? "/contacts" : null, { staleTime: 60_000 });

  const toList = parseAddresses(to), ccList = parseAddresses(cc), bccList = parseAddresses(bcc);
  const invalidTo = toList.filter(a => !looksValid(a)), invalidCc = ccList.filter(a => !looksValid(a)), invalidBcc = bccList.filter(a => !looksValid(a));
  const allValid = !invalidTo.length && !invalidCc.length && !invalidBcc.length;
  const composed = () => [body, signature ? `-- \n${signature.text}` : "", quoted].filter(Boolean).join("\n\n");
  const payload = () => ({ id: draftKey.current, accountId, threadId: init.threadId, to: toList, cc: ccList, bcc: bccList, subject, text: composed(), aiGenerated: !!init.aiGenerated, fromAlias: fromAlias || undefined });

  const save = async () => {
    if (!accountId || !allValid) return draftId;
    if (!navigator.onLine) { try { sessionStorage.setItem(LOCAL_KEY, JSON.stringify(payload())); } catch { /* storage blocked */ } setSaved("local"); return draftId; }
    setSaved("saving");
    try {
      const r = await api<{ id: string }>("/drafts", { body: payload() });
      setDraftId(r.id); setSaved("saved"); dirty.current = false;
      try { sessionStorage.removeItem(LOCAL_KEY); } catch { /* storage blocked */ }
      return r.id;
    } catch { setSaved("idle"); return draftId; }
  };
  useEffect(() => {
    if (!dirty.current || (isEmpty() && !draftId)) return;
    const t = setTimeout(() => void save(), 1500);
    return () => clearTimeout(t);
  }, [to, cc, bcc, subject, body, quoted, accountId, fromAlias, chosenSig, online]); // eslint-disable-line
  const touch = <T,>(setter: (v: T) => void) => (v: T) => { dirty.current = true; setter(v); };
  // Like Gmail: a new message closed with nothing in it isn't kept as a draft, and one emptied out is removed.
  const isEmpty = () => !init.threadId && !toList.length && !ccList.length && !bccList.length && !subject.trim() && !body.trim() && !files.length;
  const close = () => {
    if (isEmpty()) { if (draftId) void api(`/drafts/${draftId}`, { method: "DELETE" }).catch(() => {}).finally(refresh); onClose(); return; }
    // A reply opened and closed without a keystroke isn't a draft either.
    if (!dirty.current && !draftId) { onClose(); return; }
    void save().finally(refresh); onClose();
  };
  useEscape(close, !mini && !confirmRisk && schedule === null, 2);

  const send = async (ack = false, when?: string) => {
    setError(null);
    if (!navigator.onLine) { setError("You're offline. This draft is kept on this device and will not send until you reconnect and press Send."); return; }
    if (!account) { setError("Choose an account to send from."); return; }
    if (!toList.length) { setError("Add at least one recipient."); return; }
    if (!allValid) { setError("One of those addresses doesn't look right. Fix it to send."); return; }
    setBusy(true);
    try {
      const id = await save();
      if (!id) throw new ApiError(400, "invalid", "Couldn't save this draft, so it wasn't sent. Check the addresses and try again.");
      // The address displayed to the user goes with the request; the server refuses a mismatch.
      const r = await api<{ scheduledFor: string | null }>(`/drafts/${id}/send`, { body: { expectedFrom: fromAddress, idempotencyKey: idemKey.current, acknowledgedRisk: ack, scheduledFor: when } });
      toast({ text: r.scheduledFor ? `Scheduled from ${fromAddress}.` : `Sending from ${fromAddress}. If your provider refuses it, it comes back to Drafts.` });
      refresh();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "risk_acknowledgement_required") setConfirmRisk(true);
      else setError(e instanceof ApiError ? e.message : "Couldn't send.");
    } finally { setBusy(false); }
  };

  const discard = async () => {
    if (draftId) await api(`/drafts/${draftId}`, { method: "DELETE" }).catch(() => {});
    refresh(); onClose();
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    const used = files.reduce((s, f) => s + f.size, 0), adding = [...list].reduce((s, f) => s + f.size, 0);
    if (used + adding > MAX_FILES_BYTES) { setError("Attachments on one message can total at most 3 MB."); return; }
    if (!allValid) { setError("Fix the addresses first. The draft has to save before it can hold a file."); return; }
    setUploading(true);
    try {
      const id = await save();
      if (!id) throw new ApiError(400, "invalid", "Couldn't save this draft, so the file wasn't added.");
      for (const f of list) {
        const r = await api<{ attachments: DraftFile[] }>(`/drafts/${id}/attachments`, { body: { filename: f.name, contentType: f.type || undefined, dataBase64: await readBase64(f) } });
        setFiles(r.attachments);
      }
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't add that file."); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ""; }
  };
  const removeFile = async (id: string) => {
    if (!draftId) return;
    try { const r = await api<{ attachments: DraftFile[] }>(`/drafts/${draftId}/attachments/${id}`, { method: "DELETE" }); setFiles(r.attachments); }
    catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't remove that file."); }
  };

  /** The file's own switch: on copies it into the draft on the server, off removes it. The draft is what gets sent. */
  const includeOriginals = async (ids: string[]) => {
    if (!init.original || !ids.length) return;
    setError(null);
    if (!allValid) { setError("Fix the addresses first. The draft has to save before it can hold a file."); return; }
    setUploading(true);
    try {
      const id = await save();
      if (!id) throw new ApiError(400, "invalid", "Couldn't save this draft, so the file wasn't added.");
      const r = await api<{ attachments: DraftFile[] }>(`/drafts/${id}/attachments/from-message`, { body: { messageId: init.original.messageId, attachmentIds: ids } });
      setFiles(r.attachments);
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't add that file."); }
    finally { setUploading(false); }
  };
  // On unless the message is flagged. Off and explained if the files can't all fit, since choosing which is the person's call.
  const originalsFlagged = !!init.flaggedLabel;
  const eligibleOriginals = originals.filter(f => !whyNotForwardable(f, init.original?.label));
  const originalsOverLimit = eligibleOriginals.reduce((s, f) => s + f.size, 0) > MAX_FILES_BYTES;
  useEffect(() => {
    if (copiedDefaults.current || !init.original || !accountId || cantSend || !account) return;
    copiedDefaults.current = true;
    if (!originalsFlagged && !originalsOverLimit) void includeOriginals(eligibleOriginals.map(f => f.id));
  }, [accountId, account, cantSend]); // eslint-disable-line

  const unfamiliar = forwarding && known.data ? toList.concat(ccList, bccList).filter(a => looksValid(a) && !known.data!.some(c => c.address.toLowerCase() === a.toLowerCase())) : [];
  const external = forwarding && account ? toList.concat(ccList, bccList).filter(a => looksValid(a) && domainOf(a) !== domainOf(account.email)) : [];
  const title = forwarding ? "Forward" : init.threadId ? "Reply" : "New message";

  if (mini) return <button onClick={() => setMini(false)} className="fixed right-4 bottom-0 z-30 flex h-10 w-72 max-w-[calc(100vw-2rem)] items-center justify-between rounded-t-lg bg-ink px-3 text-sm text-bg shadow-soft print:hidden"><span className="truncate">{subject || title}</span><span className="text-xs opacity-70">{saved === "saved" ? "Saved" : ""}</span></button>;

  const box = (
    <div role="dialog" aria-label="Compose message" data-inline={slot ? "true" : undefined} className={slot ? "relative flex flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_1px_3px_rgb(0_0_0/.18),0_6px_24px_rgb(0_0_0/.08)] print:hidden" : "fixed inset-0 z-30 flex flex-col overflow-hidden bg-surface sm:inset-auto sm:right-6 sm:bottom-0 sm:h-[min(40rem,88dvh)] sm:w-[37rem] sm:rounded-t-2xl sm:shadow-[0_8px_40px_rgb(0_0_0/.28)] print:hidden"}>
      <div className={`flex items-center justify-between gap-2 py-1.5 pr-2 pl-4 ${slot ? "" : "bg-surface-2"}`}>
        <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">{slot ? <Reply className="size-4 text-muted" aria-hidden /> : null}{title === "New message" ? "New Message" : title}{init.aiGenerated && <Chip tone="accent"><Lightbulb className="size-3" aria-hidden />Suggested draft, edit before sending</Chip>}</span>
        <span className="flex shrink-0"><IconButton icon={Minus} label="Minimize" onClick={() => setMini(true)} /><IconButton icon={X} label="Close (draft is saved)" onClick={close} /></span>
      </div>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-auto">
        {restorable && <div className="p-2"><Banner tone="info" action={<span className="flex gap-2"><Button size="sm" onClick={() => { dirty.current = true; setTo((restorable.to ?? []).join(", ")); setSubject(restorable.subject ?? ""); setBody(restorable.text ?? ""); if (restorable.accountId) setAccountId(restorable.accountId); setRestorable(null); }}>Restore</Button><Button size="sm" variant="ghost" onClick={() => { try { sessionStorage.removeItem(LOCAL_KEY); } catch { /* storage blocked */ } setRestorable(null); }}>Discard</Button></span>}>You have a draft you wrote while offline, kept on this device.</Banner></div>}
        {/* The sending identity is always visible and always explicit. */}
        <label className="mx-4 flex items-center gap-2 border-b border-line py-2.5 text-sm">
          <span className="shrink-0 text-muted">From</span>
          {locked && !account?.aliases.length
            ? <span className="flex min-w-0 items-center gap-2 font-medium"><span className="size-2 shrink-0 rounded-full" style={{ background: account?.color }} aria-hidden /><span className="truncate">{account?.displayName} &lt;{account?.email}&gt;</span></span>
            : (
              <select value={`${accountId}|${fromAlias}`} onChange={e => { const [id, alias] = e.target.value.split("|"); dirty.current = true; if (id !== accountId) setChosenSig(null); setAccountId(id ?? ""); setFromAlias(alias ?? ""); }} className="min-w-0 flex-1 truncate bg-transparent font-medium text-ellipsis outline-none">
                {(locked ? sendable.filter(a => a.id === accountId) : sendable).flatMap(a => [
                  <option key={a.id} value={`${a.id}|`}>{a.displayName} &lt;{a.email}&gt;{a.simulated ? " (demo)" : ""}{a.owned ? "" : " (shared, sends as owner)"}</option>,
                  ...a.aliases.map(al => <option key={`${a.id}|${al.address}`} value={`${a.id}|${al.address}`}>{al.name ? `${al.name} ` : `${a.displayName} `}&lt;{al.address}&gt; (alias)</option>),
                ])}
              </select>
            )}
        </label>
        {shared && !cantSend && <div className="p-2"><Banner tone="info" icon={Users}>You're sending from a shared mailbox. This goes out from <strong className="font-semibold">{fromAddress}</strong> under its owner's name, not from your own address. It's recorded in the audit log.</Banner></div>}
        {fromAlias && <div className="p-2"><Banner tone="neutral">Sending as an alias. It has to be set up at your mail provider, which may refuse it or replace it with {account?.email}.</Banner></div>}
        {sendable.length === 0 && !locked && <div className="p-2"><Banner tone="warn">None of your connected accounts can send. Read-only and POP3 connections can't send mail, and a shared mailbox can only send if its owner allowed it.</Banner></div>}
        {cantSend && <div className="p-2"><Banner tone="warn">{account?.displayName} can't send: {account?.readOnly ? "it's connected read-only" : !account?.capabilities.send ? "it's an import-only connection" : "its owner shared it for reading only"}.</Banner></div>}
        <AddressRow label="To" value={to} onChange={touch(setTo)} invalid={invalidTo} autoFocus={!init.to?.length} action={!showCc ? <button type="button" className="shrink-0 text-sm text-muted hover:text-ink" onClick={() => setShowCc(true)}>Cc Bcc</button> : undefined} />
        {showCc && <AddressRow label="Cc" value={cc} onChange={touch(setCc)} invalid={invalidCc} />}
        {showCc && <AddressRow label="Bcc" value={bcc} onChange={touch(setBcc)} invalid={invalidBcc} />}
        {!(slot && init.threadId && !forwarding) && <label className="mx-4 flex items-center gap-2 border-b border-line py-2.5 text-sm focus-within:border-line-strong"><span className="sr-only">Subject</span><input value={subject} onChange={e => touch(setSubject)(e.target.value)} placeholder="Subject" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted focus-visible:outline-none" /></label>}
        {!!init.unfamiliarRecipients?.length && <div className="p-2"><Banner tone="warn">Not previously in this conversation: {init.unfamiliarRecipients.join(", ")}</Banner></div>}
        {init.flaggedThread && !forwarding && <div className="p-2"><Banner tone="danger" icon={ShieldAlert}>This conversation was flagged as suspicious. Check the sender before replying, and verify any payment details by phone using a number you already have.</Banner></div>}
        {forwarding && init.flaggedLabel && <div className="p-2"><Banner tone="danger" icon={ShieldAlert}>You're forwarding a message rated {init.flaggedLabel}. Anyone who receives it can click what's in it. Say why you're sending it, and don't forward it to anyone who might act on it.</Banner></div>}
        {forwarding && unfamiliar.length > 0 && <div className="p-2" data-testid="recipient-warning"><Banner tone="warn">You haven't exchanged mail with {unfamiliar.join(", ")}. Check the address before this leaves your mailbox.</Banner></div>}
        {forwarding && external.length > 0 && !unfamiliar.length && <div className="p-2"><Banner tone="neutral">Outside {domainOf(account?.email ?? "")}: {external.join(", ")}.</Banner></div>}
        {init.aiGenerated && (init.provider || !!init.assumptions?.length || !!init.issues?.length) && (
          <div className="space-y-1 border-b border-line bg-surface-2 px-3 py-2 text-xs text-muted">
            <div>{init.hosted ? "Written by a hosted AI model, using this conversation." : "Written by on-device rules. No content left this deployment."}</div>
            {init.assumptions?.map(a => <div key={a}>Assumption: {a}</div>)}
            {init.issues?.map(i => <div key={i.code} className="font-medium text-warn">Check: {i.message}</div>)}
          </div>
        )}
        <textarea value={body} onChange={e => touch(setBody)(e.target.value)} aria-label="Message body" autoFocus={!!init.to?.length} rows={8} className="min-h-56 w-full flex-1 resize-none bg-transparent px-4 py-3 text-[15px] leading-relaxed outline-none focus-visible:outline-none" placeholder={forwarding ? "Add a note above the forwarded message" : "Write your message"} />
        {signatures.length > 0 && (
          <div className="border-t border-line px-3 py-1.5 text-[13px]">
            <label className="flex flex-wrap items-center gap-2"><span className="text-muted">Signature</span><select value={signature?.id ?? ""} onChange={e => touch(setChosenSig)(e.target.value)} className="min-w-0 bg-transparent font-medium outline-none"><option value="">None</option>{signatures.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            {signature && <p className="mt-1 text-xs whitespace-pre-wrap text-muted" data-testid="signature-preview">{signature.text}</p>}
          </div>
        )}
        {quoted && (
          <details className="border-t border-line px-3 py-1.5 text-[13px]" open>
            <summary className="cursor-pointer text-muted">Forwarded message, included as text</summary>
            <pre tabIndex={0} data-testid="quoted-original" className="scroll-thin mt-1 max-h-48 overflow-auto rounded-lg bg-surface-2 p-2 font-sans text-xs whitespace-pre-wrap break-words">{quoted}</pre>
            <Button size="sm" variant="ghost" className="mt-1" onClick={() => { dirty.current = true; setQuoted(""); }}>Remove it</Button>
          </details>
        )}
        {originals.length > 0 && (
          <fieldset className="border-t border-line px-3 py-2" data-testid="original-attachments">
            <legend className="float-left mb-1 w-full text-[13px] text-muted">Attachments on the original. Only the ones you leave on are sent.</legend>
            {originalsFlagged && eligibleOriginals.length > 0 && <p className="clear-both mb-1 text-xs font-medium text-warn">This message couldn't be fully checked, so these start off. Turn one on only if you trust it.</p>}
            {!originalsFlagged && originalsOverLimit && <p className="clear-both mb-1 text-xs font-medium text-warn">Together these are over the 3 MB limit for one message, so they start off. Choose which to include.</p>}
            <ul className="clear-both space-y-1">
              {originals.map(f => {
                const why = whyNotForwardable(f, init.original?.label);
                const copy = files.find(x => x.sourceAttachmentId === f.id);
                return (
                  <li key={f.id} className="text-[13px]" data-testid="original-attachment">
                    <label className={`flex min-h-6 items-center gap-2 ${why ? "text-muted" : "cursor-pointer"}`}>
                      <input type="checkbox" className="size-4 shrink-0 accent-[var(--accent)]" checked={!!copy} disabled={!!why || uploading || !online || cantSend} onChange={() => { if (copy) void removeFile(copy.id); else void includeOriginals([f.id]); }} aria-label={`Include ${f.filename}`} />
                      <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 truncate">{f.filename}</span>
                      <span className="shrink-0 text-xs text-muted">{fmtSize(f.size)}</span>
                    </label>
                    {why ? <p className="pl-6 text-xs text-muted">{why}</p> : f.scan === "not_scanned" ? <p className="pl-6 text-xs text-muted">Baseline checks only: not scanned by an antivirus engine</p> : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {files.some(f => !originals.some(o => o.id === f.sourceAttachmentId)) && (
          <ul className="flex flex-wrap gap-2 border-t border-line px-3 py-2" aria-label="Attachments">
            {files.filter(f => !originals.some(o => o.id === f.sourceAttachmentId)).map(f => <li key={f.id} className="flex items-center gap-1.5 rounded-lg border border-line py-0.5 pr-0.5 pl-2 text-[13px]"><FileText className="size-3.5 shrink-0 text-muted" aria-hidden /><span className="max-w-44 truncate">{f.filename}</span><span className="text-xs text-muted">{fmtSize(f.size)}</span><IconButton icon={X} label={`Remove ${f.filename}`} onClick={() => void removeFile(f.id)} /></li>)}
          </ul>
        )}
      </div>
      {error && <div className="px-3 pt-2"><Banner tone="danger">{error}</Banner></div>}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-2 pb-3">
        <Button variant="primary" className="!h-10 !rounded-full !px-6" loading={busy} disabled={!online || !account || cantSend || uploading} onClick={() => send()}>Send</Button>
        <Button variant="ghost" icon={Clock} className="!rounded-full" onClick={() => setSchedule(localDateTime(new Date(Date.now() + 3600e3 * 18)))} disabled={!online || !account || cantSend || uploading}>Schedule</Button>
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={e => void addFiles(e.target.files)} />
        <IconButton icon={Paperclip} label="Attach files, up to 3 MB in total" disabled={!online || !account || cantSend || uploading} onClick={() => fileInput.current?.click()} />
        <span className="min-w-0 flex-1 basis-40 text-xs text-muted" aria-live="polite">{account && <>Sends from <strong className="font-medium break-all text-ink">{fromAddress}</strong>{shared ? " as its owner" : ""}</>}{uploading ? " · Adding file" : saved === "saved" ? " · Draft saved" : saved === "saving" ? " · Saving" : saved === "local" ? " · Kept on this device" : ""}</span>
        <IconButton icon={Trash2} label="Discard draft" onClick={discard} />
      </div>
      {confirmRisk && <Modal title="Reply to a flagged conversation?" onClose={() => setConfirmRisk(false)} footer={<><Button onClick={() => setConfirmRisk(false)}>Go back</Button><Button variant="danger" onClick={() => { setConfirmRisk(false); void send(true); }}>Send anyway</Button></>}><p className="text-sm">This conversation has been flagged as possible phishing or fraud. Replying confirms your address is active and may expose information. Verify through another channel if you can.</p></Modal>}
      {schedule !== null && <Modal title="Schedule send" onClose={() => setSchedule(null)} footer={<><Button onClick={() => setSchedule(null)}>Cancel</Button><Button variant="primary" disabled={!schedule || Number.isNaN(new Date(schedule).getTime())} onClick={() => { const at = new Date(schedule); if (Number.isNaN(at.getTime())) return; setSchedule(null); void send(false, at.toISOString()); }}>Schedule</Button></>}><label className="block text-sm"><span className="mb-1 block font-medium">Send at</span><input type="datetime-local" className={inputClass} value={schedule} min={localDateTime(new Date())} onChange={e => setSchedule(e.target.value)} /></label><p className="mt-2 text-xs text-muted">From {fromAddress}. Your approval is recorded now, and you can cancel any time before then from Scheduled.</p></Modal>}
    </div>
  );
  return slot ? createPortal(box, slot) : box;
}
