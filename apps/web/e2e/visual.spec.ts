import { expect, test } from "@playwright/test";
import { rows, signIn } from "./helpers";

/** Visual regression. Baselines live beside this file; refresh with --update-snapshots after an intended change. */
// Seed dates are relative to today, so times and date chips change daily. Everything else must match.
const mask = (page: import("@playwright/test").Page) => [page.locator("time"), page.getByText(/^(Due|Maybe) /), page.locator("canvas")];
test.beforeEach(async ({ page }) => { await signIn(page); });

test("focus light", async ({ page }) => {
  await page.goto("/app/focus"); await expect(rows(page).first()).toBeVisible(); await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot("focus-light.png", { mask: mask(page) });
});
test("focus dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/app/focus"); await expect(rows(page).first()).toBeVisible(); await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot("focus-dark.png", { mask: mask(page) });
});
test("threat detail", async ({ page }) => {
  await page.goto("/app/quarantine");
  await rows(page).filter({ hasText: "updated bank details" }).click();
  await page.getByTestId("security-strip").waitFor(); await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot("threat.png", { mask: mask(page) });
});
test("privacy center", async ({ page }) => {
  await page.goto("/app/privacy"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(300);
  await expect(page).toHaveScreenshot("privacy.png", { mask: mask(page) });
});
test("marketing home", async ({ page }) => {
  // The plain page. The film moves, so it has its own checks in film.spec.ts.
  await page.goto("/?static"); await page.waitForLoadState("networkidle");
  // Only the frame in view matters here, and it has to have arrived.
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>("#flurry img"); return !!i && i.complete && i.naturalWidth > 0; });
  await expect(page).toHaveScreenshot("home.png");
});
