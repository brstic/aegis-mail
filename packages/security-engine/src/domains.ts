/** Lookalike and homograph analysis. Pure functions; no network. */
import { domainToUnicode } from "node:url";

export interface Brand {
  name: string;
  /** Domains the brand itself sends mail from. Authenticated mail from one of these is the brand. */
  domains: string[];
  /**
   * Domains the brand owns but that don't prove a message is the brand's: link shorteners, CDNs, and hosts for customers'
   * own content. A link to one isn't a lookalike. Mail from one isn't trusted as the brand either.
   */
  related?: string[];
  /** The brand runs country sites on its own name, such as amazon.ca. Its name under a country code isn't a lookalike. */
  countrySites?: boolean;
}

/** Well-known brands commonly impersonated. Tenant protected domains and known correspondents are added at call time. */
export const BRANDS: Brand[] = [
  { name: "Microsoft", domains: ["microsoft.com", "office.com", "office365.com", "microsoft365.com", "microsoftonline.com", "outlook.com", "live.com", "hotmail.com", "msn.com", "windows.com", "xbox.com", "skype.com", "bing.com", "azure.com", "visualstudio.com", "microsoftstoreemail.com", "microsoftemail.com"],
    related: ["sharepoint.com", "onedrive.com", "onmicrosoft.com", "sharepointonline.com", "windows.net", "azure.net", "azurewebsites.net", "azureedge.net", "live.net", "office.net", "microsoft.net", "aka.ms", "msft.net", "s-microsoft.com", "msecnd.net"] },
  { name: "Google", domains: ["google.com", "gmail.com", "googlemail.com", "youtube.com", "android.com"], countrySites: true,
    related: ["goo.gl", "g.co", "youtu.be", "withgoogle.com", "googleusercontent.com", "gstatic.com", "googleapis.com", "google-analytics.com", "googleadservices.com", "googlesyndication.com", "googlegroups.com", "doubleclick.net", "appspot.com", "blogger.com", "blogspot.com", "googleblog.com"] },
  { name: "Apple", domains: ["apple.com", "icloud.com", "me.com", "itunes.com"], related: ["mzstatic.com", "cdn-apple.com", "apple.news", "icloud-content.com", "apple-cloudkit.com"] },
  { name: "Amazon", domains: ["amazon.com", "amazon.ca", "amazon.co.uk", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.nl", "amazon.se", "amazon.pl", "amazon.com.be", "amazon.ie", "amazon.com.tr", "amazon.ae", "amazon.sa", "amazon.eg", "amazon.in", "amazon.co.jp", "amazon.com.au", "amazon.sg", "amazon.com.mx", "amazon.com.br", "amazon.co.za", "amazon.cn", "primevideo.com"], countrySites: true,
    related: ["amazonaws.com", "amazonses.com", "awsapps.com", "awsstatic.com", "a.co", "amzn.to", "amzn.com", "amazonpay.com", "amazon.jobs", "amazon.science", "aboutamazon.com", "media-amazon.com", "ssl-images-amazon.com", "amazon-adsystem.com", "amazontrust.com", "kindle.com"] },
  { name: "PayPal", domains: ["paypal.com"], countrySites: true, related: ["paypalobjects.com", "paypal-communication.com", "paypal.me", "paypalcorp.com"] },
  { name: "DocuSign", domains: ["docusign.com", "docusign.net"] },
  { name: "Dropbox", domains: ["dropbox.com", "dropboxmail.com"], related: ["dropboxusercontent.com", "dropboxstatic.com", "dropbox.tech", "db.tt"] },
  { name: "Adobe", domains: ["adobe.com", "adobesign.com", "echosign.com", "acrobat.com"], related: ["adobelogin.com", "adobe.io", "adobecc.com", "typekit.net", "behance.net"] },
  { name: "LinkedIn", domains: ["linkedin.com"], related: ["lnkd.in", "licdn.com"] },
  { name: "Netflix", domains: ["netflix.com"], related: ["nflxext.com", "nflximg.net", "nflxso.net", "nflxvideo.net"] },
  { name: "DHL", domains: ["dhl.com", "dhl.de"], countrySites: true, related: ["dhlparcel.nl", "deutschepost.de"] },
  { name: "FedEx", domains: ["fedex.com"] },
  { name: "UPS", domains: ["ups.com"], related: ["upsemail.com", "theupsstore.com", "theupsstore.ca"] },
  { name: "USPS", domains: ["usps.com"], related: ["usps.gov"] },
  { name: "IRS", domains: ["irs.gov"] },
  { name: "Stripe", domains: ["stripe.com"], related: ["stripe.network", "stripe.dev", "stripecdn.com"] },
  { name: "Slack", domains: ["slack.com"], related: ["slack-edge.com", "slack-msgs.com", "slack-files.com", "slack-imgs.com", "slack-redir.net", "slackb.com", "slackhq.com"] },
  { name: "Zoom", domains: ["zoom.us", "zoom.com"], related: ["zoomgov.com"] },
  { name: "Chase", domains: ["chase.com", "jpmorgan.com", "jpmorganchase.com"], related: ["chasepaymentech.com", "chasecdn.com"] },
  { name: "Wells Fargo", domains: ["wellsfargo.com"], related: ["wf.com", "wellsfargoadvisors.com"] },
  { name: "Bank of America", domains: ["bankofamerica.com", "bofa.com"] },
  { name: "Coinbase", domains: ["coinbase.com"] },
  { name: "Okta", domains: ["okta.com"], related: ["oktapreview.com", "okta-emea.com", "oktacdn.com"] },
];

/** Second-level labels that registries sell names under, as in example.co.uk or example.com.au. */
const REGISTRY_SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "mil", "nom", "ltd", "plc", "sch"]);

