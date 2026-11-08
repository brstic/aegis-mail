import { expect, test } from "@playwright/test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NOTES, notesFor } from "../src/explain/registry";
import { signIn } from "./helpers";

test.describe.configure({ mode: "serial" });

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return pages(p);
    return f === "page.tsx" ? [p] : [];
  });
}

test("every screen has an explanation, with no entries for screens that don't exist", () => {
  const root = join(process.cwd(), "src/app");
  const routes = [...pages(join(root, "app")), ...pages(join(root, "admin"))].map(p => `/${relative(root, p).replace(/\/?page\.tsx$/, "")}`);
  for (const r of routes) expect(NOTES[r], `${r} has nothing in src/explain/registry.ts`).toBeTruthy();
  // Views that come from /app/[view], and aren't their own files.
  const views = ["/app/focus", "/app/quarantine"];
  for (const k of Object.keys(NOTES)) expect([...routes, ...views], `${k} isn't a screen`).toContain(k);
  for (const k of Object.keys(NOTES)) for (const n of NOTES[k]!) expect(n.text.length, `${k}: ${n.title}`).toBeGreaterThan(15);
});

/** Screens the demo member can reach, with how many things must be pointed at. Others have conditions: see the second list. */
const MEMBER = ["/app/focus", "/app/inbox", "/app/quarantine", "/app/connect", "/app/labels", "/app/tasks", "/app/rules", "/app/privacy", "/app/insights", "/app/settings", "/app/settings/accounts", "/app/settings/people", "/app/settings/personalization", "/app/settings/search", "/app/settings/security", "/app/settings/topics", "/app/shared", "/app/drafts", "/app/scheduled"];

for (const path of MEMBER) test(`explains ${path}, and points at what it describes`, async ({ page }) => {
  await signIn(page);
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.getByTestId("explain-toggle").first().click();
  const panel = page.getByTestId("explain-panel");
  await expect(panel).toBeVisible();
  const items = panel.getByTestId("explain-list").getByRole("button");
  await expect(items).toHaveCount(notesFor(path).length);
  await page.waitForTimeout(900);
  const pointed = await panel.locator('[data-found="true"]').count();
  expect(pointed, `${path}: nothing on screen matched its explanations`).toBeGreaterThan(0);
});

test("a tour steps through a screen, and can be skipped or finished", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/focus");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("explain-toggle").first().click();
  const panel = page.getByTestId("explain-panel");
  await panel.getByRole("button", { name: "Take the tour of this screen" }).click();
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("Tour: 1 of");
  await panel.getByRole("button", { name: "Next" }).click();
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("Tour: 2 of");
  await panel.getByRole("button", { name: "Back" }).click();
  await expect(panel.getByRole("heading", { level: 2 })).toContainText("Tour: 1 of");
  await panel.getByRole("button", { name: "Skip" }).click();
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText("About this screen");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("works from the keyboard, follows navigation, and doesn't steal typing", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/inbox");
  await page.getByTestId("thread-row").first().waitFor();
  await page.keyboard.press("Shift+E");
  await expect(page.getByTestId("explain-panel")).toContainText("A conversation");
  await page.goto("/app/tasks");
  await page.keyboard.press("Shift+E");
  await expect(page.getByTestId("explain-panel")).toContainText("Add a task");
  await page.keyboard.press("Escape");
  await page.getByPlaceholder(/search/i).first().fill("");
  await page.getByPlaceholder(/search/i).first().pressSequentially("E");
  await expect(page.getByTestId("explain-panel")).toHaveCount(0);
});

test("the operator console is explained too", async ({ page }) => {
  await signIn(page, "operator");
  for (const path of ["/admin", "/admin/tenants", "/admin/jobs", "/admin/health", "/admin/audit"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("explain-toggle").first().click();
    await expect(page.getByTestId("explain-panel")).toBeVisible();
    await page.waitForTimeout(800);
    expect(await page.locator('[data-testid=explain-panel] [data-found="true"]').count(), path).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
  }
});
