import { expect, request, test } from "@playwright/test";
import { signIn, watchErrors } from "./helpers";

/**
 * Self-hosted, with no plans: limits are off unless the server admin sets one, and the operator console sets them per workspace.
 * No AEGIS_LIMIT_* is set for these runs, so every limit starts as none.
 */
const DEMO_PW = "demo-password-not-secret";
const AVERY = "avery@demo.aegis.example";

test.describe("no plans in the app", () => {
  test.beforeEach(async ({ page }) => { await signIn(page); });

  test("settings has no plan page, and the old address and API are gone", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/app/settings");
    await expect(page.getByRole("link", { name: /^Plan/ })).toHaveCount(0);
    await expect(page.getByText(/your plan|upgrade|pricing/i)).toHaveCount(0);
    expect(errors).toEqual([]);
    expect((await page.goto("/app/settings/billing"))!.status()).toBe(404);
    for (const path of ["/api/v1/billing", "/api/v1/public/pricing"]) expect((await page.request.get(path)).status(), path).toBe(404);
    expect((await page.request.post("/api/v1/billing/checkout", { data: { plan: "pro" } })).status()).toBe(404);
    expect((await page.request.post("/api/v1/webhooks/stripe", { data: "{}" })).status()).toBe(404);
  });

  test("every limit is none by default, and nothing on connect talks about limits", async ({ page }) => {
    const r = await (await page.request.get("/api/v1/limits")).json();
    expect(r.limits).toEqual({ accounts: null, aiActionsPerMonth: null, automations: null, seats: null, indexBytes: null });
    await page.goto("/app/connect");
    await expect(page.getByRole("heading", { name: "Connect your email" })).toBeVisible();
    await expect(page.getByText(/server admin can raise it|account limit/i)).toHaveCount(0);
  });

  test("the Security Center is there for the owner, with no plan gate", async ({ page }) => {
    await page.goto("/app/security");
    await expect(page.getByRole("main")).toContainText(/Security/);
    await expect(page.getByText(/Not on your current plan|See plans/)).toHaveCount(0);
  });

  test("roles to choose from don't include a billing role", async ({ page }) => {
    await page.goto("/app/org");
    await expect(page.getByRole("heading", { name: "Invite someone" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Billing/i })).toHaveCount(0);
    await expect(page.getByText(/Billing manager/)).toHaveCount(0);
  });
});

test.describe("operator console is hidden from everyone else", () => {
  test("a tenant owner gets a 404 on the pages and the API", async ({ page }) => {
    await signIn(page);
    for (const path of ["/admin", "/admin/tenants", "/admin/jobs", "/admin/health", "/admin/audit"]) expect((await page.goto(path))!.status(), path).toBe(404);
    for (const path of ["overview", "tenants", "jobs", "health", "audit"]) expect((await page.request.get(`/api/v1/operator/${path}`)).status(), path).toBe(404);
    expect((await page.request.post("/api/v1/operator/tenants/00000000-0000-4000-8000-000000000000/suspend", { data: { reason: "not allowed" } })).status()).toBe(404);
  });
  test("someone signed out gets a 404, not a sign-in page", async ({ page }) => {
    expect((await page.goto("/admin"))!.status()).toBe(404);
    expect((await page.request.get("/api/v1/operator/overview")).status()).toBe(404);
  });
});

