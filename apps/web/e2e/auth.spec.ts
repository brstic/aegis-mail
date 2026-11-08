import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";

const unique = () => `e2e-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.org`;
const PASSWORD = "correct-horse-battery-staple";

/** RFC 6238, as an authenticator app would do it. */
function totp(base32: string) {
  const bits = [...base32.replace(/=+$/, "")].map(c => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const at = h[19]! & 15;
  return String((h.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("sign up with a password, reach onboarding, sign out, sign back in", async ({ page }) => {
  const email = unique();
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name").fill("Sam Tester");
  await page.getByRole("button", { name: /create|sign up|get started/i }).click();
  await expect(page).toHaveURL(/\/app\/onboarding/);
  // Leave the app first. It redirects itself when its session ends, and that would race the navigation below.
  await page.goto("about:blank");
  await page.request.post("/api/v1/auth/signout");
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password-here");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByRole("alert").filter({ hasText: /don't match/ })).toBeVisible();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/app/);
});

test("the app redirects to sign-in without a session, and the API says 401", async ({ page }) => {
  await page.goto("/app/focus");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await page.request.get("/api/v1/threads")).status()).toBe(401);
});

test("passkey: register with an authenticator, sign out, sign in with it, then remove it", async ({ page, context }) => {
  // A real WebAuthn ceremony against the real server, through Chromium's virtual authenticator.
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const email = unique();
  const r = await page.request.post("/api/v1/auth/signup", { data: { email, password: PASSWORD, name: "Pat Key", workspaceKind: "personal" } });
  expect(r.ok()).toBeTruthy();
  await page.goto("/app/settings/security");
  // A signed-in session isn't enough to add a way in.
  await expect(page.getByLabel("Your password")).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("Enter your password to add a passkey.")).toBeVisible();
  await expect(page.getByTestId("passkey-row")).toHaveCount(0);
  await page.getByLabel("Your password").fill("not-the-right-password");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByText("That password isn't right.")).toBeVisible();
  await expect(page.getByTestId("passkey-row")).toHaveCount(0);
  await page.getByLabel("Your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByTestId("passkey-row")).toHaveCount(1);
  await page.request.post("/api/v1/auth/signout");
  await context.clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: /passkey/i }).click();
  await expect(page).toHaveURL(/\/app\/(focus|inbox)/);
  const me = await (await page.request.get("/api/v1/me")).json();
  expect(me.email).toBe(email);
  await page.goto("/app/settings/security");
  await page.getByRole("button", { name: /Remove passkey/ }).click();
  await expect(page.getByTestId("passkey-row")).toHaveCount(0);
});

test("authenticator app: setting one up takes the password, ends other sessions, and sign-in then needs a code", async ({ page, browser, baseURL }) => {
  const email = unique();
  const r = await page.request.post("/api/v1/auth/signup", { data: { email, password: PASSWORD, name: "Pat Code", workspaceKind: "personal" } });
  expect(r.ok()).toBeTruthy();
  const elsewhere = await browser.newContext({ baseURL: baseURL!, extraHTTPHeaders: { Origin: baseURL! } });
  expect((await elsewhere.request.post("/api/v1/auth/signin", { data: { email, password: PASSWORD } })).ok()).toBeTruthy();
  expect((await elsewhere.request.get("/api/v1/me")).ok()).toBeTruthy();

  await page.goto("/app/settings/security");
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up an authenticator app?" });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("totp-enroll")).toHaveCount(0);
  await dialog.getByLabel("Your password").fill("not-the-right-password");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText("That password isn't right.")).toBeVisible();
  await expect(page.getByTestId("totp-enroll")).toHaveCount(0);
  await dialog.getByLabel("Your password").fill(PASSWORD);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("totp-enroll")).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").textContent())!;
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByTestId("totp-enroll")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Move to a new app" })).toBeVisible();

  expect((await elsewhere.request.get("/api/v1/me")).status()).toBe(401);
  await elsewhere.close();
  // This session carries on, and there's a way in only with the code now.
  expect((await page.request.get("/api/v1/me")).ok()).toBeTruthy();
  const noCode = await page.request.post("/api/v1/auth/signin", { data: { email, password: PASSWORD } });
  expect((await noCode.json()).error.code).toBe("mfa_required");
});

test("a security admin can sign in to the demo and see aggregates in the UI", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: /admin/i }).click();
  await expect(page).toHaveURL(/\/app\/(focus|inbox)/);
  await page.goto("/app/security");
  await expect(page.getByText(/no message contents|aggregate/i).first()).toBeVisible();
});

test("the demo panel on the sign-in page says the data is synthetic", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByText(/synthetic/i).first()).toBeVisible();
});
