import * as oauth from "oauth4webapi";
import { GrantRevokedError } from "@aegis/domain/mail";
import type { AdapterCredential } from "./index";
import { ProviderHttpError, ProviderNetworkError, readJson, safeCode } from "./shared";

export type OAuthProvider = "gmail" | "microsoft";
type OAuthCredential = Extract<AdapterCredential, { kind: "oauth" }>;

export const GMAIL_SCOPES_READONLY = ["https://www.googleapis.com/auth/gmail.readonly"] as const;
export const GMAIL_SCOPES_FULL = ["https://www.googleapis.com/auth/gmail.modify"] as const;
export const MICROSOFT_SCOPES_READONLY = ["Mail.Read", "offline_access", "User.Read"] as const;
export const MICROSOFT_SCOPES_FULL = ["Mail.ReadWrite", "Mail.Send", "offline_access", "User.Read"] as const;

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret?: string;
  /** Endpoint overrides for mock servers. Plain http is honoured only for loopback hosts. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  apiBase?: string;
}
export interface OAuthClientConfig { gmail?: OAuthProviderConfig; microsoft?: OAuthProviderConfig }

export interface OAuthRuntime { config: OAuthClientConfig; fetch?: typeof fetch; now?: () => number }

const DEFAULTS = {
  gmail: {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    apiBase: "https://gmail.googleapis.com/gmail/v1",
  },
  microsoft: {
    issuer: "https://login.microsoftonline.com/common/v2.0",
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    revocationEndpoint: undefined,
    apiBase: "https://graph.microsoft.com/v1.0",
  },
} as const;

const HTTP_TIMEOUT_MS = 30_000;

export function apiBaseFor(provider: OAuthProvider, config?: OAuthClientConfig): string {
  return (config?.[provider]?.apiBase ?? DEFAULTS[provider].apiBase).replace(/\/$/, "");
}

function providerConfig(provider: OAuthProvider, config: OAuthClientConfig): OAuthProviderConfig {
  const entry = config[provider];
  if (!entry?.clientId) throw new Error(`OAuth client is not configured for ${provider}`);
  return entry;
}

function isLoopbackHttp(url: string): boolean {
  const u = new URL(url);
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

function tokenClient(provider: OAuthProvider, rt: OAuthRuntime) {
  const entry = providerConfig(provider, rt.config);
  const tokenEndpoint = entry.tokenEndpoint ?? DEFAULTS[provider].tokenEndpoint;
  const as: oauth.AuthorizationServer = { issuer: DEFAULTS[provider].issuer, token_endpoint: tokenEndpoint };
  const client: oauth.Client = { client_id: entry.clientId };
  const auth = entry.clientSecret ? oauth.ClientSecretPost(entry.clientSecret) : oauth.None();
  const options = {
    signal: () => AbortSignal.timeout(HTTP_TIMEOUT_MS),
    ...(rt.fetch ? { [oauth.customFetch]: rt.fetch } : {}),
    ...(isLoopbackHttp(tokenEndpoint) ? { [oauth.allowInsecureRequests]: true } : {}),
  };
  return { as, client, auth, options };
}

export function buildAuthorizationUrl(
  provider: OAuthProvider,
  opts: { redirectUri: string; state: string; codeChallenge: string; readOnly: boolean; loginHint?: string },
  config: OAuthClientConfig,
): string {
  if (!opts.state || !opts.codeChallenge) throw new Error("state and codeChallenge are required");
  const entry = providerConfig(provider, config);
  const url = new URL(entry.authorizationEndpoint ?? DEFAULTS[provider].authorizationEndpoint);
  const scopes =
    provider === "gmail"
      ? opts.readOnly ? GMAIL_SCOPES_READONLY : GMAIL_SCOPES_FULL
      : opts.readOnly ? MICROSOFT_SCOPES_READONLY : MICROSOFT_SCOPES_FULL;
  url.searchParams.set("client_id", entry.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.loginHint) url.searchParams.set("login_hint", opts.loginHint);
  if (provider === "gmail") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("response_mode", "query");
  }
  return url.toString();
}

export async function generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string; method: "S256" }> {
  const codeVerifier = oauth.generateRandomCodeVerifier();
  return { codeVerifier, codeChallenge: await oauth.calculatePKCECodeChallenge(codeVerifier), method: "S256" };
}

/** Rewraps every library error: oauth4webapi errors can carry the response body as `cause`. */
function toTokenError(err: unknown): Error {
  if (err instanceof oauth.ResponseBodyError) {
    if (err.error === "invalid_grant" || err.error === "interaction_required") {
      return new GrantRevokedError(`OAuth grant is no longer valid (${err.error})`);
    }
    return new TokenRefreshError(`OAuth token request failed (${safeCode(err.error) ?? "unknown"})`);
  }
  if (err instanceof oauth.WWWAuthenticateChallengeError) return new TokenRefreshError("OAuth client authentication failed");
  return new TokenRefreshError("OAuth token request failed");
}

function toCredential(provider: OAuthProvider, res: oauth.TokenEndpointResponse, nowMs: number, prev?: OAuthCredential): OAuthCredential {
  const refreshToken = res.refresh_token ?? prev?.refreshToken;
  return {
    kind: "oauth",
    provider,
    accessToken: res.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: nowMs + (res.expires_in ?? 3600) * 1000,
    scopes: res.scope ? res.scope.split(/\s+/).filter(Boolean) : (prev?.scopes ?? []),
  };
}

/**
 * Exchanges an authorization code. `state` is what came back on the callback and `expectedState` what
 * the caller stored when it built the URL; the exchange is refused unless they match.
 */
