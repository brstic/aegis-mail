/** Lookalike and homograph analysis. Pure functions; no network. */
import { domainToUnicode } from "node:url";

/** Well-known brands commonly impersonated. Tenant protected domains and known correspondents are added at call time. */
export const BRANDS: { name: string; domains: string[] }[] = [
  { name: "Microsoft", domains: ["microsoft.com", "office.com", "outlook.com", "live.com", "microsoftonline.com", "sharepoint.com", "onedrive.com"] },
  { name: "Google", domains: ["google.com", "gmail.com", "googlemail.com", "youtube.com"] },
  { name: "Apple", domains: ["apple.com", "icloud.com"] },
  { name: "Amazon", domains: ["amazon.com", "amazon.co.uk", "amazon.de", "amazonaws.com", "aws.amazon.com"] },
  { name: "PayPal", domains: ["paypal.com"] },
  { name: "DocuSign", domains: ["docusign.com", "docusign.net"] },
  { name: "Dropbox", domains: ["dropbox.com"] },
  { name: "Adobe", domains: ["adobe.com"] },
  { name: "LinkedIn", domains: ["linkedin.com"] },
  { name: "Netflix", domains: ["netflix.com"] },
  { name: "DHL", domains: ["dhl.com"] },
  { name: "FedEx", domains: ["fedex.com"] },
  { name: "UPS", domains: ["ups.com"] },
  { name: "USPS", domains: ["usps.com"] },
  { name: "IRS", domains: ["irs.gov"] },
  { name: "Stripe", domains: ["stripe.com"] },
  { name: "Slack", domains: ["slack.com"] },
  { name: "Zoom", domains: ["zoom.us"] },
  { name: "Chase", domains: ["chase.com"] },
  { name: "Wells Fargo", domains: ["wellsfargo.com"] },
  { name: "Bank of America", domains: ["bankofamerica.com", "bofa.com"] },
  { name: "Coinbase", domains: ["coinbase.com"] },
  { name: "Okta", domains: ["okta.com"] },
];

const MULTI_LABEL_TLDS = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","net.au","co.jp","co.nz","co.za","com.br","com.mx","co.in","com.sg","com.tr","co.kr"]);

/** Approximate registrable domain. Conservative heuristic rather than the full PSL. */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join(".");
  if (MULTI_LABEL_TLDS.has(last2)) return parts.slice(-3).join(".");
  return last2;
}

export function sameOrganization(a: string, b: string): boolean {
  return !!a && !!b && registrableDomain(a) === registrableDomain(b);
}

/** Damerau-Levenshtein, bounded. Returns max+1 once exceeded. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length > 253 || b.length > 253) return max + 1;
  const m = a.length, n = b.length;
  let prev2: number[] = [], prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[n]!;
}

/** Confusable folding: visually similar Latin digraphs and Cyrillic/Greek homoglyphs. */
const HOMOGLYPHS: Record<string, string> = {
  "а":"a","е":"e","о":"o","р":"p","с":"c","х":"x","у":"y","і":"i","ј":"j","ѕ":"s","һ":"h","ԁ":"d","ɡ":"g","ո":"n","ν":"v","ο":"o","α":"a","ι":"i","κ":"k","ρ":"p","τ":"t","υ":"u","ω":"w",
};
export function skeleton(label: string): string {
  let s = label.toLowerCase().normalize("NFKC");
  s = [...s].map(c => HOMOGLYPHS[c] ?? c).join("");
  return s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/cl/g, "d").replace(/[0]/g, "o").replace(/[1l|!]/g, "i").replace(/[5$]/g, "s").replace(/3/g, "e").replace(/-/g, "");
}

/** Decodes punycode (RFC 3492) labels so homographs can be inspected. */
export function decodeIdnHost(host: string): string {
  try { return domainToUnicode(host) || host; } catch { return host; }
}

