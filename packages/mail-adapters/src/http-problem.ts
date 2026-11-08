import { GrantRevokedError, RateLimitedError, type ConnectionTestResult } from "@aegis/domain/mail";
import { TokenRefreshError } from "./oauth";
import { ProviderHttpError, ProviderNetworkError, problemDetail } from "./shared";

/** Maps a failure from an OAuth/REST provider to a credential-free connection test result. */
export function classifyHttpProblem(err: unknown): ConnectionTestResult {
  const problem = ((): NonNullable<ConnectionTestResult["problem"]> => {
    if (err instanceof GrantRevokedError) return "oauth_revoked";
    if (err instanceof RateLimitedError) return "rate_limited";
    if (err instanceof ProviderNetworkError) return err.timedOut ? "timeout" : "host_unreachable";
    if (err instanceof TokenRefreshError) return "unknown";
    if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) return "auth_failed";
    if (err instanceof ProviderHttpError) return "protocol_error";
    return "unknown";
  })();
  return { ok: false, problem, detail: problemDetail(problem) };
}
