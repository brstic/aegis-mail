import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kmsConfigured, kmsFromEnv } from "../context";

describe("root of trust from the environment", () => {
  const key = randomBytes(32).toString("base64");
  it("uses nothing when nothing is set, so development falls back to its local key", async () => {
    expect(await kmsFromEnv({})).toBeUndefined();
    expect(kmsConfigured({})).toBe(false);
  });
  it("uses AEGIS_ROOT_KEY", async () => {
    expect((await kmsFromEnv({ AEGIS_ROOT_KEY: key }))?.id).toBe("root-key");
    expect(kmsConfigured({ AEGIS_ROOT_KEY: key })).toBe(true);
  });
  it("reads AEGIS_ROOT_KEY_FILE, e.g. a Docker secret with a trailing newline", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "aegis-key-")), "root.key");
    writeFileSync(f, `${key}\n`);
    const kms = await kmsFromEnv({ AEGIS_ROOT_KEY_FILE: f });
    expect(kms?.productionSafe).toBe(true);
    expect(kmsConfigured({ AEGIS_ROOT_KEY_FILE: f })).toBe(true);
  });
  it("refuses both a root key and AWS KMS at once", async () => {
    await expect(kmsFromEnv({ AEGIS_ROOT_KEY: key, AWS_KMS_KEY_ID: "arn:aws:kms:eu-west-1:1:key/x" })).rejects.toThrow(/not both/);
  });
  it("refuses a weak key at boot", async () => {
    await expect(kmsFromEnv({ AEGIS_ROOT_KEY: "changeme" })).rejects.toThrow(/32 random bytes/);
  });
});
