import { Db, type Tx } from "@aegis/db";
import { assertKmsAllowed, Envelope, type KeyClass, type KeyStore, type KmsProvider, LocalDevKms, parseRootKey, RootKeyKms, type WrappedKey } from "@aegis/cryptography";
import type { MailAdapter } from "@aegis/domain";
import type { HostedConfig, InferenceProvider } from "@aegis/ai-core";
import type { MalwareScanner, SemanticClassifier } from "@aegis/security-engine";
import { BaselineScanner, ClamdScanner } from "@aegis/security-engine";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { makeLogger, type Logger } from "./log";
import { limitsFromEnv, type Limits } from "./limits";
import { resolveMailer, type TransactionalMailer } from "./mailer";
import { embeddingsFromEnv, type EmbeddingProvider } from "./embeddings";
import { assertDeletionSinkAllowed, type DeletionSink, deletionSinkFromEnv } from "./deletion-log";

export interface Ctx { tenantId: string; userId: string; sessionId?: string }

export class PgKeyStore implements KeyStore {
  constructor(private db: Db, private kmsId: string) {}
  private map(r: { tenant_id: string; key_class: KeyClass; version: number; wrapped: Buffer }): WrappedKey { return { tenantId: r.tenant_id, keyClass: r.key_class, version: r.version, wrapped: r.wrapped }; }
  async getActive(tenantId: string, keyClass: KeyClass) {
    const r = await this.db.withKeys(tenantId, t => t.one<any>("SELECT * FROM tenant_keys WHERE tenant_id=$1 AND key_class=$2 ORDER BY version DESC LIMIT 1", [tenantId, keyClass]));
    return r ? this.map(r) : null;
  }
  async get(tenantId: string, keyClass: KeyClass, version: number) {
    const r = await this.db.withKeys(tenantId, t => t.one<any>("SELECT * FROM tenant_keys WHERE tenant_id=$1 AND key_class=$2 AND version=$3", [tenantId, keyClass, version]));
    return r ? this.map(r) : null;
  }
  async put(k: WrappedKey) {
    await this.db.withKeys(k.tenantId, t => t.query("INSERT INTO tenant_keys(tenant_id,key_class,version,wrapped,kms_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [k.tenantId, k.keyClass, k.version, k.wrapped, this.kmsId]));
  }
}

export interface AccountRow { id: string; tenant_id: string; owner_user_id: string; kind: string; email: string; display_name: string; read_only: boolean; status: string; settings: any; color: string; is_primary: boolean }
export type StoredCredential = Record<string, any>;
export type AdapterFactory = (account: AccountRow, credential: StoredCredential | null, platform: Platform) => Promise<MailAdapter> | MailAdapter;

/**
 * Which hosted model this server uses. OpenAI is the main provider: OPENAI_API_KEY alone is enough. An Anthropic key is
 * used when it's the only one set, or when AEGIS_LLM_PROVIDER=anthropic says so. The model and endpoint settings
 * apply to whichever was chosen. No key, no hosted model: nothing leaves the server for AI.
 */
export function hostedAiFromEnv(env: NodeJS.ProcessEnv): HostedConfig | undefined {
  const keys = { openai: env.OPENAI_API_KEY || undefined, anthropic: env.ANTHROPIC_API_KEY || undefined };
  const asked = env.AEGIS_LLM_PROVIDER?.trim().toLowerCase();
  if (asked && asked !== "openai" && asked !== "anthropic") throw new Error(`AEGIS_LLM_PROVIDER must be "openai" or "anthropic", not "${asked}"`);
  const provider = (asked as "openai" | "anthropic" | undefined) ?? (keys.openai ? "openai" : keys.anthropic ? "anthropic" : undefined);
  const apiKey = provider && keys[provider];
  if (!provider || !apiKey) return undefined;
  // Earlier .env files set AEGIS_LLM_MODEL to a Claude model by default. A name that plainly belongs to the other
  // provider is left out, so switching keys doesn't send every request to a model that doesn't exist there.
  const named = env.AEGIS_LLM_MODEL?.trim();
  const foreign = named && (provider === "openai" ? /^claude/i : /^(gpt|o\d)/i).test(named);
  return { provider, apiKey, ...(env.AEGIS_LLM_BASE_URL ? { baseURL: env.AEGIS_LLM_BASE_URL } : {}), ...(named && !foreign ? { model: named } : {}) };
}

export interface PlatformConfig {
  demoMode: boolean;
  appOrigin: string;
  webauthnRpId: string;
  /**
   * The hosted AI model, when the server has a key for one. With it set, every incoming message's security review uses
   * it, for every mailbox on the server. Summaries and drafts use it only for people who turned that on.
   */
  ai?: HostedConfig;
  region?: string;
  google?: { clientId: string; clientSecret: string; pubsubTopic?: string; pubsubAudience?: string; pubsubServiceAccount?: string };
  microsoft?: { clientId: string; clientSecret: string; webhookUrl?: string };
  /** Instance-wide default limits, from AEGIS_LIMIT_*. A missing key means no limit. Operators can set a different one per workspace. */
  limits?: Partial<Limits>;
  clamd?: { host: string; port: number };
  /** Transactional mail relay. Separate from any mailbox a user connects. */
  mail?: { smtpUrl: string; from: string };
  /** Product sign-in with Google or Microsoft. Separate from mailbox authorization, with its own client and no mail scopes. */
  social?: { google?: SocialClient; microsoft?: SocialClient };
  /** Test only. Lets identity provider requests reach a local fake, over http, on this machine only. */
  ssoAllowLoopback?: boolean;
  /**
   * Who can create an account. "invite" (configFromEnv's default for NODE_ENV=production outside demo mode): only the first account
   * on an empty instance and addresses with a pending invitation. "open" (or unset): anyone who can reach the server.
   */
  signup?: "open" | "invite";
}

export interface SocialClient {
  clientId: string;
  clientSecret: string;
  /** Test only: discover from a fake instead of using the provider's published endpoints. */
  issuer?: string;
  /** Test only: Microsoft's multi-tenant issuer pattern, with {tid} for the signed-in user's tenant. */
  issuerTemplate?: string;
}

export interface Platform {
  db: Db;
  envelope: Envelope;
  kms: KmsProvider;
  log: Logger;
  config: PlatformConfig;
  scanner: MalwareScanner;
  /** Null means this deployment can't send email. Flows that need it say so. */
  mailer: TransactionalMailer | null;
  adapterFactory?: AdapterFactory;
  /** Test seam for the domain re-check. Defaults to the system resolver. */
  resolveTxt?: (domain: string) => Promise<string[][]>;
  /** Test seam: replaces provider selection. */
  inferenceOverride?: (ctx: { tenantId: string; userId?: string }) => InferenceProvider | null;
  semantic?: SemanticClassifier;
  /** Null means semantic search isn't enabled on this deployment. Off unless AEGIS_EMBEDDINGS=local. */
  embeddings: EmbeddingProvider | null;
  /** Where the worker ships the deletion log. Null means rows wait in the outbox, which production refuses for a worker. */
  deletionSink: DeletionSink | null;
  /** Test seam for provider HTTP. Defaults to global fetch. */
  fetch?: typeof fetch;
  now: () => Date;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  return {
    demoMode: env.DEMO_MODE === "true",
    // Closed by default on a production server outside demo mode, and any value but "open" closes it, so a typo never opens a server to everyone.
    signup: env.AEGIS_SIGNUP ? (env.AEGIS_SIGNUP === "open" ? "open" : "invite") : env.NODE_ENV === "production" && env.DEMO_MODE !== "true" ? "invite" : "open",
    // Browser tests run a local identity provider against a real server. Demo mode only, and never on by default.
    ssoAllowLoopback: env.AEGIS_TEST_SSO_LOOPBACK === "true" && env.DEMO_MODE === "true" ? true : undefined,
    mail: env.TRANSACTIONAL_SMTP_URL && env.TRANSACTIONAL_FROM ? { smtpUrl: env.TRANSACTIONAL_SMTP_URL, from: env.TRANSACTIONAL_FROM } : undefined,
    social: {
      google: env.SIGNIN_GOOGLE_CLIENT_ID && env.SIGNIN_GOOGLE_CLIENT_SECRET ? { clientId: env.SIGNIN_GOOGLE_CLIENT_ID, clientSecret: env.SIGNIN_GOOGLE_CLIENT_SECRET } : undefined,
      microsoft: env.SIGNIN_MICROSOFT_CLIENT_ID && env.SIGNIN_MICROSOFT_CLIENT_SECRET ? { clientId: env.SIGNIN_MICROSOFT_CLIENT_ID, clientSecret: env.SIGNIN_MICROSOFT_CLIENT_SECRET } : undefined,
    },
    appOrigin: env.APP_ORIGIN ?? "http://localhost:3000",
    webauthnRpId: env.WEBAUTHN_RP_ID ?? "localhost",
    ai: hostedAiFromEnv(env),
    region: env.AEGIS_REGION || undefined,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, pubsubTopic: env.GOOGLE_PUBSUB_TOPIC || undefined, pubsubAudience: env.GOOGLE_PUBSUB_AUDIENCE || undefined, pubsubServiceAccount: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT || undefined } : undefined,
    microsoft: env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, webhookUrl: env.MICROSOFT_WEBHOOK_URL || undefined } : undefined,
    limits: limitsFromEnv(env),
    clamd: env.CLAMD_HOST ? { host: env.CLAMD_HOST, port: Number(env.CLAMD_PORT || 3310) } : undefined,
  };
}