test.describe("operator console, as the demo operator", () => {
  test.beforeEach(async ({ page }) => { await signIn(page, "operator"); });

  test("the demo button on sign-in opens the console, which looks different and says what it can't do", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/sign-in");
    await page.getByRole("button", { name: /platform operator console/ }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText("Operator console")).toBeVisible();
    await expect(page.getByText("Demo", { exact: true })).toBeVisible();
    await expect(page.getByText(/Content-blind by design/)).toBeVisible();
    await expect(page.getByTestId("overview-stats")).toContainText("Tenants");
    await expect(page.getByRole("heading", { name: "Connected mailboxes" })).toBeVisible();
    await expect(page.getByText(/Plan distribution|Paying subscriptions|Stripe/)).toHaveCount(0);
    // There's no way to see mail from here: no such control exists, and no address shows.
    await expect(page.getByRole("button", { name: /impersonate|view email|sign in as/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /impersonate|view email|sign in as/i })).toHaveCount(0);
  });

  test("tenant detail shows counts with no addresses", async ({ page }) => {
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: /Fernhill Studio/ }).click();
    await page.getByRole("heading", { name: "Usage" }).waitFor();
    await expect(page.getByTestId("limit-list")).toContainText("Connected accounts per person: No limit");
    await expect(page.getByRole("main")).not.toContainText(/\bplan\b|trial|payment|seats billed/i);
    const main = await page.getByRole("main").innerText();
    expect(main).not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    await expect(page.getByRole("button", { name: /Show owner contact/ })).toBeDisabled();
  });

  test("a limit: reason required, shown in the list, in the operator log, to the tenant's owner, and in what they're told", async ({ page }) => {
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: /Harbor (Trial )?Co/ }).click();
    await page.getByRole("heading", { name: "Limits" }).waitFor();
    const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Limits" }) });
    await card.getByRole("combobox", { name: "Limit", exact: true }).selectOption("accounts");
    await card.getByLabel("Value", { exact: true }).fill("0");
    await expect(card.getByRole("button", { name: "Save limit" })).toBeDisabled();
    await card.getByLabel("Reason").fill("Pilot without mailboxes, e2e");
    await card.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByTestId("limit-list")).toContainText("Connected accounts per person: 0");

    const avery = await request.newContext({ baseURL: page.url().split("/admin")[0], extraHTTPHeaders: { Origin: new URL(page.url()).origin } });
    expect((await avery.post("/api/v1/auth/signin", { data: { email: AVERY, password: DEMO_PW } })).ok()).toBeTruthy();
    const rows = (await (await avery.get("/api/v1/org/audit")).json()).rows as { event: string; meta: { reason?: string } }[];
    expect(rows.find(r => r.event === "operator.override_set")?.meta.reason).toBe("Pilot without mailboxes, e2e");
    expect((await (await avery.get("/api/v1/limits")).json()).limits.accounts).toBe(0);
    const refused = await avery.post("/api/v1/accounts/imap", { data: { kind: "imap", displayName: "X", email: "x@harbor.example", username: "x", password: "y", imapHost: "imap.harbor.example", imapPort: 993, imapSecurity: "tls" } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toMatchObject({ code: "limit_reached", message: "This workspace's limit is 0 connected accounts. The server admin can raise it." });
    await avery.dispose();

    // No limit for this tenant, whatever the default.
    await card.getByRole("combobox", { name: "Limit", exact: true }).selectOption("seats");
    await card.getByLabel(/No limit for this tenant/).check();
    await expect(card.getByLabel("Value", { exact: true })).toBeDisabled();
    await card.getByLabel("Reason").fill("Unlimited members, e2e");
    await card.getByRole("button", { name: "Save limit" }).click();
    await expect(page.getByTestId("limit-list")).toContainText("Unlimited members, e2e");

    for (const label of ["Connected accounts per person", "Members"]) {
      await page.getByRole("button", { name: `Use the server default for ${label}` }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Reason").fill("Finished, e2e");
      await dialog.getByRole("button", { name: "Use default" }).click();
      await expect(dialog).toHaveCount(0);
    }
    await expect(page.getByTestId("limit-list")).toContainText("Connected accounts per person: No limit");
    await expect(page.getByRole("button", { name: /Use the server default/ })).toHaveCount(0);

    await page.goto("/admin/audit");
    await expect(page.getByTestId("op-audit-row").filter({ hasText: "Pilot without mailboxes, e2e" })).toContainText("Set a limit");
  });

  test("owner contact is logged", async ({ page }) => {
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: /Harbor (Trial )?Co/ }).click();
    const contact = page.locator("section").filter({ has: page.getByRole("heading", { name: "Owner contact" }) });
    await contact.getByLabel("Reason").fill("Support ticket, e2e");
    await contact.getByRole("button", { name: "Show owner contact" }).click();
    await expect(page.getByTestId("owner-contact")).toContainText(AVERY);
    await page.goto("/admin/audit");
    await expect(page.getByTestId("op-audit-row").filter({ hasText: "Support ticket, e2e" })).toContainText("Viewed owner contact");
  });

  test("suspend blocks sign-in and says nothing is deleted; lifting it restores access", async ({ page }) => {
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: /Harbor (Trial )?Co/ }).click();
    await page.getByRole("button", { name: "Suspend this tenant" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Reason").fill("Abuse report, e2e");
    await dialog.getByRole("button", { name: "Suspend tenant" }).click();
    await expect(page.getByText(/Suspended .*Reason given: Abuse report, e2e/)).toBeVisible();

    const origin = new URL(page.url()).origin;
    const blocked = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
    const refused = await blocked.post("/api/v1/auth/signin", { data: { email: AVERY, password: DEMO_PW } });
    expect(refused.status()).toBe(403);
    const body = await refused.json();
    expect(body.error.code).toBe("workspace_suspended");
    expect(body.error.message).toContain("Nothing has been deleted");
    await blocked.dispose();

    await page.getByRole("button", { name: "Lift suspension" }).first().click();
    const lift = page.getByRole("dialog");
    await lift.getByLabel("Reason").fill("Report was mistaken, e2e");
    await lift.getByRole("button", { name: "Lift suspension" }).click();
    await expect(page.getByRole("button", { name: "Suspend this tenant" })).toBeVisible();

    const back = await request.newContext({ baseURL: origin, extraHTTPHeaders: { Origin: origin } });
    expect((await back.post("/api/v1/auth/signin", { data: { email: AVERY, password: DEMO_PW } })).ok()).toBeTruthy();
    const rows = (await (await back.get("/api/v1/org/audit")).json()).rows as { event: string }[];
    expect(rows.map(r => r.event)).toEqual(expect.arrayContaining(["operator.tenant_suspended", "operator.tenant_unsuspended"]));
    await back.dispose();
  });

  test("job queue and health show state and nothing from inside a job", async ({ page }) => {
    await page.goto("/admin/jobs");
    await expect(page.getByRole("heading", { name: "Job queue" })).toBeVisible();
    await page.getByLabel("Queued").check();
    await page.goto("/admin/health");
    await expect(page.getByTestId("health-row").filter({ hasText: "Database" })).toContainText("Answering");
    await expect(page.getByTestId("health-row").filter({ hasText: /^\s*Worker/ })).toContainText(/Last heartbeat/);
    await expect(page.getByTestId("health-row").filter({ hasText: "Deletion log" })).toBeVisible();
    await expect(page.getByTestId("health-row").filter({ hasText: "Limits" })).toContainText("None.");
    await expect(page.getByTestId("health-row").filter({ hasText: /Billing|Stripe/ })).toHaveCount(0);
  });
});
