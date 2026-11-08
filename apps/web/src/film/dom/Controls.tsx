"use client";
import { ProviderIcon } from "@/components/marketing/provider-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { film } from "../store";

/** A control that writes to the film. Every interaction in the world has one of these, so nothing needs a pointer or WebGL. */
export function SourceToggles() {
  const [on, setOn] = useState([true, true, true]);
  const names = ["Gmail", "Outlook", "iCloud & IMAP"];
  const icons: ("gmail" | "outlook" | "icloud" | "imap")[][] = [["gmail"], ["outlook"], ["icloud", "imap"]];
  useEffect(() => { film.controls.sources = on; }, [on]);
  return (
    <div className="film-controls" role="group" aria-label="Mail sources in this picture">
      {names.map((n, i) => <button key={n} type="button" className="film-btn source" aria-pressed={on[i]} onClick={() => setOn(v => v.map((x, j) => (j === i ? !x : x)))}>{icons[i]!.map(k => <ProviderIcon key={k} kind={k} />)}{n}</button>)}
    </div>
  );
}

const SENDERS = [
  { id: "real", label: "The real sender", bad: false, text: <>From <b>acme-supplies.example</b>, and sent by it. All three checks agree. That confirms who sent it, not that what it says is honest.</> },
  { id: "spoofed", label: "Faking the domain", bad: true, text: <>It says <b>acme-supplies.example</b> but didn&apos;t come from there. SPF, DKIM and DMARC all fail, and the seals crack. This one is easy.</> },
  { id: "lookalike", label: "A lookalike domain", bad: true, text: <>From <b>acme-suppl1es.example</b>, with a 1 for the i. Every seal holds, because it really is that domain. So seals alone aren&apos;t enough: this has to be caught by comparing it with who you already write to.</> },
] as const;

export function SenderChoice() {
  const [id, setId] = useState<(typeof SENDERS)[number]["id"]>("real");
  useEffect(() => { film.controls.sender = id; }, [id]);
  const s = SENDERS.find(x => x.id === id)!;
  return (
    <>
      <div className="film-controls" role="group" aria-label="Who sent this letter">
        {SENDERS.map(x => <button key={x.id} type="button" className={`film-btn${x.bad ? " danger" : ""}`} aria-pressed={x.id === id} onClick={() => setId(x.id)}>{x.label}</button>)}
      </div>
      <p className={`film-readout${s.bad ? " bad" : ""}`} aria-live="polite">{s.text}</p>
    </>
  );
}

/** "Read the detail": everything the short copy leaves out, for anyone who wants it. Native dialog, so focus and Escape just work. */
export function DetailSheet({ label = "Read the detail", title, children }: { label?: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" className="film-sheet-btn" onClick={() => ref.current?.showModal()}>{label}</button>
      <dialog ref={ref} className="film-sheet" onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
        <div className="flex items-start justify-between gap-4">
          <h3>{title}</h3>
          <button type="button" aria-label="Close" className="film-btn" onClick={() => ref.current?.close()}>Close</button>
        </div>
        {children}
      </dialog>
    </>
  );
}
