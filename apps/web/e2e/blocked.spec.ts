import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("blocked mail stays out of the inbox; admins see it in Organization, without its content", async ({ page }) => {
  await signIn(page);
  // An ordinary inbox: no Quarantine in the menu, no count asking for review.
  await page.goto("/app/inbox");
  const nav = page.getByRole("navigation", { name: "Mailboxes" });
  await expect(nav.getByRole("link", { name: /Quarantine/ })).toHaveCount(0);
  await expect(page.getByText(/to review/)).toHaveCount(0);
  await expect(page.getByTestId("thread-row").filter({ hasText: "updated bank details" })).toHaveCount(0);
  await page.goto("/app/focus");
  await expect(page.getByTestId("thread-row").filter({ hasText: "updated bank details" })).toHaveCount(0);
  // The admin's view: whose mailbox, when, why. Never the subject.
  await page.goto("/app/org/blocked");
  await expect(page.getByRole("heading", { level: 1, name: "Blocked mail" })).toBeVisible();
  const rows = page.getByTestId("blocked-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Blocked mail" })).not.toContainText("updated bank details");
  const api = await (await page.request.get("/api/v1/org/blocked")).json();
  expect(JSON.stringify(api)).not.toMatch(/updated bank details|harb0r/);
});
