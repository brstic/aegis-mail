"use client";
import { useEffect, useState } from "react";
import { FOCUS_MESSAGES, SECTIONS } from "@/components/marketing/demo-data";
import { ACTION_LABEL, EVIDENCE, LAYERS, RISK_LABEL, WEIGHT_NAMES, XRAY_STAGES, type LayerId, type XrayStage } from "../data/content";
import { film } from "../store";

/** Every interaction in the world, as ordinary controls. These work with a keyboard, a screen reader and no WebGL. */

function useWorldEvent<T>(name: string, on: (detail: T) => void) {
  useEffect(() => {
    const h = (e: Event) => on((e as CustomEvent<T>).detail);
    window.addEventListener(name, h);
    return () => window.removeEventListener(name, h);
  }, [name, on]);
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

export function AutopsyPanel() {
  const [sel, setSel] = useState<LayerId>("sender");
  useEffect(() => { film.controls.inspect = sel; }, [sel]);
  useWorldEvent<string>("film:inspect", d => { if (LAYERS.some(l => l.id === d)) setSel(d as LayerId); });
  const l = LAYERS.find(x => x.id === sel)!;
  return (
    <>
      <div className="film-controls" role="group" aria-label="Layers of the letter">
        {LAYERS.map(x => <button key={x.id} type="button" className="film-btn" aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>{x.title}</button>)}
      </div>
      <div className="film-readout" aria-live="polite">
        {l.ask}
        {l.found[0] && <ul className="film-list"><li key={l.found[0].code}><b className="tabular-nums">{signed(l.found[0].weight)}</b><span>{WEIGHT_NAMES[l.found[0].code] ?? l.found[0].code}</span></li></ul>}
      </div>
      {LAYERS.map(x => (
        <button key={x.id} type="button" tabIndex={-1} aria-hidden="true" className="film-tag" data-anchor={`au-${x.id}`} data-side="right" aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>
          {x.title}<small>{x.short}</small>
        </button>
      ))}
    </>
  );
}

export function UvPanel() {
  const [all, setAll] = useState(false);
  const [found, setFound] = useState(false);
  useEffect(() => { film.controls.inspect = all ? "uv-all" : ""; }, [all]);
  useWorldEvent<void>("film:uv-found", () => setFound(true));
  const i = EVIDENCE.injection;
  const show = all || found;
  return (
    <>
      <div className="film-controls"><button type="button" className="film-btn" aria-pressed={all} onClick={() => setAll(v => !v)}>Light the whole page</button></div>
      <div className={`film-readout${show ? " bad" : ""}`} aria-live="polite">
        {show ? <>
          <p className="!mt-0 !text-sm !text-ink font-mono [overflow-wrap:anywhere]">&ldquo;{i.hidden}&rdquo;</p>
          <p className="!mt-2 !text-sm">{i.evidence[0]?.explanation} Rated <b>{RISK_LABEL[i.label]?.toLowerCase()}</b> by the engine.</p>
        </> : <>Nothing you can see on this page says anything unusual.</>}
      </div>
    </>
  );
}

export function ScalePanel() {
  const [idx, setIdx] = useState(1);
  const [all, setAll] = useState(false);
  useEffect(() => { film.controls.sample = idx; }, [idx]);
  const s = EVIDENCE.samples[idx]!;
  const bad = s.label !== "safe";
  return (
    <>
      <div className="film-controls" role="group" aria-label="Choose a synthetic message">
        {EVIDENCE.samples.map((x, i) => <button key={x.id} type="button" className="film-btn" aria-pressed={i === idx} onClick={() => setIdx(i)}>{x.pick}</button>)}
      </div>
      <div className={`film-readout${bad ? " bad" : ""}`} aria-live="polite">
        <b>{RISK_LABEL[s.label] ?? s.label}.</b> {ACTION_LABEL[s.action] ?? s.action}.
        <ul className="film-list">
          {s.evidence.slice(0, all ? undefined : 3).map(e => <li key={e.code}><b className="tabular-nums">{signed(e.weight)}</b><span>{WEIGHT_NAMES[e.code] ?? e.code}</span></li>)}
        </ul>
        {s.evidence.length > 3 && <button type="button" className="film-sheet-btn !mt-2" aria-expanded={all} onClick={() => setAll(v => !v)}>{all ? "Show fewer" : `Show all ${s.evidence.length}`}</button>}
      </div>
    </>
  );
}

export function CasePanel() {
  const [released, setReleased] = useState(false);
  useEffect(() => { film.controls.released = released; }, [released]);
  return (
    <>
      <div className="film-controls">
        <button type="button" className="film-btn" aria-pressed={released} onClick={() => setReleased(v => !v)}>{released ? "Hold it again" : "Release it"}</button>
      </div>
      <p className="film-readout" aria-live="polite">{released ? "Back on your desk, and the slip records who released it and when. In a workspace with an approval policy, this can be a request instead." : "Held. You can read it in safety here, and nothing in it runs or loads."}</p>
    </>
  );
}

export function FocusPanel() {
  const [sel, setSel] = useState(FOCUS_MESSAGES[0]!.id);
  const [shelfOf, setShelfOf] = useState<Record<string, number>>({});
  useEffect(() => { film.controls.inspect = `focus-${sel}`; }, [sel]);
  useEffect(() => { film.controls.shelfOf = shelfOf; }, [shelfOf]);
  useWorldEvent<string>("film:inspect", d => { if (d.startsWith("focus-")) setSel(d.slice(6)); });
  useWorldEvent<{ id: string; shelf: number }>("film:shelf", d => setShelfOf(v => ({ ...v, [d.id]: d.shelf })));
  const m = FOCUS_MESSAGES.find(x => x.id === sel)!;
  const order = ["needs_attention", "todays_commitments", "important_people", "low_priority"];
  const base = order.indexOf(m.section);
  const at = shelfOf[m.id] ?? base;
  const flagged = m.section === "security_review";
  const move = (by: number) => setShelfOf(v => ({ ...v, [m.id]: Math.min(3, Math.max(0, at + by)) }));
  return (
    <>
      <div className="film-controls" role="group" aria-label="Choose a letter">
        {FOCUS_MESSAGES.slice(0, 4).map(x => <button key={x.id} type="button" className="film-btn" aria-pressed={x.id === sel} onClick={() => setSel(x.id)}>{x.fromName}</button>)}
      </div>
      <div className={`film-readout${flagged ? " bad" : ""}`} aria-live="polite">
        <b>{SECTIONS.find(s => s.key === (flagged ? "security_review" : order[at]))?.label}.</b> {m.reasons[0]}
        {m.reasons.length > 1 && <span> {m.reasons.slice(1).join(" ")}</span>}
      </div>
      {flagged
        ? <p className="fine">Flagged mail stays out of the order, however urgently it&apos;s worded.</p>
        : <div className="film-controls"><button type="button" className="film-btn" onClick={() => move(-1)} disabled={at === 0}>Move up</button><button type="button" className="film-btn" onClick={() => move(1)} disabled={at === 3}>Move down</button></div>}
    </>
  );
}

export function GlassPanel() {
  const [note, setNote] = useState<"none" | "model" | "you">("none");
  const [pulled, setPulled] = useState(false);
  useEffect(() => { film.controls.leverPulled = pulled; }, [pulled]);
  return (
    <>
      <div className="film-controls">
        <button type="button" className="film-btn" onClick={() => { film.controls.glassKnock = film.time || 0.001; setNote("model"); }}>Tell the model to send it</button>
        <button type="button" className="film-btn" aria-pressed={pulled} onClick={() => { setPulled(v => !v); setNote("you"); }}>{pulled ? "Undo" : "Approve and send"}</button>
      </div>
      <p className="film-readout" aria-live="polite">
        {note === "model" ? "Nothing happens. This isn't a rule the model is asked to follow: it has no send tool to call, so there's nothing a clever email could talk it into." : note === "you" ? (pulled ? "That's you. Sending happens outside the model, and only after your approval." : "Taken back before it left.") : "The draft is only text. Try each."}
      </p>
    </>
  );
}

export function VaultPanel() {
  const [gone, setGone] = useState(false);
  useEffect(() => { film.controls.shredded = gone; }, [gone]);
  return (
    <>
      <div className="film-controls">
        <button type="button" className="film-btn danger" aria-pressed={gone} onClick={() => setGone(v => !v)}>{gone ? "Bring the key back" : "Destroy the key"}</button>
      </div>
      <p className={`film-readout${gone ? " bad" : ""}`} aria-live="polite">
        {gone ? "Without the key, what's stored is noise. A backup from before the deletion is different: it's still readable with the root key until it expires, and a restore re-applies the deletion from a log." : "The page is sealed under the workspace's key, and that key is sealed under the root key."}
      </p>
    </>
  );
}

export function XrayPanel() {
  const [sel, setSel] = useState<XrayStage>("file");
  useEffect(() => { film.controls.inspect = `xray-${sel}`; }, [sel]);
  useWorldEvent<XrayStage>("film:xray", setSel);
  const st = XRAY_STAGES.find(x => x.id === sel)!;
  const x = EVIDENCE.xray;
  const top = x.evidence[0];
  return (
    <>
      <div className="film-controls" role="group" aria-label="Stages of the inspection">
        {XRAY_STAGES.map(v => <button key={v.id} type="button" className="film-btn" aria-pressed={v.id === sel} onClick={() => setSel(v.id)}>{v.title}</button>)}
      </div>
      <div className={`film-readout${sel === "verdict" ? " bad" : ""}`} aria-live="polite">
        {sel === "verdict" && top ? <>
          <b>{RISK_LABEL[x.label] ?? x.label}. {ACTION_LABEL[x.action] ?? x.action}.</b> {top.explanation}
          <p className="!mt-2 !mb-0 !text-sm font-mono [overflow-wrap:anywhere]">{x.code}</p>
        </> : <>{st.body}</>}
      </div>
    </>
  );
}
