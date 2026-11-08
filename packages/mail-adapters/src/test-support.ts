/** Test-only. Not exported from the package. */
export interface RecordedCall { url: string; method: string; headers: Headers; body: string | undefined }

type Handler = Response | Error | ((call: RecordedCall) => Response | Error | Promise<Response | Error>);
export type Route = [method: string, match: string | RegExp, handler: Handler];

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * A fetch that only answers listed routes and throws on anything else, so no test can reach a real
 * host. The first matching route wins; a route given a queue answers with its next entry.
 */
export function fakeFetch(routes: Route[]): typeof fetch & { calls: RecordedCall[]; to(match: string | RegExp): RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const matches = (url: string, m: string | RegExp) => (typeof m === "string" ? url.includes(m) : m.test(url));
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body == null ? undefined : String(init.body);
    const call: RecordedCall = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body };
    calls.push(call);
    const route = routes.find(([method, m]) => method === call.method && matches(url, m));
    if (!route) throw new Error(`Unexpected request in test: ${call.method} ${url}`);
    const handler = route[2];
    const out = typeof handler === "function" ? await handler(call) : handler;
    if (out instanceof Error) throw out;
    return out.clone();
  };
  return Object.assign(impl as typeof fetch, {
    calls,
    to: (m: string | RegExp) => calls.filter((c) => matches(c.url, m)),
  });
}

/** Answers with each response in turn, repeating the last. */
export function sequence(...responses: Array<Response | Error>): () => Response | Error {
  let i = 0;
  return () => responses[Math.min(i++, responses.length - 1)] as Response | Error;
}

export const NOW = Date.parse("2026-11-06T12:00:00Z");
export const oauthCred = (provider: "gmail" | "microsoft", over: Record<string, unknown> = {}) => ({
  kind: "oauth" as const,
  provider,
  accessToken: "access-token-SENTINEL",
  refreshToken: "refresh-token-SENTINEL",
  expiresAt: NOW + 3_600_000,
  scopes: [],
  ...over,
});
export const OAUTH_CONFIG = {
  gmail: { clientId: "g-client", clientSecret: "g-secret-SENTINEL" },
  microsoft: { clientId: "m-client", clientSecret: "m-secret-SENTINEL" },
};