/**
 * Approximate registrable domain. A heuristic rather than the full Public Suffix List: under a two-letter country code,
 * a registry label such as "co" or "com" belongs to the suffix. Without that, every name under com.ar would count as
 * one organization.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const tld = parts[parts.length - 1]!, second = parts[parts.length - 2]!;
  if (tld.length === 2 && REGISTRY_SECOND_LEVEL.has(second)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

/** The name a registrable domain was registered under: "amazon" for both amazon.com and amazon.co.uk. */
function registeredLabel(reg: string): string { return reg.split(".")[0] ?? ""; }
/** Is this registrable domain a name directly under a country code, as amazon.ca and amazon.co.uk are? */
function underCountryCode(reg: string): boolean { return (reg.split(".").pop() ?? "").length === 2; }

export function sameOrganization(a: string, b: string): boolean {
  return !!a && !!b && registrableDomain(a) === registrableDomain(b);
}

const BRAND_INDEX = new Map<string, { brand: Brand; official: boolean }>();
for (const brand of BRANDS) {
  for (const d of brand.related ?? []) BRAND_INDEX.set(registrableDomain(d), { brand, official: false });
  for (const d of brand.domains) BRAND_INDEX.set(registrableDomain(d), { brand, official: true });
}
const COUNTRY_SITE_LABELS: Map<string, Brand> = new Map(BRANDS.filter(b => b.countrySites).map(b => [registeredLabel(registrableDomain(b.domains[0]!)), b] as const));

/**
 * Which brand owns this host, if any. `official` means the brand sends its own mail from it. Related domains and
 * country sites that aren't listed one by one belong to the brand, but mail from them isn't proof of anything.
 */
