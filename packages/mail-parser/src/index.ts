import { simpleParser, type AddressObject, type Attachment as MPAttachment } from "mailparser";
import { createHash } from "node:crypto";
import type { EmailAddress } from "@aegis/domain";
import { extractUrls, type ExtractedUrl } from "./urls";
import { htmlToText, sanitizeEmailHtml, type SanitizeResult } from "./sanitize";

export { extractUrls, hostOf } from "./urls";
export type { ExtractedUrl } from "./urls";
export { htmlToText, normalizeHref, sanitizeEmailHtml, wrapForSandbox } from "./sanitize";
export type { SanitizeResult, SanitizeOptions } from "./sanitize";

export const PARSE_LIMITS = {
  maxRawBytes: 50 * 1024 * 1024,
  maxTextChars: 2_000_000,
  maxHtmlChars: 4_000_000,
  maxAttachments: 100,
  maxHeaderBytes: 512 * 1024,
  /** MIME nesting depth above which a message is treated as a parser-abuse attempt. */
  maxMimeBoundaries: 200,
  parseTimeoutMs: 15_000,
};

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  disposition: "attachment" | "inline";
  cid?: string;
  /** Bytes stay in memory only for the scan. */
  content: Buffer;
}

export interface ParsedMail {
  subject: string;
  /** What a person actually sees: the HTML part's text when there is one, otherwise the plain part. */
  visibleText: string;
  from?: EmailAddress;
  sender?: EmailAddress;
  replyTo?: EmailAddress;
  returnPath?: string;
  to: EmailAddress[];
  cc: EmailAddress[];
  date?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  headers: Record<string, string[]>;
  authResults: string[];
  listUnsubscribe?: string;
  precedence?: string;
  autoSubmitted?: string;
  text: string;
  html?: string;
  sanitized?: SanitizeResult;
  urls: ExtractedUrl[];
  attachments: ParsedAttachment[];
  sizeBytes: number;
  /** Truthful flags when limits truncated or blocked part of the analysis. */
  limitsHit: string[];
}

export class MessageTooLargeError extends Error { override name = "MessageTooLargeError"; }
export class MessageParseError extends Error { override name = "MessageParseError"; }

/** PostgreSQL text can't hold NUL, and it's never legitimate in mail text. One NUL must not be able to stall a mailbox. */
const clean = (s: string) => (s.includes("\0") ? s.replace(/\0/g, "") : s);

function addr(o: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!o) return [];
  const list = Array.isArray(o) ? o : [o];
  const out: EmailAddress[] = [];
  const walk = (v: { address?: string; name?: string; group?: unknown[] }) => {
    if (v.address) out.push(v.name ? { name: clean(v.name).slice(0, 256), address: clean(v.address).toLowerCase().slice(0, 320) } : { address: clean(v.address).toLowerCase().slice(0, 320) });
    if (Array.isArray(v.group)) (v.group as typeof v[]).forEach(walk);
  };
  for (const a of list) a.value.forEach(walk);
  return out.slice(0, 500);
}

function headerMap(h: Map<string, unknown>, lines: { key: string; line: string }[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { key, line } of lines.slice(0, 2000)) {
    const v = line.slice(line.indexOf(":") + 1).replace(/\r?\n\s+/g, " ").trim();
    (out[key.toLowerCase()] ??= []).push(v.slice(0, 8192));
  }
  void h;
  return out;
}

function ids(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).flatMap(s => s.match(/<[^<>\s]{1,512}>/g) ?? []).slice(0, 200);
}

