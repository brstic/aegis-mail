import type { Evidence } from "@aegis/domain";
import type { ParsedMail, ExtractedUrl } from "@aegis/mail-parser";
import { emailDomain, hostOf } from "@aegis/mail-parser";
import { brandClaimedBy, brandInText, brandOwning, FREE_MAIL, findLookalike, registrableDomain, sameOrganization, SUSPICIOUS_TLDS, URL_SHORTENERS, decodeIdnHost, hasMixedScript, type Brand, type LookalikeHit } from "./domains";

export interface RelationshipContext {
  /** Prior messages from this exact address. */
  senderMessageCount: number;
  /** Prior messages from this domain. */
  domainMessageCount: number;
  /** User has replied to this sender. */
  repliedTo: boolean;
  /** Message is a reply into an existing thread in this mailbox. */
  threadKnown: boolean;
  /** Registrable domains previously seen in this thread, excluding this message. */
  threadDomains: string[];
  /** Domains this mailbox regularly corresponds with. Used for lookalike checks. */
  knownDomains: string[];
  /** Display names known for correspondents, lowercased, with their domain. */
  knownNames: { name: string; domain: string }[];
  /** Domains belonging to the mailbox owner. */
  ownDomains: string[];
  /** Display names of the mailbox owner, lowercased. External mail using them is impersonation. */
  ownerNames: string[];
  /** Every address the owner has connected, with aliases, lowercased. Mail between someone's own mailboxes is theirs. */
  ownAddresses: string[];
  /** The owner released mail from this sender, or said it wasn't a threat. */
  senderTrusted: boolean;
  isVip: boolean;
}

export const EMPTY_RELATIONSHIP: RelationshipContext = {
  senderMessageCount: 0, domainMessageCount: 0, repliedTo: false, threadKnown: false, threadDomains: [], knownDomains: [], knownNames: [], ownDomains: [], ownerNames: [], ownAddresses: [], senderTrusted: false, isVip: false,
};

interface AuthFindings { spf?: string; dkim?: string; dmarc?: string; arc?: string; dkimDomains: string[]; spfDomain?: string; headerPresent: boolean; arcVerified: boolean }

/** Parses only the first (nearest) Authentication-Results; earlier ones can be forged by the sender. */
export function parseAuthResults(mail: ParsedMail): AuthFindings {
  const line = mail.headers["authentication-results"]?.[0];
  const arc = mail.headers["arc-authentication-results"]?.[0];
  const pick = (s: string | undefined, k: string) => s?.match(new RegExp(`\\b${k}=([a-z]+)`, "i"))?.[1]?.toLowerCase();
  return {
    headerPresent: !!line,
    arcVerified: pick(line, "arc") === "pass",
    spf: pick(line, "spf"), dkim: pick(line, "dkim"), dmarc: pick(line, "dmarc"), arc: pick(arc, "arc") ?? pick(line, "arc"),
    dkimDomains: [...(line?.matchAll(/header\.(?:d|i)=@?([a-z0-9.-]+)/gi) ?? [])].map(m => m[1]!.toLowerCase()),
    spfDomain: line?.match(/smtp\.mailfrom=(?:[^@\s;]+@)?([a-z0-9.-]+)/i)?.[1]?.toLowerCase(),
  };
}


/**
 * What's established about the sender before any content is read. Everything here needs the provider's DMARC verdict
 * not to be a failure, since the From address is otherwise only a claim.
 */
export interface SenderStanding {
  fromDomain: string;
  authenticated: boolean;
  /** The address is one of the owner's own connected mailboxes. */
  ownAddress: boolean;
  /** The owner vouched for this sender by releasing its mail. */
  trusted: boolean;
}

export function senderStanding(mail: ParsedMail, rel: RelationshipContext): SenderStanding {
  const address = (mail.from?.address ?? "").toLowerCase();
  const fromDomain = emailDomain(address);
  const dmarc = parseAuthResults(mail).dmarc;
  const authenticated = dmarc === "pass";
  const notForged = dmarc !== "fail";
  return {
    fromDomain, authenticated,
    ownAddress: !!address && notForged && (rel.ownAddresses ?? []).includes(address),
    trusted: !!rel.senderTrusted && notForged,
  };
}

const mentions = (brand: string, text: string) => new RegExp(`(^|[^a-z])${brand.toLowerCase().replace(/ /g, "\\s*")}([^a-z]|$)`).test(text.toLowerCase());

