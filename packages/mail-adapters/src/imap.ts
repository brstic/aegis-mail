import { ImapFlow } from "imapflow";
import {
  CursorExpiredError,
  UnsupportedOperationError,
  type ConnectionProblem,
  type ConnectionTestResult,
  type FolderRole,
  type MailAdapter,
  type MailChange,
  type MessageChange,
  type OutboundMessage,
  type ProviderCapabilities,
  type RemoteFolder,
  type SendResult,
  type SyncPage,
} from "@aegis/domain/mail";
import { classifyConnectionError, effectiveCapabilities, isOutlookHost, normalizeMessageId, problemDetail } from "./shared";
import { createSmtpSender, type SmtpSender } from "./smtp";
import { HostBlockedError, createHostGuard, type HostGuard } from "./ssrf";

/** Per-folder cap on UIDs tracked in the cursor for expunge and flag reconciliation. */
export const MAX_TRACKED_UIDS = 5_000;
/** A larger message is reported without raw content rather than truncated or buffered. */
export const IMAP_MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const MAX_FOLDERS = 100;
const SEEN = 1;
const FLAGGED = 2;

export interface ImapMailbox { path: string; name: string; specialUse?: string; flags: string[] }
export interface ImapMailboxStatus { uidValidity: string; uidNext: number; highestModseq?: string }
export interface ImapFlagRow { uid: number; flags: string[] }
export interface ImapFetched extends ImapFlagRow { internalDate?: Date; raw?: Uint8Array }

/** The few IMAP operations sync needs. Fake it to test sync logic; imapflow backs it in production. */
export interface ImapPort {
  list(): Promise<ImapMailbox[]>;
  open(path: string, opts: { readOnly: boolean }): Promise<ImapMailboxStatus>;
  searchUids(query: { since?: Date; uidRange?: string }): Promise<number[]>;
  fetchFlags(uidRange: string, changedSince?: string): Promise<ImapFlagRow[]>;
  fetchMessages(uids: number[]): Promise<ImapFetched[]>;
  findByMessageId(messageId: string): Promise<number[]>;
  addFlags(uid: number, flags: string[]): Promise<void>;
  removeFlags(uid: number, flags: string[]): Promise<void>;
  /** Resolves to where it landed when the server says (COPYUID), so the caller can keep following it. */
  move(uid: number, destinationPath: string): Promise<void | { uid: number; uidValidity: string }>;
  close(): Promise<void>;
}

/** Sync position for one folder. `known` is `[uid, flagBits]`; `fullAfter` is present while a window backfill runs. */
export interface ImapFolderCursor {
  uidValidity: string;
  uidNext: number;
  modseq?: string;
  known: Array<[number, number]>;
  fullAfter?: number;
}
export type ImapCursor = Record<string, ImapFolderCursor>;

export function parseImapCursor(value: string): ImapCursor {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const valid = Object.values(parsed).every((c: any) =>
        typeof c?.uidValidity === "string" && Number.isInteger(c?.uidNext) && Array.isArray(c?.known) &&
        c.known.every((k: any) => Array.isArray(k) && Number.isInteger(k[0]) && Number.isInteger(k[1])));
      if (valid) return parsed as ImapCursor;
    }
  } catch { /* falls through */ }
  throw new CursorExpiredError("IMAP cursor is not usable");
}

export function encodeImapRemoteId(folder: string, uidValidity: string, uid: number): string {
  return `${folder}:${uidValidity}:${uid}`;
}

/** Splits from the right, because a folder path may itself contain colons. */
export function parseImapRemoteId(remoteId: string): { folder: string; uidValidity: string; uid: number } {
  const match = /^(.+):(\d+):(\d+)$/s.exec(remoteId);
  if (!match) throw new TypeError("Not an IMAP message id");
  return { folder: match[1] as string, uidValidity: match[2] as string, uid: Number(match[3]) };
}

function flagBits(flags: readonly string[]): number {
  const lower = flags.map((f) => f.toLowerCase());
  return (lower.includes("\\seen") ? SEEN : 0) | (lower.includes("\\flagged") ? FLAGGED : 0);
}

