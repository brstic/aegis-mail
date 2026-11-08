import { describe, expect, it } from "vitest";
import { createAdapter, type AdapterCredential } from "./index";
import { NOW, OAUTH_CONFIG, fakeFetch, oauthCred } from "./test-support";

const account = { email: "a@example.com", readOnly: false };
const password: AdapterCredential = { kind: "password", username: "u", password: "pw-SENTINEL", imap: { host: "imap.example.com", port: 993, security: "tls" } };

describe("createAdapter", () => {
  it("builds each kind", () => {
    const f = fakeFetch([]);
    expect(createAdapter("gmail", account, oauthCred("gmail"), { fetch: f, oauth: OAUTH_CONFIG }).kind).toBe("gmail");
    expect(createAdapter("microsoft", account, oauthCred("microsoft"), { fetch: f, oauth: OAUTH_CONFIG }).kind).toBe("microsoft");
    expect(createAdapter("imap", account, password).kind).toBe("imap");
    expect(createAdapter("pop3", account, password).kind).toBe("pop3");
  });

  it.each([
    ["gmail", password], ["microsoft", password], ["gmail", oauthCred("microsoft")], ["microsoft", oauthCred("gmail")],
    ["imap", oauthCred("gmail")], ["pop3", oauthCred("gmail")],
  ] as const)("rejects %s with a mismatched credential, without quoting it", (kind, cred) => {
    let err: unknown;
    try { createAdapter(kind, account, cred); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).not.toContain("SENTINEL");
  });

  it("doesn't expose credentials when an adapter is serialized or inspected", async () => {
    const { inspect } = await import("node:util");
    for (const a of [
      createAdapter("gmail", account, oauthCred("gmail"), { oauth: OAUTH_CONFIG, now: () => NOW }),
      createAdapter("microsoft", account, oauthCred("microsoft"), { oauth: OAUTH_CONFIG }),
      createAdapter("imap", account, { ...password, smtp: { host: "smtp.example.com", port: 587, security: "starttls" } }),
      createAdapter("pop3", account, password),
    ]) {
      expect(JSON.stringify(a)).not.toContain("SENTINEL");
      expect(inspect(a, { depth: 10, showHidden: true })).not.toContain("SENTINEL");
    }
  });
});
