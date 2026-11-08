import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against a production build on its own port and its own database, reset and reseeded first,
 * with the real worker process. Nothing here touches the dev database.
 */
const PORT = 3217;
export const E2E_DB = "aegis_e2e";
/** Point the tests at a server you started yourself, on your own database. No server is started and nothing is reset. */
const EXTERNAL = process.env.BASE_URL;
const ORIGIN = EXTERNAL ?? `http://localhost:${PORT}`;
const env = {
  NODE_ENV: "production", DEMO_MODE: "true", AEGIS_MARKETING_SITE: "true", APP_ORIGIN: `http://localhost:${PORT}`, WEBAUTHN_RP_ID: "localhost", NEXT_DIST_DIR: ".next-e2e", AEGIS_TEST_SSO_LOOPBACK: "true",
  DATABASE_URL: `postgres://localhost:5432/${E2E_DB}`, DATABASE_URL_WEB: `postgres://aegis_web_login@localhost:5432/${E2E_DB}`, DATABASE_URL_WORKER: `postgres://aegis_worker_login@localhost:5432/${E2E_DB}`,
};
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.005, animations: "disabled" } },
  reporter: [["list"]],
  use: { baseURL: ORIGIN, trace: "retain-on-failure", timezoneId: "UTC", locale: "en-US", extraHTTPHeaders: { Origin: ORIGIN } },
  // Reset and seed first: Playwright starts servers before global setup, and the worker needs the database to exist.
  // One process group, so stopping it takes down both the web server and the real worker.
  webServer: EXTERNAL ? undefined : { command: `pnpm --dir ../.. db:reset && pnpm --dir ../.. db:seed && pnpm exec next build && (pnpm --filter @aegis/worker exec tsx src/main.ts & exec pnpm exec next start -p ${PORT})`, url: `http://localhost:${PORT}/api/v1/health`, timeout: 300_000, reuseExistingServer: false, env },
  projects: [
    // Visual runs first, against the pristine seed: the other suites change mail state.
    { name: "visual", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testMatch: /visual/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile|visual/, dependencies: ["visual"] },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile/, dependencies: ["desktop"] },
  ],
});
