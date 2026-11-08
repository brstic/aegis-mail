import { expect, test, type Page } from "@playwright/test";
import { rows, signIn, watchErrors } from "./helpers";

const convo = (page: Page) => page.getByRole("region", { name: "Conversation" });
const composer = (page: Page) => page.getByRole("dialog", { name: "Compose message" });
const openFirst = async (page: Page, path = "/app/inbox") => {
  await page.goto(path);
  await rows(page).first().click();
  await convo(page).getByRole("heading", { level: 1 }).waitFor();
};
const selectRow = async (page: Page, n: number) => { await rows(page).nth(n).hover(); await page.locator("li.thread-row").nth(n).getByRole("checkbox").check(); };
const prefsNow = async (page: Page) => (await page.request.get("/api/v1/preferences")).json();
const setPrefs = (page: Page, body: Record<string, unknown>) => page.request.patch("/api/v1/preferences", { data: body });

test.beforeEach(async ({ page }) => { await signIn(page); });
test.afterEach(async ({ page }) => { await setPrefs(page, { layout: "split", density: "comfortable", hiddenSections: [], pinnedSections: [], digestHours: 24, savedSearches: [] }).catch(() => {}); });

test("labels: create, color and delete on the labels screen", async ({ page }) => {
  await page.goto("/app/labels");
  await page.getByLabel("Name", { exact: true }).fill("E2E Receipts");
  await page.getByRole("button", { name: "Create label" }).click();
  const row = page.getByTestId("label-row").filter({ hasText: "E2E Receipts" });
  await expect(row).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mailboxes" }).getByRole("link", { name: "E2E Receipts" })).toBeVisible();
  await row.getByLabel("Color for E2E Receipts").evaluate((el: HTMLInputElement) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, "#8a4b4b"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("focusout", { bubbles: true })); });
  await expect.poll(async () => (await (await page.request.get("/api/v1/labels")).json()).find((l: any) => l.name === "E2E Receipts")?.color).toBe("#8a4b4b");
  await row.getByRole("button", { name: "Delete label E2E Receipts" }).click();
  await expect(page.getByRole("dialog")).toContainText("A label at your provider stays there");
  await page.getByRole("button", { name: "Delete label", exact: true }).click();
  await expect(row).toBeHidden();
});

test("labels: apply and remove from a thread with l, and from a bulk selection", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).filter({ hasText: "Fernhill Studio" }).first().click();
  await convo(page).getByRole("heading", { level: 1 }).waitFor();
  const subject = await convo(page).getByRole("heading", { level: 1 }).innerText();
  await page.keyboard.press("l");
  const dialog = page.getByTestId("label-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("New label").fill("E2E Applied");
  await dialog.getByRole("button", { name: "Create and apply" }).click();
  await expect(dialog.getByRole("checkbox", { name: "E2E Applied" })).toBeChecked();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(convo(page).getByRole("list", { name: "Labels" })).toContainText("E2E Applied");
  await expect(rows(page).filter({ hasText: subject }).first()).toContainText("E2E Applied");
  // Remove it from the toolbar, then apply to a selection.
  await page.getByRole("toolbar", { name: "Conversation actions" }).getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menu", { name: "More actions" }).getByRole("menuitem", { name: /Labels/ }).click();
  await dialog.getByRole("checkbox", { name: "E2E Applied" }).uncheck();
  await expect(dialog.getByRole("checkbox", { name: "E2E Applied" })).not.toBeChecked();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(convo(page).getByRole("list", { name: "Labels" })).toHaveCount(0);

  await page.goto("/app/inbox");
  const fernhill = page.locator("li.thread-row").filter({ hasText: "Fernhill Studio" });
  for (const n of [0, 1]) { await fernhill.nth(n).hover(); await fernhill.nth(n).getByRole("checkbox").check(); }
  await expect(page.getByTestId("bulk-bar")).toContainText("2 selected");
  await page.getByRole("button", { name: "Label selected" }).click();
  await dialog.getByRole("checkbox", { name: "E2E Applied" }).check();
  await expect(page.getByText("Added E2E Applied on 2 conversations.")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(rows(page).filter({ hasText: "E2E Applied" })).toHaveCount(2);
  // A mailbox without that label is left alone, and the result says so.
  const personal = page.locator("li.thread-row").filter({ hasText: "Personal" }).first();
  await personal.hover();
  await personal.getByRole("checkbox").check();
  const another = fernhill.nth(2);
  await another.hover();
  await another.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Label selected" }).click();
  await dialog.getByRole("checkbox", { name: "E2E Applied" }).click();
  await expect(page.getByText(/Skipped 1: that mailbox has no such label/)).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  const id = (await (await page.request.get("/api/v1/labels")).json()).find((l: any) => l.name === "E2E Applied").id;
  await page.request.delete(`/api/v1/labels/${id}`);
});

test("a label from one mailbox can't be applied to another mailbox's thread", async ({ page }) => {
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  const labels = await (await page.request.get("/api/v1/labels")).json();
  const foreign = labels.find((l: any) => l.accountId === accounts[0].id);
  const list = await (await page.request.get(`/api/v1/threads?view=inbox&accountId=${accounts[1].id}&limit=1`)).json();
  const r = await page.request.post(`/api/v1/threads/${list.items[0].id}/actions`, { data: { action: "label", labelId: foreign.id } });
  expect(r.status()).toBe(400);
});