const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
  "\\inbox": "inbox", "\\sent": "sent", "\\drafts": "drafts", "\\archive": "archive", "\\junk": "spam", "\\trash": "trash",
};
const NAME_ROLES: Record<string, FolderRole> = {
  inbox: "inbox",
  sent: "sent", "sent items": "sent", "sent mail": "sent", "sent messages": "sent",
  drafts: "drafts", draft: "drafts",
  archive: "archive", archives: "archive",
  junk: "spam", spam: "spam", "junk e-mail": "spam", "junk email": "spam", "bulk mail": "spam",
  trash: "trash", bin: "trash", deleted: "trash", "deleted items": "trash", "deleted messages": "trash",
};

export function imapFolderRole(box: Pick<ImapMailbox, "path" | "name" | "specialUse">): FolderRole {
  if (box.path.toUpperCase() === "INBOX") return "inbox";
  const special = box.specialUse ? SPECIAL_USE_ROLES[box.specialUse.toLowerCase()] : undefined;
  return special ?? NAME_ROLES[box.name.trim().toLowerCase()] ?? "custom";
}

/**
 * Mailboxes we can sync, role folders first so the folder cap can't drop the inbox. \\All and \\Flagged
 * are virtual views that would duplicate every message in them.
 */
function selectableBoxes(boxes: readonly ImapMailbox[]): ImapMailbox[] {
  const selectable = boxes.filter((b) => {
    const flags = b.flags.map((f) => f.toLowerCase());
    if (flags.includes("\\noselect") || flags.includes("\\nonexistent")) return false;
    const special = b.specialUse?.toLowerCase();
    return special !== "\\all" && special !== "\\flagged" && special !== "\\important";
  });
  const rank = (b: ImapMailbox) => (imapFolderRole(b) === "custom" ? 1 : 0);
  return selectable.sort((a, b) => rank(a) - rank(b));
}

function syncableBoxes(boxes: readonly ImapMailbox[]): ImapMailbox[] {
  return selectableBoxes(boxes).slice(0, MAX_FOLDERS);
}

function folderForRole(boxes: readonly ImapMailbox[], role: FolderRole): ImapMailbox | undefined {
  const matches = boxes.filter((b) => imapFolderRole(b) === role);
  return matches.find((b) => b.specialUse) ?? matches[0];
}

/**
 * Compares what the cursor knows with what the server reports. Tracked UIDs missing from `presentUids`
 * were expunged. `flagRows` may be partial (CONDSTORE); with `reportUntracked` a row for a UID older
 * than the tracked window is still reported, since only that UID's state can have changed.
 */
export function reconcileFolder(input: {
  folder: string;
  uidValidity: string;
  known: ReadonlyArray<readonly [number, number]>;
  presentUids: readonly number[];
  flagRows: readonly ImapFlagRow[];
  reportUntracked?: boolean;
  maxTracked?: number;
}): { changes: MailChange[]; known: Array<[number, number]> } {
  const present = new Set(input.presentUids);
  const next = new Map<number, number>();
  const changes: MailChange[] = [];
  const id = (uid: number) => encodeImapRemoteId(input.folder, input.uidValidity, uid);
  for (const [uid, bits] of input.known) {
    if (present.has(uid)) next.set(uid, bits);
    else changes.push({ type: "delete", remoteId: id(uid) });
  }
  const tracked = new Set(input.known.map(([uid]) => uid));
  for (const row of input.flagRows) {
    const bits = flagBits(row.flags);
    const previous = next.get(row.uid);
    const untracked = !tracked.has(row.uid);
    if (untracked ? !input.reportUntracked : previous === undefined || previous === bits) continue;
    if (!untracked) next.set(row.uid, bits);
    changes.push({ type: "state", remoteId: id(row.uid), state: { isRead: (bits & SEEN) !== 0, isStarred: (bits & FLAGGED) !== 0 } });
  }
  return { changes, known: trimKnown(next, input.maxTracked) };
}

function trimKnown(known: ReadonlyMap<number, number>, max = MAX_TRACKED_UIDS): Array<[number, number]> {
  return [...known].sort((a, b) => a[0] - b[0]).slice(-max);
}

function toUpsert(row: ImapFetched, folder: string, uidValidity: string, role: FolderRole, nowMs: number): MailChange {
  const bits = flagBits(row.flags);
  return {
    type: "upsert",
    remoteId: encodeImapRemoteId(folder, uidValidity, row.uid),
    internalDate: (row.internalDate ?? new Date(nowMs)).toISOString(),
    state: { folderRole: role, labels: [], isRead: (bits & SEEN) !== 0, isStarred: (bits & FLAGGED) !== 0 },
    ...(row.raw ? { raw: row.raw } : {}),
  };
}

