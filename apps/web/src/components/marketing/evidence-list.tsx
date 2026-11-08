import { ArrowDown, ArrowUp, Info } from "lucide-react";
import { SOURCE_LABEL, type DemoEvidence } from "./demo-data";

const DIR = {
  raises: { icon: ArrowUp, label: "Raises risk", tone: "text-danger" },
  lowers: { icon: ArrowDown, label: "Lowers risk", tone: "text-safe" },
  note: { icon: Info, label: "For information", tone: "text-info" },
} as const;

/** Each entry states its direction and source in words. Color only reinforces it. */
export function EvidenceList({ items, label }: { items: DemoEvidence[]; label: string }) {
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {items.map(e => {
        const d = DIR[e.direction];
        const I = d.icon;
        return (
          <li key={e.code} className="py-2.5 first:pt-0 last:pb-0">
            <p className="flex flex-wrap items-center gap-x-2 text-xs font-medium text-muted">
              <span className={`inline-flex items-center gap-1 ${d.tone}`}><I className="size-3" aria-hidden />{d.label}</span>
              <span aria-hidden>·</span>
              <span>{SOURCE_LABEL[e.source]}</span>
            </p>
            <p className="mt-0.5 text-sm leading-snug [overflow-wrap:anywhere]">{e.text}</p>
          </li>
        );
      })}
    </ul>
  );
}