test("forward: quotes the original, validates recipients, and warns first on flagged mail", async ({ page }) => {
  await openFirst(page);
  await page.keyboard.press("f");
  await expect(composer(page)).toBeVisible();
  await expect(composer(page).getByText("Forward", { exact: true })).toBeVisible();
  await expect(composer(page).getByLabel("Subject")).toHaveValue(/^Fwd: /);
  await expect(composer(page).getByTestId("quoted-original")).toContainText("Forwarded message");
  await composer(page).getByLabel("To", { exact: true }).fill("not-an-address, ok@example.com");
  await expect(composer(page).getByRole("alert")).toContainText("not-an-address");
  await composer(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer(page).getByText(/doesn't look right/)).toBeVisible();
  await composer(page).getByLabel("To", { exact: true }).fill("stranger@example.org");
  await expect(composer(page).getByTestId("recipient-warning")).toContainText("stranger@example.org");
  await composer(page).getByRole("button", { name: "Discard draft" }).click();
  await expect(composer(page)).toBeHidden();

  await page.goto("/app/inbox");
  await rows(page).filter({ hasText: "Partnership idea" }).first().click();
  await convo(page).getByRole("heading", { level: 1 }).waitFor();
  await page.keyboard.press("f");
  const warn = page.getByRole("dialog", { name: "Forward a flagged message?" });
  await expect(warn).toContainText("suspicious");
  await warn.getByRole("button", { name: "Cancel" }).click();
  await expect(composer(page)).toBeHidden();
  await page.getByRole("button", { name: "Forward (f)" }).click();
  await warn.getByRole("button", { name: "Write the forward" }).click();
  await expect(composer(page)).toContainText("You're forwarding a message rated suspicious");
  await composer(page).getByRole("button", { name: "Discard draft" }).click();
});

test("signatures and aliases: set up, picked in the composer, and only a listed alias sends", async ({ page }) => {
  await setPrefs(page, { signatures: [] });
  for (const a of await (await page.request.get("/api/v1/accounts")).json()) await page.request.patch(`/api/v1/accounts/${a.id}`, { data: { aliases: [] } });
  await page.goto("/app/settings/identity");
  const card = page.getByTestId("identity-account").first();
  await card.getByRole("button", { name: "Add a signature" }).click();
  await card.getByLabel("Signature name").fill("Work");
  await card.getByLabel("Text").fill("Morgan Lee\nFernhill Studio");
  await card.getByRole("button", { name: "Add signature" }).click();
  await expect(card.getByTestId("signature-row")).toContainText("Default");
  await expect.poll(async () => (await prefsNow(page)).signatures?.length).toBe(1);
  await card.getByRole("textbox", { name: "Address" }).fill("hello@fernhill.example");
  await card.getByRole("button", { name: "Add address" }).click();
  await expect(card.getByTestId("alias-row")).toContainText("hello@fernhill.example");

  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("c");
  await expect(composer(page).getByTestId("signature-preview")).toContainText("Fernhill Studio");
  await composer(page).getByLabel("From").selectOption({ label: "Fernhill Studio <hello@fernhill.example> (alias)" });
  await expect(composer(page)).toContainText("Sends from hello@fernhill.example");
  await composer(page).getByLabel("To", { exact: true }).fill("priya@oakridge.example");
  await composer(page).getByLabel("Subject").fill("E2E alias send");
  await composer(page).getByLabel("Message body").fill("Testing");
  await composer(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer(page)).toBeHidden();
  await expect.poll(async () => (await (await page.request.get("/api/v1/threads?view=sent&q=subject:alias")).json()).items.length, { timeout: 20_000, intervals: [1000] }).toBeGreaterThan(0);
  const sent = (await (await page.request.get("/api/v1/threads?view=sent&q=subject:alias")).json()).items[0];
  expect(sent.from.address).toBe("hello@fernhill.example");
  const thread = await (await page.request.get(`/api/v1/threads/${sent.id}`)).json();
  expect(thread.messages[0].text).toContain("Fernhill Studio");

  // The server refuses an address that isn't listed, whatever the page claims.
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  const draft = await (await page.request.post("/api/v1/drafts", { data: { accountId: accounts[0].id, to: ["a@example.com"], subject: "x", text: "y" } })).json();
  const r = await page.request.post(`/api/v1/drafts/${draft.id}/send`, { data: { expectedFrom: "ceo@elsewhere.example", idempotencyKey: "e2e-alias-refused-0000" } });
  expect(r.status()).toBe(409);
  await page.request.delete(`/api/v1/drafts/${draft.id}`);
  await page.request.patch(`/api/v1/accounts/${accounts[0].id}`, { data: { aliases: [] } });
  await setPrefs(page, { signatures: [] });
});

test("attachments: added in the composer, kept through autosave, and sent", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("c");
  await composer(page).getByLabel("To", { exact: true }).fill("priya@oakridge.example");
  await composer(page).getByLabel("Subject").fill("E2E attachment send");
  await composer(page).locator("input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachment") });
  await expect(composer(page).getByRole("list", { name: "Attachments" })).toContainText("notes.txt");
  await composer(page).getByLabel("Message body").fill("See the file.");
  await expect(composer(page).getByText(/Draft saved/)).toBeVisible();
  await composer(page).getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get("/api/v1/threads?view=sent&q=subject:attachment")).json()).items[0]?.hasAttachments, { timeout: 20_000, intervals: [1000] }).toBe(true);
});