export function brandOwning(host: string): { brand: Brand; official: boolean } | null {
  if (!host) return null;
  const reg = registrableDomain(decodeIdnHost(host.toLowerCase()));
  const listed = BRAND_INDEX.get(reg) ?? BRAND_INDEX.get(registrableDomain(host.toLowerCase()));
  if (listed) return listed;
  const country = underCountryCode(reg) ? COUNTRY_SITE_LABELS.get(registeredLabel(reg)) : undefined;
  return country ? { brand: country, official: false } : null;
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

export interface LookalikeHit {
  target: string; brand?: string;
  /**
   * `tld_variant` is the same name under another ending, such as acme.io beside acme.com. Organizations own several
   * endings far more often than attackers register one, so it's a weak signal on its own.
   */
  kind: "homograph" | "typosquat" | "combosquat" | "subdomain_spoof" | "tld_variant";
  /** A near miss by spelling alone, such as strike.com beside stripe.com. Real names collide this way; callers should want more before believing it. */
  nearMiss?: boolean;
}

/** Does the label only look like the target because of a deceptive character, rather than being a different word? */
function deceptiveSpelling(label: string): boolean {
  return /[^a-z]/.test(label) || /rn|vv|cl/.test(label);
}

/**
 * Does `host` imitate a protected domain without belonging to it?
 * Combosquat: "microsoft-login.com". Subdomain spoof: "paypal.com.evil.test".
 */
export function findLookalike(host: string, extraProtected: string[] = []): LookalikeHit | null {
  const unicodeHost = decodeIdnHost(host.toLowerCase());
  const reg = registrableDomain(unicodeHost);
  const regAscii = registrableDomain(host.toLowerCase());
  // A brand's own domains are never lookalikes. A domain that merely got onto a mailbox's known list can't vouch
  // for itself against a brand, or a few messages would teach us to trust paypa1.com.
  if (brandOwning(host)) return null;
  const extra = extraProtected.map(d => registrableDomain(d.toLowerCase()));
  // A domain this mailbox already corresponds with isn't an imitation of the others it corresponds with.
  const selfKnown = extra.includes(reg) || extra.includes(regAscii);
  const protectedSet = [
    ...(selfKnown ? [] : extra.map(d => ({ d, brand: undefined as string | undefined }))),
    ...BRANDS.flatMap(b => b.domains.map(d => ({ d: registrableDomain(d), brand: b.name as string | undefined }))),
  ];
  const regLabel = registeredLabel(reg);
  const skel = skeleton(regLabel);
  let variant: LookalikeHit | null = null, near: LookalikeHit | null = null;
  for (const { d, brand } of protectedSet) {
    if (d === reg || d === regAscii) continue;
    const label = registeredLabel(d);
    if (label.length < 3) continue;
    const tSkel = skeleton(label);
    if (regLabel === label) { variant ??= { target: d, brand, kind: "tld_variant" }; continue; }
    if (isNonLatinConfusable(regLabel) && skel === tSkel) return { target: d, brand, kind: "homograph" };
    // "dhi" and "dhl" fold to the same skeleton, and DHI is a real company. A short name needs a digit or a trick.
    if (skel === tSkel && (label.length >= 5 || deceptiveSpelling(regLabel))) return { target: d, brand, kind: "typosquat" };
    if (label.length >= 5 && skel !== tSkel) {
      const dist = editDistance(skel, tSkel, 2);
      if (dist > 0 && dist <= (label.length >= 8 ? 2 : 1)) {
        if (deceptiveSpelling(regLabel)) return { target: d, brand, kind: "typosquat" };
        near ??= { target: d, brand, kind: "typosquat", nearMiss: true };
        continue;
      }
    }
    if (label.length >= 5 && skel.includes(tSkel) && skel !== tSkel && /[-]|login|secure|verify|account|support|update|mail|pay|billing|auth|signin|service|portal/.test(regLabel)) {
      return { target: d, brand, kind: "combosquat" };
    }
    if (label.length >= 4 && unicodeHost.startsWith(`${d}.`)) return { target: d, brand, kind: "subdomain_spoof" };
    if (label.length >= 5 && unicodeHost.split(".").slice(0, -2).includes(label)) return { target: d, brand, kind: "subdomain_spoof" };
  }
  return variant ?? near;
}

const brandPattern = (b: Brand) => new RegExp(`(^|[^a-z])${b.name.toLowerCase().replace(/ /g, "\\s*")}([^a-z]|$)`);

export function brandInText(text: string): Brand | null {
  const lower = ` ${text.toLowerCase()} `;
  for (const b of BRANDS) if (brandPattern(b).test(lower)) return b;
  return null;
}

/** Words a brand's own display names are made of. "Chase Fraud Alerts" presents as the bank; "Chase Williams" is a person. */
const BRAND_NAME_FILLER = new Set(("the your my team support security service services customer care help helpdesk desk center centre account accounts billing payments payment pay "
  + "alert alerts notification notifications notice notices update updates info information news newsletter admin administrator department dept official online "
  + "id web cloud drive mail email noreply no reply bank banking card cards credit fraud protection safety trust verification express delivery deliveries shipping "
  + "tracking manager order orders returns refund refunds receipt receipts invoice invoices rewards member members membership business workspace prime store "
  + "inc llc ltd corp corporation co com and of for by via").split(" "));

/**
 * Does a display name present itself as a brand? The brand has to be the whole point of the name: every other word is
 * filler such as "Support" or "Team". Names that only contain a brand's word, such as "Apple Tree Daycare", don't count.
 */
export function brandClaimedBy(displayName: string): Brand | null {
  const brand = brandInText(displayName);
  if (!brand) return null;
  const rest = ` ${displayName.toLowerCase()} `.replace(brandPattern(brand), " ").split(/[^a-z0-9]+/).filter(Boolean);
  return rest.every(w => BRAND_NAME_FILLER.has(w) || /^\d+$/.test(w) || w.length <= 2) ? brand : null;
}

export const URL_SHORTENERS = new Set(["bit.ly","tinyurl.com","t.co","goo.gl","ow.ly","is.gd","buff.ly","cutt.ly","rb.gy","shorturl.at","rebrand.ly","t.ly","tiny.cc","lnkd.in"]);
export const SUSPICIOUS_TLDS = new Set(["zip","mov","top","xyz","click","country","stream","gq","cf","tk","ml","ga","work","rest","cam","icu","sbs","cfd","quest","lol"]);
export const FREE_MAIL = new Set(["gmail.com","googlemail.com","outlook.com","hotmail.com","live.com","msn.com","yahoo.com","ymail.com","aol.com","icloud.com","me.com","proton.me","protonmail.com","gmx.com","mail.com","yandex.com","zoho.com"]);
