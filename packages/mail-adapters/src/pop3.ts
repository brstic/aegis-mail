import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import {
  CursorExpiredError,
  UnsupportedOperationError,
  type ConnectionProblem,
  type ConnectionTestResult,
  type MailAdapter,
  type MailChange,
  type ProviderCapabilities,
  type RemoteFolder,
  type SendResult,
  type SyncPage,
} from "@aegis/domain/mail";
import { classifyConnectionError, effectiveCapabilities, isOutlookHost, problemDetail } from "./shared";
import { HostBlockedError, createHostGuard, type HostGuard, type PinnedHost } from "./ssrf";

export interface Pop3Limits {
  /** Longest status or UIDL line. */
  maxLineBytes: number;
  /** Largest message taken from the server, by its own LIST size and by what it actually sends. */
  maxMessageBytes: number;
  /** A larger listing is refused rather than buffered. */
  maxUidlEntries: number;
  /** Most UIDL hashes kept in the cursor, which is also how many of the newest messages are considered. */
  maxSeen: number;
  /** Silence allowed while waiting on the server. */
  idleTimeoutMs: number;
}

export const POP3_LIMITS: Pop3Limits = {
  maxLineBytes: 8 * 1024,
  maxMessageBytes: 50 * 1024 * 1024,
  maxUidlEntries: 100_000,
  maxSeen: 10_000,
  idleTimeoutMs: 30_000,
};

/** A POP3 failure. Holds a safe message and the classified problem; server text is never quoted. */
export class Pop3Error extends Error {
  override name = "Pop3Error";
  constructor(message: string, readonly problem: ConnectionProblem) { super(message); }
}

/** Opens the connection. The default is TLS to the pinned IP, verified against the hostname. */
export type Pop3SocketFactory = (target: PinnedHost) => Promise<Duplex>;

function defaultSocket(timeoutMs: number, ca?: string | Buffer): Pop3SocketFactory {
  return (target) =>
    new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: target.ip,
        port: target.port,
        ...(target.servername ? { servername: target.servername } : {}),
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(ca ? { ca } : {}),
      });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error("Connect timed out"), { code: "ETIMEDOUT" })), timeoutMs);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        socket.removeListener("error", reject);
        resolve(socket);
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}

/** Line-oriented reader over a socket with a hard ceiling on what it will buffer. */
class Pop3Session {
  #socket: Duplex;
  #limits: Pop3Limits;
  #buffer: Buffer = Buffer.alloc(0);
  #wake: (() => void) | undefined;
  #failure: Error | undefined;

  constructor(socket: Duplex, limits: Pop3Limits) {
    this.#socket = socket;
    this.#limits = limits;
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
      this.#wake?.();
    });
    const fail = (err?: unknown) => {
      this.#failure ??= (err as Error) ?? Object.assign(new Error("Connection closed"), { code: "ECONNRESET" });
      this.#wake?.();
    };
    socket.on("error", fail);
    socket.on("close", () => fail());
  }

  async #waitForData(): Promise<void> {
    if (this.#failure) throw this.#failure;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#wake = undefined;
        reject(new Pop3Error("POP3 server stopped responding", "timeout"));
      }, this.#limits.idleTimeoutMs);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
    });
  }

  async #line(maxBytes: number): Promise<Buffer> {
    for (;;) {
      const lf = this.#buffer.indexOf(0x0a);
      if (lf >= 0) {
        if (lf > maxBytes) throw new Pop3Error("POP3 server sent an oversized line", "protocol_error");
        const end = lf > 0 && this.#buffer[lf - 1] === 0x0d ? lf - 1 : lf;
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(lf + 1);
        return line;
      }
      if (this.#buffer.length > maxBytes) throw new Pop3Error("POP3 server sent an oversized line", "protocol_error");
      await this.#waitForData();
    }
  }

  /** Reads a +OK/-ERR status. Returns the text after the indicator, for parsing only; it never reaches an error. */
  async status(onError: () => Error): Promise<string> {
    const line = (await this.#line(this.#limits.maxLineBytes)).toString("latin1");
    if (line.startsWith("+OK")) return line.slice(3).trim();
    if (line.startsWith("-ERR")) throw onError();
    throw new Pop3Error("POP3 server sent an invalid response", "protocol_error");
  }

  command(text: string): void {
    this.#socket.write(`${text}\r\n`);
  }

  /** Reads a dot-terminated body, undoing dot-stuffing. Calls `onLine` with each line; `maxBytes` caps the total. */
  async multiline(maxBytes: number, onLine: (line: Buffer) => void): Promise<void> {
    let total = 0;
    for (;;) {
      const line = await this.#line(maxBytes);
      if (line.length === 1 && line[0] === 0x2e) return;
      const body = line[0] === 0x2e ? line.subarray(1) : line;
      total += body.length + 2;
      if (total > maxBytes) throw new Pop3Error("POP3 message exceeds the size limit", "protocol_error");
      onLine(body);
    }
  }

  async quit(): Promise<void> {
    try {
      this.command("QUIT");
      await this.status(() => new Pop3Error("QUIT refused", "protocol_error"));
    } catch { /* The session is over either way. */ }
    this.destroy();
  }

  destroy(): void {
    this.#socket.destroy();
  }
}