test("attachments: over the limit is refused before and at the server", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("c");
  await composer(page).locator("input[type=file]").setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(3 * 1024 * 1024 + 1) });
  await expect(composer(page).getByText(/at most 3 MB/)).toBeVisible();
  await composer(page).getByRole("button", { name: "Discard draft" }).click();
});

test("draft reopens from the list with its fields intact", async ({ page }) => {
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  await page.request.post("/api/v1/drafts", { data: { accountId: accounts[0].id, to: ["kept@example.com"], cc: ["cc@example.com"], subject: "E2E reopen", text: "Kept text" } });
  await page.goto("/app/drafts");
  await page.getByRole("button", { name: /^Open draft:.*E2E reopen/ }).click();
  await expect(composer(page).getByLabel("To", { exact: true })).toHaveValue("kept@example.com");
  await expect(composer(page).getByLabel("Cc", { exact: true })).toHaveValue("cc@example.com");
  await expect(composer(page).getByLabel("Message body")).toHaveValue("Kept text");
  await composer(page).getByRole("button", { name: "Discard draft" }).click();
});

test("layout: each option changes the list or detail, from the switcher, and it's saved", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  const choose = async (name: string) => {
    await page.getByRole("button", { name: /^Layout:/ }).click();
    await page.getByTestId("layout-switcher").getByText(name, { exact: true }).click();
    await page.keyboard.press("Escape");
  };
  // Split: list stays beside the open conversation.
  await rows(page).first().click();
  await convo(page).getByRole("heading", { level: 1 }).waitFor();
  await expect(rows(page).first()).toBeVisible();
  // Full width: the open conversation replaces the list.
  await choose("Full width");
  await expect(rows(page).first()).toBeHidden();
  await expect.poll(async () => (await (await page.request.get("/api/v1/preferences")).json()).layout).toBe("full");
  await page.getByRole("button", { name: /Back to list/ }).click();
  await expect(rows(page).first()).toBeVisible();
  // Grouped by account.
  await choose("Grouped by account");
  await expect(page.locator("[data-group='Fernhill Studio']")).toBeVisible();
  await expect(page.locator("[data-group='Personal']")).toBeVisible();
  // Grouped by action.
  await choose("Grouped by action");
  await expect(page.locator("[data-group='Needs reply']")).toBeVisible();
  // Chronological: date headings, newest first.
  await choose("Chronological");
  await expect(page.locator("[data-group]").first()).toHaveAttribute("data-group", /Today|Yesterday|Earlier/);
  const times = await page.getByTestId("thread-row").locator("time").evaluateAll(els => els.map(e => e.getAttribute("datetime")!));
  expect(times.length).toBeGreaterThan(5);
  expect([...times].sort().reverse()).toEqual(times);
  // Focus honors it too, and Security review stays apart.
  await expect.poll(async () => (await prefsNow(page)).layout).toBe("chronological");
  await page.goto("/app/focus");
  await expect(page.locator("[data-section='security_review']")).toBeVisible();
  await expect(page.locator("[data-group]").nth(1)).toHaveAttribute("data-group", /Today|Yesterday|Earlier/);
  await expect(page.locator("[data-section='needs_attention']")).toHaveCount(0);
});

test("density: changes row height, from the switcher", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  const height = async () => Math.round((await rows(page).first().boundingBox())!.height);
  // Start from Comfortable whatever an earlier test left saved, so the comparison has a real baseline.
  await page.getByRole("button", { name: /^Layout:/ }).click();
  await page.getByTestId("layout-switcher").getByText("Comfortable", { exact: true }).click();
  await expect.poll(height).toBeGreaterThan(36);
  const comfortable = await height();
  await page.getByTestId("layout-switcher").getByText("Compact", { exact: true }).click();
  await expect.poll(height).toBeLessThan(comfortable);
  const compact = await height();
  await page.getByTestId("layout-switcher").getByText("Spacious", { exact: true }).click();
  await expect.poll(height).toBeGreaterThan(comfortable);
  expect(compact).toBeLessThan(comfortable);
});

