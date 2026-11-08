import { defineConfig, devices } from "@playwright/test";

/** The identity browser suite alone, on its own port and database, so it can run beside the other work on this machine. */
const PORT = Number(process.env.E2E_PORT ?? 3277);
const DB = "aegis_e2e_identity";
process.env.E2E_DATABASE_URL = `postgres://localhost:5432/${DB}`;
const env = {
  NODE_ENV: "production", DEMO_MODE: "true", APP_ORIGIN: `http://localhost:${PORT}`, WEBAUTHN_RP_ID: "localhost", NEXT_DIST_DIR: ".next-e2e-identity", AEGIS_TEST_SSO_LOOPBACK: "true",
  DATABASE_URL: `postgres://localhost:5432/${DB}`, DATABASE_URL_WEB: `postgres://aegis_web_login@localhost:5432/${DB}`, DATABASE_URL_WORKER: `postgres://aegis_worker_login@localhost:5432/${DB}`,
};
export default defineConfig({
  testDir: "./e2e",
  testMatch: process.env.E2E_MATCH ? new RegExp(process.env.E2E_MATCH) : /identity\.spec/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", timezoneId: "UTC", locale: "en-US", extraHTTPHeaders: { Origin: `http://localhost:${PORT}` }, ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
  webServer: { command: `pnpm --dir ../.. db:reset && pnpm --dir ../.. db:seed && pnpm exec next build && (pnpm --filter @aegis/worker exec tsx src/main.ts & exec pnpm exec next start -p ${PORT})`, url: `http://localhost:${PORT}/api/v1/health`, timeout: 400_000, reuseExistingServer: false, env },
});
