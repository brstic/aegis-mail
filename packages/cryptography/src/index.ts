import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export type KeyClass = "body" | "credential" | "index" | "metadata";

/** Root-of-trust boundary. Production must be backed by a KMS or HSM. */
export interface KmsProvider {
  readonly id: string;
  /** True only for providers suitable for production. */
  readonly productionSafe: boolean;
  wrap(plaintextKey: Buffer, context: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: string): Promise<Buffer>;
}

const NONCE = 12;
const TAG = 16;
const KEY = 32;
const FORMAT = 1;

function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([nonce, c.getAuthTag(), body]);
}

function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < NONCE + TAG) throw new DecryptionError("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, NONCE));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(blob.subarray(NONCE, NONCE + TAG));
  try {
    return Buffer.concat([d.update(blob.subarray(NONCE + TAG)), d.final()]);
  } catch {
    throw new DecryptionError("authentication failed");
  }
}

export class DecryptionError extends Error { override name = "DecryptionError"; }
export class KeyDestroyedError extends Error { override name = "KeyDestroyedError"; }

/** DEV ONLY. Holds the root key in process memory. Refused in production by assertKmsAllowed. */
export class LocalDevKms implements KmsProvider {
  readonly id = "local-dev";
  readonly productionSafe = false;
  private readonly root: Buffer;
  constructor(rootKey: Buffer) {
    if (rootKey.length !== KEY) throw new Error("LocalDevKms root key must be 32 bytes");
    this.root = rootKey;
  }
  async wrap(k: Buffer, context: string) { return seal(this.root, k, `kms:${context}`); }
  async unwrap(w: Buffer, context: string) { return open(this.root, w, `kms:${context}`); }
}

/**
 * Parses an operator-supplied root key: 32 random bytes, base64. Refuses anything that isn't exactly that, and text that was
 * base64-encoded instead of random bytes (a placeholder such as the demo stack's key), so a weak key can't be used by mistake.
 */
export function parseRootKey(value: string): Buffer {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(v)) throw new Error("The root key must be 32 random bytes in base64 (44 characters). Generate one with: openssl rand -base64 32");
  const key = Buffer.from(v, "base64");
  if (key.every(b => b >= 0x20 && b < 0x7f)) throw new Error("The root key is readable text, not random bytes. Generate one with: openssl rand -base64 32");
  return key;
}

/**
 * The self-hosted root of trust: a 32-byte key the operator generates and supplies through AEGIS_ROOT_KEY or a file
 * (AEGIS_ROOT_KEY_FILE, e.g. a Docker secret). It wraps every workspace key, so database dumps and backups are unreadable
 * without it, provided it's stored apart from them. Unlike a KMS, whoever can read the key on the server can unwrap every
 * workspace key: restrict who can read it, and back it up separately, since losing it loses the mail it protects.
 * It uses the same format as LocalDevKms, so a development key can be promoted without re-encrypting.
 */
export class RootKeyKms implements KmsProvider {
  readonly id = "root-key";
  readonly productionSafe = true;
  private readonly root: Buffer;
  constructor(rootKey: Buffer) {
    if (rootKey.length !== KEY) throw new Error("The root key must be 32 bytes");
    this.root = rootKey;
  }
  async wrap(k: Buffer, context: string) { return seal(this.root, k, `kms:${context}`); }
  async unwrap(w: Buffer, context: string) { return open(this.root, w, `kms:${context}`); }
}

export function assertKmsAllowed(kms: KmsProvider, env: { NODE_ENV?: string; DEMO_MODE?: string }): void {
  if (env.NODE_ENV === "production" && env.DEMO_MODE !== "true" && !kms.productionSafe) {
    throw new Error(`KMS provider "${kms.id}" isn't allowed in production. Set AEGIS_ROOT_KEY (or AEGIS_ROOT_KEY_FILE), or AWS_KMS_KEY_ID for AWS KMS.`);
  }
}

export interface WrappedKey { tenantId: string; keyClass: KeyClass; version: number; wrapped: Buffer }

/** Persistence for tenant KEKs. Destroying rows crypto-shreds everything under them. */
export interface KeyStore {
  getActive(tenantId: string, keyClass: KeyClass): Promise<WrappedKey | null>;
  get(tenantId: string, keyClass: KeyClass, version: number): Promise<WrappedKey | null>;
  put(key: WrappedKey): Promise<void>;
}

/** Record-binding context. Prevents ciphertext being replayed onto another row or tenant. */
export interface SealContext { tenantId: string; keyClass: KeyClass; table: string; recordId: string }

function aadFor(c: SealContext, keyVersion: number) {
  return JSON.stringify([FORMAT, c.tenantId, c.keyClass, c.table, c.recordId, keyVersion]);
}

/**
 * Envelope format: [format:1][version:4][dekLen:2][wrappedDek][sealedBody]
 * root (KMS) → tenant KEK per class → per-record DEK → body.
 */
export class Envelope {
  private cache = new Map<string, { key: Buffer; at: number }>();
  constructor(private kms: KmsProvider, private store: KeyStore, private cacheMs = 60_000) {}

  private ctx(tenantId: string, keyClass: KeyClass) { return `tenant:${tenantId}:${keyClass}`; }