export async function exchangeCode(
  provider: OAuthProvider,
  params: { code: string; state: string; expectedState: string; codeVerifier: string; redirectUri: string },
  rt: OAuthRuntime,
): Promise<OAuthCredential> {
  const { as, client, auth, options } = tokenClient(provider, rt);
  try {
    const callback = oauth.validateAuthResponse(
      as, client, new URLSearchParams({ code: params.code, state: params.state }), params.expectedState,
    );
    const response = await oauth.authorizationCodeGrantRequest(as, client, auth, callback, params.redirectUri, params.codeVerifier, options);
    const result = await oauth.processAuthorizationCodeResponse(as, client, response);
    return toCredential(provider, result, (rt.now ?? Date.now)());
  } catch (err) {
    throw toTokenError(err);
  }
}

export async function refresh(provider: OAuthProvider, credential: OAuthCredential, rt: OAuthRuntime): Promise<OAuthCredential> {
  if (!credential.refreshToken) throw new GrantRevokedError("No refresh token is available; reconnect the account");
  const { as, client, auth, options } = tokenClient(provider, rt);
  try {
    const response = await oauth.refreshTokenGrantRequest(as, client, auth, credential.refreshToken, options);
    const result = await oauth.processRefreshTokenResponse(as, client, response);
    return toCredential(provider, result, (rt.now ?? Date.now)(), credential);
  } catch (err) {
    throw toTokenError(err);
  }
}

/** True when the token is revoked now, including when it was already invalid. Throws if that's unknown. */
export async function revokeGoogleToken(token: string, rt: Partial<OAuthRuntime> = {}): Promise<boolean> {
  const endpoint = rt.config?.gmail?.revocationEndpoint ?? DEFAULTS.gmail.revocationEndpoint;
  const doFetch = rt.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderNetworkError("Google revoke request failed", false);
  }
  if (res.ok) return true;
  if (res.status === 400) {
    const body = await res.json().catch(() => undefined);
    if (body?.error === "invalid_token") return true;
  }
  throw new ProviderHttpError(`Google revoke request failed (${res.status})`, res.status);
}

/** The mailbox address a token belongs to. */
export async function userinfo(provider: OAuthProvider, accessToken: string, rt: Partial<OAuthRuntime> = {}): Promise<string> {
  const base = apiBaseFor(provider, rt.config);
  const url = provider === "gmail" ? `${base}/users/me/profile` : `${base}/me?$select=mail,userPrincipalName`;
  const doFetch = rt.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new ProviderNetworkError("Profile request failed", false);
  }
  if (!res.ok) throw new ProviderHttpError(`Profile request failed (${res.status})`, res.status);
  const body = await readJson(res, "Profile request");
  const email = provider === "gmail" ? body?.emailAddress : (body?.mail ?? body?.userPrincipalName);
  if (typeof email !== "string" || !email.includes("@")) throw new Error("Profile response has no mailbox address");
  return email;
}

/** Token endpoint failed for a reason other than a revoked grant. Nothing reached the mail API. */
export class TokenRefreshError extends Error {
  override name = "TokenRefreshError";
}

export const REFRESH_SKEW_MS = 60_000;

export interface TokenManagerOptions {
  credential: OAuthCredential;
  config: OAuthClientConfig;
  fetch?: typeof fetch;
  onCredentialUpdate?: (c: AdapterCredential) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
}

/** Holds one account's tokens. `expiresAt` is epoch milliseconds, the same clock as `now`. */
export class TokenManager {
  #cred: OAuthCredential;
  #opts: TokenManagerOptions;
  #inflight: Promise<OAuthCredential> | undefined;
  #unpersisted = false;

  constructor(opts: TokenManagerOptions) {
    this.#cred = opts.credential;
    this.#opts = opts;
  }

  /** Best token to revoke: a refresh token ends the whole grant at Google. */
  get revocationToken(): string {
    return this.#cred.refreshToken ?? this.#cred.accessToken;
  }

  async getAccessToken(): Promise<string> {
    const now = (this.#opts.now ?? Date.now)();
    if (this.#cred.expiresAt - REFRESH_SKEW_MS <= now) await this.#refresh();
    await this.#persist();
    return this.#cred.accessToken;
  }

  #refresh(): Promise<OAuthCredential> {
    if (!this.#inflight) {
      this.#inflight = refresh(this.#cred.provider, this.#cred, this.#opts)
        .then(async (next) => {
          // Memory first: a rotated refresh token must not be lost if persisting it fails.
          this.#cred = next;
          this.#unpersisted = true;
          await this.#persist();
          return next;
        })
        .finally(() => { this.#inflight = undefined; });
    }
    return this.#inflight;
  }

  async #persist(): Promise<void> {
    if (!this.#unpersisted || !this.#opts.onCredentialUpdate) return;
    await this.#opts.onCredentialUpdate(this.#cred);
    this.#unpersisted = false;
  }

  /** Authorized fetch. Retries once after a 401. Transport failures become ProviderNetworkError. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const first = await this.#send(url, init, token);
    if (first.status !== 401) return first;
    void first.body?.cancel().catch(() => undefined);
    // Another caller may have refreshed while this request was in flight.
    const retryToken = this.#cred.accessToken !== token ? this.#cred.accessToken : (await this.#refresh()).accessToken;
    return this.#send(url, init, retryToken);
  }

  async #send(url: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    try {
      return await (this.#opts.fetch ?? fetch)(url, {
        ...init,
        headers,
        redirect: "error",
        signal: init.signal ?? AbortSignal.timeout(this.#opts.requestTimeoutMs ?? HTTP_TIMEOUT_MS),
      });
    } catch (err) {
      const name = (err as { name?: unknown })?.name;
      throw new ProviderNetworkError("Provider request failed", name === "TimeoutError" || name === "AbortError");
    }
  }
}