function devRootKey(env: NodeJS.ProcessEnv): Buffer {
  if (env.AEGIS_DEV_ROOT_KEY) return Buffer.from(env.AEGIS_DEV_ROOT_KEY, "base64");
  // Walk up to the repo root so web and worker (different cwd) share one dev key.
  let dir = process.cwd();
  for (let i = 0; i < 5 && !existsSync(join(/*turbopackIgnore: true*/ dir, "pnpm-workspace.yaml")); i++) dir = join(/*turbopackIgnore: true*/ dir, "..");
  const keyDir = join(/*turbopackIgnore: true*/ dir, ".dev-keys"), keyPath = join(/*turbopackIgnore: true*/ keyDir, "root.key");
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const k = randomBytes(32);
  writeFileSync(keyPath, k.toString("base64"), { mode: 0o600 });
  return k;
}

/** Picks the configured root of trust. Production without one refuses to boot, via assertKmsAllowed. */
export async function kmsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<KmsProvider | undefined> {
  const rootKey = env.AEGIS_ROOT_KEY_FILE ? readFileSync(/*turbopackIgnore: true*/ env.AEGIS_ROOT_KEY_FILE, "utf8") : env.AEGIS_ROOT_KEY;
  if (env.AWS_KMS_KEY_ID && rootKey) throw new Error("Set either AWS_KMS_KEY_ID or AEGIS_ROOT_KEY, not both: data wrapped by one can't be read by the other.");
  if (rootKey) return new RootKeyKms(parseRootKey(rootKey));
  if (!env.AWS_KMS_KEY_ID) return undefined;
  const { createAwsKms } = await import("@aegis/cryptography");
  return createAwsKms(env.AWS_KMS_KEY_ID, env.AWS_REGION);
}

