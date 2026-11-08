/**
 * Where the project lives, and whether this server shows the marketing site. No React here, so the proxy can import it.
 * The repository URL is written once, here: every "Get it on GitHub" and every license link reads it.
 */
export const REPO_URL = "https://github.com/brstic/aegis-mail";
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const README_URL = `${REPO_URL}#readme`;

/**
 * A self-hosted instance is the app, not our website. The marketing pages show only when AEGIS_MARKETING_SITE is exactly "true".
 * Read at request time (in the proxy and in server components), so one image serves either role.
 */
export function marketingSiteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AEGIS_MARKETING_SITE === "true";
}

/** Pages that only make sense on the marketing site. With it off, they send people to the app. Legal pages stay reachable. */
export const MARKETING_ONLY_PATHS = ["/features", "/security", "/trust", "/docs", "/privacy-architecture"] as const;
