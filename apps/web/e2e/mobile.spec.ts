import { expect, test } from "@playwright/test";
import { rows, signIn } from "./helpers";

const noHorizontalScroll = async (page: import("@playwright/test").Page, name: string) => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(r.sw, name).toBeLessThanOrEqual(r.cw);
};

test.beforeEach(async ({ page }) => { await signIn(page); });

test("mobile: list, open conversation, back, navigation drawer, composer", async ({ page }) => {
  await page.goto("/app/focus");
  await expect(rows(page).first()).toBeVisible();
  await noHorizontalScroll(page, "focus");
  await rows(page).first().click();
  await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();
  await noHorizontalScroll(page, "thread");
  await page.getByRole("button", { name: /Back to list/ }).click();
  await expect(rows(page).first()).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: /Sent/ }).click();
  await expect(page).toHaveURL(/\/app\/sent/);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation" }).getByRole("button", { name: "Compose" }).click();
  await expect(page.getByRole("dialog", { name: "Compose message" })).toBeVisible();
});

for (const path of ["/", "/docs", "/privacy-architecture", "/sign-in", "/app/privacy", "/app/settings/accounts", "/app/connect", "/app/org", "/app/security", "/app/rules", "/app/labels", "/app/insights", "/app/search?q=invoice", "/app/settings/topics", "/app/settings/identity", "/app/shared", "/app/tasks", "/app/org/policies", "/design-system"]) {
  test(`mobile: no horizontal scroll on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page, path);
  });
}

test("mobile: 360px thread toolbar, overflow menu, intelligence sheet, full-screen composer", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/app/inbox");
  await rows(page).first().click();
  const convo = page.getByRole("region", { name: "Conversation" });
  await convo.getByRole("heading", { level: 1 }).waitFor();
  await noHorizontalScroll(page, "thread at 360");
  const bar = page.getByRole("toolbar", { name: "Conversation actions" });
  const barBox = await bar.boundingBox();
  expect(barBox!.width).toBeLessThanOrEqual(360);
  const lastBtn = await bar.locator("button:visible").last().boundingBox();
  expect(lastBtn!.x + lastBtn!.width).toBeLessThanOrEqual(360);

  await bar.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: /Labels/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "More actions" })).toBeHidden();

  await bar.getByRole("button", { name: /Show summary/ }).click();
  const sheet = page.getByRole("dialog", { name: "Summary" });
  await expect(sheet.getByText("Why you're seeing this").or(sheet.getByText("Suggested replies")).first()).toBeVisible();
  await noHorizontalScroll(page, "sheet");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  await bar.getByRole("button", { name: /^Reply/ }).click();
  const composer = page.getByRole("dialog", { name: "Compose message" });
  await composer.waitFor();
  const box = await composer.boundingBox();
  expect(box!.width).toBe(360);
  expect(box!.height).toBe(740);
  await noHorizontalScroll(page, "composer");
  await composer.getByRole("button", { name: /Close/ }).click();
});

test("mobile: selecting by tapping the avatar opens bulk actions", async ({ page }) => {
  await page.goto("/app/inbox");
  await expect(rows(page).first()).toBeVisible();
  await page.getByRole("checkbox", { name: /^Select / }).first().check({ force: true });
  await expect(page.getByTestId("bulk-bar")).toBeVisible();
  await noHorizontalScroll(page, "bulk bar");
  await expect(page.getByRole("button", { name: "Label selected" })).toBeVisible();
  await page.getByRole("button", { name: "Clear selection" }).click();
});

test.describe("mobile: operator console", () => {
  test.beforeEach(async ({ page }) => { await page.context().clearCookies(); await signIn(page, "operator"); await page.setViewportSize({ width: 360, height: 780 }); });
  for (const path of ["/admin", "/admin/tenants", "/admin/jobs", "/admin/health", "/admin/audit"]) {
    test(`no horizontal scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.getByTestId("admin-shell")).toBeVisible();
      await noHorizontalScroll(page, path);
    });
  }
  test("no horizontal scroll on a tenant", async ({ page }) => {
    await page.goto("/admin/tenants");
    await page.getByRole("link", { name: /Harbor (Trial )?Co/ }).click();
    await page.getByRole("heading", { name: "Limits" }).waitFor();
    await noHorizontalScroll(page, "tenant");
  });
});