function hashUidl(uidl: string): string {
  return createHash("sha256").update(uidl, "latin1").digest("base64url").slice(0, 16);
}

function parseSeen(cursor: string | undefined): Set<string> {
  if (!cursor) return new Set();
  try {
    const parsed = JSON.parse(cursor);
    if (Array.isArray(parsed?.seen) && parsed.seen.every((s: unknown) => typeof s === "string")) return new Set(parsed.seen);
  } catch { /* falls through */ }
  throw new CursorExpiredError("POP3 cursor is not usable");
}

/**
 * The newest Received header is added by the receiving server, so a sender can't backdate it the way
 * it can the Date header. A forged date must not be able to push mail out of the sync window.
 */
export function receivedDate(raw: Uint8Array, fallbackMs: number): Date {
  const head = Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.length, 64 * 1024)).toString("latin1");
  const headerEnd = head.search(/\r?\n\r?\n/);
  const headers = (headerEnd >= 0 ? head.slice(0, headerEnd) : head).replace(/\r?\n[ \t]+/g, " ");
  const lines = headers.split(/\r?\n/);
  const received = lines.find((l) => /^received:/i.test(l));
  const fromReceived = received?.includes(";") ? Date.parse(received.slice(received.lastIndexOf(";") + 1).trim()) : NaN;
  if (!Number.isNaN(fromReceived)) return new Date(fromReceived);
  const dateLine = lines.find((l) => /^date:/i.test(l));
  const fromDate = dateLine ? Date.parse(dateLine.slice(5).trim()) : NaN;
  return new Date(Number.isNaN(fromDate) ? fallbackMs : fromDate);
}

const IMPORT_ONLY = "POP3 is import only";

export interface Pop3AdapterOptions {
  account: { email: string; readOnly: boolean };
  username: string;
  password: string;
  server: { host: string; port: number; security: "tls" | "starttls" };
  hostGuard?: HostGuard;
  now?: () => number;
  /** Extra trust anchors. Verification stays on; this exists so tests can use an in-process CA. */
  ca?: string | Buffer;
  socketFactory?: Pop3SocketFactory;
  limits?: Partial<Pop3Limits>;
}

export function isICloudHost(host: string): boolean {
  return /(^|\.)(mail\.me\.com|icloud\.com|me\.com|mac\.com)$/i.test(host.replace(/\.$/, ""));
}

export function createPop3Adapter(opts: Pop3AdapterOptions): MailAdapter {
  if (isICloudHost(opts.server.host)) throw new UnsupportedOperationError("iCloud Mail does not support POP");
  if (isOutlookHost(opts.server.host)) {
    throw new UnsupportedOperationError("Outlook.com and Microsoft 365 don't accept passwords over POP. Use Microsoft sign-in.");
  }
  if (opts.server.security !== "tls") throw new UnsupportedOperationError("POP3 is only supported over direct TLS");
  return new Pop3Adapter(opts);
}

