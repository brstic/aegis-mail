import { Readable } from "node:stream";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import {
  SendOutcomeUnknownError,
  type ConnectionProblem,
  type ConnectionTestResult,
  type OutboundMessage,
  type SendResult,
} from "@aegis/domain/mail";
import { classifyConnectionError, composeMime, problemDetail } from "./shared";
import { createHostGuard, type HostGuard, type PinnedHost } from "./ssrf";

export interface SmtpConfig { host: string; port: number; security: "tls" | "starttls"; username: string; password: string }

export interface SmtpOptions {
  hostGuard?: HostGuard;
  now?: () => number;
  /** Extra trust anchors. Verification stays on; this exists so tests can use an in-process CA. */
  ca?: string | Buffer;
  timeoutMs?: number;
}

/** The send failed before the server took responsibility for the message. Safe to surface; holds no server text. */
export class SmtpError extends Error {
  override name = "SmtpError";
  constructor(message: string, readonly problem: ConnectionProblem, readonly responseCode?: number) { super(message); }
}

function isICloudSmtp(host: string): boolean {
  return /(^|\.)mail\.me\.com$/i.test(host);
}

interface RawSmtpError { code?: string; responseCode?: number; originalCode?: string }

/**
 * Uses nodemailer's SMTPConnection rather than createTransport. The transport reports a socket timeout
 * or close with command "CONN" at every stage, so it can't tell a dead connection before the message
 * was written from one after it, and that difference decides whether a retry could double-send.
 */
export class SmtpSender {
  #config: SmtpConfig;
  #opts: SmtpOptions;
  #guard: HostGuard;

  constructor(config: SmtpConfig, opts: SmtpOptions = {}) {
    if (config.security !== "tls" && config.security !== "starttls") {
      throw new TypeError("SMTP requires tls or starttls");
    }
    this.#config = config;
    this.#opts = opts;
    this.#guard = opts.hostGuard ?? createHostGuard();
  }

  #open(pinned: PinnedHost): SMTPConnection {
    const { security, username } = this.#config;
    const timeout = this.#opts.timeoutMs ?? 60_000;
    const domain = username.includes("@") ? username.slice(username.lastIndexOf("@") + 1) : "localhost";
    return new SMTPConnection({
      host: pinned.ip,
      port: pinned.port,
      secure: security === "tls",
      requireTLS: security === "starttls",
      ignoreTLS: false,
      // Without this nodemailer announces the worker's own hostname in EHLO.
      name: domain,
      tls: {
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(pinned.servername ? { servername: pinned.servername } : {}),
        ...(this.#opts.ca ? { ca: this.#opts.ca } : {}),
      },
      connectionTimeout: Math.min(timeout, 20_000),
      greetingTimeout: Math.min(timeout, 15_000),
      socketTimeout: timeout,
      logger: false,
      debug: false,
    });
  }

  async #connectAndLogin(connection: SMTPConnection, failed: Promise<never>): Promise<void> {
    await Promise.race([
      // A silent close before the greeting arrives through this callback rather than the error event.
      new Promise<void>((resolve, reject) => connection.connect((err) => (err ? reject(err) : resolve()))),
      failed,
    ]);
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        connection.login({ user: this.#config.username, pass: this.#config.password }, (err) => (err ? reject(err) : resolve()));
      }),
      failed,
    ]);
  }

  #failure(connection: SMTPConnection): Promise<never> {
    const failed = new Promise<never>((_, reject) => { connection.once("error", reject); });
    failed.catch(() => undefined);
    return failed;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const { raw, envelope } = await composeMime(message, { keepBcc: false });
    const pinned = await this.#guard.checkHost(this.#config.host, this.#config.port, { protocol: "smtp" });
    const connection = this.#open(pinned);
    const failed = this.#failure(connection);

    // _read only runs once the server answered DATA with 354, which marks when bytes could arrive.
    let messageWritten = false;
    let info: { rejected?: string[] } | undefined;
    const body = new Readable({
      read() {
        messageWritten = true;
        this.push(raw);
        this.push(null);
      },
    });

    try {
      await this.#connectAndLogin(connection, failed);
      info = await Promise.race([
        new Promise<{ rejected?: string[] }>((resolve, reject) => {
          connection.send(envelope, body, (err, sent) => (err ? reject(err) : resolve(sent)));
        }),
        failed,
      ]);
    } catch (err) {
      connection.close();
      const e = err as RawSmtpError;
      // A reply, even a refusal, is a definite answer. Silence after the message was written is not.
      if (messageWritten && !e?.responseCode) {
        throw new SendOutcomeUnknownError("SMTP send outcome is unknown; reconcile before retrying");
      }
      const code = e?.responseCode;
      throw new SmtpError(`SMTP send failed${code ? ` (${code})` : ""}`, classifyConnectionError(err), code);
    }
    connection.quit();
    // Refused at RCPT, so no bounce will ever arrive: this is the only moment anyone can learn these didn't go out.
    const rejected = info?.rejected ?? [];
    return { acceptedAt: new Date((this.#opts.now ?? Date.now)()).toISOString(), ...(rejected.length ? { rejectedRecipients: rejected } : {}) };
  }

  /** Connects and authenticates without sending anything. */
  async test(): Promise<ConnectionTestResult> {
    let connection: SMTPConnection | undefined;
    try {
      const pinned = await this.#guard.checkHost(this.#config.host, this.#config.port, { protocol: "smtp" });
      connection = this.#open(pinned);
      await this.#connectAndLogin(connection, this.#failure(connection));
      connection.quit();
      return { ok: true };
    } catch (err) {
      connection?.close();
      const problem = classifyConnectionError(err);
      return { ok: false, problem, detail: problemDetail(problem, this.#config.host) };
    }
  }
}

export function createSmtpSender(
  smtp: { host: string; port: number; security: "tls" | "starttls" },
  credentials: { username: string; password: string; email: string },
  opts: SmtpOptions = {},
): SmtpSender {
  // iCloud SMTP wants the full address even when IMAP logs in with the local part.
  const username = isICloudSmtp(smtp.host) && !credentials.username.includes("@") ? credentials.email : credentials.username;
  return new SmtpSender({ ...smtp, username, password: credentials.password }, opts);
}
