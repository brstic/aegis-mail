import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const theme = (page: import("@playwright/test").Page) => page.evaluate(() => document.documentElement.dataset.theme ?? "system");

test.use({ colorScheme: "dark" });

test("one button switches the theme on the site, on sign-in, and in the app, and it's remembered", async ({ page }) => {
  await page.goto("/features");
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  expect(await theme(page)).toBe("light");
  await page.goto("/sign-in");
  expect(await theme(page)).toBe("light");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
  await page.goto("/sign-up");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  expect(await theme(page)).toBe("dark");
  // In the app, the choice is saved to the account, so it survives a reload.
  await signIn(page);
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /Switch to (light|dark) mode/ }).click();
  const chosen = await theme(page);
  await expect.poll(async () => (await (await page.request.get("/api/v1/preferences")).json()).theme).toBe(chosen);
  await page.reload();
  expect(await theme(page)).toBe(chosen);
});