export interface FolderSyncResult { changes: MailChange[]; cursor: ImapFolderCursor; more: boolean }

/** One page of the windowed backfill. UIDs at or past the snapshot's uidNext are left for incremental sync. */
export async function fullSyncFolder(
  port: ImapPort, box: ImapMailbox, prev: ImapFolderCursor | undefined, opts: { since: Date; budget: number; nowMs: number },
): Promise<FolderSyncResult> {
  const status = await port.open(box.path, { readOnly: true });
  if (prev && prev.uidValidity !== status.uidValidity) throw new CursorExpiredError("IMAP UIDVALIDITY changed during full sync");
  const cur: ImapFolderCursor = prev ?? {
    uidValidity: status.uidValidity,
    uidNext: status.uidNext,
    ...(status.highestModseq ? { modseq: status.highestModseq } : {}),
    known: [],
    fullAfter: 0,
  };
  const after = cur.fullAfter ?? 0;
  const top = cur.uidNext - 1;
  if (top <= after) return { changes: [], cursor: withoutFullAfter(cur), more: false };

  const uids = (await port.searchUids({ since: opts.since, uidRange: `${after + 1}:${top}` }))
    .filter((uid) => uid > after && uid <= top)
    .sort((a, b) => a - b);
  const page = uids.slice(0, opts.budget);
  const rows = page.length ? await port.fetchMessages(page) : [];
  const known = new Map(cur.known);
  for (const row of rows) known.set(row.uid, flagBits(row.flags));
  const role = imapFolderRole(box);
  const changes = rows.map((row) => toUpsert(row, box.path, cur.uidValidity, role, opts.nowMs));
  const next = { ...cur, known: trimKnown(known) };
  if (uids.length > page.length) return { changes, cursor: { ...next, fullAfter: page[page.length - 1] as number }, more: true };
  return { changes, cursor: withoutFullAfter(next), more: false };
}

function withoutFullAfter(cursor: ImapFolderCursor): ImapFolderCursor {
  const { fullAfter: _done, ...rest } = cursor;
  return rest;
}

/** New UIDs from uidNext, then expunge and flag reconciliation for what was already known. */
export async function incrementalSyncFolder(
  port: ImapPort, box: ImapMailbox, prev: ImapFolderCursor | undefined, opts: { budget: number; nowMs: number },
): Promise<FolderSyncResult> {
  const status = await port.open(box.path, { readOnly: true });
  // A folder that appeared since the last sync starts from its first UID.
  const cur: ImapFolderCursor = prev ?? {
    uidValidity: status.uidValidity,
    uidNext: 1,
    ...(status.highestModseq ? { modseq: status.highestModseq } : {}),
    known: [],
  };
  if (cur.fullAfter !== undefined) throw new CursorExpiredError("IMAP full sync has not finished");
  if (cur.uidValidity !== status.uidValidity) throw new CursorExpiredError("IMAP UIDVALIDITY changed");

  const role = imapFolderRole(box);
  const changes: MailChange[] = [];
  const fresh = new Map<number, number>();
  let uidNext = cur.uidNext;
  let more = false;
  if (status.uidNext > cur.uidNext) {
    // "n:*" always matches the highest message, even when its UID is below n, so filter.
    const uids = (await port.searchUids({ uidRange: `${cur.uidNext}:*` }))
      .filter((uid) => uid >= cur.uidNext)
      .sort((a, b) => a - b);
    const page = uids.slice(0, opts.budget);
    const rows = page.length ? await port.fetchMessages(page) : [];
    for (const row of rows) {
      fresh.set(row.uid, flagBits(row.flags));
      changes.push(toUpsert(row, box.path, cur.uidValidity, role, opts.nowMs));
    }
    more = uids.length > page.length;
    const last = page[page.length - 1] ?? 0;
    uidNext = more ? last + 1 : Math.max(status.uidNext, last + 1);
  }

  const trackedUids = cur.known.map(([uid]) => uid);
  const lo = trackedUids.length ? Math.min(...trackedUids) : 0;
  const hi = trackedUids.length ? Math.max(...trackedUids) : 0;
  const presentUids = trackedUids.length ? await port.searchUids({ uidRange: `${lo}:${hi}` }) : [];

  const useCondstore = !!cur.modseq && !!status.highestModseq;
  let flagRows: ImapFlagRow[] = [];
  if (useCondstore) {
    if (cur.modseq !== status.highestModseq) flagRows = await port.fetchFlags("1:*", cur.modseq);
  } else if (trackedUids.length) {
    flagRows = await port.fetchFlags(`${lo}:${hi}`);
  }

  const reconciled = reconcileFolder({
    folder: box.path,
    uidValidity: cur.uidValidity,
    known: cur.known,
    presentUids,
    // New mail is reported by its upsert; anything past uidNext hasn't been reported at all yet.
    flagRows: flagRows.filter((row) => row.uid < cur.uidNext),
    reportUntracked: useCondstore,
  });
  changes.push(...reconciled.changes);
  const known = new Map(reconciled.known);
  for (const [uid, bits] of fresh) known.set(uid, bits);
  return {
    changes,
    more,
    cursor: {
      uidValidity: cur.uidValidity,
      uidNext,
      ...(status.highestModseq ? { modseq: status.highestModseq } : {}),
      known: trimKnown(known),
    },
  };
}

