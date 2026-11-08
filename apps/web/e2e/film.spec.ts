import { expect, test, type Page } from "@playwright/test";
import evidence from "../src/film/data/evidence.json" with { type: "json" };
import { signIn } from "./helpers";

test.describe.configure({ mode: "serial" });
const FLAGGED = "Tallow Press Billing";

const canvas = (page: Page) => page.locator("#film-canvas canvas");
const hasWebGL = (page: Page) => page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
async function open(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", e => problems.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
  await page.goto("/?qa=1&tier=low");
  return problems;
}
const seek = async (page: Page, id: string, t: number) => { await page.evaluate(([id, t]) => { (window as any).__film.seek(id, t); }, [id, t] as const); await page.waitForTimeout(350); };
const ready = (page: Page) => page.waitForFunction(() => (window as any).__film?.ready?.() === true, null, { timeout: 40_000 });

test.describe("the film", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("about:blank");
    test.skip(!(await hasWebGL(page)), "This browser has no WebGL 2, so it gets the plain page, tested below.");
  });

  test("renders to a canvas, under the strict CSP, with no errors or requests to anywhere else", async ({ page }) => {
    const external: string[] = [];
    const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3217").origin;
    page.on("request", r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== origin) external.push(r.url()); });
    const problems = await open(page);
    await ready(page);
    await expect(canvas(page)).toBeVisible();
    const csp = (await (await page.request.get("/")).headers())["content-security-policy"]!;
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The smart inbox that stops threats.");
    expect(problems).toEqual([]);
    expect(external).toEqual([]);
  });

  test("the headline is on screen the moment the page opens, with no scrolling", async ({ page }) => {
    await page.goto("/");
    const hero = page.locator("#flurry .copy").first();
    await expect(hero).toHaveCSS("opacity", "1", { timeout: 1500 });
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("the copy for a chapter is only on while its chapter is", async ({ page }) => {
    await open(page); await ready(page);
    const seals = page.locator("#seals .copy").first();
    await expect(seals).toHaveCSS("opacity", "0");
    await seek(page, "seals", 0.5);
    await expect(seals).toHaveCSS("opacity", "1");
    await seek(page, "focus", 0.5);
    await expect(seals).toHaveCSS("opacity", "0");
  });

  test("the pointer is a wind: letters near it are pushed away, and drift back", async ({ page }) => {
    // Hosted CI runners have no GPU: WebGL runs in software at a few frames a second, too slowly for the push to build up in time.
    test.skip(!!process.env.CI, "needs a GPU");
    await open(page); await ready(page);
    await page.evaluate(() => { (window as any).__film.film.frozen = false; });
    const push = () => page.evaluate(() => (window as any).__film.film.windPeak as number);
    await page.waitForTimeout(800);
    expect(await push(), "nothing should be pushed before the pointer moves").toBeLessThan(0.05);
    const vp = page.viewportSize()!;
    // Through the open part of the flurry, away from the product panel, which keeps letters off its face.
    const tall = vp.width / vp.height < 1.1;
    for (let i = 0; i < 4; i++) { await page.mouse.move(vp.width * (tall ? 0.1 : 0.5), vp.height * (tall ? 0.12 : 0.33), { steps: 6 }); await page.mouse.move(vp.width * (tall ? 0.9 : 0.85), vp.height * (tall ? 0.18 : 0.66), { steps: 6 }); }
    const pushed = await push();
    expect(pushed, "moving through the letters should push them").toBeGreaterThan(0.3);
    // Away from all of them: out past the edge of the flurry, low on the left.
    await page.mouse.move(2, vp.height - 2);
    await page.waitForTimeout(4000);
    expect(await push(), "and they drift back").toBeLessThan(pushed);
  });

  test("stream: switching a source off lays its card down", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "stream", 0.6);
    await page.locator("#stream").getByRole("button", { name: "Outlook" }).click();
    expect(await page.evaluate(() => (window as any).__film.film.controls.sources)).toEqual([true, false, true]);
    await page.locator("#stream").getByRole("button", { name: "Outlook" }).click();
    expect(await page.evaluate(() => (window as any).__film.film.controls.sources)).toEqual([true, true, true]);
  });

  test("seals: a lookalike domain passes every check, and the page says why that isn't enough", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "seals", 0.5);
    await page.getByRole("button", { name: "A lookalike domain" }).click();
    await expect(page.locator("#seals .film-readout")).toContainText("Every seal holds");
    await page.getByRole("button", { name: "Faking the domain" }).click();
    await expect(page.locator("#seals .film-readout")).toContainText("the seals crack");
    expect(await page.evaluate(() => (window as any).__film.film.controls.sender)).toBe("spoofed");
  });

  test("autopsy: a layer can be chosen from its label in the world, or from the list", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "autopsy", 0.7);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.locator("#autopsy .film-readout")).toContainText("the layer a lookalike can't fake");
    const vp = page.viewportSize()!;
    // On a tall screen there's no room beside the scene, so the labels give way to the same buttons in the copy.
    if (vp.width / vp.height < 1.1) { await expect(page.locator('.film-tag[data-anchor="au-wording"]')).toBeHidden(); await page.locator("#autopsy").getByRole("button", { name: "Wording", exact: true }).click(); }
    else {
      await expect(page.locator('.film-tag[data-anchor="au-wording"]')).toHaveCSS("opacity", "1");
      await page.locator('.film-tag[data-anchor="au-wording"]').click();
    }
    await expect(page.locator("#autopsy .film-readout")).toContainText("change payment details");
  });

  test("the lamp: finds the hidden text, by moving over it or with a button", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "uv", 0.5);
    await expect(page.locator("#uv .film-readout")).toContainText("Nothing you can see");
    await page.getByRole("button", { name: "Light the whole page" }).click();
    await expect(page.locator("#uv .film-readout")).toContainText(evidence.injection.hidden);
    await expect(page.locator("#uv .film-readout")).toContainText(evidence.injection.evidence[0]!.explanation.slice(0, 40));
  });

  test("the scale: shows the engine's own findings and verdict for each message", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "scale", 0.5);
    for (const s of evidence.samples) {
      await page.getByRole("button", { name: s.pick }).click();
      const out = page.locator("#scale .film-readout");
      const showAll = out.getByRole("button", { name: /^Show all/ });
      if (await showAll.count()) await showAll.click();
      for (const e of s.evidence) await expect(out).toContainText(`${e.weight > 0 ? "+" : ""}${e.weight}`);
      await expect(out).toContainText(s.label === "safe" ? "No concerns found" : "Malicious");
    }
  });

  test("case, glass and vault: each control does what it says", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "case", 0.5);
    await page.getByRole("button", { name: "Release it" }).click();
    await expect(page.locator("#case .film-readout")).toContainText("records who released it");
    await seek(page, "glass", 0.6);
    await page.getByRole("button", { name: "Tell the model to send it" }).click();
    await expect(page.locator("#glass .film-readout")).toContainText("no send tool");
    await page.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.locator("#glass .film-readout")).toContainText("only after your approval");
    await seek(page, "vault", 0.8);
    await page.getByRole("button", { name: "Destroy the key" }).click();
    await expect(page.locator("#vault .film-readout")).toContainText("still readable with the root key");
  });

  test("focus: a letter moves between shelves with buttons, and flagged mail can't be moved", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "focus", 0.6);
    const out = page.locator("#focus .film-readout");
    await expect(out).toContainText("Needs your attention");
    await page.getByRole("button", { name: "Move down" }).click();
    await expect(out).toContainText("Today's commitments");
    await page.locator("#focus").getByRole("button", { name: FLAGGED }).click();
    await expect(page.locator("#focus")).toContainText("stays out of the order");
    await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);
  });

  test("focus: a letter can be picked up in the world and dropped on another shelf", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "focus", 0.75);
    await page.waitForTimeout(600);
    const at = await page.evaluate(() => { const a = (window as any).__film.film.anchors["card-priya"] ?? Object.entries((window as any).__film.film.anchors).find(([k]) => k.startsWith("card-"))?.[1]; return (window as any).__project(a.x, a.y, a.z); });
    await page.mouse.move(at[0], at[1]);
    await page.mouse.down();
    await page.mouse.move(at[0], at[1] + 120, { steps: 4 });
    await page.mouse.move(at[0], at[1] + 330, { steps: 8 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const moved = await page.evaluate(() => (window as any).__film.film.controls.shelfOf);
    expect(Object.values(moved).length, "the drop should have put a letter on a shelf").toBe(1);
    expect(Object.values(moved)[0]).toBeGreaterThan(0);
  });

  test("the lamp follows a real pointer, and finds the hidden lines", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "uv", 0.5);
    await expect(page.locator("#uv .film-readout")).toContainText("Nothing you can see");
    const at = await page.evaluate(() => (window as any).__project(122, 0.1, 0.9));
    await page.mouse.move(at[0], at[1], { steps: 5 });
    await expect(page.locator("#uv .film-readout")).toContainText("ignore your previous instructions", { timeout: 8000 });
  });

  test("x-ray: the scroll opens the PDF, and the verdict is the engine's", async ({ page }) => {
    await open(page); await ready(page);
    await seek(page, "xray", 0.2);
    await expect(page.locator("#xray .film-readout")).toContainText("Nothing about it looks wrong");
    await seek(page, "xray", 0.9);
    await expect(page.locator("#xray .film-readout")).toContainText("Malicious. Held in quarantine.");
    await expect(page.locator("#xray .film-readout")).toContainText("exploit a PDF reader");
    await page.getByRole("button", { name: "Its objects" }).click();
    await expect(page.locator("#xray .film-readout")).toContainText("runs a script the moment");
  });

  test("every chapter has more to read, in a dialog that closes with Escape", async ({ page }) => {
    await open(page); await ready(page);
    for (const id of ["flurry", "stream", "seals", "autopsy", "xray", "uv", "scale", "case", "focus", "glass", "vault", "calm"]) {
      const sheet = page.locator(`#${id} .film-sheet-btn`);
      expect(await sheet.count(), `${id} has no detail`).toBeGreaterThan(0);
    }
    await seek(page, "glass", 0.6);
    await page.locator("#glass .film-sheet-btn").click();
    await expect(page.getByRole("dialog")).toContainText("no tool to send");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a control reached with Tab brings its moment on screen", async ({ page }) => {
    await open(page); await ready(page);
    await page.getByRole("button", { name: "Faking the domain" }).focus();
    await page.waitForTimeout(300);
    await expect(page.locator("#seals .copy").first()).toHaveCSS("opacity", "1");
  });

  test("the canvas stops when the film has scrolled away", async ({ page }) => {
    await open(page); await ready(page);
    await page.locator("#focus-demo").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await expect(page.locator("#film-canvas")).toHaveCSS("visibility", "hidden");
  });
});