export function authDetector(mail: ParsedMail): Evidence[] {
  const a = parseAuthResults(mail);
  const out: Evidence[] = [];
  if (!a.headerPresent) return out; // Absence isn't proof: many providers strip or omit it.
  const fromDomain = emailDomain(mail.from?.address);
  // Only our provider's own verdict counts. List-Id, X-Forwarded-*, Resent-From and ARC headers are all set by the
  // sender, so believing them would let any forger switch this check off.
  const forwarded = a.arcVerified;
  if (a.dmarc === "fail") {
    out.push(forwarded
      ? { code: "AUTH_DMARC_FAIL_FORWARDED", weight: 0.5, source: "auth", explanation: "Sender authentication failed, but this looks like forwarded or mailing-list mail, which often breaks authentication legitimately." }
      : { code: "AUTH_DMARC_FAIL", weight: 2.4, category: "brand_spoof", source: "auth", explanation: `The sender's domain (${fromDomain}) failed DMARC, so the From address may be forged.` });
  } else if (a.dmarc === "pass") {
    // Proves the domain owner sent it, not that the owner is honest: attackers authenticate their own lookalikes.
    out.push({ code: "AUTH_DMARC_PASS", weight: -0.3, source: "auth", explanation: "The sender's domain passed DMARC authentication. This confirms who owns the domain, not that they're trustworthy." });
  }
  if (a.dkim === "fail" && a.dmarc !== "pass" && !forwarded) out.push({ code: "AUTH_DKIM_FAIL", weight: 0.8, source: "auth", explanation: "The message's cryptographic signature (DKIM) didn't verify." });
  if (a.spf === "fail" && a.dmarc !== "pass" && !forwarded) out.push({ code: "AUTH_SPF_FAIL", weight: 0.8, source: "auth", explanation: "The sending server isn't authorized by the sender's domain (SPF)." });
  if (a.spf === "softfail" && a.dmarc !== "pass" && !forwarded) out.push({ code: "AUTH_SPF_SOFTFAIL", weight: 0.3, source: "auth", explanation: "The sending server wasn't clearly authorized by the sender's domain." });
  return out;
}

export function headerDetector(mail: ParsedMail, rel: RelationshipContext, protectedDomains: string[], standing: SenderStanding = senderStanding(mail, rel)): Evidence[] {
  const out: Evidence[] = [];
  const fromAddr = mail.from?.address ?? "";
  const fromDomain = emailDomain(fromAddr);
  const name = (mail.from?.name ?? "").slice(0, 256).trim();
  const extra = [...protectedDomains, ...rel.knownDomains, ...rel.ownDomains];

  if (!fromAddr) out.push({ code: "HDR_NO_FROM", weight: 1.5, source: "headers", explanation: "The message has no valid From address." });

  // The owner's own mailbox, or a sender the owner vouched for, isn't checked for resembling someone else.
  const vouched = standing.ownAddress || standing.trusted;

  // Lookalike sender domain.
  const hit = fromDomain && !vouched ? findLookalike(fromDomain, extra) : null;
  if (hit) {
    const isOwn = rel.ownDomains.some(d => registrableDomain(d) === hit.target);
    const shown = decodeIdnHost(fromDomain);
    if (hit.kind === "tld_variant") {
      out.push({ code: "HDR_FROM_TLD_VARIANT", weight: hit.brand ? 2.0 : isOwn ? 1.6 : 1.2, category: hit.brand ? "brand_spoof" : "bec", source: "headers",
        explanation: `The sender's domain "${shown}" has the same name as ${hit.brand ?? hit.target} with a different ending. Organizations often own both, and so can an impersonator.` });
    } else if (hit.nearMiss && hit.brand && !mentions(hit.brand, `${name}\n${analysisText(mail)}`)) {
      // strike.com beside stripe.com. A real name that never claims to be the brand is a coincidence.
      out.push({ code: "HDR_FROM_NEAR_MISS", weight: 0.6, source: "headers", explanation: `The sender's domain "${shown}" is spelled much like ${hit.brand}'s, though the message doesn't claim to be from ${hit.brand}.` });
    } else {
      out.push({
        code: hit.kind === "homograph" ? "HDR_FROM_HOMOGRAPH" : "HDR_FROM_LOOKALIKE", weight: isOwn ? 3.8 : 3.2,
        category: hit.brand ? "brand_spoof" : "bec", source: "headers",
        explanation: `The sender's domain "${shown}" closely resembles ${hit.brand ?? hit.target}, but it isn't the same domain.`,
      });
    }
  }

  // Display-name impersonation of a brand. A free mail address is never the brand, even one the brand runs.
  const nameBrand = name ? brandClaimedBy(name) : null;
  const sameFact = hit?.kind === "tld_variant" && hit.brand === nameBrand?.name;
  if (nameBrand && fromDomain && !sameFact && (brandOwning(fromDomain)?.brand !== nameBrand || FREE_MAIL.has(registrableDomain(fromDomain)))) {
    out.push({ code: "HDR_DISPLAY_BRAND_MISMATCH", weight: 2.6, category: "brand_spoof", source: "headers", explanation: `The display name says "${name}", but the message came from ${fromDomain}, not a ${nameBrand.name} domain.` });
  }

  // Display name contains a different email address.
  const nameEmail = name.slice(0, 256).match(/[a-z0-9._%+-]{1,64}@([a-z0-9.-]{1,253}\.[a-z]{2,24})/i);
  if (nameEmail && !sameOrganization(nameEmail[1]!.toLowerCase(), fromDomain)) {
    out.push({ code: "HDR_DISPLAY_EMAIL_MISMATCH", weight: 2.4, category: "brand_spoof", source: "headers", explanation: `The display name shows the address ${nameEmail[0]}, but the actual sender is ${fromAddr}.` });
  }

  // Known correspondent's name from a new domain.
  if (name.length >= 5 && fromDomain && !vouched) {
    const known = rel.knownNames.find(k => k.name === name.toLowerCase() && !sameOrganization(k.domain, fromDomain));
    if (known) out.push({ code: "HDR_KNOWN_NAME_NEW_DOMAIN", weight: 2.5, category: "bec", source: "relationship", explanation: `"${name}" usually writes from ${known.domain}, but this message came from ${fromDomain}.` });
  }

  // Someone outside the mailbox owner's domains using the owner's own name: classic executive fraud.
  if (name && !vouched && rel.ownerNames.includes(name.toLowerCase()) && fromDomain && !rel.ownDomains.some(d => sameOrganization(d, fromDomain))) {
    out.push({ code: "HDR_OWNER_NAME_SPOOF", weight: 2.2, category: "bec", source: "headers", explanation: `The display name is your own name, "${name}", but the message came from ${fromDomain}, outside your domains.` });
  }

  const fromTld = registrableDomain(fromDomain).split(".").pop() ?? "";
  if (SUSPICIOUS_TLDS.has(fromTld)) out.push({ code: "HDR_SUSPICIOUS_TLD", weight: 0.8, source: "headers", explanation: `The sender's domain ends in ".${fromTld}", which is frequently abused.` });

  // Reply-To diverting the conversation elsewhere.
  const replyTo = mail.replyTo?.address;
  if (replyTo && fromDomain) {
    const rd = emailDomain(replyTo);
    if (rd && !sameOrganization(rd, fromDomain)) {
      // List-Unsubscribe is sender-set too: only a domain that passed DMARC earns the benefit of the doubt.
      const bulk = !!mail.listUnsubscribe && parseAuthResults(mail).dmarc === "pass";
      const free = FREE_MAIL.has(registrableDomain(rd));
      out.push({
        code: free ? "HDR_REPLYTO_FREEMAIL" : "HDR_REPLYTO_MISMATCH", weight: bulk ? 0.2 : free ? 2.0 : 1.3,
        category: "bec", source: "headers",
        explanation: `Replies would go to ${replyTo}, a different domain from the sender (${fromDomain}).`,
      });
    }
  }

  if (mail.sender?.address && fromDomain) {
    const sd = emailDomain(mail.sender.address);
    if (sd && !sameOrganization(sd, fromDomain) && !mail.listUnsubscribe) {
      out.push({ code: "HDR_SENDER_MISMATCH", weight: 0.3, source: "headers", explanation: `This message was sent on behalf of ${fromDomain} by ${sd}.` });
    }
  }

  // Reply-chain hijack: "Re:" claims with no known parent, or a new domain joins a thread.
  // "Re:" only: forwards legitimately start new threads with no In-Reply-To.
  const claimsReply = /^\s*re\s*:/i.test(mail.subject);
  if (claimsReply && !mail.inReplyTo && !mail.references.length && !rel.threadKnown) {
    out.push({ code: "THREAD_FAKE_REPLY", weight: 1.3, category: "reply_chain_hijack", source: "headers", explanation: `The subject looks like a reply, but it isn't part of any existing conversation.` });
  }
  if (rel.threadKnown && fromDomain && !vouched && rel.threadDomains.length && !rel.threadDomains.some(d => sameOrganization(d, fromDomain))) {
    out.push({ code: "THREAD_NEW_DOMAIN", weight: 1.7, category: "reply_chain_hijack", source: "relationship", explanation: `A sender from a new domain (${fromDomain}) joined this conversation. Earlier messages came from ${rel.threadDomains.slice(0, 3).join(", ")}.` });
  }
  return out;
}

