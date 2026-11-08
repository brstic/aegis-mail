import { expect, test } from "@playwright/test";
import { LICENSE_URL, REPO_URL } from "../src/components/marketing/site";

// The marketing site (AEGIS_MARKETING_SITE=true in playwright.config.ts): open source, self-hosted, and no pricing anywhere.

test("calls to action lead to the repository, and the demo stays one click away", async ({ page }) => {
  await page.goto("/?static");
  const github = page.getByRole("link", { name: "Get it on GitHub" });
  await expect(github.first()).toHaveAttribute("href", REPO_URL);
  for (const href of await github.evaluateAll(as => as.map(a => a.getAttribute("href")))) expect(href).toBe(REPO_URL);
  await expect(page.getByRole("link", { name: "Try the demo" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /pricing|plans|get started/i })).toHaveCount(0);
});

test("there's no pricing page, and the old terms lead to the license", async ({ page }) => {
  expect((await page.request.get("/pricing")).status()).toBe(404);
  await page.goto("/legal/terms");
  await expect(page).toHaveURL(/\/legal\/license$/);
  await expect(page.getByRole("heading", { level: 1, name: "License" })).toBeVisible();
  await expect(page.getByRole("link", { name: "LICENSE file" })).toHaveAttribute("href", LICENSE_URL);
});

test("the docs explain self-hosting", async ({ page }) => {
  await page.goto("/docs#self-host");
  await expect(page.getByRole("heading", { name: "Self-host" })).toBeVisible();
  await expect(page.getByRole("link", { name: "README" })).toHaveAttribute("href", `${REPO_URL}#readme`);
});
