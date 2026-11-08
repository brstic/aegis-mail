import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GrantRevokedError } from "@aegis/domain/mail";
import {
  GMAIL_SCOPES_FULL, GMAIL_SCOPES_READONLY, MICROSOFT_SCOPES_FULL, MICROSOFT_SCOPES_READONLY,
  ProviderNetworkError, TokenManager, TokenRefreshError,
  buildAuthorizationUrl, exchangeCode, generatePkce, refresh, revokeGoogleToken, userinfo,
} from "./index";
import { NOW, OAUTH_CONFIG, fakeFetch, json, oauthCred, sequence } from "./test-support";

const rt = (f: typeof fetch) => ({ config: OAUTH_CONFIG, fetch: f, now: () => NOW });
const TOKEN_URL = "oauth2.googleapis.com/token";
const MS_TOKEN_URL = "login.microsoftonline.com/common/oauth2/v2.0/token";

describe("scopes", () => {
  it("never request mail.google.com", () => {
    for (const scopes of [GMAIL_SCOPES_READONLY, GMAIL_SCOPES_FULL, MICROSOFT_SCOPES_READONLY, MICROSOFT_SCOPES_FULL]) {
      for (const scope of scopes) expect(scope).not.toContain("mail.google.com");
    }
  });

  it("match the integration matrix", () => {
    expect(GMAIL_SCOPES_READONLY).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(GMAIL_SCOPES_FULL).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(MICROSOFT_SCOPES_READONLY).toEqual(["Mail.Read", "offline_access", "User.Read"]);
    expect(MICROSOFT_SCOPES_FULL).toEqual(["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read"]);
  });
});

describe("buildAuthorizationUrl", () => {
  const base = { redirectUri: "https://app.test/cb", state: "st", codeChallenge: "ch" };

  it("asks Google for offline access and consent with S256", () => {
    const url = new URL(buildAuthorizationUrl("gmail", { ...base, readOnly: false, loginHint: "a@b.com" }, OAUTH_CONFIG));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st");
    expect(p.get("login_hint")).toBe("a@b.com");
    expect(url.toString()).not.toContain("g-secret");
  });

  it("uses gmail.readonly in read-only mode", () => {
    const url = new URL(buildAuthorizationUrl("gmail", { ...base, readOnly: true }, OAUTH_CONFIG));
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("uses Microsoft /common v2 with the right scope sets", () => {
    const full = new URL(buildAuthorizationUrl("microsoft", { ...base, readOnly: false }, OAUTH_CONFIG));
    expect(full.origin + full.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(full.searchParams.get("scope")).toBe("Mail.ReadWrite Mail.Send offline_access User.Read");
    const ro = new URL(buildAuthorizationUrl("microsoft", { ...base, readOnly: true }, OAUTH_CONFIG));
    expect(ro.searchParams.get("scope")).toBe("Mail.Read offline_access User.Read");
  });

  it("refuses to build a URL without state or a client id", () => {
    expect(() => buildAuthorizationUrl("gmail", { ...base, state: "", readOnly: true }, OAUTH_CONFIG)).toThrow();
    expect(() => buildAuthorizationUrl("gmail", { ...base, readOnly: true }, {})).toThrow(/not configured/);
  });
});

describe("generatePkce", () => {
  it("produces an S256 challenge of the verifier", async () => {
    const { codeVerifier, codeChallenge, method } = await generatePkce();
    expect(method).toBe("S256");
    expect(codeChallenge).toBe(createHash("sha256").update(codeVerifier).digest("base64url"));
  });
});

describe("exchangeCode", () => {
  const params = { code: "the-code", state: "st", expectedState: "st", codeVerifier: "verifier-123", redirectUri: "https://app.test/cb" };
  const tokenBody = { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/gmail.readonly" };

  it("sends the verifier and returns a credential", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, json(tokenBody)]]);
    const cred = await exchangeCode("gmail", params, rt(f));
    expect(cred).toMatchObject({ kind: "oauth", provider: "gmail", accessToken: "at", refreshToken: "rt", expiresAt: NOW + 3_600_000 });
    expect(cred.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    const body = new URLSearchParams(f.calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-123");
    expect(body.get("redirect_uri")).toBe("https://app.test/cb");
  });

  it("refuses a state mismatch without calling the token endpoint", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, json(tokenBody)]]);
    await expect(exchangeCode("gmail", { ...params, state: "other" }, rt(f))).rejects.toBeInstanceOf(TokenRefreshError);
    expect(f.calls).toHaveLength(0);
  });

  it("turns invalid_grant into GrantRevokedError", async () => {
    const f = fakeFetch([["POST", MS_TOKEN_URL, json({ error: "invalid_grant", error_description: "AADSTS70008 expired" }, 400)]]);
    await expect(exchangeCode("microsoft", params, rt(f))).rejects.toBeInstanceOf(GrantRevokedError);
  });
});

