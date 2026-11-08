import { expect, type Locator, type Page } from "@playwright/test";

export async function signIn(page: Page, as: "member" | "admin" | "operator" = "member") {
  const r = await page.request.post("/api/v1/demo/signin", { data: { as } });
  expect(r.ok()).toBeTruthy();
  // Most tests look at the list and the message side by side. The real default, full width, has its own test in frontend.spec.ts.
  if (as !== "operator") await page.request.patch("/api/v1/preferences", { data: { layout: "split" } });
}
export const rows = (page: Page) => page.getByTestId("thread-row");
/**
 * Presses a shortcut until what it opens is there. Right after a page load the key can arrive before hydration has attached its
 * listener, which happens on slow machines such as CI runners. Each try waits briefly, so a shortcut that toggles is pressed again only
 * when the last press did nothing.
 */
export async function pressUntil(page: Page, key: string, opened: Locator) {
  await expect(async () => { if (!(await opened.isVisible())) await page.keyboard.press(key); await expect(opened).toBeVisible({ timeout: 1500 }); }).toPass({ timeout: 20_000 });
}
export async function openFocus(page: Page) { await page.goto("/app/focus"); await expect(rows(page).first()).toBeVisible(); }
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) errors.push(m.text()); });
  return errors;
}
/** Requests leaving our own origin. Message rendering must never produce any. */
export function watchExternal(page: Page, origin: string) {
  const hits: string[] = [];
  page.on("request", r => { const u = r.url(); if (/^https?:/.test(u) && !u.startsWith(origin)) hits.push(u); });
  return hits;
}
