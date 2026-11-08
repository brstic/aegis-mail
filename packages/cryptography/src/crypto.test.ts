import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { AwsKmsProvider, assertKmsAllowed, parseRootKey, RootKeyKms, DecryptionError, Envelope, KeyDestroyedError, type KeyClass, type KeyStore, LocalDevKms, type WrappedKey } from "./index";

class MemStore implements KeyStore {
  keys: WrappedKey[] = [];
  async getActive(t: string, c: KeyClass) { return this.keys.filter(k => k.tenantId === t && k.keyClass === c).sort((a, b) => b.version - a.version)[0] ?? null; }
  async get(t: string, c: KeyClass, v: number) { return this.keys.find(k => k.tenantId === t && k.keyClass === c && k.version === v) ?? null; }
  async put(k: WrappedKey) { this.keys.push(k); }
}
const ctx = { tenantId: "t1", keyClass: "body" as const, table: "message_contents", recordId: "r1" };

describe("envelope encryption", () => {
  let store: MemStore; let env: Envelope;
  beforeEach(() => { store = new MemStore(); env = new Envelope(new LocalDevKms(randomBytes(32)), store, 0); });

  it("round-trips and uses a fresh nonce and DEK each time", async () => {
    const a = await env.seal(ctx, "hello"), b = await env.seal(ctx, "hello");
    expect(a.equals(b)).toBe(false);
    expect((await env.open(ctx, a)).toString()).toBe("hello");
    expect(a.includes(Buffer.from("hello"))).toBe(false);
  });
  it("detects tampering", async () => {
    const blob = await env.seal(ctx, "hello");
    blob[blob.length - 1]! ^= 1;
    await expect(env.open(ctx, blob)).rejects.toBeInstanceOf(DecryptionError);
  });
  it("binds ciphertext to record, table and class via AAD", async () => {
    const blob = await env.seal(ctx, "hello");
    await expect(env.open({ ...ctx, recordId: "r2" }, blob)).rejects.toBeInstanceOf(DecryptionError);
    await expect(env.open({ ...ctx, table: "other" }, blob)).rejects.toBeInstanceOf(DecryptionError);
  });
  it("isolates tenants: another tenant's keys can't open a blob", async () => {
    const blob = await env.seal(ctx, "secret");
    await env.seal({ ...ctx, tenantId: "t2" }, "other");
    await expect(env.open({ ...ctx, tenantId: "t2" }, blob)).rejects.toBeInstanceOf(DecryptionError);
  });
  it("rotation keeps old ciphertext readable and new seals use the new version", async () => {
    const old = await env.seal(ctx, "old");
    await env.rotate("t1", "body");
    const fresh = await env.seal(ctx, "new");
    expect(fresh.readUInt32BE(1)).toBe(2);
    expect((await env.open(ctx, old)).toString()).toBe("old");
  });
  it("crypto-shredding: destroying the tenant key makes data permanently unreadable", async () => {
    const blob = await env.seal(ctx, "secret");
    store.keys = []; env.forget("t1");
    await expect(env.open(ctx, blob)).rejects.toBeInstanceOf(KeyDestroyedError);
  });
  it("stores KEKs wrapped, never raw", async () => {
    await env.seal(ctx, "x");
    expect(store.keys[0]!.wrapped.length).toBeGreaterThan(32);
  });
  it("blind index is deterministic, normalized, and tenant-scoped", async () => {
    const a = await env.blindIndex("t1", "sender", "A@Example.com ");
    expect(a).toBe(await env.blindIndex("t1", "sender", "a@example.com"));
    expect(a).not.toBe(await env.blindIndex("t2", "sender", "a@example.com"));
    expect(a).not.toBe(await env.blindIndex("t1", "other", "a@example.com"));
  });
});