  private async kek(tenantId: string, keyClass: KeyClass, version?: number): Promise<{ key: Buffer; version: number }> {
    const found = version === undefined ? await this.store.getActive(tenantId, keyClass) : await this.store.get(tenantId, keyClass, version);
    if (!found) {
      if (version !== undefined) throw new KeyDestroyedError(`no key for ${keyClass} v${version}`);
      return this.rotate(tenantId, keyClass);
    }
    const id = `${tenantId}:${keyClass}:${found.version}`;
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < this.cacheMs) return { key: hit.key, version: found.version };
    const key = await this.kms.unwrap(found.wrapped, this.ctx(tenantId, keyClass));
    this.cache.set(id, { key, at: Date.now() });
    return { key, version: found.version };
  }

  /** Creates a new active KEK version. Old ciphertext stays readable through its stored version. */
  async rotate(tenantId: string, keyClass: KeyClass): Promise<{ key: Buffer; version: number }> {
    const current = await this.store.getActive(tenantId, keyClass);
    const version = (current?.version ?? 0) + 1;
    const key = randomBytes(KEY);
    await this.store.put({ tenantId, keyClass, version, wrapped: await this.kms.wrap(key, this.ctx(tenantId, keyClass)) });
    // A concurrent writer may have won this version; always use what's actually stored.
    return this.kek(tenantId, keyClass, version);
  }

  /** Drop cached KEKs. Must follow key destruction. */
  forget(tenantId?: string) {
    if (!tenantId) return this.cache.clear();
    for (const k of this.cache.keys()) if (k.startsWith(`${tenantId}:`)) this.cache.delete(k);
  }

  async seal(ctx: SealContext, plaintext: Buffer | string): Promise<Buffer> {
    const { key: kek, version } = await this.kek(ctx.tenantId, ctx.keyClass);
    const dek = randomBytes(KEY);
    const aad = aadFor(ctx, version);
    const wrappedDek = seal(kek, dek, `dek:${aad}`);
    const body = seal(dek, typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext, aad);
    dek.fill(0);
    const header = Buffer.alloc(7);
    header.writeUInt8(FORMAT, 0);
    header.writeUInt32BE(version, 1);
    header.writeUInt16BE(wrappedDek.length, 5);
    return Buffer.concat([header, wrappedDek, body]);
  }

  async open(ctx: SealContext, blob: Buffer): Promise<Buffer> {
    if (blob.length < 7 || blob.readUInt8(0) !== FORMAT) throw new DecryptionError("unknown envelope format");
    const version = blob.readUInt32BE(1);
    const dekLen = blob.readUInt16BE(5);
    if (blob.length < 7 + dekLen) throw new DecryptionError("truncated envelope");
    const { key: kek } = await this.kek(ctx.tenantId, ctx.keyClass, version);
    const aad = aadFor(ctx, version);
    const dek = open(kek, blob.subarray(7, 7 + dekLen), `dek:${aad}`);
    try {
      return open(dek, blob.subarray(7 + dekLen), aad);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Opens many records of one tenant and key class. open() reads the key store for every record, which is right for a handful and
   * far too slow for thousands, so this reads it once per key version. Destroyed keys still throw; a record that fails
   * authentication comes back as null, so one damaged row can't take the rest down with it.
   */
  async openMany(tenantId: string, keyClass: KeyClass, records: { table: string; recordId: string; blob: Buffer }[]): Promise<(Buffer | null)[]> {
    const keks = new Map<number, Buffer>();
    const out: (Buffer | null)[] = [];
    for (let i = 0; i < records.length; i++) {
      const { table, recordId, blob } = records[i]!;
      // Don't starve the event loop: this runs on a request path.
      if (i && i % 256 === 0) await new Promise(r => setImmediate(r));
      if (blob.length < 7 || blob.readUInt8(0) !== FORMAT) { out.push(null); continue; }
      const version = blob.readUInt32BE(1);
      const dekLen = blob.readUInt16BE(5);
      if (blob.length < 7 + dekLen) { out.push(null); continue; }
      let kek = keks.get(version);
      if (!kek) { kek = (await this.kek(tenantId, keyClass, version)).key; keks.set(version, kek); }
      const aad = aadFor({ tenantId, keyClass, table, recordId }, version);
      try {
        const dek = open(kek, blob.subarray(7, 7 + dekLen), `dek:${aad}`);
        try { out.push(open(dek, blob.subarray(7 + dekLen), aad)); }
        finally { dek.fill(0); }
      } catch (e) {
        if (!(e instanceof DecryptionError)) throw e;
        out.push(null);
      }
    }
    return out;
  }

  /** Key version a blob was sealed under. */
  versionOf(blob: Buffer): number {
    if (blob.length < 7 || blob.readUInt8(0) !== FORMAT) throw new DecryptionError("unknown envelope format");
    return blob.readUInt32BE(1);
  }
  /** Re-encrypts under the active key, or returns null if it's already there. */
  async resealIfOld(ctx: SealContext, blob: Buffer): Promise<Buffer | null> {
    const active = await this.store.getActive(ctx.tenantId, ctx.keyClass);
    if (active && this.versionOf(blob) >= active.version) return null;
    return this.seal(ctx, await this.open(ctx, blob));
  }

  async sealJson(ctx: SealContext, value: unknown) { return this.seal(ctx, JSON.stringify(value)); }
  async openJson<T>(ctx: SealContext, blob: Buffer): Promise<T> { return JSON.parse((await this.open(ctx, blob)).toString("utf8")) as T; }

  /** Deterministic keyed index for equality lookups. Scoped per tenant and purpose; not reversible. */
  async blindIndex(tenantId: string, purpose: string, value: string): Promise<string> {
    const { key } = await this.kek(tenantId, "index", 1).catch(async () => this.kek(tenantId, "index"));
    const derived = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `blind:${purpose}`, KEY));
    return createHmac("sha256", derived).update(value.trim().toLowerCase(), "utf8").digest("base64url");
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomToken(bytes = 32) { return randomBytes(bytes).toString("base64url"); }

export * from "./aws-kms";