export interface ImapConnectParams { user: string; pass: string }

/** Failure in an IMAP operation. Holds a safe message and the classified problem, never server text. */
export class ImapError extends Error {
  override name = "ImapError";
  constructor(message: string, readonly problem: ConnectionProblem) { super(message); }
}

/**
 * imapflow reports a refused SEARCH, STORE or MOVE by resolving false. Passing that on as an empty
 * result would read as "every tracked message was expunged", and a failed write as a successful one.
 */
function required<T>(result: T | false | undefined, command: string): T {
  if (result === false || result === undefined) throw new ImapError(`IMAP server refused ${command}`, "protocol_error");
  return result;
}

export function imapFlowPort(client: ImapFlow): ImapPort {
  return {
    async list() {
      const boxes = await client.list();
      return boxes.map((b) => ({
        path: b.path,
        name: b.name,
        ...(b.specialUse ? { specialUse: b.specialUse } : {}),
        flags: [...b.flags],
      }));
    },
    async open(path, { readOnly }) {
      const box = await client.mailboxOpen(path, { readOnly });
      let uidNext = box.uidNext;
      if (!uidNext) {
        const all = required(await client.search({ all: true }, { uid: true }), "SEARCH");
        uidNext = (all.length ? Math.max(...all) : 0) + 1;
      }
      return {
        uidValidity: String(box.uidValidity),
        uidNext,
        // CHANGEDSINCE is dropped unless CONDSTORE is enabled, which would turn it into a full mailbox fetch.
        ...(box.highestModseq !== undefined && !box.noModseq && client.enabled.has("CONDSTORE") ? { highestModseq: String(box.highestModseq) } : {}),
      };
    },
    async searchUids({ since, uidRange }) {
      return required(await client.search({ ...(since ? { since } : {}), ...(uidRange ? { uid: uidRange } : {}) }, { uid: true }), "SEARCH");
    },
    async fetchFlags(uidRange, changedSince) {
      const rows = await client.fetchAll(
        uidRange,
        { uid: true, flags: true },
        { uid: true, ...(changedSince ? { changedSince: BigInt(changedSince) } : {}) },
      );
      return rows.map((r) => ({ uid: r.uid, flags: [...(r.flags ?? [])] }));
    },
    async fetchMessages(uids) {
      // source uses BODY.PEEK, so syncing never marks mail as read.
      const rows = await client.fetchAll(
        uids.join(","),
        { uid: true, flags: true, internalDate: true, size: true, source: { maxLength: IMAP_MAX_MESSAGE_BYTES } },
        { uid: true },
      );
      return rows.map((r) => {
        const oversized = (r.size ?? 0) > IMAP_MAX_MESSAGE_BYTES;
        return {
          uid: r.uid,
          flags: [...(r.flags ?? [])],
          ...(r.internalDate ? { internalDate: new Date(r.internalDate) } : {}),
          ...(r.source && !oversized ? { raw: new Uint8Array(r.source) } : {}),
        };
      });
    },
    async findByMessageId(messageId) {
      return required(await client.search({ header: { "message-id": messageId } }, { uid: true }), "SEARCH");
    },
    async addFlags(uid, flags) {
      required((await client.messageFlagsAdd(String(uid), flags, { uid: true })) || false, "STORE");
    },
    async removeFlags(uid, flags) {
      required((await client.messageFlagsRemove(String(uid), flags, { uid: true })) || false, "STORE");
    },
    async move(uid, destinationPath) {
      const moved = required(await client.messageMove(String(uid), destinationPath, { uid: true }), "MOVE");
      const newUid = moved.uidMap?.get(uid);
      return newUid !== undefined && moved.uidValidity !== undefined ? { uid: newUid, uidValidity: String(moved.uidValidity) } : undefined;
    },
    async close() {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    },
  };
}

