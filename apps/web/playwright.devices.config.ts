import { defineConfig, devices } from "@playwright/test";

/**
 * The film and the plain page on other engines and device sizes, against a site that's already running: Safari's engine as an iPhone
 * and an iPad, and Chrome as an Android phone. These are emulated. They catch engine and layout problems, not a real phone's GPU or heat.
 *   DEVICE_URL=https://staging.example.com STAGING_USER=... STAGING_PASSWORD=... pnpm exec playwright test -c playwright.devices.config.ts
 */
const URL = process.env.DEVICE_URL ?? "http://localhost:3217";
const httpCredentials = process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASSWORD ?? "" } : undefined;
export default defineConfig({
  testDir: "./e2e",
  testMatch: /film\.spec\.ts/,
  grepInvert: /workspace doesn't download/,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: { baseURL: URL, httpCredentials, extraHTTPHeaders: { Origin: URL } },
  projects: [
    { name: "iphone-webkit", use: { ...devices["iPhone 15"] } },
    { name: "ipad-webkit", use: { ...devices["iPad Pro 11"] } },
    { name: "android-chrome", use: { ...devices["Pixel 7"] } },
  ],
});