describe("refresh", () => {
  it("keeps the old refresh token when Google doesn't send a new one", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, json({ access_token: "at2", expires_in: 100, token_type: "Bearer" })]]);
    const next = await refresh("gmail", oauthCred("gmail"), rt(f));
    expect(next.accessToken).toBe("at2");
    expect(next.refreshToken).toBe("refresh-token-SENTINEL");
    expect(next.expiresAt).toBe(NOW + 100_000);
    expect(new URLSearchParams(f.calls[0]!.body).get("grant_type")).toBe("refresh_token");
  });

  it("adopts a rotated Microsoft refresh token", async () => {
    const f = fakeFetch([["POST", MS_TOKEN_URL, json({ access_token: "at2", refresh_token: "rt2", expires_in: 100, token_type: "Bearer", scope: "Mail.Read" })]]);
    const next = await refresh("microsoft", oauthCred("microsoft"), rt(f));
    expect(next.refreshToken).toBe("rt2");
    expect(next.scopes).toEqual(["Mail.Read"]);
  });

  it("maps invalid_grant to GrantRevokedError with no secret in the message", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, json({ error: "invalid_grant", error_description: "refresh-token-SENTINEL is bad" }, 400)]]);
    const err = await refresh("gmail", oauthCred("gmail"), rt(f)).catch((e) => e);
    expect(err).toBeInstanceOf(GrantRevokedError);
    expect(err.message).not.toContain("SENTINEL");
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain("refresh-token-SENTINEL is bad");
    expect(err.cause).toBeUndefined();
  });

  it("maps other OAuth errors to TokenRefreshError by code only", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, json({ error: "invalid_client", error_description: "g-secret-SENTINEL wrong" }, 400)]]);
    const err = await refresh("gmail", oauthCred("gmail"), rt(f)).catch((e) => e);
    expect(err).toBeInstanceOf(TokenRefreshError);
    expect(err.message).toBe("OAuth token request failed (invalid_client)");
  });

  it("treats a missing refresh token as a lost grant", async () => {
    const f = fakeFetch([]);
    await expect(refresh("gmail", oauthCred("gmail", { refreshToken: undefined }), rt(f))).rejects.toBeInstanceOf(GrantRevokedError);
  });
});

