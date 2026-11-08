import { expect, test } from "@playwright/test";
import { pressUntil, signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

test("command palette: opens from the keyboard, navigates, and hands off a search", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/focus");
  const box = page.getByRole("combobox", { name: "Type a command or search" });
  await pressUntil(page, "ControlOrMeta+k", box);
  await expect(box).toBeFocused();
  await box.fill("tasks");
  await expect(page.getByRole("option", { name: "Go to Tasks" })).toBeVisible();
  await box.press("Enter");
  await expect(page).toHaveURL(/\/app\/tasks/);
  await pressUntil(page, "ControlOrMeta+k", box);
  await box.fill("zebra invoices");
  await page.getByRole("combobox", { name: "Type a command or search" }).press("Enter");
  await expect(page).toHaveURL(/\/app\/search\?q=zebra%20invoices/);
});

test("command palette: arrow keys move the selection, and it opens from inside an input", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/focus");
  await page.getByLabel("Search mail").focus();
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: "Type a command or search" });
  await box.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Commands" }).getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
});

test("tasks: the promises view and the up-next queue", async ({ page }) => {
  await signIn(page);
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  const accountId = (accounts.items ?? accounts)[0].id;
  const r = await page.request.post("/api/v1/tasks", { data: { text: "Overdue e2e item", accountId, dueAt: new Date(Date.now() - 86_400_000).toISOString() } });
  expect(r.ok()).toBeTruthy();
  await page.goto("/app/tasks");
  await expect(page.getByTestId("up-next").getByText("Overdue e2e item")).toBeVisible();
  await page.getByRole("button", { name: "Promises I made" }).click();
  await expect(page.getByRole("button", { name: "Promises I made" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: /Promises I made/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /Promises I made/ }).getByText("Overdue e2e item")).toHaveCount(0);
});

test("people: an account can be ranked and the choice sticks", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/settings/people");
  const select = page.getByRole("combobox").first();
  await select.selectOption("0.5");
  await expect(page.getByText(/Saved\. This applies to new mail/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox").first()).toHaveValue("0.5");
  await page.getByRole("combobox").first().selectOption("0");
});

test("org policies: a blocked outbound domain is saved (enforcement is in audit-gaps.test.ts)", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/app/org/policies");
  const box = page.getByLabel("Domains mail can't be sent to");
  await box.fill("blocked-e2e.example");
  // Reloading before the save has reached the server would throw the save away.
  const saved = page.waitForResponse(r => r.url().includes("/api/v1/org/policy") && r.request().method() !== "GET" && r.ok());
  await page.getByRole("button", { name: /save/i }).first().click();
  await saved;
  await page.reload();
  await expect(page.getByLabel("Domains mail can't be sent to")).toHaveValue(/blocked-e2e\.example/);
  await page.getByLabel("Domains mail can't be sent to").fill("");
  const cleared = page.waitForResponse(r => r.url().includes("/api/v1/org/policy") && r.request().method() !== "GET" && r.ok());
  await page.getByRole("button", { name: /save/i }).first().click();
  await cleared;
});

test("preferences saved quickly land in the order they were chosen, even if the first is slow", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/inbox");
  await page.getByTestId("thread-row").first().waitFor();
  let first = true;
  await page.route("**/api/v1/preferences", async route => {
    if (route.request().method() === "PATCH" && first) { first = false; await new Promise(r => setTimeout(r, 1500)); }
    await route.continue();
  });
  const choose = async (name: string) => {
    await page.getByRole("button", { name: /^Layout:/ }).click();
    await page.getByTestId("layout-switcher").getByText(name, { exact: true }).click();
    await page.keyboard.press("Escape");
  };
  await choose("Grouped by action");
  await choose("Chronological");
  await page.waitForTimeout(2500);
  const prefs = await (await page.request.get("/api/v1/preferences")).json();
  expect(prefs.layout).toBe("chronological");
});

test("refreshing mail never runs the path of a query observer that is switched off", async ({ page }) => {
  // The mail view watches the labels query with a null path outside label views, and shares its key with the sidebar. Opening unread
  // mail marks it read and invalidates queries, and an invalidation runs whichever query function rendered last.
  await signIn(page);
  const asked: string[] = [];
  page.on("request", r => { if (/\/api\/v1(null|undefined)/.test(r.url())) asked.push(r.url()); });
  await page.goto("/app/inbox");
  const rows = page.getByTestId("thread-row");
  await rows.first().waitFor();
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  // An unread thread is what triggers it, so make sure there is one each time.
  const markUnread = async (row: typeof rows) => {
    const id = new URL((await row.getAttribute("href"))!, "http://x").searchParams.get("t");
    expect((await page.request.post(`/api/v1/threads/${id}/actions`, { data: { action: "unread" } })).ok()).toBeTruthy();
  };
  for (let i = 0; i < 4; i++) {
    const row = rows.nth(i);
    await markUnread(row);
    await row.click();
    await page.waitForTimeout(1_200);
  }
  // And the sidebar still gets a label created elsewhere, on the next refresh.
  const name = `Refetch ${Date.now()}`;
  expect((await page.request.post("/api/v1/labels", { data: { accountId: accounts[0].id, name } })).ok()).toBeTruthy();
  await markUnread(rows.nth(4));
  await rows.nth(4).click();
  await page.getByTestId("nav-more").click();
  await expect(page.getByRole("link", { name: new RegExp(name) }).first()).toBeVisible();
  expect(asked).toEqual([]);
});
