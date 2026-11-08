import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../dist");
const PAGE = `<!doctype html><html><body><main>
  <a id="phish" href="https://micros0ft-login.test/verify">Sign in</a>
  <a id="mismatch" href="https://evil.test/x">https://bank.example</a>
  <a id="ok" href="https://github.com/org/repo">the repo</a>
  <a id="short" href="https://bit.ly/abc">read more</a>
  <a id="userinfo" href="https://paypal.com@evil.test/x">PayPal</a>
  <a id="xss" href="https://micros0ft-login.test/&quot;&gt;&lt;img src=x onerror=window.__pwned=1&gt;">x</a>
</main><div id="later"></div></body></html>`;

test("marks risky links in place, leaves good ones, and makes no requests of its own", async () => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "aegis-ext-")), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  const external: string[] = [];
  await ctx.route("**/*", r => {
    const u = r.request().url();
    if (u === "https://mail.google.com/mail/u/0/") return r.fulfill({ contentType: "text/html", body: PAGE });
    external.push(u);
    return r.abort();
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("https://mail.google.com/mail/u/0/");
  await expect(page.locator("#phish + [data-aegis-link-check=lookalike]")).toContainText("imitates Microsoft");
  await expect(page.locator("#mismatch + [data-aegis-link-check=mismatch]")).toContainText("says bank.example but goes to evil.test");
  await expect(page.locator("#short + [data-aegis-link-check=shortener]")).toBeVisible();
  await expect(page.locator("#userinfo + [data-aegis-link-check=userinfo]")).toContainText("evil.test");
  await expect(page.locator("#ok + [data-aegis-link-check]")).toHaveCount(0);
  // Links added later, as webmail does when opening a message.
  await page.evaluate(() => { document.getElementById("later")!.innerHTML = '<a id="late" href="https://paypa1.com/login">Pay</a>'; });
  await expect(page.locator("#late + [data-aegis-link-check=lookalike]")).toBeVisible();
  // Page content is only ever written as text.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("the manifest asks for no permissions, and the code has no way to send anything", () => {
  const m = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  expect(m.permissions).toEqual([]);
  expect(m.host_permissions).toEqual([]);
  const js = readFileSync(join(dist, "content.js"), "utf8");
  for (const api of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "chrome.runtime", "innerHTML"]) expect(js.includes(api), api).toBe(false);
});
