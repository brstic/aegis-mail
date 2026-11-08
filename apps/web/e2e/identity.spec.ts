import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Db } from "../../../packages/db/src/index";
import { fakeOidc } from "../../../packages/platform/src/__tests__/fake-oidc";
import { fakeSamlIdp } from "../../../packages/platform/src/__tests__/fake-saml";
import { signIn, watchErrors } from "./helpers";

const DB_URL = process.env.E2E_DATABASE_URL ?? "postgres://localhost:5432/aegis_e2e";
const PASSWORD = "correct-horse-battery";
const stamp = Date.now().toString(36);
const addr = (name: string, domain = "example.org") => `${name}-${stamp}@${domain}`;

async function db<T>(fn: (d: Db) => Promise<T>) {
  const d = new Db(DB_URL, 1);
  try { return await fn(d); } finally { await d.close(); }
}
async function signUp(page: Page, email: string, name = "Test Person", kind: "personal" | "organization" = "personal") {
  const r = await page.request.post("/api/v1/auth/signup", { data: { email, password: PASSWORD, name, workspaceKind: kind } });
  expect(r.ok(), await r.text()).toBeTruthy();
}
/** Waits for the real worker to send it, then reads it off the labelled dev page. */
async function linkFromOutbox(page: Page, to: string, path: string, atLeast = 1) {
  for (let i = 0; i < 40; i++) {
    await page.goto("/dev/outbox");
    // Links show as buttons ("Confirm email"), so the mail is found by where its link goes. Older mail can be hidden behind "Show more".
    const mail = page.getByTestId("outbox-mail").filter({ hasText: to }).filter({ has: page.locator(`a[href*="/${path}/"]`) });
    if (await mail.count() >= atLeast) return (await mail.first().locator(`a[href*="/${path}/"]`).first().getAttribute("href"))!;
    await page.waitForTimeout(500);
  }
  throw new Error(`no ${path} mail for ${to}`);
}
const relative = (url: string) => { const u = new URL(url); return `${u.pathname}${u.search}`; };
async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
async function axeClean(page: Page, within?: string) {
  const b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]);
  if (within) b.include(within);
  const r = await b.analyze();
  expect(r.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test.describe("email verification", () => {
  test("banner, dev outbox, single-use link, and the banner goes", async ({ page }) => {
    const errors = watchErrors(page);
    const email = addr("verify");
    await signUp(page, email);
    await page.goto("/app/settings");
    await expect(page.getByTestId("verify-banner")).toContainText(email);
    await page.getByTestId("verify-banner").getByRole("button", { name: "Resend" }).click();
    await expect(page.getByTestId("verify-banner")).toContainText("new link");
    // The original and the resend. Only the resend's token is live, but the two can be delivered in either order, so "newest" isn't enough to tell which.
    await linkFromOutbox(page, email, "verify-email", 2);
    const mails = page.getByTestId("outbox-mail").filter({ hasText: email }).filter({ has: page.locator('a[href*="/verify-email/"]') });
    const links = await Promise.all((await mails.all()).map(async m => (await m.locator('a[href*="/verify-email/"]').first().getAttribute("href"))!));
    expect(links).toHaveLength(2);
    const results: { link: string; ok: boolean }[] = [];
    for (const l of links) {
      await page.goto(relative(l));
      await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
      await page.getByRole("button", { name: "Confirm my email" }).click();
      const outcome = page.getByRole("heading", { name: /Email confirmed|This link isn't valid anymore/ });
      await expect(outcome).toBeVisible();
      results.push({ link: l, ok: /Email confirmed/.test((await outcome.textContent()) ?? "") });
      if (results.at(-1)!.ok) break;
    }
    // The first link tried is live, or it was the revoked one and the second is.
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const link = results.find(r => r.ok)!.link;
    await page.goto("/app/settings");
    await expect(page.getByRole("heading", { name: "Settings", exact: false }).first()).toBeVisible();
    await expect(page.getByTestId("verify-banner")).toHaveCount(0);
    await page.goto(relative(link));
    await page.getByRole("button", { name: "Confirm my email" }).click();
    await expect(page.getByRole("heading", { name: "This link isn't valid anymore" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("an unverified invitee is told to verify, then can accept", async ({ page, browser }) => {
    await signIn(page);
    const email = addr("invitee");
    await page.goto("/app/org");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Create invitation" }).click();
    const inviteUrl = await page.getByLabel("Invitation link").inputValue();
    const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin, extraHTTPHeaders: { Origin: new URL(page.url()).origin } });
    const invitee = await ctx.newPage();
    await signUp(invitee, email);
    await invitee.goto(relative(inviteUrl));
    await invitee.getByRole("button", { name: "Accept invitation" }).click();
    await expect(invitee.getByRole("heading", { name: "Confirm your email first" })).toBeVisible();
    await invitee.goto(relative(await linkFromOutbox(invitee, email, "verify-email")));
    await invitee.getByRole("button", { name: "Confirm my email" }).click();
    await expect(invitee.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await invitee.goto(relative(inviteUrl));
    await invitee.getByRole("button", { name: "Accept invitation" }).click();
    await expect(invitee).toHaveURL(/\/app/);
    await ctx.close();
  });
});

test.describe("password reset", () => {
  test("reveals nothing about the address, changes the password, and ends old sessions", async ({ page, browser }) => {
    const email = addr("reset");
    const ctx = await browser.newContext({ baseURL: new URL(test.info().project.use.baseURL!).origin, extraHTTPHeaders: test.info().project.use.extraHTTPHeaders });
    const other = await ctx.newPage();
    await signUp(other, email);
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByLabel("Email").fill(`nobody-${stamp}@example.org`);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const unknown = (await page.getByRole("heading", { name: "Check your email" }).locator("../..").innerText()).replace(`nobody-${stamp}@example.org`, "ADDR");
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const known = (await page.getByRole("heading", { name: "Check your email" }).locator("../..").innerText()).replace(email, "ADDR");
    expect(known).toBe(unknown);
    await page.goto(relative(await linkFromOutbox(page, email, "reset-password")));
    await page.getByLabel("New password").fill("a-brand-new-password-99");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible();
    expect((await other.request.get("/api/v1/me")).status()).toBe(401);
    expect((await page.request.post("/api/v1/auth/signin", { data: { email, password: PASSWORD } })).status()).toBe(401);
    expect((await page.request.post("/api/v1/auth/signin", { data: { email, password: "a-brand-new-password-99" } })).ok()).toBeTruthy();
    await ctx.close();
  });
});

test.describe("OIDC SSO in a real browser", () => {
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  const domain = `sso-${stamp}.example`;
  test.beforeAll(async () => { idp = await fakeOidc({ clientId: "e2e-client", clientSecret: "e2e-secret-value" }); });
  test.afterAll(async () => { await idp.close(); });

  test("configure, sign in through the provider, JIT, enforce, and password is refused", async ({ page, browser }) => {
    const owner = addr("owner");
    await signUp(page, owner, "Owner", "organization");
    await page.request.post("/api/v1/org/domains", { data: { domain } });
    await db(d => d.pool.query("UPDATE verified_domains SET verified_at=now() WHERE domain=$1", [domain]));
    await page.goto("/app/org/sso");
    await expect(page.getByRole("heading", { name: "Single sign-on" })).toBeVisible();
    await expect(page.getByText("Test with one account before requiring it for everyone.")).toBeVisible();
    await expect(page.getByTestId("sso-callback")).toContainText("/api/v1/auth/sso/callback");
    await page.getByLabel("Add a provider for").selectOption(domain);
    await page.getByLabel("Issuer URL").fill(idp.issuer);
    await page.getByLabel("Client ID").fill("e2e-client");
    await page.getByLabel("Client secret").fill("e2e-secret-value");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("sso-config")).toContainText("Not tested yet");
    await expect(page.getByRole("switch", { name: "Require single sign-on for this domain" })).toBeDisabled();
    expect((await page.content()).includes("e2e-secret-value")).toBe(false);

    // A stranger's browser: the sign-in page offers SSO, and the provider sends them back signed in.
    const base = new URL(page.url()).origin;
    const ctx = await browser.newContext({ baseURL: base });
    const person = await ctx.newPage();
    await person.goto("/sign-in");
    await person.getByRole("button", { name: "Use single sign-on" }).click();
    await person.getByLabel("Work email").fill(`jit@${domain}`);
    await person.getByRole("button", { name: "Continue to your organization" }).click();
    await expect(person).toHaveURL(/\/app/);
    const me = await (await person.request.get("/api/v1/me")).json();
    expect(me).toMatchObject({ email: `jit@${domain}`, role: "member", emailVerified: true });
    const cookies = await ctx.cookies();
    const session = cookies.find(c => c.name === "aegis_session")!;
    expect(session.httpOnly).toBe(true);
    expect(session.sameSite).toBe("Lax");
    expect(cookies.find(c => c.name === "aegis_sso_flow")).toBeUndefined();

    // A replayed callback URL doesn't sign anyone in, and shows only our own message.
    const replay = await browser.newContext({ baseURL: base });
    const r = await replay.newPage();
    await r.goto(`/api/v1/auth/sso/callback?code=x&state=y`);
    await expect(r).toHaveURL(/\/sign-in\?error=sso_state_invalid/);
    await expect(r.getByText("That sign-in attempt expired or didn't start in this browser")).toBeVisible();
    await r.goto("/sign-in?error=%3Cscript%3Ealert(1)%3C/script%3E");
    await expect(r.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(r.getByText("alert(1)")).toHaveCount(0);
    expect((await r.request.get("/api/v1/me")).status()).toBe(401);
    await replay.close();

    // Now it has worked once, it can be required.
    await page.reload();
    await expect(page.getByTestId("sso-config")).toContainText("Last sign-in worked");
    await page.getByRole("switch", { name: "Require single sign-on for this domain" }).click();
    await expect(page.getByTestId("sso-config")).toContainText("Required");
    await person.goto("/sign-in");
    await person.getByLabel("Email").first().fill(`jit@${domain}`);
    await person.getByLabel("Password").fill(PASSWORD);
    await person.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(person.getByText("requires single sign-on")).toBeVisible();
    await expect(person.getByRole("link", { name: "Continue with single sign-on" })).toBeVisible();
    await ctx.close();
  });
});

test.describe("adding a factor when you sign in through a provider", () => {
  let idp: Awaited<ReturnType<typeof fakeOidc>>;
  const domain = `reauth-${stamp}.example`;
  test.beforeAll(async () => { idp = await fakeOidc({ clientId: "e2e-client", clientSecret: "e2e-secret-value" }); });
  test.afterAll(async () => { await idp.close(); });

  test("no password to ask for, so a recent sign-in does it, and an old one is sent back through the provider", async ({ page, browser }) => {
    const owner = addr("reauthowner");
    await signUp(page, owner, "Owner", "organization");
    await page.request.post("/api/v1/org/domains", { data: { domain } });
    await db(d => d.pool.query("UPDATE verified_domains SET verified_at=now() WHERE domain=$1", [domain]));
    expect((await page.request.post("/api/v1/org/sso", { data: { domain, issuer: idp.issuer, clientId: "e2e-client", clientSecret: "e2e-secret-value" } })).ok()).toBeTruthy();

    const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL! });
    const person = await ctx.newPage();
    const throughProvider = async () => {
      await person.getByRole("button", { name: "Use single sign-on" }).click();
      await person.getByLabel("Work email").fill(`sam@${domain}`);
      await person.getByRole("button", { name: "Continue to your organization" }).click();
    };
    await person.goto("/sign-in");
    await throughProvider();
    // Where the redirects end, so the next navigation doesn't cut one short.
    await expect(person).toHaveURL(/\/app\/(inbox|focus|onboarding)/);

    await person.goto("/app/settings/security");
    await expect(person.getByRole("button", { name: "Add a passkey" })).toBeVisible();
    await expect(person.getByLabel("Your password")).toHaveCount(0);
    await person.getByRole("button", { name: "Set up authenticator app" }).click();
    await expect(person.getByTestId("totp-enroll")).toBeVisible();

    // Ten minutes on, the same session can't.
    await db(d => d.pool.query("UPDATE sessions SET created_at=now() - interval '11 minutes' WHERE user_id=(SELECT id FROM users WHERE lower(email)=$1) AND revoked_at IS NULL", [`sam@${domain}`]));
    await person.reload();
    await person.getByRole("button", { name: "Set up authenticator app" }).click();
    await expect(person.getByTestId("reauth-required")).toBeVisible();
    await expect(person.getByTestId("totp-enroll")).toHaveCount(0);

    await person.getByRole("button", { name: "Sign out and sign in again" }).click();
    await expect(person).toHaveURL(/\/sign-in\?next=/);
    await throughProvider();
    await expect(person).toHaveURL(/\/app\/settings\/security/);
    await person.getByRole("button", { name: "Set up authenticator app" }).click();
    await expect(person.getByTestId("totp-enroll")).toBeVisible();
    await ctx.close();
  });
});

test.describe("SAML in a real browser", () => {
  test("the provider's cross-site POST signs someone in, and a replay of it doesn't", async ({ page, browser }) => {
    const base = new URL(test.info().project.use.baseURL!).origin;
    const domain = `saml-${stamp}.example`;
    const owner = addr("samlowner");
    await signUp(page, owner, "Owner", "organization");
    await page.request.post("/api/v1/org/domains", { data: { domain } });
    await db(d => d.pool.query("UPDATE verified_domains SET verified_at=now() WHERE domain=$1", [domain]));
    const email = `sam@${domain}`;
    const idp = await fakeSamlIdp({ acs: d => `${base}/api/v1/auth/saml/${d}/acs`, audience: d => `${base}/api/v1/auth/saml/${d}`, email, domain });
    try {
      await page.goto("/app/org/sso");
      await page.getByLabel("Add a provider for").selectOption(domain);
      await page.getByRole("radio", { name: "SAML 2.0" }).check();
      await expect(page.getByTestId("saml-sp")).toContainText(`${base}/api/v1/auth/saml/${domain}/acs`);
      await page.getByLabel("Provider entity ID").fill("https://idp.corp.example/entity");
      await page.getByLabel("Provider sign-in URL").fill(idp.entryPoint);
      await page.getByLabel("Provider signing certificate").fill(idp.keys.cert);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByTestId("sso-config")).toContainText("SAML 2.0");

      const ctx = await browser.newContext({ baseURL: base });
      const person = await ctx.newPage();
      let posted: string | null = null;
      person.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/acs")) posted = r.postData(); });
      await person.goto("/sign-in");
      await person.getByRole("button", { name: "Use single sign-on" }).click();
      await person.getByLabel("Work email").fill(email);
      await person.getByRole("button", { name: "Continue to your organization" }).click();
      await expect(person).toHaveURL(/\/app/);
      expect(await (await person.request.get("/api/v1/me")).json()).toMatchObject({ email, role: "member", emailVerified: true });
      expect(posted).toBeTruthy();

      // The same POST again, from the same browser and a fresh one, signs nobody in.
      await person.request.post("/api/v1/auth/signout", { headers: { Origin: base } });
      const replay = await ctx.request.post(`/api/v1/auth/saml/${domain}/acs`, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, data: posted!, maxRedirects: 0 });
      expect(replay.status()).toBe(303);
      expect(replay.headers().location).toContain("/sign-in?error=sso_token_invalid");
      await ctx.close();
    } finally { await idp.close(); }
  });
});

test.describe("SCIM over real HTTP", () => {
  test("token shown once, provisioning, deprovisioning, and no cross-tenant reach", async ({ page, request, browser }) => {
    const domain = `scim-${stamp}.example`;
    await signUp(page, addr("scimowner"), "Owner", "organization");
    await page.request.post("/api/v1/org/domains", { data: { domain } });
    await db(d => d.pool.query("UPDATE verified_domains SET verified_at=now() WHERE domain=$1", [domain]));
    await page.goto("/app/org/sso");
    await page.getByRole("button", { name: "Generate token" }).click();
    const token = await page.getByLabel("SCIM bearer token").inputValue();
    expect(token).toMatch(/^aegis_scim_/);
    await page.reload();
    await expect(page.getByLabel("SCIM bearer token")).toHaveCount(0);
    expect(await page.content()).not.toContain(token);

    const base = "/api/v1/scim/v2";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json", Origin: "https://idp.example.net" };
    expect((await request.get(`${base}/Users`)).status()).toBe(401);
    expect((await request.get(`${base}/Users`, { headers: { Authorization: "Bearer nope" } })).status()).toBe(401);
    const cfg = await request.get(`${base}/ServiceProviderConfig`, { headers });
    expect(cfg.headers()["content-type"]).toContain("application/scim+json");
    expect((await cfg.json()).patch.supported).toBe(true);
    const created = await request.post(`${base}/Users`, { headers, data: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: `amy@${domain}`, displayName: "Amy" } });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    const list = await (await request.get(`${base}/Users?filter=${encodeURIComponent(`userName eq "amy@${domain}"`)}`, { headers })).json();
    expect(list.totalResults).toBe(1);
    const bad = await request.get(`${base}/Users?filter=${encodeURIComponent('title sw "x"')}`, { headers });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).scimType).toBe("invalidFilter");
    expect((await request.post(`${base}/Users`, { headers, data: { userName: "x@not-ours.example" } })).status()).toBe(403);
    const off = await request.patch(`${base}/Users/${id}`, { headers, data: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] } });
    expect((await off.json()).active).toBe(false);
    expect((await request.delete(`${base}/Users/${id}`, { headers })).status()).toBe(204);
    expect((await request.get(`${base}/Users/${id}`, { headers })).status()).toBe(404);
    expect((await request.get(`${base}/Users/not-a-uuid`, { headers })).status()).toBe(404);
    // A session cookie alone gets nowhere here: it's the token or nothing.
    expect((await page.request.get(`${base}/Users`)).status()).toBe(401);
    void browser;
  });
});