class Pop3Adapter implements MailAdapter {
  readonly kind = "pop3" as const;
  readonly capabilities: ProviderCapabilities;
  #opts: Pop3AdapterOptions;
  #guard: HostGuard;
  #limits: Pop3Limits;

  constructor(opts: Pop3AdapterOptions) {
    this.#opts = opts;
    this.#guard = opts.hostGuard ?? createHostGuard();
    this.#limits = { ...POP3_LIMITS, ...opts.limits };
    this.capabilities = effectiveCapabilities("pop3", { readOnly: opts.account.readOnly });
  }

  async #open(): Promise<Pop3Session> {
    const { username, password, server } = this.#opts;
    // A line break here would be a second POP3 command.
    if (/[\r\n]/.test(username) || /[\r\n]/.test(password)) throw new Pop3Error("Invalid credentials", "auth_failed");
    const pinned = await this.#guard.checkHost(server.host, server.port, { protocol: "pop3" });
    const socket = await (this.#opts.socketFactory ?? defaultSocket(this.#limits.idleTimeoutMs, this.#opts.ca))(pinned);
    const session = new Pop3Session(socket, this.#limits);
    try {
      const refused = () => new Pop3Error("POP3 server refused the connection", "protocol_error");
      await session.status(refused);
      const authFailed = () => new Pop3Error("POP3 login failed", "auth_failed");
      session.command(`USER ${username}`);
      await session.status(authFailed);
      session.command(`PASS ${password}`);
      await session.status(authFailed);
    } catch (err) {
      session.destroy();
      throw err;
    }
    return session;
  }

  async #listUidl(session: Pop3Session): Promise<Array<{ number: number; uidl: string }>> {
    session.command("UIDL");
    await session.status(() => new Pop3Error("This POP3 server doesn't support UIDL", "protocol_error"));
    const entries: Array<{ number: number; uidl: string }> = [];
    const seen = new Set<string>();
    await session.multiline(this.#limits.maxUidlEntries * 128, (line) => {
      const match = /^(\d{1,10}) ([\x21-\x7e]{1,70})$/.exec(line.toString("latin1").trim());
      if (!match) throw new Pop3Error("POP3 server sent an invalid UIDL line", "protocol_error");
      if (seen.has(match[2] as string)) return;
      seen.add(match[2] as string);
      if (entries.length >= this.#limits.maxUidlEntries) throw new Pop3Error("POP3 mailbox has too many messages", "protocol_error");
      entries.push({ number: Number(match[1]), uidl: match[2] as string });
    });
    return entries;
  }

