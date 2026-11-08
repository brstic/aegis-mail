import { expect, test } from "@playwright/test";
import { signIn, watchErrors } from "./helpers";

// Real people aren't in the server's time zone. A page that renders dates differently on each side breaks hydration.
test.use({ timezoneId: "Pacific/Auckland", locale: "de-DE" });

const PAGES = ["/app/focus", "/app/inbox", "/app/quarantine", "/app/tasks", "/app/insights", "/app/settings/security", "/app/privacy", "/app/security", "/app/org/audit", "/docs", "/"];

test("no hydration errors in another time zone and locale", async ({ page }) => {
  await signIn(page, "admin");
  const errors = watchErrors(page);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  expect(errors).toEqual([]);
});

test("a thread opens without errors there too", async ({ page }) => {
  await signIn(page);
  const errors = watchErrors(page);
  await page.goto("/app/focus");
  await page.getByTestId("thread-row").first().click();
  await expect(page.getByRole("region", { name: "Conversation" }).getByRole("heading", { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});
