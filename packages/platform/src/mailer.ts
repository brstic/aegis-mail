import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { Db } from "@aegis/db";
import type { KmsProvider } from "@aegis/cryptography";

export interface TransactionalMail { to: string; subject: string; text: string }
export interface TransactionalMailer {
  readonly kind: "smtp" | "outbox";
  send(mail: TransactionalMail): Promise<void>;
}

export class MailConfigError extends Error { override name = "MailConfigError"; }

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * TLS is required unless the relay is on this machine. The URL can't turn that off: query parameters are refused, because
 * nodemailer's own URL syntax accepts things like ?ignoreTLS=true.
 */
export function smtpTransportOptions(rawUrl: string) {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new MailConfigError("TRANSACTIONAL_SMTP_URL isn't a valid URL."); }
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new MailConfigError("TRANSACTIONAL_SMTP_URL must start with smtp:// or smtps://.");
  if (u.search) throw new MailConfigError("TRANSACTIONAL_SMTP_URL can't carry query parameters.");
  const implicitTls = u.protocol === "smtps:";
  const local = LOOPBACK.has(u.hostname);
  return {
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port ? Number(u.port) : implicitTls ? 465 : 587,
    secure: implicitTls,
    requireTLS: !implicitTls && !local,
    tls: local ? { rejectUnauthorized: false } : { rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
    ...(u.username ? { auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } } : {}),
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    disableFileAccess: true, disableUrlAccess: true,
    logger: false, debug: false,
  };
}

/** `overrides` is a test seam: it lets a test reach a local server while keeping the production TLS rules. */
export function createSmtpMailer(url: string, from: string, overrides: { host?: string; port?: number; tls?: Record<string, unknown> } = {}): TransactionalMailer {
  if (/[\r\n]/.test(from) || !from.includes("@")) throw new MailConfigError("TRANSACTIONAL_FROM isn't a valid address.");
  const base = smtpTransportOptions(url);
  const transport = nodemailer.createTransport({ ...base, ...overrides, tls: { ...base.tls, ...overrides.tls } } as never);
  return {
    kind: "smtp",
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text, headers: { "Auto-Submitted": "auto-generated" } } as never);
    },
  };
}

// ---------- Sealing under the KMS directly ----------
// Transactional mail can go to someone with no workspace, so it can't use a tenant key.
function aesSeal(key: Buffer, plaintext: Buffer, aad: string) {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), body]);
}
function aesOpen(key: Buffer, blob: Buffer, aad: string) {
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
export { aesOpen as openWithKey, aesSeal as sealWithKey };

export async function sealUnderKms(kms: KmsProvider, context: string, value: unknown): Promise<Buffer> {
  const dek = randomBytes(32);
  const wrapped = await kms.wrap(dek, context);
  const header = Buffer.alloc(2);
  header.writeUInt16BE(wrapped.length, 0);
  const out = Buffer.concat([header, wrapped, aesSeal(dek, Buffer.from(JSON.stringify(value), "utf8"), context)]);
  dek.fill(0);
  return out;
}
export async function openUnderKms<T>(kms: KmsProvider, context: string, blob: Buffer): Promise<T> {
  const n = blob.readUInt16BE(0);
  const dek = await kms.unwrap(blob.subarray(2, 2 + n), context);
  try { return JSON.parse(aesOpen(dek, blob.subarray(2 + n), context).toString("utf8")) as T; } finally { dek.fill(0); }
}

/** For DEMO_MODE and local development. Nothing leaves the machine: mail is recorded, sealed, for the labelled dev page. */
export function createDevOutboxMailer(db: Db, kms: KmsProvider): TransactionalMailer {
  return {
    kind: "outbox",
    async send(mail) {
      const id = randomUUID();
      const enc = await sealUnderKms(kms, `dev_outbox:${id}`, mail);
      await db.withSystem(t => t.query("INSERT INTO dev_outbox(id,content_enc) VALUES ($1,$2)", [id, enc]));
    },
  };
}

/**
 * Which mailer this process gets. Demo mode always records, so a demo can't mail real people. Production with no relay gets
 * none, and flows that need email say so instead of pretending. Local development falls back to recording.
 */
export function resolveMailer(cfg: { demoMode: boolean; mail?: { smtpUrl: string; from: string } }, env: { NODE_ENV?: string }, deps: { db: Db; kms: KmsProvider }): TransactionalMailer | null {
  if (cfg.demoMode) return createDevOutboxMailer(deps.db, deps.kms);
  if (cfg.mail) return createSmtpMailer(cfg.mail.smtpUrl, cfg.mail.from);
  if (env.NODE_ENV === "production") return null;
  return createDevOutboxMailer(deps.db, deps.kms);
}