describe("TokenManager", () => {
  const refreshed = () => json({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" });
  const manager = (f: typeof fetch, over: Partial<ReturnType<typeof oauthCred>> = {}, extra = {}) =>
    new TokenManager({ credential: oauthCred("gmail", over), config: OAUTH_CONFIG, fetch: f, now: () => NOW, ...extra });

  it("doesn't refresh a token with more than 60s left", async () => {
    const f = fakeFetch([]);
    expect(await manager(f, { expiresAt: NOW + 61_000 }).getAccessToken()).toBe("access-token-SENTINEL");
    expect(f.calls).toHaveLength(0);
  });

  it("refreshes about 60s before expiry and persists the result", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, refreshed()]]);
    const onCredentialUpdate = vi.fn(async () => undefined);
    const tokens = manager(f, { expiresAt: NOW + 60_000 }, { onCredentialUpdate });
    expect(await tokens.getAccessToken()).toBe("fresh");
    expect(onCredentialUpdate).toHaveBeenCalledOnce();
    expect(onCredentialUpdate.mock.calls[0]).toMatchObject([{ accessToken: "fresh", refreshToken: "refresh-token-SENTINEL" }]);
  });

  it("de-duplicates concurrent refreshes", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, refreshed()]]);
    const tokens = manager(f, { expiresAt: NOW - 1 });
    const results = await Promise.all([tokens.getAccessToken(), tokens.getAccessToken(), tokens.getAccessToken()]);
    expect(results).toEqual(["fresh", "fresh", "fresh"]);
    expect(f.to(TOKEN_URL)).toHaveLength(1);
  });

  it("refreshes and retries once on a 401", async () => {
    const f = fakeFetch([
      ["POST", TOKEN_URL, refreshed()],
      ["GET", "api.test/x", (call) => (call.headers.get("authorization") === "Bearer fresh" ? json({ ok: true }) : json({}, 401))],
    ]);
    const res = await manager(f).fetch("https://api.test/x");
    expect(res.status).toBe(200);
    expect(f.to("api.test/x")).toHaveLength(2);
    expect(f.to(TOKEN_URL)).toHaveLength(1);
  });

  it("gives up after the single retry", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, refreshed()], ["GET", "api.test/x", json({}, 401)]]);
    const res = await manager(f).fetch("https://api.test/x");
    expect(res.status).toBe(401);
    expect(f.to("api.test/x")).toHaveLength(2);
    expect(f.to(TOKEN_URL)).toHaveLength(1);
  });

  it("surfaces a revoked grant found while retrying a 401", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, json({ error: "invalid_grant" }, 400)], ["GET", "api.test/x", json({}, 401)]]);
    await expect(manager(f).fetch("https://api.test/x")).rejects.toBeInstanceOf(GrantRevokedError);
  });

  it("uses a token another caller already refreshed instead of refreshing again", async () => {
    let gate!: () => void;
    const hold = new Promise<void>((r) => { gate = r; });
    const f = fakeFetch([
      ["POST", TOKEN_URL, refreshed()],
      ["GET", "api.test/slow", async (call) => { await hold; return call.headers.get("authorization") === "Bearer fresh" ? json({}) : json({}, 401); }],
      ["GET", "api.test/fast", (call) => (call.headers.get("authorization") === "Bearer fresh" ? json({}) : json({}, 401))],
    ]);
    const tokens = manager(f);
    const slow = tokens.fetch("https://api.test/slow");
    await tokens.fetch("https://api.test/fast");
    gate();
    expect((await slow).status).toBe(200);
    expect(f.to(TOKEN_URL)).toHaveLength(1);
  });

  it("keeps a rotated token in memory and retries persisting after a failure", async () => {
    const f = fakeFetch([["POST", TOKEN_URL, refreshed()]]);
    const onCredentialUpdate = vi.fn<(c: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValue(undefined);
    const tokens = manager(f, { expiresAt: NOW - 1 }, { onCredentialUpdate });
    await expect(tokens.getAccessToken()).rejects.toThrow("db down");
    expect(await tokens.getAccessToken()).toBe("fresh");
    expect(f.to(TOKEN_URL)).toHaveLength(1);
    expect(onCredentialUpdate).toHaveBeenCalledTimes(2);
  });

  it("reports transport failures without the request details", async () => {
    const f = fakeFetch([["GET", "api.test", new Error("boom access-token-SENTINEL")]]);
    const err = await manager(f).fetch("https://api.test/x").catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNetworkError);
    expect(err.message).not.toContain("SENTINEL");
    expect(err.cause).toBeUndefined();
  });

  it("flags timeouts", async () => {
    const f = fakeFetch([["GET", "api.test", new DOMException("timed out", "TimeoutError")]]);
    const err = await manager(f).fetch("https://api.test/x").catch((e) => e);
    expect(err.timedOut).toBe(true);
  });

  it("doesn't expose tokens when serialized", () => {
    const tokens = manager(fakeFetch([]));
    expect(JSON.stringify(tokens)).not.toContain("SENTINEL");
  });
});

describe("revokeGoogleToken", () => {
  it("posts the token in the form body, not the URL", async () => {
    const f = fakeFetch([["POST", "oauth2.googleapis.com/revoke", new Response(null, { status: 200 })]]);
    expect(await revokeGoogleToken("tok-SENTINEL", { fetch: f })).toBe(true);
    expect(f.calls[0]!.url).not.toContain("tok-SENTINEL");
    expect(f.calls[0]!.body).toBe("token=tok-SENTINEL");
  });

  it("counts an already invalid token as revoked", async () => {
    const f = fakeFetch([["POST", "/revoke", json({ error: "invalid_token" }, 400)]]);
    expect(await revokeGoogleToken("t", { fetch: f })).toBe(true);
  });

  it("throws rather than claim success on a server error", async () => {
    const f = fakeFetch([["POST", "/revoke", json({}, 500)]]);
    await expect(revokeGoogleToken("t", { fetch: f })).rejects.toThrow("(500)");
  });
});

describe("userinfo", () => {
  it("reads the Gmail profile", async () => {
    const f = fakeFetch([["GET", "gmail.googleapis.com/gmail/v1/users/me/profile", json({ emailAddress: "a@gmail.com" })]]);
    expect(await userinfo("gmail", "tok", { fetch: f })).toBe("a@gmail.com");
    expect(f.calls[0]!.headers.get("authorization")).toBe("Bearer tok");
  });

  it("reads Graph /me and falls back to the UPN", async () => {
    const f = fakeFetch([["GET", "graph.microsoft.com/v1.0/me", json({ mail: null, userPrincipalName: "a@outlook.com" })]]);
    expect(await userinfo("microsoft", "tok", { fetch: f })).toBe("a@outlook.com");
  });

  it("rejects a profile without an address", async () => {
    const f = fakeFetch([["GET", "/me", sequence(json({ mail: null }))]]);
    await expect(userinfo("microsoft", "tok", { fetch: f })).rejects.toThrow(/no mailbox/);
  });
});
