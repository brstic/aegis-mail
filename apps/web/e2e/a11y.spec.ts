import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { rows, signIn } from "./helpers";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function audit(page: import("@playwright/test").Page, name: string, within?: string) {
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  if (within) builder.include(within);
  const r = await builder.analyze();
  const summary = r.violations.map(v => `${v.id} (${v.impact}): ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target}`);
  expect(summary, name).toEqual([]);
}

const PUBLIC = ["/", "/features", "/security", "/privacy-architecture", "/trust", "/docs", "/legal/privacy", "/legal/license", "/sign-in", "/sign-up", "/design-system"];
for (const path of PUBLIC) test(`axe public ${path}`, async ({ page }) => { await page.goto(path); await page.waitForLoadState("networkidle"); await audit(page, path); });

const APP = ["/app/focus", "/app/inbox", "/app/quarantine", "/app/drafts", "/app/scheduled", "/app/tasks", "/app/rules", "/app/shared", "/app/privacy", "/app/connect", "/app/connect/manual", "/app/onboarding", "/app/settings", "/app/settings/accounts", "/app/settings/personalization", "/app/settings/security", "/app/security", "/app/org", "/app/labels", "/app/insights", "/app/search?q=invoice", "/app/settings/topics", "/app/settings/identity", "/app/org/policies"];
for (const path of APP) test(`axe app ${path}`, async ({ page }) => { await signIn(page); await page.goto(path); await page.waitForLoadState("networkidle"); await page.waitForTimeout(400); await audit(page, path); });

const OPERATOR = ["/admin", "/admin/tenants", "/admin/jobs", "/admin/health", "/admin/audit"];
for (const path of OPERATOR) test(`axe operator ${path}`, async ({ page }) => {
  await signIn(page, "operator");
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await audit(page, path);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await audit(page, `${path} dark`);
});
test("axe operator tenant detail, light and dark", async ({ page }) => {
  await signIn(page, "operator");
  await page.goto("/admin/tenants");
  await page.getByRole("link", { name: /Harbor (Trial )?Co/ }).click();
  await page.getByRole("heading", { name: "Limits" }).waitFor();
  await audit(page, "tenant detail");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await audit(page, "tenant detail dark");
});

test("axe thread detail, threat view, composer, in dark mode too", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/quarantine");
  await rows(page).first().click();
  await page.getByTestId("security-strip").waitFor();
  await audit(page, "threat");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400); // Let color transitions finish, or axe measures mid-animation values.
  await audit(page, "threat dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/inbox");
  await rows(page).first().click();
  await page.keyboard.press("c");
  await page.getByRole("dialog", { name: "Compose message" }).waitFor();
  await audit(page, "composer");
});

test("axe new overlays: label dialog, layout switcher, search help, forward, intelligence sheet, security report", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/inbox");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /^Layout:/ }).click();
  await page.getByTestId("layout-switcher").waitFor();
  await page.waitForTimeout(400);
  await audit(page, "layout switcher");
  await page.keyboard.press("Escape");
  await rows(page).first().click();
  await page.getByRole("region", { name: "Conversation" }).getByRole("heading", { level: 1 }).waitFor();
  await page.keyboard.press("l");
  await page.getByTestId("label-dialog").waitFor();
  await page.waitForTimeout(400);
  await audit(page, "label dialog");
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await page.getByRole("dialog", { name: "Compose message" }).waitFor();
  await audit(page, "forward composer");
  await page.keyboard.press("Escape");
  await page.goto("/app/search?q=invoice");
  await page.getByRole("button", { name: "Search help" }).waitFor();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  // The results on their own, with nothing over them.
  await audit(page, "search results");
  await page.getByRole("button", { name: "Search help" }).click();
  await page.getByRole("dialog", { name: "Search help" }).waitFor();
  await page.waitForTimeout(400);
  // Just the dialog. Axe blends the scrim into what's behind it but not into its text, which reports contrast failures for content nobody can use while this is open.
  await audit(page, "search help", '[role="dialog"]');
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/app/quarantine");
  await rows(page).first().click();
  await page.getByRole("button", { name: /Show summary/ }).click();
  await page.getByTestId("intelligence").waitFor();
  await page.waitForTimeout(300);
  await audit(page, "intelligence sheet");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/quarantine");
  await rows(page).first().click();
  await page.getByTestId("security-strip").getByRole("button", { name: /Why this rating/ }).click();
  await page.getByTestId("security-strip").getByRole("link", { name: /security report/i }).click();
  await page.getByTestId("security-report").waitFor();
  await page.waitForTimeout(400);
  await audit(page, "security report");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await audit(page, "security report dark");
});
