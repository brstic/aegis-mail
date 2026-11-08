import { expect, test, type Page } from "@playwright/test";
import { rows, signIn, watchErrors } from "./helpers";

/**
 * Run twice to cover both states of a deployment. The default config leaves semantic search off. To run against the real model:
 *   AEGIS_EMBEDDINGS=local pnpm exec playwright test e2e/semantic-forward.spec.ts --project=desktop --no-deps
 * Tests for the other state skip, and say why.
 */
const composer = (page: Page) => page.getByRole("dialog", { name: "Compose message" });
const status = async (page: Page) => (await page.request.get("/api/v1/search/semantic")).json();
const openBySearch = async (page: Page, q: string, subject: string) => {
  await page.goto(`/app/search?q=${encodeURIComponent(q)}`);
  await rows(page).filter({ hasText: subject }).first().click();
};

test.beforeEach(async ({ page }) => { await signIn(page); });

test.describe("semantic search", () => {
  test("not enabled: the search page and Settings say unavailable, with no control to press", async ({ page }) => {
    const errors = watchErrors(page);
    const s = await status(page);
    test.skip(s.available, "This server has AEGIS_EMBEDDINGS=local, so it's the other state being tested.");
    expect(s).toMatchObject({ available: false, reason: "deployment", model: null });
    await page.goto("/app/search?q=invoice&semantic=true");
    await expect(rows(page).first()).toBeVisible();
    await expect(page.getByTestId("semantic-unavailable")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Semantic search" })).toHaveCount(0);
    // A link to it must still do nothing false: these are word results.
    await expect(page.getByTestId("semantic-note")).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "Similar meaning" })).toHaveCount(0);

    await page.goto("/app/settings/search");
    const setting = page.getByTestId("semantic-setting");
    await expect(setting).toContainText("Not available on this server yet");
    await expect(setting.getByRole("switch")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Related words" })).toBeVisible();
    await expect(page.getByText("so payment also finds invoice. It stores nothing.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Related words stays labelled as what it is", async ({ page }) => {
    await page.goto("/app/search?q=payment");
    await page.getByRole("button", { name: "Related words" }).click();
    await expect(page.getByTestId("related-note")).toContainText("isn't semantic search");
  });

  test("enabled: finds a message by meaning, labels it, and turning it off deletes the vectors", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    const first = await status(page);
    test.skip(!first.available, "AEGIS_EMBEDDINGS isn't set on this server. See the comment at the top of this file.");
    // The worker is embedding the seed through real jobs.
    await expect.poll(async () => { const s = await status(page); return s.indexed > 0 && s.indexed >= s.eligible - 2; }, { timeout: 120_000, intervals: [1000] }).toBe(true);

    const q = "somebody confirming that a bill got settled";
    await page.goto(`/app/search?q=${encodeURIComponent(q)}`);
    await expect(page.getByRole("button", { name: "Semantic search" })).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Semantic search" }).click();
    await expect(page).toHaveURL(/semantic=true/);
    await expect(page.getByRole("button", { name: "Semantic search" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("semantic-note")).toContainText("using a model on this server", { timeout: 30_000 });
    await expect(page.getByTestId("semantic-note")).toContainText("most recent indexed messages");
    const hit = rows(page).filter({ hasText: "Remittance advice" });
    await expect(hit).toBeVisible();
    await expect(hit).toContainText("Similar meaning");
    // Nothing like that matched by words alone.
    await page.goto(`/app/search?q=${encodeURIComponent(q)}`);
    await expect(page.getByTestId("search-panel")).toBeVisible();
    await expect(rows(page).filter({ hasText: "Remittance advice" })).toHaveCount(0);

    // Filters still apply, and held mail stays out.
    const held = (await (await page.request.get(`/api/v1/threads?q=${encodeURIComponent("the supplier who wanted a bank detail change")}&semantic=true&limit=20`)).json()).items;
    expect(held.filter((i: { held: boolean }) => i.held)).toEqual([]);

    await page.goto("/app/settings/search");
    await expect(page.getByTestId("semantic-coverage")).toContainText("messages you can search are indexed");
    await page.getByRole("switch", { name: "Semantic search" }).click();
    await page.getByRole("button", { name: "Turn off and delete vectors" }).click();
    await expect.poll(async () => (await status(page)).indexed).toBe(0);
    await expect(page.getByRole("switch", { name: "Semantic search" })).toHaveAttribute("aria-checked", "false");
    await page.goto(`/app/search?q=${encodeURIComponent(q)}&semantic=true`);
    await expect(page.getByTestId("semantic-off")).toBeVisible();
    // Leave it as the next suite expects.
    await page.request.patch("/api/v1/preferences", { data: { semanticSearchEnabled: true } });
    await expect.poll(async () => (await status(page)).indexed, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

test.describe("forwarding the original's attachments", () => {
  test("files are shown on, can be removed and restored, and the one left on reaches the provider", async ({ page }) => {
    const errors = watchErrors(page);
    await openBySearch(page, "remittance", "Remittance advice");
    await page.getByRole("button", { name: "Forward (f)" }).click();
    const c = composer(page);
    const box = c.getByRole("checkbox", { name: "Include remittance-F-1182.pdf" });
    await expect(box).toBeChecked();
    await expect(c.getByTestId("original-attachment")).toContainText("remittance-F-1182.pdf");
    await expect(c.getByTestId("original-attachment")).toContainText("Baseline checks only");
    await expect(c.getByText("Forwarded message, included as text")).toBeVisible();
    await expect(c.getByText("that aren't included")).toHaveCount(0);

    await box.click();
    await expect(box).not.toBeChecked();
    let drafts = await (await page.request.get("/api/v1/drafts")).json();
    expect(drafts.find((d: { subject: string }) => d.subject.includes("Remittance advice")).attachments).toEqual([]);
    await box.click();
    await expect(box).toBeChecked();
    drafts = await (await page.request.get("/api/v1/drafts")).json();
    const draft = drafts.find((d: { subject: string }) => d.subject.includes("Remittance advice"));
    expect(draft.attachments.map((a: { filename: string }) => a.filename)).toEqual(["remittance-F-1182.pdf"]);

    await c.getByLabel("To", { exact: true }).fill("colleague@example.test");
    await c.getByRole("button", { name: "Send", exact: true }).click();
    await expect(c).toHaveCount(0);
    await expect.poll(async () => {
      const sent = await (await page.request.get(`/api/v1/threads?view=sent&q=${encodeURIComponent('subject:"Fwd"')}&limit=5`)).json();
      return sent.items.find((i: { subject: string; hasAttachments: boolean }) => i.subject.includes("Remittance advice"))?.hasAttachments;
    }, { timeout: 30_000, intervals: [1000] }).toBe(true);
    expect(errors).toEqual([]);
  });

  test("couldn't be verified: the file starts off, and it's the person's call to turn it on", async ({ page }) => {
    const list = await (await page.request.get(`/api/v1/threads?q=${encodeURIComponent("risk:unknown_unscannable has:attachment")}&limit=5`)).json();
    const item = list.items[0];
    const thread = await (await page.request.get(`/api/v1/threads/${item.id}`)).json();
    const file = thread.messages.find((m: { id: string }) => m.id === item.messageId).attachments.find((a: { disposition: string }) => a.disposition === "attachment");
    await page.goto(`/app/search?q=${encodeURIComponent("risk:unknown_unscannable has:attachment")}&t=${item.id}`);
    await page.getByRole("button", { name: "Forward (f)" }).click();
    await page.getByRole("dialog", { name: "Forward a flagged message?" }).getByRole("button", { name: "Write the forward" }).click();
    const c = composer(page);
    const box = c.getByRole("checkbox", { name: `Include ${file.filename}` });
    await expect(box).toBeEnabled();
    await expect(box).not.toBeChecked();
    await expect(c.getByTestId("original-attachments")).toContainText("these start off");
    await box.click();
    await expect(box).toBeChecked();
    await c.getByRole("button", { name: "Discard draft" }).click();
    await expect(c).toHaveCount(0);
  });

  test("rated malicious: even released from quarantine, the file can't be turned on, and the server refuses regardless", async ({ page }) => {
    const list = await (await page.request.get(`/api/v1/threads?q=${encodeURIComponent("risk:malicious has:attachment")}&limit=20`)).json();
    const item = list.items[0];
    if (item.held) expect((await page.request.post(`/api/v1/messages/${item.messageId}/quarantine`, { data: { decision: "release" } })).ok()).toBeTruthy();
    const thread = await (await page.request.get(`/api/v1/threads/${item.id}`)).json();
    const message = thread.messages.find((m: { id: string }) => m.id === item.messageId);
    const file = message.attachments.find((a: { disposition: string }) => a.disposition === "attachment");

    await page.goto(`/app/search?q=${encodeURIComponent("risk:malicious has:attachment")}&t=${item.id}`);
    await page.getByRole("button", { name: "Forward (f)" }).click();
    await page.getByRole("dialog", { name: "Forward a flagged message?" }).getByRole("button", { name: "Write the forward" }).click();
    const c = composer(page);
    const box = c.getByRole("checkbox", { name: `Include ${file.filename}` });
    await expect(box).not.toBeChecked();
    await expect(box).toBeDisabled();
    await expect(c.getByTestId("original-attachment")).toContainText("Can't be forwarded: this message was flagged");

    // The disabled box is only a courtesy. Ask the server directly.
    await c.getByLabel("To", { exact: true }).fill("colleague@example.test");
    await expect(c.getByText("Draft saved")).toBeVisible({ timeout: 15_000 });
    const drafts = await (await page.request.get("/api/v1/drafts")).json();
    const draft = drafts.find((d: { to: string[] }) => d.to.includes("colleague@example.test"));
    expect(draft.attachments).toEqual([]);
    const refused = await page.request.post(`/api/v1/drafts/${draft.id}/attachments/from-message`, { data: { messageId: message.id, attachmentIds: [file.id] } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error.code).toBe("attachments_refused");
    await c.getByRole("button", { name: "Discard draft" }).click();
  });
});