describe("KMS production guard", () => {
  const dev = new LocalDevKms(randomBytes(32));
  it("refuses LocalDevKms in production", () => expect(() => assertKmsAllowed(dev, { NODE_ENV: "production" })).toThrow(/isn't allowed/));
  it("allows it in development", () => expect(() => assertKmsAllowed(dev, { NODE_ENV: "development" })).not.toThrow());
  it("allows an operator-supplied root key in production", () => expect(() => assertKmsAllowed(new RootKeyKms(randomBytes(32)), { NODE_ENV: "production" })).not.toThrow());
});

describe("Self-hosted root key", () => {
  it("accepts 32 random bytes in base64", () => expect(parseRootKey(` ${randomBytes(32).toString("base64")}\n`)).toHaveLength(32));
  it("refuses the wrong length or junk", () => {
    expect(() => parseRootKey(randomBytes(16).toString("base64"))).toThrow(/32 random bytes/);
    expect(() => parseRootKey("not a key")).toThrow(/32 random bytes/);
  });
  it("refuses base64-encoded text such as a placeholder", () => expect(() => parseRootKey(Buffer.from("demo-only-key-never-use-for-real").toString("base64"))).toThrow(/readable text/));
  it("reads data wrapped by a development key with the same bytes, so a dev key can be promoted", async () => {
    const k = randomBytes(32), dek = randomBytes(32);
    const wrapped = await new LocalDevKms(k).wrap(dek, "t1:body:1");
    expect(await new RootKeyKms(k).unwrap(wrapped, "t1:body:1")).toEqual(dek);
    await expect(new RootKeyKms(randomBytes(32)).unwrap(wrapped, "t1:body:1")).rejects.toThrow(DecryptionError);
    await expect(new RootKeyKms(k).unwrap(wrapped, "t2:body:1")).rejects.toThrow(DecryptionError);
  });
});

describe("AWS KMS provider (against a double)", () => {
  class Enc { constructor(public input: any) {} }
  class Dec { constructor(public input: any) {} }
  const fake = () => {
    const calls: any[] = [];
    return { calls, send: async (c: any) => {
      calls.push(c);
      // A real KMS refuses a mismatched encryption context; the double does too.
      if (c instanceof Enc) return { CiphertextBlob: Buffer.concat([Buffer.from(`${c.input.EncryptionContext.aegis}|`), c.input.Plaintext]) };
      const b = Buffer.from(c.input.CiphertextBlob);
      const sep = b.indexOf(0x7c);
      if (b.subarray(0, sep).toString() !== c.input.EncryptionContext.aegis) throw new Error("InvalidCiphertextException");
      return { Plaintext: b.subarray(sep + 1) };
    } };
  };
  it("is allowed in production, unlike the dev store", () => {
    const k = new AwsKmsProvider(fake(), "arn:aws:kms:eu-west-1:1:key/abc", { Encrypt: Enc, Decrypt: Dec });
    expect(() => assertKmsAllowed(k, { NODE_ENV: "production" })).not.toThrow();
  });
  it("binds wrapped keys to their tenant through the encryption context", async () => {
    const f = fake();
    const k = new AwsKmsProvider(f, "key", { Encrypt: Enc, Decrypt: Dec });
    const w = await k.wrap(Buffer.alloc(32, 7), "tenant:a:body");
    expect((await k.unwrap(w, "tenant:a:body")).equals(Buffer.alloc(32, 7))).toBe(true);
    await expect(k.unwrap(w, "tenant:b:body")).rejects.toThrow(/Invalid/);
    expect(f.calls[0].input.KeyId).toBe("key");
  });
  it("works as the root for envelope encryption", async () => {
    const store = new MemStore();
    const e = new Envelope(new AwsKmsProvider(fake(), "key", { Encrypt: Enc, Decrypt: Dec }), store, 0);
    const b = await e.seal(ctx, "hello");
    expect((await e.open(ctx, b)).toString()).toBe("hello");
  });
});

describe("re-sealing after rotation", () => {
  it("moves old ciphertext to the active key, once", async () => {
    const store = new MemStore();
    const e = new Envelope(new LocalDevKms(randomBytes(32)), store, 0);
    const old = await e.seal(ctx, "secret");
    expect(await e.resealIfOld(ctx, old)).toBeNull();
    await e.rotate("t1", "body");
    const fresh = (await e.resealIfOld(ctx, old))!;
    expect(e.versionOf(fresh)).toBe(2);
    expect((await e.open(ctx, fresh)).toString()).toBe("secret");
    expect(await e.resealIfOld(ctx, fresh)).toBeNull();
  });
});