/** Whether a production root of trust is configured, so callers know to build the platform with kmsFromEnv. */
export const kmsConfigured = (env: NodeJS.ProcessEnv = process.env) => !!(env.AWS_KMS_KEY_ID || env.AEGIS_ROOT_KEY || env.AEGIS_ROOT_KEY_FILE);

export type ProcessRole = "web" | "worker" | "admin" | "restore";

/**
 * web and worker connect as separate login roles; see migration 003. "admin" (migrations, seeding) uses DATABASE_URL.
 * In production, DATABASE_URL_WEB and DATABASE_URL_WORKER must be set; there's no fallback to an owner connection.
 */
export function connectionFor(role: ProcessRole, env: NodeJS.ProcessEnv): string {
  const admin = env.DATABASE_URL ?? "postgres://localhost:5432/aegis_dev";
  if (role === "admin") return admin;
  const specific = role === "web" ? env.DATABASE_URL_WEB : role === "restore" ? env.DATABASE_URL_RESTORE : env.DATABASE_URL_WORKER;
  if (specific) return specific;
  if (env.NODE_ENV === "production" && env.DEMO_MODE !== "true") throw new Error(`DATABASE_URL_${role.toUpperCase()} is required in production.`);
  const u = new URL(admin);
  u.username = role === "web" ? "aegis_web_login" : role === "restore" ? "aegis_restore_login" : "aegis_worker_login";
  u.password = "";
  return u.toString();
}

export function createPlatform(opts: { processRole?: ProcessRole; databaseUrl?: string; db?: Db; kms?: KmsProvider; config?: Partial<PlatformConfig>; env?: NodeJS.ProcessEnv; adapterFactory?: AdapterFactory; log?: Logger; scanner?: MalwareScanner; now?: () => Date; inferenceOverride?: Platform["inferenceOverride"]; semantic?: SemanticClassifier; fetch?: typeof fetch; mailer?: TransactionalMailer | null; embeddings?: EmbeddingProvider | null; deletionSink?: DeletionSink | null } = {}): Platform {
  const env = opts.env ?? process.env;
  const config = { ...configFromEnv(env), ...opts.config };
  const processRole = opts.processRole ?? "admin";
  const db = opts.db ?? new Db(opts.databaseUrl ?? connectionFor(processRole, env), 20, { keyRole: processRole === "web" ? "aegis_app" : "aegis_worker" });
  const kms = opts.kms ?? new LocalDevKms(devRootKey(env));
  assertKmsAllowed(kms, { NODE_ENV: env.NODE_ENV, DEMO_MODE: env.DEMO_MODE });
  const envelope = new Envelope(kms, new PgKeyStore(db, kms.id));
  const log = opts.log ?? makeLogger();
  const deletionSink = opts.deletionSink !== undefined ? opts.deletionSink : processRole === "worker" ? deletionSinkFromEnv(env, log) : null;
  assertDeletionSinkAllowed(deletionSink, processRole, { NODE_ENV: env.NODE_ENV, DEMO_MODE: env.DEMO_MODE });
  const scanner = opts.scanner ?? (config.clamd ? new ClamdScanner(config.clamd.host, config.clamd.port) : new BaselineScanner());
  return { db, kms, envelope, config, mailer: opts.mailer !== undefined ? opts.mailer : resolveMailer(config, env, { db, kms }), log, deletionSink, scanner, adapterFactory: opts.adapterFactory, inferenceOverride: opts.inferenceOverride, semantic: opts.semantic, embeddings: opts.embeddings !== undefined ? opts.embeddings : embeddingsFromEnv(env), fetch: opts.fetch, now: opts.now ?? (() => new Date()) };
}

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "AppError"; }
}
export const notFound = () => new AppError(404, "not_found", "Not found");
export const forbidden = (msg = "You don't have permission to do that.") => new AppError(403, "forbidden", msg);
export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);

export type { Tx };
