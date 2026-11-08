import { findLookalike, registrableDomain, URL_SHORTENERS } from "@aegis/security-engine/domains";

export interface LinkFinding { kind: "lookalike" | "mismatch" | "scheme" | "shortener" | "userinfo"; message: string }

const SHOWN = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/\s]|$)/i;

/** Pure and local: never fetches the URL. Webmail often wraps links, so a redirector host alone isn't reported. */
export function checkLink(href: string, text: string): LinkFinding | null {
  const stripped = href.replace(/[\x00-\x20\x7f]+/g, "");
  if (/^(javascript|data|vbscript):/i.test(stripped)) return { kind: "scheme", message: "This link can run code rather than open a page." };
  let u: URL;
  try { u = new URL(stripped); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (u.username) return { kind: "userinfo", message: `The address is disguised. It really goes to ${host}.` };
  const hit = findLookalike(host);
  if (hit) return { kind: "lookalike", message: `${host} imitates ${hit.brand ?? hit.target}.` };
  const m = text.trim().match(SHOWN);
  if (m && registrableDomain(m[1]!.toLowerCase()) !== registrableDomain(host) && !isWebmailWrapper(host)) return { kind: "mismatch", message: `The link says ${m[1]} but goes to ${host}.` };
  if (URL_SHORTENERS.has(registrableDomain(host))) return { kind: "shortener", message: `${host} hides the real destination.` };
  return null;
}

function isWebmailWrapper(host: string) {
  return /(^|\.)(google\.com|safelinks\.protection\.outlook\.com|yahoo\.com)$/.test(host);
}