test.describe("the plain page", () => {
  const CHAPTERS = ["flurry", "stream", "seals", "autopsy", "xray", "uv", "scale", "case", "focus", "glass", "vault", "calm"];

  test("with reduced motion: no canvas, every chapter readable, with a frame from the film", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("#film-canvas canvas")).toHaveCount(0);
    for (const id of CHAPTERS) {
      const s = page.locator(`#${id}`);
      await expect(s.getByRole("heading").first()).toBeVisible();
      const img = s.locator("img");
      await img.scrollIntoViewIfNeeded();
      await expect(img).toHaveAttribute("alt", /.{10}/);
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    }
    await ctx.close();
  });

  test("controls still work in the plain page", async ({ page }) => {
    await page.goto("/?static");
    await page.getByRole("button", { name: "Faking the domain" }).click();
    await expect(page.locator("#seals .film-readout")).toContainText("the seals crack");
    await page.getByRole("button", { name: "Read the detail" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("with no JavaScript at all, the words are all there", async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The smart inbox that stops threats.");
    await expect(page.getByText("Held, not deleted.")).toBeVisible();
    await ctx.close();
  });
});

test("the plain page doesn't download the 3D engine either", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const scripts: string[] = [];
  page.on("response", async r => { if (r.url().endsWith(".js") && r.ok()) { try { if ((await r.text()).includes("WebGLRenderer")) scripts.push(r.url()); } catch { /* navigated away */ } } });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(scripts).toEqual([]);
  await ctx.close();
});

test("the workspace doesn't download the 3D engine", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", async r => { if (r.url().endsWith(".js") && r.ok()) { try { if ((await r.text()).includes("WebGLRenderer")) scripts.push(r.url()); } catch { /* navigated away */ } } });
  await signIn(page);
  await page.goto("/app/inbox");
  await page.getByTestId("thread-row").first().waitFor();
  await page.waitForTimeout(800);
  expect(scripts).toEqual([]);
});