const LOGIN_PATH = /(login|signin|sign-in|verify|account|secure|password|credential|auth|sso|webscr|update-info|validate|wallet|unlock)/i;

/** Endings that are file types far more often than web addresses when they appear as bare link text. */
const FILE_ENDINGS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip", "rar", "png", "jpg", "jpeg", "gif", "svg", "js", "ts", "md", "json", "xml", "html", "htm", "php", "py", "sh", "exe", "ics", "eml", "mp3", "mp4", "mov"]);
const COMMON_ENDINGS = new Set(["com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "app", "dev", "xyz", "online", "site", "shop", "store", "tech", "cloud", "top", "club", "live", "pro", "email", "link", "click", "page", "blog", "news", "bank", "test", "example"]);

/** The web address a link's visible text claims, if the text contains one. File names, email addresses and ordinary words with a dot aren't addresses. */
export function shownHost(text: string): string | null {
  for (const m of text.slice(0, 2000).matchAll(/(?<![@\w.-])(https?:\/\/|www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\w@-])/gi)) {
    const host = m[2]!.toLowerCase(), ending = host.split(".").pop()!;
    if (m[1] || (!FILE_ENDINGS.has(ending) && (ending.length === 2 || COMMON_ENDINGS.has(ending)))) return host;
  }
  return null;
}

interface UrlContext { senderDomain: string; rel: RelationshipContext; protectedDomains: string[]; fromQr: boolean; standing: SenderStanding; brandText: string }

function urlEvidence(u: ExtractedUrl, ctx: UrlContext): Evidence[] {
  const { senderDomain, rel, protectedDomains, fromQr } = ctx;
  const out: Evidence[] = [];
  const prefix = fromQr ? "A QR code in this message points to" : "A link points to";
  const cat = fromQr ? "qr_phish" as const : "malicious_link" as const;
  if (/^(javascript|data|vbscript|file):/i.test(u.href)) {
    out.push({ code: "URL_DANGEROUS_SCHEME", weight: 3.5, category: "malicious_link", source: "url", explanation: "A link uses a scheme that can run code rather than opening a web page." });
    return out;
  }
  const host = u.host;
  const display = decodeIdnHost(host);
  if (!host) return out;
  const reg = registrableDomain(host);
  const sameAsSender = !!senderDomain && sameOrganization(reg, senderDomain);

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) out.push({ code: "URL_IP_HOST", weight: 2.4, category: cat, source: "url", explanation: `${prefix} a raw IP address (${host}) instead of a named website.` });
  try {
    const parsed = new URL(u.href);
    if (parsed.username) out.push({ code: "URL_USERINFO_TRICK", weight: 3, category: cat, source: "url", explanation: `A link is disguised with "${parsed.username}@" before its real destination, ${host}.` });
    if (parsed.protocol === "http:" && LOGIN_PATH.test(parsed.pathname)) out.push({ code: "URL_INSECURE_LOGIN", weight: 1.2, category: "credential_phish", source: "url", explanation: `A sign-in style link on ${display} doesn't use encryption.` });
    const redirect = [...parsed.searchParams.entries()].find(([k, v]) => /^(url|u|redirect|redir|next|target|dest|destination|continue|goto|link)$/i.test(k) && /^https?:\/\//i.test(v));
    if (redirect) {
      const target = hostOf(redirect[1]);
      if (target && !sameOrganization(target, host)) out.push({ code: "URL_OPEN_REDIRECT", weight: 1.3, category: cat, source: "url", explanation: `A link passes through ${host} and redirects to ${target}.` });
    }
    if (reg && !sameAsSender && LOGIN_PATH.test(parsed.pathname + parsed.hostname)) out.push({ code: "URL_CREDENTIAL_PATH", weight: 0.9, category: "credential_phish", source: "url", explanation: `A link on ${display} looks like a sign-in or verification page, and it isn't on the sender's domain.` });
  } catch { /* extractUrls already filtered unparsable hrefs */ }

  // The sender's own domain was already judged in the headers. Counting its links again would turn one fact into two.
  const hit: LookalikeHit | null = sameAsSender ? null : findLookalike(host, [...protectedDomains, ...rel.knownDomains, ...rel.ownDomains]);
  if (hit?.kind === "tld_variant") out.push({ code: "URL_TLD_VARIANT", weight: hit.brand ? 1.6 : 0.8, category: cat, source: "url", explanation: `${prefix} ${display}, which has the same name as ${hit.brand ?? hit.target} with a different ending.` });
  else if (hit && !(hit.nearMiss && hit.brand && !mentions(hit.brand, ctx.brandText))) out.push({ code: hit.kind === "homograph" ? "URL_HOMOGRAPH" : "URL_LOOKALIKE", weight: 3.4, category: fromQr ? "qr_phish" : "credential_phish", source: "url", explanation: `${prefix} ${display}, which imitates ${hit.brand ?? hit.target}.` });
  else if (host.startsWith("xn--") || host.includes(".xn--")) {
    const label = display.split(".")[0] ?? "";
    if (hasMixedScript(label)) out.push({ code: "URL_MIXED_SCRIPT", weight: 2.2, category: cat, source: "url", explanation: `A link's address (${display}) mixes alphabets, a trick to imitate another site.` });
  }
  if (URL_SHORTENERS.has(reg)) out.push({ code: "URL_SHORTENER", weight: 0.9, category: cat, source: "url", explanation: `A shortened link (${host}) hides its real destination.` });
  const tld = reg.split(".").pop() ?? "";
  if (SUSPICIOUS_TLDS.has(tld) && !sameAsSender) out.push({ code: "URL_SUSPICIOUS_TLD", weight: 0.9, category: cat, source: "url", explanation: `A link uses the domain ending ".${tld}", which is frequently abused.` });

  // Visible text claims a different domain than the real destination.
  const shown = u.source === "html" && u.text ? shownHost(u.text) : null;
  if (shown && !sameOrganization(shown, host)) {
    // A sender showing its own name over a tracking link is how newsletters are built. Two domains of one brand aren't a disguise either.
    const ownName = ctx.standing.authenticated && sameOrganization(shown, senderDomain);
    const shownBrand = brandOwning(shown)?.brand;
    const sameBrand = !!shownBrand && shownBrand === brandOwning(host)?.brand;
    if (!ownName && !sameBrand) out.push({ code: "URL_TEXT_MISMATCH", weight: 2.8, category: cat, source: "url", explanation: `A link displays "${shown}" but really goes to ${display}.` });
  }
  if (fromQr) out.push({ code: "QR_LINK", weight: 1.6, category: "qr_phish", source: "url", explanation: `An image contains a QR code that goes to ${display}. QR codes bypass the warnings normally shown for links.` });
  return out;
}

export function urlDetector(mail: ParsedMail, rel: RelationshipContext, protectedDomains: string[], qrUrls: string[], fileUrls: string[] = [], standing: SenderStanding = senderStanding(mail, rel)): Evidence[] {
  const senderDomain = emailDomain(mail.from?.address);
  const ctx = (fromQr: boolean): UrlContext => ({ senderDomain, rel, protectedDomains, fromQr, standing, brandText: `${mail.from?.name ?? ""}\n${analysisText(mail)}` });
  const all: Evidence[] = [];
  for (const u of mail.urls) all.push(...urlEvidence(u, ctx(false)));
  // Links inside attachments (PDF, Office, HTML) are checked like links in the message.
  for (const href of fileUrls) { const host = hostOf(href); if (host) all.push(...urlEvidence({ href, host, source: "text" }, ctx(false))); }
  for (const href of qrUrls) { const host = hostOf(href); if (host) all.push(...urlEvidence({ href, host, source: "text" }, ctx(true))); }
  // De-duplicate by code: a link repeated ten times is still one piece of evidence.
  const seen = new Set<string>();
  return all.filter(e => (seen.has(e.code) ? false : (seen.add(e.code), true)));
}

type Pat = { code: string; re: RegExp; weight: number; category: Evidence["category"]; text: string };

const CONTENT_PATTERNS: Pat[] = [
  { code: "TXT_CREDENTIAL_REQUEST", re: /\b(verify|confirm|validate|re-?enter|update)\b[^.\n]{0,60}\b(password|credentials?|login details|account (details|information)|security (code|details)|sign-?in)\b/i, weight: 1.7, category: "credential_phish", text: "It asks you to confirm a password or sign-in details." },
  { code: "TXT_ACCOUNT_THREAT", re: /\b(account|mailbox|access|subscription|storage)\b[^.\n]{0,50}\b(suspended|locked|disabled|terminated|deactivated|restricted|expir\w+|will be (closed|deleted|removed))\b/i, weight: 1.3, category: "credential_phish", text: "It warns that an account will be locked or closed." },
  { code: "TXT_PASSWORD_EXPIRY", re: /\bpassword\b[^.\n]{0,30}\b(expir\w+|reset required)\b|\bmailbox (is )?(almost )?full\b|\bquota (exceeded|reached)\b/i, weight: 1.5, category: "credential_phish", text: "It claims a password is expiring or a mailbox is full." },
  { code: "TXT_URGENCY", re: /\b(urgent(ly)?|immediate(ly)?|right away|asap|within (the next )?\d+ (hours?|minutes?)|act now|final notice|last warning|today only)\b/i, weight: 0.5, category: undefined, text: "It pressures you to act quickly." },
  { code: "TXT_SECRECY", re: /\b(keep (this|it) (confidential|between us|quiet|private|to yourself)|don'?t (tell|mention|discuss)|do not (tell|mention|discuss)|strictly confidential|am in a meeting|can'?t (talk|take calls))\b/i, weight: 1.6, category: "bec", text: "It asks for secrecy or says the sender can't be reached." },
  { code: "TXT_PAYMENT_CHANGE", re: /\b(bank(ing)?( account| details| information| info)?|payment (details|instructions|information)|remit(tance)?( details| info\w*| instructions)?|wire instructions|iban|routing( number)?|sort code|swift|direct deposit)\b[^.\n]{0,60}\b(chang\w+|updat\w+|amended|revised|moved|switch\w*|different)\b|\b(chang\w+|updat\w+|new|amended|revised)\b[^.\n]{0,60}\b(bank(ing)? (details|account|information|info)|payment (details|instructions|information)|remittance( info\w*| details)?|iban|routing number|wire instructions|direct deposit)\b|\bchanged banks\b/i, weight: 2.6, category: "invoice_fraud", text: "It asks to change bank or payment details." },
  { code: "TXT_BANK_DETAILS_GIVEN", re: /\b(routing|sort code|iban|swift|aba)\b[^\n]{0,24}[:#]?\s{0,4}[0-9A-Z][0-9A-Z -]{5,30}\b[\s\S]{0,80}\b(account|acct)\b/i, weight: 1.6, category: "invoice_fraud", text: "It supplies bank account numbers in the message itself." },
  { code: "TXT_VENDOR_MASTER", re: /\b(vendor master|supplier master|payee (record|details)|payment run|ap system)\b/i, weight: 0.8, category: "invoice_fraud", text: "It asks to change records used to pay vendors." },
  { code: "TXT_OVERPAYMENT", re: /\b(overpa(id|yment)|paid twice|arrived twice|duplicate payment|credit on your account)\b[\s\S]{0,300}\b(refund\w*|return|send|wire|transfer)\b|\b(refund\w*|wire)\b[^.\n]{0,40}\b(the difference|it back)\b/i, weight: 2.2, category: "invoice_fraud", text: "It asks you to return an overpayment, a common way to steal money." },
  { code: "TXT_SIGNIN_REQUIRED", re: /\b(sign|log)[- ]?in with your (work|company|corporate|office|business|microsoft|google|email)\b|\bwith your company login\b|\bre-?authenticate\b|\bsign in (again )?to (view|open|play|listen|respond|continue|access)\b/i, weight: 1.9, category: "credential_phish", text: "It sends you to a link and has you sign in to see something. Fake sign-in pages work this way." },
  { code: "TXT_RESHIP", re: /\b(receive|accept)\b[^.\n]{0,40}\bpackages?\b[\s\S]{0,200}\b(reship|re-ship|forward|prepaid labels?)\b/i, weight: 2.4, category: "lure_recruiting_tax_shipping", text: "It offers pay to receive and reship packages, a known fraud that uses people as mules." },
  { code: "TXT_EASY_MONEY", re: /\$\s?\d{2,5}(\s?(to|-)\s?\$?\s?\d{2,5})?\s?(per|a|an|\/)\s?(hour|day|week)\b/i, weight: 1.2, category: "lure_recruiting_tax_shipping", text: "It promises specific pay up front, typical of job scams." },
  { code: "TXT_LEGAL_THREAT", re: /\b(default judg(e)?ment|summons|civil complaint|named as (a )?defendant|legal action (will|may) be|court (order|notice)|subpoena)\b/i, weight: 1.9, category: "lure_recruiting_tax_shipping", text: "It uses a legal threat to push you toward a link." },
  { code: "TXT_WIRE_REQUEST", re: /\b(wire transfer|wire (the )?(funds|payment|money)|process (a |an |the )?(payment|wire|transfer)|same[- ]day (payment|transfer)|initiate (a )?(payment|transfer))\b/i, weight: 1.5, category: "bec", text: "It requests a wire transfer or payment." },
  { code: "TXT_GIFT_CARDS", re: /\b(gift ?cards?|itunes cards?|apple cards?|google play cards?|steam cards?)\b[^.\n]{0,100}\b(purchase|buy|get|send|code|scratch|pick up)\b|\b(purchase|buy|get|send|pick up)\b[^.\n]{0,60}\bgift ?cards?\b/i, weight: 3, category: "bec", text: "It asks you to buy gift cards, a hallmark of scams." },
  { code: "TXT_EXEC_REQUEST", re: /\b(are you (available|at your desk|free)|quick favou?r|need (you|a favou?r)|can you handle)\b/i, weight: 0.7, category: "bec", text: "It opens with an unusual personal request." },
  { code: "TXT_CRYPTO_PAYMENT", re: /\b(bitcoin|btc|ethereum|usdt|crypto(currency)? (wallet|payment|address))\b/i, weight: 1.3, category: "spam", text: "It involves cryptocurrency payments." },
  { code: "TXT_SEXTORTION", re: /\b(i (have )?(hacked|recorded|have access to) (your|you)|webcam|embarrassing (video|footage)|send .{0,20}(bitcoin|btc)|your (device|computer) (was|has been) (hacked|infected))\b/i, weight: 2.5, category: "spam", text: "It uses extortion language." },
  { code: "TXT_ADVANCE_FEE", re: /\b(inheritance|beneficiary|next of kin|unclaimed (funds|prize)|lottery|you (have )?won|million (usd|dollars))\b/i, weight: 2, category: "spam", text: "It uses advance-fee scam language." },
  { code: "TXT_CALLBACK", re: /\b(call|phone|contact|dial)\b[^.\n]{0,50}(\+?\d[\d\s().-]{8,24}\d)[^\n]{0,80}\b(cancel|dispute|refund|charge|renew\w*|subscription|order|invoice)\b|\b(cancel|dispute|refund|charged?|renew\w*|subscription|auto-?renew)\b[^\n]{0,120}\b(call|phone|contact|dial)\b[^.\n]{0,50}(\+?\d[\d\s().-]{8,24}\d)/i, weight: 2.4, category: "callback_phish", text: "It pushes you to call a phone number about a charge. Scammers use this to avoid links." },
  { code: "TXT_DOC_SHARED_LURE", re: /\b(shared (a |an )?(document|file)|view (the )?(secure )?document|document (is )?waiting|sent you (a |an )?(secure )?(document|file|fax)|voicemail|encrypted message)\b/i, weight: 1.1, category: "credential_phish", text: "It claims a document or voicemail is waiting for you." },
  { code: "TXT_DELIVERY_LURE", re: /\b(package|parcel|shipment|delivery)\b[^.\n]{0,60}\b(failed|held|on hold|unable|pending|customs|fee|reschedule|attempt)\b/i, weight: 1.1, category: "lure_recruiting_tax_shipping", text: "It claims a delivery problem that needs action." },
  { code: "TXT_TAX_LURE", re: /\b(tax (refund|return|notice|rebate)|irs|hmrc|w-?2 forms?)\b[^.\n]{0,80}\b(claim|verify|owed|overdue|penalty|submit|click|confirm|send)\b/i, weight: 1.5, category: "lure_recruiting_tax_shipping", text: "It uses a tax notice to prompt action." },
  { code: "TXT_RECRUIT_LURE", re: /\b(work from home|remote (job|position)|part[- ]time (job|position))\b[^.\n]{0,100}\b(\$\d+|per (hour|day|week)|no experience|whatsapp|telegram)\b|\b(no experience (needed|required))\b|\b(telegram|whatsapp)\b[^.\n]{0,40}@\w+/i, weight: 1.8, category: "lure_recruiting_tax_shipping", text: "It's an unsolicited job offer with common scam traits." },
  { code: "TXT_OFFCHANNEL", re: /\b(whatsapp|telegram|signal)\b[^.\n]{0,40}(\+?\d[\d\s-]{7,24}|me|us|contact)|\b(personal (email|number|cell)|text me at)\b/i, weight: 0.9, category: "bec", text: "It tries to move the conversation to another channel." },
];

const WINDOW = 100_000;
const windowed = (t: string) => (t.length <= WINDOW * 2 ? t : `${t.slice(0, WINDOW)}\n${t.slice(-WINDOW)}`);
/** The plain part and the HTML part can say different things, and people read the HTML. Padding can't push a lure out of view. */
export function analysisText(mail: Pick<ParsedMail, "subject" | "text" | "visibleText">): string {
  const v = mail.visibleText && mail.visibleText !== mail.text ? `\n${windowed(mail.visibleText)}` : "";
  return `${mail.subject}\n${windowed(mail.text)}${v}`;
}

const BENIGN_SECURITY_NOTICE = /\b(if this wasn'?t you|you can safely ignore|we will never ask (you )?for your password)\b/i;

/** "We have not changed our bank details" and "we'll never ask you to update them" are warnings, not requests. */
const NEGATED = /\b(not|never|no|n't|can'?t|cannot|won'?t|don'?t|do not|ignore|unchanged|fraud\w*|scam\w*|beware)\b/i;
const NEGATABLE = new Set(["TXT_PAYMENT_CHANGE", "TXT_BANK_DETAILS_GIVEN"]);
function matchIsAssertion(re: RegExp, text: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let n = 0;
  for (const m of text.matchAll(g)) {
    if (n++ > 40) break;
    // The clause containing the match, and what leads into it.
    const start = Math.max(text.lastIndexOf(".", m.index), text.lastIndexOf("\n", m.index), m.index - 120) + 1;
    const clause = text.slice(start, m.index + m[0].length);
    if (!NEGATED.test(clause)) return true;
  }
  return false;
}

export function contentDetector(mail: ParsedMail): Evidence[] {
  const haystack = analysisText(mail);
  const out: Evidence[] = [];
  for (const p of CONTENT_PATTERNS) {
    if (!p.re.test(haystack)) continue;
    if (NEGATABLE.has(p.code) && !matchIsAssertion(p.re, haystack)) continue;
    out.push({ code: p.code, weight: p.weight, category: p.category, source: "content", explanation: p.text });
  }
  if (BENIGN_SECURITY_NOTICE.test(haystack)) out.push({ code: "TXT_BENIGN_NOTICE_LANGUAGE", weight: -0.5, source: "content", explanation: "Its wording resembles a routine security notice." });
  return out;
}

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (all |any |your |the )?(previous|prior|above|earlier|preceding)?\s{0,8}(instructions?|prompts?|rules?|context)\b/i,
  /\b(disregard|forget|override) (all |any |your |the )?(previous|prior|above|system)?\s{0,8}(instructions?|prompts?|rules?)\b/i,
  /\b(you are now|act as|pretend to be|new instructions?:|system prompt|developer mode|jailbreak)\b/i,
  /\b(assistant|ai|chatbot|llm|copilot|model)\s{0,8}[:,]?\s{0,8}(please )?(forward|send|delete|reply|email|exfiltrate|mark|classify|label|summari[sz]e this as)\b/i,
  /\b(forward|send) (all|every|the|my)\b[^.\n]{0,40}\b(emails?|messages?|inbox|mail)\b[^.\n]{0,40}\bto\b/i,
  /\bmark this (email|message) as (safe|not (spam|phishing))\b/i,
  /<\/?(system|assistant|instructions?|tool_?(call|use|result))>/i,
];

function decodedBase64Runs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.slice(0, 200_000).matchAll(/[A-Za-z0-9+/]{24,4096}={0,2}/g)) {
    if (out.length > 20) break;
    try { const d = Buffer.from(m[0], "base64").toString("utf8"); if (/^[\x20-\x7e\s]{16,}$/.test(d)) out.push(d); } catch { /* ignore */ }
  }
  return out;
}

export interface InjectionScreen { detected: boolean; locations: string[] }

/** Screens every place a model might read, including ones a person can't see. */
export function screenPromptInjection(mail: Pick<ParsedMail, "subject" | "text" | "sanitized"> & { visibleText?: string }, attachmentTexts: string[] = []): InjectionScreen {
  const places: [string, string][] = [
    ["subject", mail.subject], ["body", windowed(mail.text)],
    ["message", windowed(mail.visibleText ?? "")],
    ["hidden text", (mail.sanitized?.hiddenText ?? []).join("\n")],
    ["HTML comment", (mail.sanitized?.htmlComments ?? []).join("\n")],
    ["encoded text", decodedBase64Runs(mail.text).join("\n")],
    ["attachment", attachmentTexts.join("\n")],
  ];
  const locations = places.filter(([, t]) => t && INJECTION_PATTERNS.some(r => r.test(t))).map(([k]) => k).filter(k => k !== "message" || !places.some(([n, t]) => n === "body" && INJECTION_PATTERNS.some(r => r.test(t))));
  return { detected: locations.length > 0, locations };
}

export function injectionDetector(mail: ParsedMail, attachmentTexts: string[]): Evidence[] {
  const s = screenPromptInjection(mail, attachmentTexts);
  if (!s.detected) return [];
  const hiddenPlace = s.locations.some(l => l !== "body" && l !== "subject" && l !== "message");
  return [{ code: "AI_PROMPT_INJECTION", weight: hiddenPlace ? 2.8 : 1.6, category: "prompt_injection", source: "content",
    explanation: `${s.locations.some(l => /attachment/.test(l)) ? "Text in an attachment" : hiddenPlace ? "Hidden text in this email" : "This email"} tries to give orders to AI assistants. It's ignored, and nothing acts on it.` }];
}

export function trackingDetector(mail: ParsedMail): Evidence[] {
  const s = mail.sanitized;
  if (!s || !s.trackingPixels) return [];
  return [{ code: "TRK_PIXEL", weight: 0, category: "tracking", source: "headers", explanation: `${s.trackingPixels} tracking pixel${s.trackingPixels === 1 ? " was" : "s were"} blocked, so the sender can't see when you open this.` }];
}

export function bulkDetector(mail: ParsedMail): { isBulk: boolean; evidence: Evidence[] } {
  const signals = [
    !!mail.listUnsubscribe, !!mail.headers["list-id"]?.length, mail.precedence === "bulk" || mail.precedence === "list",
    !!mail.headers["x-campaign"]?.length || !!mail.headers["x-mailchimp-id"]?.length || !!mail.headers["feedback-id"]?.length,
    /\bunsubscribe\b/i.test(analysisText(mail)),
  ].filter(Boolean).length;
  const isBulk = signals >= 2 || (!!mail.listUnsubscribe);
  return { isBulk, evidence: isBulk ? [{ code: "BULK_LIST_MAIL", weight: 0, source: "headers", explanation: "This looks like newsletter or bulk mail." }] : [] };
}

export function spamDetector(mail: ParsedMail): Evidence[] {
  const out: Evidence[] = [];
  const subj = mail.subject;
  const letters = subj.replace(/[^a-z]/gi, "");
  if (letters.length >= 12 && letters === letters.toUpperCase()) out.push({ code: "SPAM_SUBJECT_CAPS", weight: 0.5, category: "spam", source: "content", explanation: "The subject is written entirely in capitals." });
  if ((subj.match(/!/g) ?? []).length >= 3) out.push({ code: "SPAM_SUBJECT_PUNCT", weight: 0.3, category: "spam", source: "content", explanation: "The subject overuses exclamation marks." });
  if (/\b(viagra|cialis|casino|lose weight|miracle|100% free|risk[- ]free|cheap meds|payday loan|earn \$?\d+|double your)\b/i.test(analysisText(mail))) out.push({ code: "SPAM_KEYWORDS", weight: 1.6, category: "spam", source: "content", explanation: "It uses wording typical of unsolicited promotions." });
  return out;
}

export function relationshipDetector(mail: ParsedMail, rel: RelationshipContext): Evidence[] {
  const out: Evidence[] = [];
  const from = emailDomain(mail.from?.address);
  // Your own domain, proven by DMARC. Compromised internal accounts exist, so it offsets rather than excuses: the cap in
  // finalizeAnalysis still lets several strong signals win.
  if (from && rel.ownDomains.some(d => sameOrganization(d, from)) && parseAuthResults(mail).dmarc === "pass") {
    out.push({ code: "REL_INTERNAL_AUTHENTICATED", weight: -1.0, source: "relationship", explanation: "It's authenticated mail from your own organization's domain." });
    return out;
  }
  const standing = senderStanding(mail, rel);
  if (standing.ownAddress) return [{ code: "REL_OWN_ADDRESS", weight: -1.0, source: "relationship", explanation: "It came from one of your own connected mailboxes." }];
  if (standing.trusted) out.push({ code: "REL_SENDER_TRUSTED", weight: -2.0, source: "relationship", explanation: "Mail from this sender was reviewed and cleared before." });
  if (rel.senderMessageCount === 0 && rel.domainMessageCount === 0) out.push({ code: "REL_FIRST_CONTACT", weight: 0.35, source: "relationship", explanation: "This is the first message from this sender." });
  else if (rel.repliedTo && rel.senderMessageCount >= 3) out.push({ code: "REL_ESTABLISHED", weight: -1.1, source: "relationship", explanation: "You've exchanged several messages with this sender." });
  else if (rel.senderMessageCount >= 3) out.push({ code: "REL_RECURRING", weight: -0.4, source: "relationship", explanation: "You've received several messages from this sender." });
  return out;
}

export function brandContentMismatch(mail: ParsedMail): Evidence[] {
  const domain = emailDomain(mail.from?.address);
  if (!domain) return [];
  const brand = brandInText(mail.subject);
  if (!brand || (brandOwning(domain)?.brand === brand && !FREE_MAIL.has(registrableDomain(domain)))) return [];
  if (!mail.urls.length) return [];
  const hasCred = /\b(sign in|log ?in|verify|password|account|confirm)\b/i.test(analysisText(mail));
  if (!hasCred) return [];
  return [{ code: "BRAND_SUBJECT_MISMATCH", weight: 1.6, category: "brand_spoof", source: "content", explanation: `The message presents itself as ${brand.name} and asks you to sign in, but it came from ${domain}.` }];
}
