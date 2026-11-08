export type ProviderKind = "gmail" | "microsoft" | "imap" | "pop3" | "demo";
export type FolderRole = "inbox" | "sent" | "drafts" | "archive" | "spam" | "trash" | "custom";

/** Truthful per-provider capability flags. UI and services branch on these, never on provider names. */
export interface ProviderCapabilities {
  twoWaySync: boolean;
  pushNotifications: boolean;
  /** Seconds. Displayed to users; never say "instant" for polling. */
  latencyBudgetSeconds: number;
  labels: "labels" | "folders" | "none";
  serverSearch: boolean;
  send: boolean;
  drafts: boolean;
  archive: boolean;
  moveToSpam: boolean;
  flags: boolean;
  oauth: boolean;
  revokeSupported: boolean;
  readOnlyMode: boolean;
  /** Plain-language limitations displayed at connection time. */
  limitations: string[];
}

export interface EmailAddress { name?: string; address: string }

export interface RemoteFolder { remoteId: string; name: string; role: FolderRole }

export interface RemoteState {
  folderRole: FolderRole;
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
}

export type MailChange =
  | { type: "upsert"; remoteId: string; remoteThreadId?: string; internalDate: string; state: RemoteState; raw?: Uint8Array }
  | { type: "state"; remoteId: string; state: Partial<RemoteState> }
  | { type: "delete"; remoteId: string };

export interface SyncPage {
  changes: MailChange[];
  /** Opaque cursor. Persisted only after every change in this page is durably recorded. */
  cursor: string;
  hasMore: boolean;
}

export interface OutboundMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  remoteThreadId?: string;
  /** RFC 5322 Message-ID we generate; makes send reconciliation possible. */
  messageId: string;
  /** Rendered into the MIME body by composeMime, so every adapter that uses it supports these. */
  attachments?: { filename: string; contentType: string; content: Uint8Array }[];
}

export interface SendResult {
  remoteId?: string;
  acceptedAt: string;
  /** The server took the message for the others but refused these at RCPT. Only SMTP can report this. */
  rejectedRecipients?: string[];
}

export type ConnectionProblem =
  | "auth_failed" | "tls_failed" | "host_unreachable" | "host_blocked" | "protocol_error"
  | "timeout" | "oauth_revoked" | "rate_limited" | "unknown";

export interface ConnectionTestResult {
  ok: boolean;
  problem?: ConnectionProblem;
  /** Safe, credential-free guidance for the user. */
  detail?: string;
  folders?: number;
}

export interface MessageChange {
  moveToRole?: FolderRole;
  isRead?: boolean;
  isStarred?: boolean;
  addLabels?: string[];
  removeLabels?: string[];
}

/** Thrown when a provider cursor is unusable and a full reconciliation is required. */
export class CursorExpiredError extends Error {
  override name = "CursorExpiredError";
}
/** Thrown when a grant was revoked; processing must stop and the user must be told. */
export class GrantRevokedError extends Error {
  override name = "GrantRevokedError";
}
/** Retryable provider throttling. */
export class RateLimitedError extends Error {
  override name = "RateLimitedError";
  constructor(message: string, readonly retryAfterSeconds?: number) { super(message); }
}
/** Send outcome is unknown (e.g. timed out after write). Must reconcile before any retry. */
export class SendOutcomeUnknownError extends Error {
  override name = "SendOutcomeUnknownError";
}
/** The requested action isn't possible with this provider or grant. */
export class UnsupportedOperationError extends Error {
  override name = "UnsupportedOperationError";
}

export interface MailAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  testConnection(): Promise<ConnectionTestResult>;
  listFolders(): Promise<RemoteFolder[]>;
  /** Full sync of a bounded recent window. Pass the prior page's cursor to continue. */
  fullSync(opts: { windowDays: number; pageSize: number; cursor?: string }): Promise<SyncPage>;
  /** @throws CursorExpiredError when the cursor is no longer valid. */
  incrementalSync(cursor: string, opts: { pageSize: number }): Promise<SyncPage>;
  fetchRaw(remoteId: string): Promise<Uint8Array>;
  /** Returns the message's new id when the change gave it one, as an IMAP move does. Absent when it kept its id, or it isn't known. */
  applyChange(remoteId: string, change: MessageChange): Promise<void | { remoteId?: string }>;
  /** Whether an id from an earlier cursor generation can still name a message. Only for ids that can go stale (IMAP UIDVALIDITY). */
  isRemoteIdCurrent?(remoteId: string, cursor: string): boolean;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Reconciliation: was a message with this RFC 5322 Message-ID actually sent? */
  findSentByMessageId(messageId: string): Promise<{ remoteId: string } | null>;
  /** Establish or renew push. Returns next required renewal, or null when not supported. */
  renewPush?(): Promise<{ expiresAt: string; state?: Record<string, string> } | null>;
  stopPush?(): Promise<void>;
  /** Best effort. Returns false when the provider has no revocation API. */
  revoke(): Promise<boolean>;
  close?(): Promise<void>;
}

export const CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  gmail: {
    twoWaySync: true, pushNotifications: true, latencyBudgetSeconds: 60, labels: "labels", serverSearch: true,
    send: true, drafts: true, archive: true, moveToSpam: true, flags: true, oauth: true, revokeSupported: true, readOnlyMode: true,
    limitations: ["Quarantine happens after Gmail receives the message. It can still be opened in other Gmail clients."],
  },
  microsoft: {
    twoWaySync: true, pushNotifications: true, latencyBudgetSeconds: 180, labels: "folders", serverSearch: true,
    send: true, drafts: true, archive: true, moveToSpam: true, flags: true, oauth: true, revokeSupported: false, readOnlyMode: true,
    limitations: [
      "Quarantine happens after Microsoft receives the message.",
      "Microsoft has no per-app revoke API for delegated users. Remove access at myaccount.microsoft.com to finish revoking.",
    ],
  },
  imap: {
    twoWaySync: true, pushNotifications: false, latencyBudgetSeconds: 120, labels: "folders", serverSearch: false,
    send: true, drafts: true, archive: true, moveToSpam: true, flags: true, oauth: false, revokeSupported: false, readOnlyMode: true,
    limitations: [
      "New mail appears by polling, within about 2 minutes. It isn't instant.",
      "Revoke access by deleting the app password at your provider.",
    ],
  },
  pop3: {
    twoWaySync: false, pushNotifications: false, latencyBudgetSeconds: 900, labels: "none", serverSearch: false,
    send: false, drafts: false, archive: false, moveToSpam: false, flags: false, oauth: false, revokeSupported: false, readOnlyMode: true,
    limitations: [
      "POP3 is import only: no folders, labels, server search or read status sync.",
      "Changes here don't reach your mail server.",
      "Sending isn't available on this connection.",
    ],
  },
  demo: {
    twoWaySync: true, pushNotifications: false, latencyBudgetSeconds: 5, labels: "labels", serverSearch: false,
    send: true, drafts: true, archive: true, moveToSpam: true, flags: true, oauth: false, revokeSupported: true, readOnlyMode: false,
    limitations: ["Demo mailbox: synthetic messages only. Nothing is really sent."],
  },
};