export function hasMixedScript(label: string): boolean {
  const scripts = new Set<string>();
  for (const ch of label) {
    if (/[a-z]/i.test(ch)) scripts.add("latin");
    else if (/\p{Script=Cyrillic}/u.test(ch)) scripts.add("cyrillic");
    else if (/\p{Script=Greek}/u.test(ch)) scripts.add("greek");
    else if (/\p{Script=Armenian}/u.test(ch)) scripts.add("armenian");
  }
  return scripts.size > 1;
}
export function isNonLatinConfusable(label: string) { return /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u.test(label); }

export interface LookalikeHit { target: string; brand?: string; kind: "homograph" | "typosquat" | "combosquat" | "subdomain_spoof"; }

/**
 * Does `host` imitate a protected domain without belonging to it?
 * Combosquat: "microsoft-login.com". Subdomain spoof: "paypal.com.evil.test".
 */
export function findLookalike(host: string, extraProtected: string[] = []): LookalikeHit | null {
  const unicodeHost = decodeIdnHost(host.toLowerCase());
  const reg = registrableDomain(unicodeHost);
  const protectedSet = [
    ...extraProtected.map(d => ({ d: registrableDomain(d), brand: undefined as string | undefined })),
    ...BRANDS.flatMap(b => b.domains.map(d => ({ d: registrableDomain(d), brand: b.name as string | undefined }))),
  ];
  const regAscii = registrableDomain(host.toLowerCase());
  // A brand's genuine domains are never lookalikes. A domain that merely got onto a mailbox's known list can't vouch
  // for itself against a brand, or a few messages would teach us to trust paypa1.com.
  if (BRANDS.some(b => b.domains.some(d => { const r = registrableDomain(d); return r === reg || r === regAscii; }))) return null;
  const regLabel = reg.split(".")[0] ?? "";
  const skel = skeleton(regLabel);
  for (const { d, brand } of protectedSet) {
    if (d === reg || d === regAscii) continue;
    const label = d.split(".")[0] ?? "";
    if (label.length < 3) continue;
    const tSkel = skeleton(label);
    if (isNonLatinConfusable(regLabel) && skel === tSkel) return { target: d, brand, kind: "homograph" };
    if (skel === tSkel) return { target: d, brand, kind: "typosquat" };
    if (label.length >= 5) {
      const dist = editDistance(skel, tSkel, 2);
      if (dist > 0 && dist <= (label.length >= 8 ? 2 : 1)) return { target: d, brand, kind: "typosquat" };
    }
    if (label.length >= 5 && skel.includes(tSkel) && skel !== tSkel && /[-]|login|secure|verify|account|support|update|mail|pay|billing|auth|signin|service|portal/.test(regLabel)) {
      return { target: d, brand, kind: "combosquat" };
    }
    if (label.length >= 4 && unicodeHost.startsWith(`${d}.`)) return { target: d, brand, kind: "subdomain_spoof" };
    if (label.length >= 5 && unicodeHost.split(".").slice(0, -2).includes(label)) return { target: d, brand, kind: "subdomain_spoof" };
  }
  return null;
}

export function brandInText(text: string): { name: string; domains: string[] } | null {
  const lower = ` ${text.toLowerCase()} `;
  for (const b of BRANDS) {
    const re = new RegExp(`(^|[^a-z])${b.name.toLowerCase().replace(/ /g, "\\s*")}([^a-z]|$)`);
    if (re.test(lower)) return b;
  }
  return null;
}

export const URL_SHORTENERS = new Set(["bit.ly","tinyurl.com","t.co","goo.gl","ow.ly","is.gd","buff.ly","cutt.ly","rb.gy","shorturl.at","rebrand.ly","t.ly","tiny.cc","lnkd.in"]);
export const SUSPICIOUS_TLDS = new Set(["zip","mov","top","xyz","click","country","stream","gq","cf","tk","ml","ga","work","rest","cam","icu","sbs","cfd","quest","lol"]);
export const FREE_MAIL = new Set(["gmail.com","googlemail.com","outlook.com","hotmail.com","live.com","yahoo.com","aol.com","icloud.com","me.com","proton.me","protonmail.com","gmx.com","mail.com","yandex.com","zoho.com"]);