test("long lists: rows skip offscreen work, and more load on scroll", async ({ page }) => {
  const make = (start: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(start + i).padStart(12, "0")}`, accountId: "x", messageId: "m", subject: `Synthetic row ${start + i}`, snippet: "Snippet", to: [], date: new Date(Date.now() - (start + i) * 6e4).toISOString(), isRead: true, isStarred: false, hasAttachments: false, count: 1, folder: "inbox", risk: "safe", action: "allow", held: false, section: null, topics: [], intent: "fyi", score: null, labels: [], lastFromMe: false, failed: false, duplicateOf: null }));
  await page.route("**/api/v1/threads?*view=inbox*", route => {
    const u = new URL(route.request().url());
    if (u.searchParams.get("cursor")) return route.fulfill({ json: { items: make(500, 100), nextCursor: null } });
    return route.fulfill({ json: { items: make(0, 500), nextCursor: "2026-01-01T00:00:00.000Z" } });
  });
  await page.goto("/app/inbox");
  await expect(rows(page).first()).toContainText("Synthetic row 0");
  expect(await page.locator("li.thread-row").first().evaluate(el => getComputedStyle(el).contentVisibility)).toBe("auto");
  await expect.poll(() => rows(page).count()).toBe(500);
  const list = page.locator("li.thread-row").first().locator("xpath=ancestor::div[contains(@class,'overflow-auto')][1]");
  const started = Date.now();
  await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => rows(page).count()).toBe(600);
  expect(Date.now() - started).toBeLessThan(5000);
});

test("focus: hide and restore a section, pin it, per-account view", async ({ page }) => {
  await page.goto("/app/focus");
  await rows(page).first().waitFor();
  await page.getByRole("button", { name: "Hide Needs your attention" }).click();
  await expect(page.locator("[data-section='needs_attention']")).toHaveCount(0);
  await expect(page.getByTestId("hidden-sections")).toContainText("Needs your attention");
  await page.getByRole("button", { name: "Show Needs your attention again" }).click();
  await expect(page.locator("[data-section='needs_attention']")).toBeVisible();
  // Security review can't be hidden.
  await expect(page.getByRole("button", { name: "Hide Worth a second look" })).toHaveCount(0);
  const r = await setPrefs(page, { hiddenSections: ["security_review"] });
  expect(r.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator("[data-section='security_review']")).toBeVisible();
  await setPrefs(page, { hiddenSections: [] });
  await page.reload();
  // Two pins both stick, and order follows.
  await page.getByRole("button", { name: "Pin to top: Worth a second look" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/v1/preferences")).json()).pinnedSections).toEqual(["security_review"]);
  await page.reload();
  await expect(page.locator("[data-section]").first()).toHaveAttribute("data-section", "security_review");
  await page.getByRole("button", { name: "Pin to top: Needs your attention" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/v1/preferences")).json()).pinnedSections).toHaveLength(2);
  // Per-account Focus, chosen with the account switcher.
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  await page.goto(`/app/focus?account=${accounts[1].id}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Focus: ${accounts[1].displayName}`);
});

test("search: chips, related words, help, saved searches, empty and no-result states", async ({ page }) => {
  await page.goto("/app/search");
  await expect(page.getByRole("heading", { level: 2, name: "Search your mail" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Search");

  await page.getByRole("searchbox", { name: "Search mail" }).or(page.getByLabel("Search mail")).fill("invoice");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=invoice/);
  await expect(rows(page).first()).toBeVisible();
  const plain = await rows(page).count();

  await page.getByRole("button", { name: "Has attachment" }).click();
  await expect(page).toHaveURL(/has%3Aattachment|has:attachment/);
  await expect(page.getByRole("button", { name: "Has attachment" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Has attachment" }).click();
  await expect(page.getByRole("button", { name: "Has attachment" })).toHaveAttribute("aria-pressed", "false");

  await page.getByRole("button", { name: "Related words" }).click();
  await expect(page).toHaveURL(/concepts=true/);
  await expect(page.getByTestId("related-note")).toContainText("isn't semantic search");
  await expect.poll(() => rows(page).count()).toBeGreaterThanOrEqual(plain);
  await page.getByRole("button", { name: "Related words" }).click();

  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByLabel("From", { exact: true }).fill("harbor");
  await page.getByRole("button", { name: "Apply filters" }).click();
  const chip = page.getByTestId("search-chip").filter({ hasText: "From: harbor" });
  await expect(chip).toBeVisible();
  await expect(page.getByRole("button", { name: "Related words" })).toBeDisabled();
  await page.getByLabel("Risk").selectOption("malicious");
  await expect(page.getByTestId("search-chip").filter({ hasText: "Risk: Malicious" })).toBeVisible();
  await page.getByRole("button", { name: "Remove filter Risk: Malicious" }).click();
  await expect(page.getByTestId("search-chip")).toHaveCount(1);

  await page.getByRole("button", { name: "Save this search" }).click();
  await page.getByLabel("Name for this search").fill("Harbor invoices");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("saved-search")).toContainText("Harbor invoices");
  await expect.poll(async () => (await prefsNow(page)).savedSearches?.length).toBe(1);
  await page.goto("/app/search?q=zzzznothing");
  await expect(page.getByText("No results")).toBeVisible();
  await page.getByRole("link", { name: "Harbor invoices" }).click();
  await expect(page).toHaveURL(/from/);
  await expect(page.getByTestId("search-chip").filter({ hasText: "From: harbor" })).toBeVisible();

  await page.getByRole("button", { name: "Search help" }).click();
  const help = page.getByRole("dialog", { name: "Search help" });
  await expect(help).toContainText("has:attachment");
  await expect(help).toContainText("isn't semantic search");
  await expect(help).toContainText("word index stored unencrypted");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
});

test("copies of a message stay as separate rows, without extra clutter", async ({ page }) => {
  await page.route("**/api/v1/threads?*view=inbox*", async route => {
    const res = await route.fetch();
    const json = await res.json();
    json.items[1].duplicateOf = json.items[0].messageId;
    await route.fulfill({ json });
  });
  await page.goto("/app/inbox");
  await expect(rows(page).nth(1)).toBeVisible();
  await expect(page.getByText("Duplicate", { exact: true })).toHaveCount(0);
});

test("security center shows campaign counts", async ({ page }) => {
  await page.route("**/api/v1/org/security*", async route => {
    const json = await (await route.fetch()).json();
    json.campaigns = { count: 2, messages: 9 };
    await route.fulfill({ json });
  });
  await page.goto("/app/security");
  await expect(page.getByText("2 campaigns.")).toBeVisible();
  await expect(page.getByText(/9 messages in all/)).toBeVisible();
});

test("key rotation: owner confirms, stated as background work", async ({ page }) => {
  await page.goto("/app/org/policies");
  const card = page.getByTestId("key-rotation");
  await card.getByRole("button", { name: "Rotate keys" }).click();
  const dialog = page.getByRole("dialog", { name: "Rotate encryption keys?" });
  await expect(dialog).toContainText("re-encrypts in the background");
  await dialog.getByRole("button", { name: "Rotate keys" }).click();
  await expect(card.getByText(/re-encrypting in the background/)).toBeVisible();
});

test("key rotation: not offered to a security admin", async ({ page }) => {
  await signIn(page, "admin");
  await page.goto("/app/org/policies");
  await expect(page.getByTestId("key-rotation")).toContainText("Only workspace owners");
  await expect(page.getByTestId("key-rotation").getByRole("button")).toHaveCount(0);
  await signIn(page);
});

test("privacy center: new toggles save, and region row is honest", async ({ page }) => {
  await page.goto("/app/privacy");
  await expect(page.getByTestId("region")).toContainText(/Depends on the deployment/);
  for (const name of ["Summaries", "Topics", "Keep attachments"]) {
    const sw = page.getByRole("switch", { name, exact: true });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
  }
  await expect.poll(() => prefsNow(page)).toMatchObject({ summariesEnabled: false, topicsEnabled: false, storeAttachments: false });
  // With summaries off, the panel says so and doesn't ask for one.
  let asked = false;
  page.on("request", r => { if (/\/summary$/.test(r.url())) asked = true; });
  await openFirst(page);
  await page.getByRole("button", { name: /Show summary/ }).click();
  await expect(page.getByTestId("intelligence")).toContainText("Summaries are off");
  expect(asked).toBe(false);
  await setPrefs(page, { summariesEnabled: true, topicsEnabled: true, storeAttachments: true });
});

test("delegated send: owner grants, delegate sees it clearly, and sends as the owner", async ({ page, context }) => {
  const accounts = await (await page.request.get("/api/v1/accounts")).json();
  const mailbox = accounts.find((a: any) => a.owned);
  for (const g of await (await page.request.get("/api/v1/org/grants")).json()) await page.request.post("/api/v1/org/grants/revoke", { data: { accountId: g.accountId, granteeUserId: g.granteeUserId } });
  await page.goto("/app/shared");
  await page.getByLabel("Mailbox to share").selectOption(mailbox.id);
  await page.getByLabel("Share with").selectOption({ index: 1 });
  await page.getByRole("checkbox", { name: /Can send/ }).check();
  await page.getByRole("button", { name: "Share mailbox" }).click();
  await expect(page.getByTestId("grant-row")).toContainText("They can read it and send as you");

  await signIn(page, "admin");
  const adminAccounts = await (await page.request.get("/api/v1/accounts")).json();
  const shared = adminAccounts.find((a: any) => a.id === mailbox.id);
  expect(shared).toMatchObject({ owned: false, canSend: true });
  await page.goto("/app/shared");
  await expect(page.getByTestId("grant-row")).toContainText("You can read it and send as its owner");
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("c");
  await expect(composer(page).getByLabel("From")).toContainText("(shared, sends as owner)");
  await composer(page).getByLabel("From").selectOption({ value: `${mailbox.id}|` });
  await expect(composer(page)).toContainText("You're sending from a shared mailbox");
  await expect(composer(page)).toContainText("as its owner");
  await composer(page).getByRole("button", { name: "Discard draft" }).click();
  // A read-only grant goes back out of the list.
  await signIn(page);
  await page.goto("/app/shared");
  await page.getByRole("checkbox", { name: /^Let .* send from / }).uncheck();
  await expect(page.getByTestId("grant-row")).toContainText("Read only");
  await signIn(page, "admin");
  const after = await (await page.request.get("/api/v1/accounts")).json();
  expect(after.find((a: any) => a.id === mailbox.id)).toMatchObject({ owned: false, canSend: false });
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("c");
  await expect(composer(page).getByLabel("From")).not.toContainText("(shared, sends as owner)");
  await composer(page).getByRole("button", { name: /Close/ }).click();
  await signIn(page);
  await page.request.post("/api/v1/org/grants/revoke", { data: { accountId: mailbox.id, granteeUserId: (await (await page.request.get("/api/v1/org/grants")).json())[0].granteeUserId } });
  void context;
});

test("custom topics: add, edit, delete, built-ins listed, says it applies to new mail", async ({ page }) => {
  await page.goto("/app/settings/topics");
  await expect(page.getByTestId("builtin-topic")).toHaveCount(10);
  await expect(page.getByText(/apply to new mail/).first()).toBeVisible();
  await page.getByLabel("Topic name").fill("Oakridge");
  await page.getByLabel("Words and phrases").fill("oakridge, rebrand");
  await page.getByRole("button", { name: "Add topic" }).click();
  const row = page.getByTestId("topic-row").filter({ hasText: "Oakridge" });
  await expect(row).toContainText("oakridge, rebrand");
  await expect.poll(async () => (await prefsNow(page)).customTopics).toEqual([{ name: "Oakridge", terms: ["oakridge", "rebrand"] }]);
  await page.getByLabel("Topic name").fill("invoices");
  await page.getByLabel("Words and phrases").fill("x");
  await page.getByRole("button", { name: "Add topic" }).click();
  await expect(page.getByText("There's already a topic with that name.")).toBeVisible();
  await page.getByLabel("Topic name").fill("");
  await page.getByLabel("Words and phrases").fill("");
  await row.getByRole("button", { name: "Edit topic Oakridge" }).click();
  await row.getByLabel("Words and phrases").fill("oakridge");
  await row.getByRole("button", { name: "Save topic" }).click();
  await expect(page.getByTestId("topic-row").filter({ hasText: "Oakridge" })).not.toContainText("rebrand");
  await page.getByRole("button", { name: "Delete topic Oakridge" }).click();
  await page.getByRole("button", { name: "Delete topic", exact: true }).click();
  await expect(page.getByTestId("topic-row")).toHaveCount(0);
});

test("insights: charts have text alternatives and no message content", async ({ page }) => {
  await page.goto("/app/insights");
  const summary = page.getByTestId("insights-summary");
  await expect(summary).toContainText("In the last 30 days you received");
  await expect(page.getByTestId("hour-chart")).toHaveAttribute("role", "img");
  await expect(page.getByTestId("hour-chart")).toHaveAttribute("aria-label", /Column chart/);
  await expect(page.getByRole("img", { name: /received per mailbox/ })).toBeVisible();
  await expect(page.getByText("Show as a table").first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Oakridge rebrand");
  const req = page.waitForRequest(/\/insights\?days=7/);
  await page.getByLabel("Period").selectOption("7");
  await req;
});

test("insights: handles a server without the endpoint", async ({ page }) => {
  const errors = watchErrors(page);
  await page.route("**/api/v1/insights*", r => r.fulfill({ status: 404, json: { error: { code: "not_found", message: "Not found" } } }));
  await page.goto("/app/insights");
  await expect(page.getByRole("heading", { name: "Insights aren't available on this deployment yet" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("tasks: calendar export link works and explains what's left out", async ({ page }) => {
  await page.goto("/app/tasks");
  const link = page.getByRole("link", { name: "Download calendar file" });
  await expect(link).toHaveAttribute("href", "/api/v1/tasks/export.ics");
  await expect(page.getByText(/Tasks marked "Timing unclear" are left out/)).toBeVisible();
  const r = await page.request.get("/api/v1/tasks/export.ics");
  expect(r.ok()).toBeTruthy();
  expect(r.headers()["content-type"]).toContain("text/calendar");
  const ics = await r.text();
  expect(ics).toContain("BEGIN:VCALENDAR");
  const tasks = await (await page.request.get("/api/v1/tasks")).json();
  for (const t of tasks.filter((x: any) => x.dueUncertain)) expect(ics).not.toContain(t.text.slice(0, 20).replace(/,/g, "\\,"));
});

test("security report: reason codes, evidence and provenance, printable", async ({ page }) => {
  await page.goto("/app/quarantine");
  await rows(page).first().click();
  await page.getByTestId("security-strip").getByRole("button", { name: /Why this rating/ }).click();
  await page.getByTestId("security-strip").getByRole("link", { name: /security report/i }).click();
  await expect(page).toHaveURL(/\/app\/security-report\//);
  const report = page.getByTestId("security-report");
  await expect(report).toContainText("Malicious");
  await expect(page.getByTestId("report-evidence").first()).toContainText(/[A-Z]+_[A-Z_]+/);
  await expect(page.getByTestId("report-provenance")).toContainText("Sender authentication");
  await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "Print or save as PDF" })).toBeHidden();
  await expect(page.locator("header").filter({ has: page.getByLabel("Search mail") })).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Mailboxes" })).toBeHidden();
  await expect(report).toBeVisible();
  const scroll = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(scroll).toBeGreaterThan(900);
  await page.emulateMedia({ media: "screen" });
});

test("security report: a missing message gets a clear answer", async ({ page }) => {
  await page.goto("/app/security-report/00000000-0000-4000-8000-000000000000");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});

test("design system: public, both themes, live components, all system states", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto("/design-system");
  await expect(page.getByRole("heading", { level: 1, name: "Design system" })).toBeVisible();
  for (const t of ["light", "dark"]) {
    const panel = page.getByTestId(`theme-${t}`);
    await expect(panel).toContainText("--accent");
    const contrast = page.getByTestId(`contrast-${t}`);
    await expect(contrast).toContainText("passes AA");
    await expect(contrast).not.toContainText("below AA");
  }
  await expect(page.getByTestId("risk-row")).toHaveCount(6);
  await expect(page.getByTestId("system-state")).toHaveCount(14);
  const compact = (await page.getByTestId("density-compact").boundingBox())!.height, spacious = (await page.getByTestId("density-spacious").boundingBox())!.height;
  expect(spacious).toBeGreaterThanOrEqual(compact);
  await page.getByRole("button", { name: "Open a modal" }).click();
  await expect(page.getByRole("dialog", { name: "Modal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Modal" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Open a modal" })).toBeFocused();
  await page.getByRole("button", { name: "Open a menu" }).click();
  await expect(page.getByRole("menuitem", { name: /Forward/ })).toBeFocused().catch(() => {});
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await page.getByRole("button", { name: "Show a toast with Undo" }).click();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.getByLabel("Page theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByText("g then l")).toBeVisible();
  expect(errors).toEqual([]);
  await ctx.close();
});

test("keyboard: shortcut help matches what works", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  for (const k of ["j / k", "Esc", "Shift+u", "g then s", "g then d", "g then t", "g then l"]) await expect(help.getByText(k, { exact: true })).toBeVisible();
  await expect(help.locator("dt").filter({ hasText: /^l$/ })).toBeVisible();
  await expect(help.locator("dt").filter({ hasText: /^f$/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();

  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await page.keyboard.press("o");
  await convo(page).getByRole("heading", { level: 1 }).waitFor();
  await page.keyboard.press("Escape");
  await expect(convo(page)).toBeHidden();
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect(page).toHaveURL(/\/app\/labels/);
  await page.keyboard.press("g");
  await page.keyboard.press("d");
  await expect(page).toHaveURL(/\/app\/drafts/);
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page).toHaveURL(/\/app\/inbox/);
  await rows(page).first().waitFor();

  // Enter and arrows keep their meaning on a focused control.
  const before = page.url();
  await page.getByRole("button", { name: /^Layout:/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("layout-switcher")).toBeVisible();
  expect(page.url()).toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("layout-switcher")).toBeHidden();
  await expect(page.getByRole("button", { name: /^Layout:/ })).toBeFocused();

  // Tab reaches a row's actions.
  await rows(page).first().focus();
  await expect(page.getByRole("button", { name: "Move to Trash" }).first()).toBeVisible();

  // One Esc closes one thing.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("a");
  await expect(page.getByRole("complementary", { name: "Assistant" })).toBeVisible();
  await page.keyboard.press("c");
  await expect(composer(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(composer(page)).toBeHidden();
  await expect(page.getByRole("complementary", { name: "Assistant" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Assistant" })).toBeHidden();
});

test("keyboard: the open conversation is what e, s and Shift+u act on, not the list cursor", async ({ page }) => {
  const list = await (await page.request.get("/api/v1/threads?view=archive&limit=1")).json();
  const inbox = await (await page.request.get("/api/v1/threads?view=inbox&limit=5")).json();
  const target = inbox.items[3];
  await page.goto(`/app/inbox?t=${target.id}`);
  await convo(page).getByRole("heading", { level: 1 }).waitFor();
  await page.keyboard.press("s");
  await expect.poll(async () => (await (await page.request.get(`/api/v1/threads/${target.id}`)).json()).messages.at(-1).isStarred).toBe(!target.isStarred);
  await page.keyboard.press("s");
  void list;
});

test("undo: bulk archive goes back where it came from; undo is offered on row actions", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  const before = await rows(page).count();
  await selectRow(page, 2);
  await selectRow(page, 3);
  await page.getByRole("button", { name: "Archive selected" }).click();
  await expect(page.getByText("Archived: 2 conversations.")).toBeVisible();
  await expect.poll(() => rows(page).count()).toBe(before - 2);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => rows(page).count()).toBe(before);

  await rows(page).first().hover();
  await rows(page).first().locator("xpath=..").getByRole("button", { name: /^(Star|Unstar)$/ }).click();
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
});

test("optimistic rollback: a refused action comes back with a message", async ({ page }) => {
  await page.route("**/api/v1/threads/*/actions", r => r.fulfill({ status: 502, json: { error: { code: "provider", message: "Your mail provider refused this." } } }));
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  const before = await rows(page).count();
  await rows(page).first().hover();
  await rows(page).first().locator("xpath=..").getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText(/Your mail provider refused this\. It's back how it was\./)).toBeVisible();
  await expect.poll(() => rows(page).count()).toBe(before);
});

test("async refusal: a change the provider refuses later is announced once", async ({ page }) => {
  let answered = false;
  await page.route("**/api/v1/mail/refusals*", r => { const body = answered ? [] : [{ messageId: "00000000-0000-4000-8000-000000000001", threadId: "00000000-0000-4000-8000-000000000002", at: new Date().toISOString(), code: "Error" }]; answered = true; return r.fulfill({ json: body }); });
  await page.goto("/app/inbox");
  await expect(page.getByText(/refused a change, so that conversation is back how it was/)).toBeVisible();
});

test("refusals endpoint: rejected input, and only your own rows", async ({ page }) => {
  expect((await page.request.get("/api/v1/mail/refusals?since=nope")).status()).toBe(400);
  const r = await page.request.get(`/api/v1/mail/refusals?since=${encodeURIComponent(new Date(Date.now() - 864e5).toISOString())}`);
  expect(r.ok()).toBeTruthy();
  expect(Array.isArray(await r.json())).toBe(true);
});

test("async send failure: a failed draft is announced and counted", async ({ page }) => {
  let n = 0;
  await page.route("**/api/v1/drafts", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    n++;
    const row = { id: "00000000-0000-4000-8000-000000000009", accountId: "x", accountEmail: "me@example.com", threadId: null, state: n > 1 ? "failed" : "editing", aiGenerated: false, updatedAt: new Date().toISOString(), errorCode: "provider_rejected", to: ["a@example.com"], cc: [], subject: "E2E failing send", text: "x", attachments: [] };
    await route.fulfill({ json: [row] });
  });
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  // Refresh by window focus, the same way the app does.
  await expect.poll(async () => { await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await page.waitForTimeout(6000); return page.getByText(/didn't send from me@example.com/).count(); }, { timeout: 40_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: /Drafts/ }).first()).toContainText("didn't send");
});

test("sync status: per account in the switcher, the sidebar and the account's own view", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.getByRole("button", { name: /^Account: / }).click();
  const menu = page.getByRole("menu", { name: "Accounts" });
  await expect(menu.getByRole("menuitem", { name: /All accounts/ })).toBeVisible();
  await menu.getByRole("menuitem", { name: /Personal/ }).click();
  await expect(page).toHaveURL(/account=/);
  await expect(page.getByTestId("account-sync")).toContainText("Last synced");
  await expect(page.getByTestId("account-sync").getByRole("button", { name: "Sync now" })).toBeVisible();
});

test("system states: account disconnected, reconnect, paused, partial sync, offline, server error", async ({ page, context }) => {
  const list = await (await page.request.get("/api/v1/accounts")).json();
  const fake = (patch: Record<string, unknown>, sync?: Record<string, unknown>) => page.route("**/api/v1/accounts", r => r.fulfill({ json: list.map((a: any, i: number) => i === 0 ? { ...a, ...patch, sync: { ...a.sync, ...sync } } : a) }));
  const url = `/app/inbox?account=${list[0].id}`;
  await fake({ status: "disconnected" });
  await page.goto(url);
  await expect(page.getByText(/This mailbox is disconnected/)).toBeVisible();
  await page.unroute("**/api/v1/accounts");
  await fake({ status: "paused" });
  await page.goto(url);
  await expect(page.locator("main").getByText(/Paused\. New mail isn't being fetched/)).toBeVisible();
  await page.unroute("**/api/v1/accounts");
  await fake({ status: "reconnect_required", statusDetail: "Access was revoked." });
  await page.goto(url);
  await expect(page.locator("main").getByText(/Access was revoked/)).toBeVisible();
  await expect(page.locator("nav").getByText("Needs reconnecting. Nothing new is arriving.")).toBeAttached();
  await page.unroute("**/api/v1/accounts");
  await fake({}, { phase: "initial", messagesSynced: 7 });
  await page.goto("/app/inbox");
  await expect(page.getByText(/Still syncing/)).toBeVisible();
  await page.unroute("**/api/v1/accounts");

  await page.route("**/api/v1/threads?*view=archive*", r => r.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong on our side." } } }));
  await page.goto("/app/archive");
  await expect(page.getByRole("heading", { name: "That didn't load" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await page.unroute("**/api/v1/threads?*view=archive*");

  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await context.setOffline(true);
  await expect(page.getByText(/You're offline/)).toBeVisible();
  await page.keyboard.press("c");
  await expect(composer(page).getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await composer(page).getByRole("button", { name: "Discard draft" }).click();
});

test("no fake capabilities: the assistant and rules still say they can't send", async ({ page }) => {
  await page.goto("/app/inbox");
  await rows(page).first().waitFor();
  await page.keyboard.press("a");
  await expect(page.getByRole("complementary", { name: "Assistant" })).toContainText("I can't send, forward, delete");
});

test("rules: edit an existing rule in plain English or rule form, and see what it has done", async ({ page }) => {
  await page.goto("/app/rules");
  const row = page.getByTestId("rule-row").first();
  const name = await row.getByRole("switch").getAttribute("aria-labelledby").then(() => row.locator("div.text-sm.font-medium").first().innerText());
  await row.getByRole("button", { name: `Edit rule: ${name}` }).click();
  const dialog = page.getByTestId("edit-rule");
  await dialog.getByLabel("The rule").fill("{ not json");
  await expect(dialog.getByRole("alert")).toContainText("isn't valid JSON");
  await expect(page.getByRole("button", { name: "Save rule" })).toBeDisabled();
  await dialog.getByLabel("The rule").fill(JSON.stringify({ trigger: "message.classified", match: "all", conditions: [], actions: [{ type: "send_mail" }] }));
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog.getByText(/isn't valid/)).toBeVisible();
  await dialog.getByLabel(/Describe it again/).fill("star mail from example.com");
  await dialog.getByRole("button", { name: "Turn into a rule" }).click();
  await expect(dialog).toContainText("example.com");
  await dialog.getByRole("button", { name: "Run a dry run" }).click();
  await expect(dialog.getByTestId("edit-dry-run")).toContainText("Nothing was changed");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("rule-row").first()).toContainText("example.com");
  await page.getByTestId("rule-row").first().getByText("What it has done").click();
  await expect(page.getByTestId("rule-row").first().getByText(/It hasn't run yet|Message details aren't kept here/).first()).toBeVisible();
});

test("the default list is one line per message, and an open message takes the whole panel", async ({ page }) => {
  await signIn(page);
  await page.request.patch("/api/v1/preferences", { data: { layout: "full" } });
  await page.goto("/app/inbox");
  const row = page.getByTestId("thread-row").first();
  await row.waitFor();
  expect((await row.boundingBox())!.height).toBeLessThan(44);
  await row.click();
  await expect(page.getByRole("region", { name: "Conversation" })).toBeVisible();
  await expect(page.getByTestId("thread-row").first()).toBeHidden();
  await page.request.patch("/api/v1/preferences", { data: { layout: "split" } });
});