export interface ImapServerConfig { host: string; port: number; security: "tls" | "starttls" }

/** Connects to the pinned IP. TLS is verified against the configured hostname, and STARTTLS can't be skipped. */
export async function connectImap(
  server: ImapServerConfig, login: ImapConnectParams, opts: { hostGuard: HostGuard; ca?: string | Buffer; timeoutMs?: number },
): Promise<ImapPort> {
  if (server.security !== "tls" && server.security !== "starttls") throw new TypeError("IMAP requires tls or starttls");
  const pinned = await opts.hostGuard.checkHost(server.host, server.port, { protocol: "imap" });
  const timeout = opts.timeoutMs ?? 60_000;
  const client = new ImapFlow({
    host: pinned.ip,
    port: pinned.port,
    secure: server.security === "tls",
    ...(server.security === "starttls" ? { doSTARTTLS: true } : {}),
    ...(pinned.servername ? { servername: pinned.servername } : {}),
    auth: { user: login.user, pass: login.pass },
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(opts.ca ? { ca: opts.ca } : {}) },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    // Decompression is a size amplifier that a hostile server could use against the worker.
    disableCompression: true,
    connectionTimeout: Math.min(timeout, 20_000),
    greetingTimeout: Math.min(timeout, 15_000),
    socketTimeout: timeout,
  });
  // ImapFlow is an EventEmitter: an unobserved 'error' would take down the process.
  client.on("error", () => undefined);
  await client.connect();
  return imapFlowPort(client);
}

function isICloudImap(host: string): boolean {
  return /(^|\.)mail\.me\.com$/i.test(host);
}

export interface ImapAdapterOptions {
  account: { email: string; readOnly: boolean };
  username: string;
  password: string;
  imap: ImapServerConfig;
  smtp?: { host: string; port: number; security: "tls" | "starttls" };
  hostGuard?: HostGuard;
  now?: () => number;
  /** Extra trust anchors. Verification stays on; this exists so tests can use an in-process CA. */
  ca?: string | Buffer;
  /** Swaps the imapflow connection, for sync logic tests. */
  connectPort?: (login: ImapConnectParams) => Promise<ImapPort>;
}

export function createImapAdapter(opts: ImapAdapterOptions): MailAdapter {
  if (opts.imap.security !== "tls" && opts.imap.security !== "starttls") throw new TypeError("IMAP requires tls or starttls");
  if (isOutlookHost(opts.imap.host)) {
    throw new UnsupportedOperationError("Outlook.com and Microsoft 365 don't accept passwords over IMAP. Use Microsoft sign-in.");
  }
  return new ImapAdapter(opts);
}

class ImapAdapter implements MailAdapter {
  readonly kind = "imap" as const;
  readonly capabilities: ProviderCapabilities;
  #opts: ImapAdapterOptions;
  #guard: HostGuard;
  #smtp: SmtpSender | undefined;
  #workingUser: string | undefined;

  constructor(opts: ImapAdapterOptions) {
    this.#opts = opts;
    this.#guard = opts.hostGuard ?? createHostGuard();
    this.#smtp = opts.smtp
      ? createSmtpSender(opts.smtp, { username: opts.username, password: opts.password, email: opts.account.email }, {
          hostGuard: this.#guard,
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.ca ? { ca: opts.ca } : {}),
        })
      : undefined;
    this.capabilities = effectiveCapabilities("imap", { readOnly: opts.account.readOnly, send: !!opts.smtp });
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  /** iCloud usually wants the local part and sometimes the full address, so both are tried in that order. */
  #logins(): string[] {
    const { username, account, imap } = this.#opts;
    if (this.#workingUser) return [this.#workingUser];
    if (!isICloudImap(imap.host)) return [username];
    const full = username.includes("@") ? username : account.email;
    const local = full.slice(0, full.lastIndexOf("@"));
    return local ? [local, full] : [full];
  }

