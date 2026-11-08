import type { MailAdapter } from "@aegis/domain/mail";
import { createGmailAdapter } from "./gmail";
import { createImapAdapter } from "./imap";
import { createMicrosoftAdapter } from "./microsoft";
import { TokenManager, type OAuthClientConfig } from "./oauth";
import { createPop3Adapter } from "./pop3";
import type { HostGuard } from "./ssrf";

export * from "./discovery";
export * from "./gmail";
export * from "./http-problem";
export * from "./imap";
export * from "./microsoft";
export * from "./oauth";
export * from "./pop3";
export * from "./shared";
export * from "./smtp";
export * from "./ssrf";

export type AdapterCredential =
  | { kind: "oauth"; provider: "gmail" | "microsoft"; accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[] }
  | { kind: "password"; username: string; password: string;
      imap: { host: string; port: number; security: "tls" | "starttls" };
      smtp?: { host: string; port: number; security: "tls" | "starttls" } };

export interface AdapterDeps {
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Client ids and secrets, plus endpoint overrides for mock servers. */
  oauth?: OAuthClientConfig;
  /** Persists refreshed tokens. */
  onCredentialUpdate?: (c: AdapterCredential) => Promise<void>;
  gmailPubsubTopic?: string;
  graphWebhookUrl?: string;
  graphClientState?: string;
  /** Defaults to the strict guard. */
  hostGuard?: HostGuard;
  now?: () => number;
  /** Extra trust anchors for IMAP, SMTP and POP3. Verification stays on; this exists for tests against a local server. */
  ca?: string | Buffer;
}

/**
 * Builds the adapter for an account. For `pop3` the POP3 server is read from `cred.imap`, the one
 * incoming-server slot AdapterCredential has. Throws UnsupportedOperationError for a combination the
 * provider can't support, such as POP3 against iCloud.
 */
export function createAdapter(
  kind: "gmail" | "microsoft" | "imap" | "pop3",
  account: { email: string; readOnly: boolean },
  cred: AdapterCredential,
  deps: AdapterDeps = {},
): MailAdapter {
  if (kind === "gmail" || kind === "microsoft") {
    if (cred.kind !== "oauth" || cred.provider !== kind) throw new TypeError(`${kind} needs an OAuth credential for ${kind}`);
    const tokens = new TokenManager({
      credential: cred,
      config: deps.oauth ?? {},
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.onCredentialUpdate ? { onCredentialUpdate: deps.onCredentialUpdate } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const common = { account, tokens, ...(deps.oauth ? { oauth: deps.oauth } : {}), ...(deps.now ? { now: deps.now } : {}) };
    if (kind === "gmail") {
      return createGmailAdapter({
        ...common,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.gmailPubsubTopic ? { pubsubTopic: deps.gmailPubsubTopic } : {}),
      });
    }
    return createMicrosoftAdapter({
      ...common,
      ...(deps.graphWebhookUrl ? { webhookUrl: deps.graphWebhookUrl } : {}),
      ...(deps.graphClientState ? { clientState: deps.graphClientState } : {}),
    });
  }
  if (cred.kind !== "password") throw new TypeError(`${kind} needs a password credential`);
  const common = {
    account,
    username: cred.username,
    password: cred.password,
    ...(deps.hostGuard ? { hostGuard: deps.hostGuard } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.ca ? { ca: deps.ca } : {}),
  };
  if (kind === "imap") return createImapAdapter({ ...common, imap: cred.imap, ...(cred.smtp ? { smtp: cred.smtp } : {}) });
  return createPop3Adapter({ ...common, server: cred.imap });
}