  async #messageSize(session: Pop3Session, number: number): Promise<number | undefined> {
    session.command(`LIST ${number}`);
    const text = await session.status(() => new Pop3Error("POP3 message is gone", "protocol_error"));
    const size = Number(text.split(/\s+/)[1]);
    return Number.isFinite(size) ? size : undefined;
  }

  async #retrieve(session: Pop3Session, number: number): Promise<Uint8Array> {
    session.command(`RETR ${number}`);
    await session.status(() => new Pop3Error("POP3 message is gone", "protocol_error"));
    const parts: Buffer[] = [];
    const crlf = Buffer.from("\r\n");
    await session.multiline(this.#limits.maxMessageBytes, (line) => {
      parts.push(Buffer.from(line), crlf);
    });
    return new Uint8Array(Buffer.concat(parts));
  }

  /**
   * Imports up to pageSize unseen messages, oldest first. Seen hashes are pruned to what the server
   * still lists and capped at maxSeen, so the cursor can't grow without bound. Only the newest maxSeen
   * entries are considered: anything older could never stay marked as seen and would import repeatedly.
   */
  async #sync(cursor: string | undefined, opts: { pageSize: number; windowDays?: number }): Promise<SyncPage> {
    const seen = parseSeen(cursor);
    const now = (this.#opts.now ?? Date.now)();
    const cutoff = opts.windowDays !== undefined ? now - opts.windowDays * 86_400_000 : undefined;
    let session: Pop3Session | undefined;
    try {
      session = await this.#open();
      const listed = (await this.#listUidl(session)).slice(-this.#limits.maxSeen);
      const hashes = new Map(listed.map((entry) => [entry.uidl, hashUidl(entry.uidl)]));
      const unseen = listed.filter((entry) => !seen.has(hashes.get(entry.uidl) as string));
      const page = unseen.slice(0, Math.max(opts.pageSize, 1));
      const changes: MailChange[] = [];
      const imported = new Set<string>();
      for (const entry of page) {
        const size = await this.#messageSize(session, entry.number);
        const base = { folderRole: "inbox" as const, labels: [], isRead: false, isStarred: false };
        if (size !== undefined && size > this.#limits.maxMessageBytes) {
          // Reported without content so the user sees it exists; POP3 can't fetch part of it.
          changes.push({ type: "upsert", remoteId: entry.uidl, internalDate: new Date(now).toISOString(), state: base });
        } else {
          const raw = await this.#retrieve(session, entry.number);
          const date = receivedDate(raw, now);
          if (cutoff === undefined || date.getTime() >= cutoff) {
            changes.push({ type: "upsert", remoteId: entry.uidl, internalDate: date.toISOString(), state: base, raw });
          }
        }
        imported.add(hashes.get(entry.uidl) as string);
      }
      await session.quit();
      const stillListed = new Set(hashes.values());
      const nextSeen = [...seen].filter((h) => stillListed.has(h));
      for (const h of imported) if (!nextSeen.includes(h)) nextSeen.push(h);
      return { changes, cursor: JSON.stringify({ seen: nextSeen.slice(-this.#limits.maxSeen) }), hasMore: unseen.length > page.length };
    } catch (err) {
      session?.destroy();
      if (err instanceof Pop3Error || err instanceof HostBlockedError) throw err;
      const problem = classifyConnectionError(err);
      throw new Pop3Error(problemDetail(problem), problem);
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const session = await this.#open();
      await session.quit();
      return { ok: true };
    } catch (err) {
      const problem = classifyConnectionError(err);
      return { ok: false, problem, detail: problemDetail(problem) };
    }
  }

  fullSync(opts: { windowDays: number; pageSize: number; cursor?: string }): Promise<SyncPage> {
    if (!Number.isInteger(opts.windowDays) || opts.windowDays < 1) throw new TypeError("windowDays must be a positive integer");
    return this.#sync(opts.cursor, { pageSize: opts.pageSize, windowDays: opts.windowDays });
  }

  incrementalSync(cursor: string, opts: { pageSize: number }): Promise<SyncPage> {
    return this.#sync(cursor, { pageSize: opts.pageSize });
  }

  async listFolders(): Promise<RemoteFolder[]> {
    throw new UnsupportedOperationError(`${IMPORT_ONLY}: no folders`);
  }
  async fetchRaw(): Promise<Uint8Array> {
    throw new UnsupportedOperationError(`${IMPORT_ONLY}: messages are delivered during sync`);
  }
  async applyChange(): Promise<void> {
    throw new UnsupportedOperationError(`${IMPORT_ONLY}: changes don't reach the server`);
  }
  async send(): Promise<SendResult> {
    throw new UnsupportedOperationError(`${IMPORT_ONLY}: sending isn't available`);
  }
  async findSentByMessageId(): Promise<{ remoteId: string } | null> {
    throw new UnsupportedOperationError(`${IMPORT_ONLY}: no sent mail`);
  }
  /** The contract's way to say there's no revocation API. The user deletes the password at the provider. */
  async revoke(): Promise<boolean> {
    return false;
  }
}