  async #connect(): Promise<ImapPort> {
    let lastError: unknown;
    for (const user of this.#logins()) {
      try {
        const login = { user, pass: this.#opts.password };
        const port = this.#opts.connectPort
          ? await this.#opts.connectPort(login)
          : await connectImap(this.#opts.imap, login, { hostGuard: this.#guard, ...(this.#opts.ca ? { ca: this.#opts.ca } : {}) });
        this.#workingUser = user;
        return port;
      } catch (err) {
        lastError = err;
        if (classifyConnectionError(err) !== "auth_failed") break;
      }
    }
    throw lastError;
  }

  /** One connection per operation. Library errors are replaced: their text can quote the server. */
  async #withPort<T>(fn: (port: ImapPort) => Promise<T>): Promise<T> {
    let port: ImapPort | undefined;
    try {
      port = await this.#connect();
      return await fn(port);
    } catch (err) {
      if (
        err instanceof CursorExpiredError || err instanceof UnsupportedOperationError || err instanceof HostBlockedError
      ) throw err;
      const problem = classifyConnectionError(err);
      throw new ImapError(problemDetail(problem, this.#opts.imap.host), problem);
    } finally {
      await port?.close().catch(() => undefined);
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    let folders: number;
    try {
      folders = await this.#withPort(async (port) => syncableBoxes(await port.list()).length);
    } catch (err) {
      const problem = classifyConnectionError(err);
      return { ok: false, problem, detail: problemDetail(problem, this.#opts.imap.host) };
    }
    if (this.#smtp) {
      const smtp = await this.#smtp.test();
      if (!smtp.ok) return { ...smtp, detail: `Outgoing mail: ${smtp.detail ?? ""}`.trim(), folders };
    }
    return { ok: true, folders };
  }

  async listFolders(): Promise<RemoteFolder[]> {
    return this.#withPort(async (port) =>
      syncableBoxes(await port.list()).map((b) => ({ remoteId: b.path, name: b.name, role: imapFolderRole(b) })));
  }

  async fullSync(opts: { windowDays: number; pageSize: number; cursor?: string }): Promise<SyncPage> {
    if (!Number.isInteger(opts.windowDays) || opts.windowDays < 1) throw new TypeError("windowDays must be a positive integer");
    const cursor = opts.cursor ? parseImapCursor(opts.cursor) : {};
    const nowMs = this.#now();
    const since = new Date(nowMs - opts.windowDays * 86_400_000);
    return this.#withPort(async (port) => {
      const boxes = syncableBoxes(await port.list());
      const changes: MailChange[] = [];
      for (const box of boxes) {
        if (changes.length >= opts.pageSize) break;
        const entry = cursor[box.path];
        if (entry && entry.fullAfter === undefined) continue;
        const result = await fullSyncFolder(port, box, entry, { since, budget: opts.pageSize - changes.length, nowMs });
        cursor[box.path] = result.cursor;
        changes.push(...result.changes);
      }
      const hasMore = boxes.some((b) => { const e = cursor[b.path]; return !e || e.fullAfter !== undefined; });
      return { changes, cursor: JSON.stringify(cursor), hasMore };
    });
  }

  async incrementalSync(cursorValue: string, opts: { pageSize: number }): Promise<SyncPage> {
    const cursor = parseImapCursor(cursorValue);
    const nowMs = this.#now();
    return this.#withPort(async (port) => {
      const listed = await port.list();
      // Every mailbox has an INBOX. A listing without one is a bad answer, not a mailbox whose
      // folders all vanished, and must not be read as deleting everything tracked.
      if (!listed.some((b) => imapFolderRole(b) === "inbox")) throw new ImapError("IMAP server returned an unusable folder list", "protocol_error");
      const boxes = syncableBoxes(listed);
      const changes: MailChange[] = [];
      // A folder that has gone away (deleted or renamed) takes its tracked messages with it. This
      // checks everything listed, so a folder merely past the cap isn't mistaken for a deleted one.
      const live = new Set(selectableBoxes(listed).map((b) => b.path));
      for (const [path, entry] of Object.entries(cursor)) {
        if (live.has(path)) continue;
        for (const [uid] of entry.known) changes.push({ type: "delete", remoteId: encodeImapRemoteId(path, entry.uidValidity, uid) });
        delete cursor[path];
      }
      let hasMore = false;
      for (const box of boxes) {
        if (changes.length >= opts.pageSize) { hasMore = true; break; }
        const result = await incrementalSyncFolder(port, box, cursor[box.path], { budget: opts.pageSize - changes.length, nowMs });
        cursor[box.path] = result.cursor;
        changes.push(...result.changes);
        hasMore ||= result.more;
      }
      return { changes, cursor: JSON.stringify(cursor), hasMore };
    });
  }