/** Bounded parse. Never resolves remote content. */
export async function parseMail(raw: Uint8Array | Buffer): Promise<ParsedMail> {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length > PARSE_LIMITS.maxRawBytes) throw new MessageTooLargeError(`message is ${buf.length} bytes; limit is ${PARSE_LIMITS.maxRawBytes}`);
  const limitsHit: string[] = [];
  const headerEnd = buf.indexOf("\r\n\r\n") >= 0 ? buf.indexOf("\r\n\r\n") : buf.indexOf("\n\n");
  if (headerEnd > PARSE_LIMITS.maxHeaderBytes) throw new MessageParseError("headers exceed limit");
  const boundaries = (buf.toString("latin1", 0, Math.min(buf.length, 4_000_000)).match(/^content-type:\s*multipart\//gim) ?? []).length;
  if (boundaries > PARSE_LIMITS.maxMimeBoundaries) throw new MessageParseError("too many MIME parts");

  let parsed;
  let timer: NodeJS.Timeout | undefined;
  try {
    parsed = await Promise.race([
      simpleParser(buf, { skipImageLinks: true, skipHtmlToText: false, skipTextLinks: true, keepCidLinks: true, maxHtmlLengthToParse: PARSE_LIMITS.maxHtmlChars } as Parameters<typeof simpleParser>[1]),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new MessageParseError("parse timed out")), PARSE_LIMITS.parseTimeoutMs); }),
    ]);
  } catch (e) {
    if (e instanceof MessageParseError) throw e;
    throw new MessageParseError("malformed message");
  } finally {
    if (timer) clearTimeout(timer);
  }

  let text = clean(parsed.text ?? "");
  if (text.length > PARSE_LIMITS.maxTextChars) { text = text.slice(0, PARSE_LIMITS.maxTextChars); limitsHit.push("text_truncated"); }
  let html = typeof parsed.html === "string" ? clean(parsed.html) : undefined;
  if (html && html.length > PARSE_LIMITS.maxHtmlChars) { html = html.slice(0, PARSE_LIMITS.maxHtmlChars); limitsHit.push("html_truncated"); }

  let rawAttachments: MPAttachment[] = parsed.attachments ?? [];
  if (rawAttachments.length > PARSE_LIMITS.maxAttachments) { rawAttachments = rawAttachments.slice(0, PARSE_LIMITS.maxAttachments); limitsHit.push("attachments_truncated"); }
  const attachments: ParsedAttachment[] = rawAttachments.map(a => ({
    filename: clean(a.filename ?? "unnamed").slice(0, 255),
    contentType: (a.contentType ?? "application/octet-stream").toLowerCase().slice(0, 127),
    size: a.size ?? a.content.length,
    sha256: createHash("sha256").update(a.content).digest("hex"),
    disposition: a.contentDisposition === "inline" ? "inline" : "attachment",
    cid: a.contentId?.replace(/[<>]/g, ""),
    content: a.content,
  }));

  const headers = headerMap(parsed.headers as Map<string, unknown>, (parsed.headerLines ?? []) as { key: string; line: string }[]);
  const one = (k: string) => headers[k]?.[0];
  const firstAddr = (o: AddressObject | AddressObject[] | undefined) => addr(o)[0];
  const senderLine = one("sender");
  const sanitized = html !== undefined ? sanitizeEmailHtml(html) : undefined;

  return {
    subject: clean(parsed.subject ?? "").slice(0, 998),
    visibleText: sanitized ? htmlToText(sanitized.html) : text,
    from: firstAddr(parsed.from),
    sender: senderLine ? { address: (senderLine.match(/[^\s<>"]+@[^\s<>"]+/)?.[0] ?? senderLine).toLowerCase() } : undefined,
    replyTo: firstAddr(parsed.replyTo),
    returnPath: one("return-path")?.replace(/[<>]/g, "").toLowerCase(),
    to: addr(parsed.to), cc: addr(parsed.cc),
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : undefined,
    messageId: parsed.messageId,
    inReplyTo: ids(parsed.inReplyTo)[0],
    references: ids(parsed.references),
    headers,
    authResults: [...(headers["authentication-results"] ?? []), ...(headers["arc-authentication-results"] ?? [])],
    listUnsubscribe: one("list-unsubscribe"),
    precedence: one("precedence")?.toLowerCase(),
    autoSubmitted: one("auto-submitted")?.toLowerCase(),
    text, html, sanitized,
    urls: extractUrls(text, html),
    attachments,
    sizeBytes: buf.length,
    limitsHit,
  };
}

/** Snippet from text. Never includes quoted content when avoidable. */
export function makeSnippet(text: string, n = 180): string {
  const lines = text.split(/\r?\n/).filter(l => !l.trim().startsWith(">") && !/^on .+wrote:$/i.test(l.trim()));
  return lines.join(" ").replace(/\s+/g, " ").trim().slice(0, n);
}

export function emailDomain(address?: string): string {
  if (!address) return "";
  const i = address.lastIndexOf("@");
  return i < 0 ? "" : address.slice(i + 1).toLowerCase().replace(/\.$/, "");
}

/** Removes reply prefixes for the conservative thread-subject check. */
export function normalizeSubject(s: string): string {
  let cur = s.trim();
  for (let i = 0; i < 8; i++) {
    const next = cur.replace(/^\s*(re|fw|fwd|aw|sv|vs|tr|rv)(\[\d+\])?\s*:\s*/i, "");
    if (next === cur) break;
    cur = next;
  }
  return cur.replace(/\s+/g, " ").trim().toLowerCase();
}
