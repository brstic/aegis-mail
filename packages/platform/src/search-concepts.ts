/**
 * Concept expansion for search: a small hand-written thesaurus for the things people actually look for in business mail.
 * This is not embedding search. It runs locally on the query only, sends nothing anywhere, and doesn't need new storage,
 * which is why it can be on by default. It widens recall; it can't find a concept outside this list.
 */
const CONCEPTS: string[][] = [
  ["bank", "banking", "iban", "routing", "remittance", "wire", "swift", "account"],
  ["payment", "pay", "paid", "invoice", "remittance", "settle", "settlement", "balance", "billing"],
  ["change", "changed", "changing", "update", "updated", "new", "moved", "switch"],
  ["supplier", "vendor", "supply", "billing", "accounts"],
  ["contract", "agreement", "nda", "retainer", "terms", "redline", "redlines"],
  ["meeting", "call", "appointment", "calendar", "reschedule", "schedule"],
  ["proposal", "quote", "scope", "estimate", "budget"],
  ["deadline", "due", "overdue", "expires", "expiry"],
  ["client", "customer", "account"],
  ["ticket", "booking", "flight", "reservation", "itinerary"],
];
const STOP = new Set(["the", "a", "an", "who", "that", "which", "wanted", "want", "to", "my", "me", "of", "for", "in", "on", "with", "from", "about", "where", "email", "emails", "message", "messages", "mail", "find", "show", "get", "and", "or", "was", "were", "is", "are", "did", "their", "our", "we", "i", "details", "detail"]);

export interface ExpandedQuery { groups: string[][]; expanded: boolean }

/** Each meaningful word becomes a group of alternatives. Words outside the thesaurus stay as themselves. */
export function expandQuery(q: string): ExpandedQuery {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1 && !STOP.has(w)).slice(0, 8);
  let expanded = false;
  const groups = words.map(w => {
    const hits = CONCEPTS.filter(c => c.includes(w));
    if (!hits.length) return [w];
    expanded = true;
    return [...new Set([w, ...hits.flat()])];
  });
  return { groups, expanded };
}

export function conceptTsQuery(q: string): string | null {
  const { groups } = expandQuery(q);
  if (!groups.length) return null;
  const safe = (w: string) => `'${w.replace(/'/g, "")}':*`;
  return groups.map(g => `(${g.map(safe).join(" | ")})`).join(" & ");
}