  async fetchRaw(remoteId: string): Promise<Uint8Array> {
    const { folder, uidValidity, uid } = parseImapRemoteId(remoteId);
    return this.#withPort(async (port) => {
      const status = await port.open(folder, { readOnly: true });
      if (status.uidValidity !== uidValidity) throw new CursorExpiredError("IMAP UIDVALIDITY changed");
      const [row] = await port.fetchMessages([uid]);
      if (!row?.raw) throw new ImapError("Message is not available", "protocol_error");
      return row.raw;
    });
  }

  async applyChange(remoteId: string, change: MessageChange): Promise<void | { remoteId?: string }> {
    if (this.#opts.account.readOnly) throw new UnsupportedOperationError("This account is connected read-only");
    if (change.addLabels?.length || change.removeLabels?.length) throw new UnsupportedOperationError("IMAP has folders, not labels");
    if (change.moveToRole === "custom") throw new UnsupportedOperationError("Moving to a custom folder needs a folder name");
    const { folder, uidValidity, uid } = parseImapRemoteId(remoteId);
    return this.#withPort(async (port) => {
      const status = await port.open(folder, { readOnly: false });
      // A UID from an older UIDVALIDITY may name a different message now.
      if (status.uidValidity !== uidValidity) throw new CursorExpiredError("IMAP UIDVALIDITY changed");
      if (change.isRead === true) await port.addFlags(uid, ["\\Seen"]);
      if (change.isRead === false) await port.removeFlags(uid, ["\\Seen"]);
      if (change.isStarred === true) await port.addFlags(uid, ["\\Flagged"]);
      if (change.isStarred === false) await port.removeFlags(uid, ["\\Flagged"]);
      if (change.moveToRole) {
        const destination = folderForRole(syncableBoxes(await port.list()), change.moveToRole);
        if (!destination) throw new UnsupportedOperationError(`This mailbox has no ${change.moveToRole} folder`);
        if (destination.path !== folder) {
          const moved = await port.move(uid, destination.path);
          if (moved) return { remoteId: encodeImapRemoteId(destination.path, moved.uidValidity, moved.uid) };
        }
      }
      return undefined;
    });
  }

  /** A UID is only meaningful under the UIDVALIDITY it was issued with, in a folder that's still there. */
  isRemoteIdCurrent(remoteId: string, cursorValue: string): boolean {
    const cursor = parseImapCursor(cursorValue);
    try {
      const { folder, uidValidity } = parseImapRemoteId(remoteId);
      return cursor[folder]?.uidValidity === uidValidity;
    } catch {
      // Not an id this adapter issued, so nothing says it's stale.
      return true;
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (this.#opts.account.readOnly) throw new UnsupportedOperationError("This account is connected read-only");
    if (!this.#smtp) throw new UnsupportedOperationError("No outgoing server is configured for this account");
    return this.#smtp.send(message);
  }

  async findSentByMessageId(messageId: string): Promise<{ remoteId: string } | null> {
    const normalized = normalizeMessageId(messageId);
    return this.#withPort(async (port) => {
      const sent = folderForRole(syncableBoxes(await port.list()), "sent");
      if (!sent) return null;
      const status = await port.open(sent.path, { readOnly: true });
      const [uid] = await port.findByMessageId(normalized);
      return uid === undefined ? null : { remoteId: encodeImapRemoteId(sent.path, status.uidValidity, uid) };
    });
  }

  /** There is no IMAP revocation; the user deletes the app password at the provider. */
  async revoke(): Promise<boolean> {
    return false;
  }
}
