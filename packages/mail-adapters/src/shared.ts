import MailComposer from "nodemailer/lib/mail-composer";
import {
  CAPABILITIES,
  type ConnectionProblem,
  type OutboundMessage,
  type ProviderCapabilities,
  type ProviderKind,
} from "@aegis/domain/mail";
import { HostBlockedError } from "./ssrf";

/** A provider answered with an error status. The message carries only the status and a sanitized code. */
export class ProviderHttpError extends Error {
  override name = "ProviderHttpError";
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

/** The request never produced a response. Holds no URL, headers or provider text. */
export class ProviderNetworkError extends Error {
  override name = "ProviderNetworkError";
  constructor(message: string, readonly timedOut: boolean) { super(message); }
}

/** Seconds from a Retry-After header (delta-seconds or HTTP-date). Undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** Parses JSON without letting the parser's error, which quotes the input, escape. */
export async function readJson(res: Response, label: string): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new Error(`${label} returned a malformed response`);
  }
}

/** Provider error codes are echoed into our errors, so only plain identifiers survive. */
export function safeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Returns the id in `<id>` form. Rejects anything that could smuggle a header, search operator or command. */
export function normalizeMessageId(messageId: string): string {
  const bare = messageId.trim().replace(/^<|>$/g, "");
  if (!/^[\x21-\x3b\x3d\x3f-\x7e]{1,900}$/.test(bare)) throw new TypeError("Invalid Message-ID");
  return `<${bare}>`;
}

export interface ComposedMessage { raw: Buffer; envelope: { from: string; to: string[] } }

/**
 * Renders RFC 5322 with our Message-ID. API senders read recipients from the headers, so they need
 * keepBcc; SMTP passes Bcc in the envelope and must not leak it into the message.
 */
export async function composeMime(message: OutboundMessage, opts: { keepBcc: boolean }): Promise<ComposedMessage> {
  const node = new MailComposer({
    from: message.from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.text,
    html: message.html,
    inReplyTo: message.inReplyTo,
    references: message.references,
    messageId: normalizeMessageId(message.messageId),
    attachments: message.attachments?.map(a => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.content) })),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  node.keepBcc = opts.keepBcc;
  const envelope = node.getEnvelope() as { from: string | false; to: string[] };
  return { raw: await node.build(), envelope: { from: envelope.from || "", to: envelope.to } };
}

/** CAPABILITIES narrowed to what this account's grant and configuration can really do. */
export function effectiveCapabilities(
  kind: ProviderKind,
  opts: { readOnly: boolean; push?: boolean; send?: boolean },
): ProviderCapabilities {
  const caps: ProviderCapabilities = { ...CAPABILITIES[kind], limitations: [...CAPABILITIES[kind].limitations] };
  if (opts.push === false && caps.pushNotifications) {
    caps.pushNotifications = false;
    caps.limitations.push("Push isn't configured for this deployment. New mail appears by polling.");
  }
  if (opts.send === false && caps.send) {
    caps.send = false;
    caps.limitations.push("Sending isn't available because no outgoing server is configured.");
  }
  if (opts.readOnly) {
    Object.assign(caps, { twoWaySync: false, send: false, drafts: false, archive: false, moveToSpam: false, flags: false });
    caps.limitations.push("Connected read-only. Changes here don't reach your mailbox.");
  }
  return caps;
}

const DETAILS: Record<ConnectionProblem, string> = {
  auth_failed: "The server rejected the username or password.",
  tls_failed: "A secure connection could not be established or the server certificate did not verify.",
  host_unreachable: "The server could not be reached.",
  host_blocked: "That server address isn't allowed.",
  protocol_error: "The server sent a response we could not understand.",
  timeout: "The server took too long to respond.",
  oauth_revoked: "Access was revoked. Reconnect this account.",
  rate_limited: "The provider is rate limiting requests. Try again shortly.",
  unknown: "The connection test failed.",
};

const ICLOUD_AUTH_HINT =
  "iCloud requires an app-specific password, not your Apple Account password. Create one at account.apple.com under Sign-In and Security.";

/** Credential-free guidance for a connection problem. Provider-supplied text is never included. */
export function problemDetail(problem: ConnectionProblem, host?: string): string {
  if (problem === "auth_failed" && host && /(^|\.)mail\.me\.com$/i.test(host)) return ICLOUD_AUTH_HINT;
  return DETAILS[problem];
}

const TLS_CODE = /^(ERR_TLS|ERR_SSL|CERT_|EPROTO$|ETLS$|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_|HOSTNAME_MISMATCH|STARTTLS_INJECTION$|UPGRADE_FAILED$)/;
const TIMEOUT_CODE = /^(ETIMEDOUT|ETIMEOUT|CONNECT_TIMEOUT|GREETING_TIMEOUT|UPGRADE_TIMEOUT)$/;
const UNREACHABLE_CODE =
  /^(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EDNS|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ECONNECTION|ESOCKET|NoConnection|EConnectionClosed)$/;

/** Maps an IMAP/SMTP/POP3 connection failure to a ConnectionProblem by error code only, never by message text. */
export function classifyConnectionError(err: unknown): ConnectionProblem {
  if (err instanceof HostBlockedError) return "host_blocked";
  const e = err as { authenticationFailed?: boolean; tlsFailed?: boolean; code?: unknown; originalCode?: unknown; problem?: unknown };
  if (typeof e?.problem === "string") return e.problem as ConnectionProblem;
  if (e?.authenticationFailed) return "auth_failed";
  if (e?.tlsFailed) return "tls_failed";
  const codes = [e?.originalCode, e?.code].filter((c): c is string => typeof c === "string");
  if (codes.includes("EAUTH") || codes.includes("ENOAUTH")) return "auth_failed";
  if (codes.some((c) => TLS_CODE.test(c))) return "tls_failed";
  if (codes.some((c) => TIMEOUT_CODE.test(c))) return "timeout";
  if (codes.some((c) => UNREACHABLE_CODE.test(c))) return "host_unreachable";
  return "protocol_error";
}

/** Providers that are refused for password protocols, because Basic auth no longer works there. */
export function isOutlookHost(host: string): boolean {
  return /(^|\.)(outlook\.office365\.com|office365\.com|outlook\.com|hotmail\.com|live\.com)$/i.test(host.replace(/\.$/, ""));
}
