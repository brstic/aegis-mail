export interface DueInfo {
  text: string;
  /** Present only when the phrase resolves to a specific date. */
  iso?: string;
  /** True for vague phrases. Must be confirmed before any calendar action. */
  uncertain: boolean;
  evidence: string;
}

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const MONTH_RE = MONTHS.map(m => `${m}|${m.slice(0, 3)}`).join("|");

const VAGUE = /\b(soon|shortly|asap|as soon as (you can|possible)|when you (can|get a chance)|early next (week|month)|later this (week|month)|end of (the )?(week|month|quarter)|sometime (next|this) \w+|in the coming (days|weeks)|next few days)\b/i;
/** "by Wednesday, November 11" states a deadline. "meets on Friday, November 13" only states an event. */
const DEADLINE_CUE = /\b(by|before|due|deadline|until|no later than|expires?( on)?)\s+((sun|mon|tues|wednes|thurs|fri|satur)day,?\s+)?$/i;
/** Asking for something, so a date in the same sentence is more likely to be the ask's date. */
const ASK = /\b(can you|could you|please|need|let (me|us) know|send|confirm|reply|respond)\b/i;

function sentenceAround(text: string, idx: number, len: number) {
  const start = Math.max(text.lastIndexOf(".", idx) + 1, text.lastIndexOf("\n", idx) + 1, 0);
  const endDot = text.indexOf(".", idx + len), endNl = text.indexOf("\n", idx + len);
  const ends = [endDot, endNl].filter(n => n >= 0);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end + 1).trim().slice(0, 240);
}

function atNoonUtc(y: number, m: number, d: number) { return new Date(Date.UTC(y, m, d, 12)); }

/**
 * Finds the first due-date expression. Never invents precision: "next Tuesday" resolves because it's
 * specific; "soon" and "early next week" come back uncertain with no ISO date.
 */
export function extractDue(text: string, ref: Date): DueInfo | null {
  const t = text.slice(0, 20_000);
  // rank: 3 stated deadline, 2 date inside a request, 1 any other date (an event, say), 0 vague.
  const candidates: { idx: number; info: DueInfo; rank: number }[] = [];
  const rankFor = (idx: number, len: number, deadline: boolean) => deadline ? 3 : ASK.test(sentenceAround(t, idx, len)) ? 2 : 1;

  for (const m of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi"))) {
    const mi = MONTHS.findIndex(x => x.startsWith(m[1]!.toLowerCase().slice(0, 3)));
    const day = Number(m[2]);
    if (mi < 0 || day < 1 || day > 31) continue;
    let y = m[3] ? Number(m[3]) : ref.getUTCFullYear();
    let d = atNoonUtc(y, mi, day);
    if (d.getUTCMonth() !== mi) continue;
    // Bare dates more than 2 months past probably mean next year.
    if (!m[3] && d.getTime() < ref.getTime() - 60 * 864e5) { y++; d = atNoonUtc(y, mi, day); }
    const before = t.slice(Math.max(0, m.index - 16), m.index);
    candidates.push({ idx: m.index, rank: rankFor(m.index, m[0].length, DEADLINE_CUE.test(before)), info: { text: m[0], iso: d.toISOString(), uncertain: false, evidence: sentenceAround(t, m.index, m[0].length) } });
  }
  for (const m of t.matchAll(/\b(by|before|due|on)\s+(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const dow = DAYS.indexOf(m[3]!.toLowerCase());
    let add = (dow - ref.getUTCDay() + 7) % 7;
    if (add === 0) add = 7;
    if (m[2]) add += add <= 7 && (dow - ref.getUTCDay() + 7) % 7 !== 0 && (dow > ref.getUTCDay()) ? 7 : 0;
    const d = new Date(ref.getTime() + add * 864e5);
    candidates.push({ idx: m.index, rank: rankFor(m.index, m[0].length, !/^on$/i.test(m[1]!)), info: { text: m[0], iso: atNoonUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).toISOString(), uncertain: false, evidence: sentenceAround(t, m.index, m[0].length) } });
  }
  for (const m of t.matchAll(/\b(today|tonight|tomorrow)\b/gi)) {
    // "notes from today" looks back; it isn't a date anyone has to meet.
    if (/\b(from|of|since|earlier)\s+$/i.test(t.slice(Math.max(0, m.index - 8), m.index))) continue;
    const add = m[1]!.toLowerCase() === "tomorrow" ? 1 : 0;
    const d = new Date(ref.getTime() + add * 864e5);
    candidates.push({ idx: m.index, rank: rankFor(m.index, m[0].length, false), info: { text: m[0], iso: atNoonUtc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).toISOString(), uncertain: false, evidence: sentenceAround(t, m.index, m[0].length) } });
  }
  const vague = VAGUE.exec(t);
  if (vague) candidates.push({ idx: vague.index, rank: 0, info: { text: vague[0], uncertain: true, evidence: sentenceAround(t, vague.index, vague[0].length) } });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.rank - a.rank || a.idx - b.idx);
  return candidates[0]!.info;
}