test.describe("notifications", () => {
  test("the bell opens a center, held mail appears with no content, and it can be marked read", async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto("/app/focus");
    const bell = page.getByTestId("notification-bell");
    await expect(bell).toBeVisible();
    await expect(async () => {
      const r = await page.request.get("/api/v1/notifications");
      expect((await r.json()).items.length).toBeGreaterThan(0);
    }).toPass({ timeout: 90_000, intervals: [2000] });
    await page.reload();
    await bell.click();
    const panel = page.getByTestId("notification-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("notification-row").first()).toBeVisible();
    const before = await page.request.get("/api/v1/notifications");
    const feed = await before.json();
    for (const i of feed.items) expect(Object.keys(i).sort()).toEqual(["at", "href", "id", "kind", "read", "severity", "title"]);
    // Just the panel: rows behind it can be mid-animation.
    await axeClean(page, '[data-testid="notification-panel"]');
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(bell).toBeFocused();
    await bell.click();
    if (feed.unread > 0) {
      await page.getByRole("button", { name: "Mark all read" }).click();
      await expect(page.getByRole("button", { name: "Mark all read" })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test("working and quiet hours say what they do now", async ({ page }) => {
    await signIn(page);
    await page.goto("/app/settings/personalization");
    await expect(page.getByText("has no effect")).toHaveCount(0);
    await expect(page.getByText("wait until your working hours")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Browser notifications" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("switch", { name: "Daily email digest" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("switch", { name: "Security alerts during quiet hours" })).toHaveAttribute("aria-checked", "false");
  });
});

test.describe("new screens", () => {
  const publicPaths = ["/sign-in", "/sign-up", "/forgot-password", "/reset-password/not-a-real-token", "/verify-email/not-a-real-token", "/dev/outbox"];
  for (const scheme of ["light", "dark"] as const) {
    test(`pass axe and don't scroll sideways at 360px, ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 360, height: 780 });
      for (const path of publicPaths) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await noSideScroll(page);
        await axeClean(page);
      }
      await signIn(page, "member");
      for (const path of ["/app/org/sso", "/app/settings/personalization", "/app/tasks"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await noSideScroll(page);
        await axeClean(page);
      }
      await page.getByTestId("notification-bell").click();
      await expect(page.getByTestId("notification-panel")).toBeVisible();
      await noSideScroll(page);
      const box = (await page.getByTestId("notification-panel").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      // Below the bell, not over the bars above it, and all of it on screen.
      const bell = (await page.getByTestId("notification-bell").boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(bell.y + bell.height);
      expect(box.y + box.height).toBeLessThanOrEqual(780);
    });
  }
  test("the SSO page's forms pass axe for an owner, at 360px", async ({ page }) => {
    const domain = `form-${stamp}.example`;
    await page.setViewportSize({ width: 360, height: 780 });
    await signUp(page, addr("formowner"), "Owner", "organization");
    await page.request.post("/api/v1/org/domains", { data: { domain } });
    await db(d => d.pool.query("UPDATE verified_domains SET verified_at=now() WHERE domain=$1", [domain]));
    await page.goto("/app/org/sso");
    await page.getByLabel("Add a provider for").selectOption(domain);
    await expect(page.getByLabel("Issuer URL")).toBeVisible();
    await noSideScroll(page);
    await axeClean(page);
    await page.getByRole("radio", { name: "SAML 2.0" }).check();
    await expect(page.getByTestId("saml-sp")).toContainText(`/api/v1/auth/saml/${domain}/acs`);
    await noSideScroll(page);
    await axeClean(page);
    await page.getByRole("button", { name: "Generate token" }).click();
    await expect(page.getByLabel("SCIM bearer token")).toBeVisible();
    await noSideScroll(page);
  });
});
