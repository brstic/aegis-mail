import type { KmsProvider } from "./index";

/** The two calls we need, matching @aws-sdk/client-kms, so a real client or a test double can be injected. */
export interface KmsClientLike {
  send(command: unknown): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
}

/**
 * Root of trust in AWS KMS. Each tenant KEK is wrapped by the KMS key, with an encryption context binding it to its tenant
 * and class, so a wrapped key can't be unwrapped as another tenant's. Written from AWS documentation and tested against a
 * double: it has never run against a real KMS key. Run the checks in docs/runbooks/deploy.md first.
 */
export class AwsKmsProvider implements KmsProvider {
  readonly productionSafe = true;
  readonly id: string;
  constructor(private client: KmsClientLike, private keyId: string, private commands: { Encrypt: new (i: any) => unknown; Decrypt: new (i: any) => unknown }) {
    this.id = `aws-kms:${keyId.slice(-12)}`;
  }
  async wrap(plaintextKey: Buffer, context: string): Promise<Buffer> {
    const r = await this.client.send(new this.commands.Encrypt({ KeyId: this.keyId, Plaintext: plaintextKey, EncryptionContext: { aegis: context } }));
    if (!r.CiphertextBlob) throw new Error("KMS returned no ciphertext");
    return Buffer.from(r.CiphertextBlob);
  }
  async unwrap(wrapped: Buffer, context: string): Promise<Buffer> {
    const r = await this.client.send(new this.commands.Decrypt({ KeyId: this.keyId, CiphertextBlob: wrapped, EncryptionContext: { aegis: context } }));
    if (!r.Plaintext) throw new Error("KMS returned no plaintext");
    return Buffer.from(r.Plaintext);
  }
}

/** Loaded only when configured, so the SDK isn't a dependency of anything that doesn't use it. */
export async function createAwsKms(keyId: string, region?: string): Promise<AwsKmsProvider> {
  const { KMSClient, EncryptCommand, DecryptCommand } = await import("@aws-sdk/client-kms");
  return new AwsKmsProvider(new KMSClient(region ? { region } : {}) as unknown as KmsClientLike, keyId, { Encrypt: EncryptCommand as never, Decrypt: DecryptCommand as never });
}
