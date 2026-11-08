import { CreateKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { beforeAll, describe, expect, it } from "vitest";
import { assertKmsAllowed } from "./index";
import { createAwsKms } from "./aws-kms";

/**
 * The real provider and the real AWS SDK, over the real KMS wire protocol, against a local server (moto, via infra/local/kms-server.sh).
 * This proves the requests are well formed and encryption context is enforced. It isn't AWS: IAM, key policies, throttling, regional
 * behaviour and audit logging are all untested.
 */
const endpoint = process.env.KMS_TEST_ENDPOINT;

describe.skipIf(!endpoint)("LIVE_KMS AwsKmsProvider", () => {
  let keyId: string;
  const region = "eu-west-1";
  beforeAll(async () => {
    process.env.AWS_ENDPOINT_URL_KMS = endpoint;
    process.env.AWS_ACCESS_KEY_ID = "local-test";
    process.env.AWS_SECRET_ACCESS_KEY = "local-test";
    const made = await new KMSClient({ region }).send(new CreateKeyCommand({ Description: "aegis live test" }));
    keyId = made.KeyMetadata!.KeyId!;
  });
  const kms = () => createAwsKms(keyId, region);
  const key = Buffer.alloc(32, 7);

  it("wraps and unwraps a tenant key through createAwsKms, as the platform does", async () => {
    const k = await kms();
    const wrapped = await k.wrap(key, "tenant-a:content");
    expect(wrapped.includes(key)).toBe(false);
    expect((await k.unwrap(wrapped, "tenant-a:content")).equals(key)).toBe(true);
  });
  it("two wraps of one key differ", async () => {
    const k = await kms();
    expect((await k.wrap(key, "c")).equals(await k.wrap(key, "c"))).toBe(false);
  });
  it("a wrapped key can't be unwrapped as another tenant's or another class's", async () => {
    const k = await kms();
    const wrapped = await k.wrap(key, "tenant-a:content");
    await expect(k.unwrap(wrapped, "tenant-b:content")).rejects.toThrow();
    await expect(k.unwrap(wrapped, "tenant-a:credential")).rejects.toThrow();
  });
  it("tampered ciphertext is refused", async () => {
    const k = await kms();
    const wrapped = await k.wrap(key, "c");
    wrapped[wrapped.length - 1]! ^= 1;
    await expect(k.unwrap(wrapped, "c")).rejects.toThrow();
  });
  it("a key that doesn't exist fails rather than falling back", async () => {
    const k = await createAwsKms("00000000-0000-0000-0000-000000000000", region);
    await expect(k.wrap(key, "c")).rejects.toThrow();
  });
  it("production boot accepts this provider", async () => {
    const k = await kms();
    expect(k.productionSafe).toBe(true);
    expect(() => assertKmsAllowed(k, { NODE_ENV: "production" })).not.toThrow();
  });
});
