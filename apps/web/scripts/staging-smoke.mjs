// Drives a deployed demo-mode instance in a real browser, through an HTTP basic-auth gate in front of it. It changes mail in the shared
// demo workspace and creates one throwaway account, so point it only at a staging instance.
//   STAGING_URL=https://staging.example.com STAGING_USER=... STAGING_PASSWORD=... node apps/web/scripts/staging-smoke.mjs
import { chromium, request } from "@playwright/test";

const BASE = process.argv[2] ?? process.env.STAGING_URL;
if (!BASE) { console.error("Set STAGING_URL (or pass the URL as the first argument)."); process.exit(2); }
const httpCredentials = { username: process.env.STAGING_USER ?? "", password: process.env.STAGING_PASSWORD ?? "" };
if (!httpCredentials.username || !httpCredentials.password) { console.error("Set STAGING_USER and STAGING_PASSWORD."); process.exit(2); }
const DEMO_PASSWORD = "demo-password-not-secret";

let failed = 0;
const ok = (name, pass, detail = "") => { if (!pass) failed++; console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`); };

const anon = await request.newContext({ baseURL: BASE });
ok("no password: the gate refuses", (await anon.get("/")).status() === 401);
ok("no password: the demo sign-in is behind the gate", (await anon.post("/api/v1/demo/signin", { data: {} })).status() === 401);
ok("no password: the dev outbox is behind the gate", (await anon.get("/dev/outbox")).status() === 401);
const http = (await anon.get(BASE.replace("https:", "http:"), { maxRedirects: 0 })).status();
ok("plain http redirects or is refused", [301, 302, 307, 308, 401].includes(http), String(http));

const browser = await chromium.launch();
const context = await browser.newContext({ httpCredentials, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const problems = [];
const missing = new Set();
page.on("pageerror", e => problems.push(`pageerror ${page.url()}: ${e.message}`));
page.on("console", m => { if (m.type() === "error") problems.push(`console ${page.url()}: ${m.text()}`); });
page.on("response", r => {
  if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
  else if (r.status() === 404) missing.add(`${r.request().method()} ${new URL(r.url()).pathname.replace(/[0-9a-f-]{36}/g, ":id")}`);
});

const api = async path => { const r = await page.request.get(`${BASE}/api/v1${path}`); return { status: r.status(), body: await r.json().catch(() => null) }; };
const visit = async (path, expected) => {
  const r = await page.goto(BASE + path, { waitUntil: "networkidle" });
  const text = await page.locator("body").innerText();
  ok(path, r.status() === 200 && expected.test(text), r.status() === 200 ? (expected.test(text) ? "" : `no ${expected} in: ${text.slice(0, 200).replace(/\s+/g, " ")}`) : String(r.status()));
};
const signIn = async email => {
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
};

const health = await api("/health");
ok("health", health.status === 200);
const config = await api("/public/config");
ok("runs in demo mode, and says so", config.body?.demoMode === true);

const home = await page.goto(BASE, { waitUntil: "networkidle" });
ok("marketing site", home.status() === 200);
const headers = home.headers();
ok("CSP survives the proxies", /script-src[^;]*'nonce-/.test(headers["content-security-policy"] ?? ""));
ok("HSTS or TLS only", headers["strict-transport-security"] !== undefined || BASE.startsWith("https:"));

await signIn("morgan@demo.aegis.example");
ok("signed in as the demo member through the form", (await api("/me")).body?.email === "morgan@demo.aegis.example");
const cookies = await context.cookies(BASE);
const session = cookies.find(c => /session/i.test(c.name));
ok("session cookie is Secure and HttpOnly", !!session && session.secure && session.httpOnly, session?.name);

await page.goto(`${BASE}/app/inbox`);
await page.getByTestId("thread-row").first().waitFor({ timeout: 30_000 });
const before = await page.getByTestId("thread-row").count();
ok("inbox lists mail", before > 0, `${before} rows`);
// Unread on purpose. Opening unread mail refreshes every mail query, which once sent a request for /api/v1null.
const firstThread = new URL(await page.getByTestId("thread-row").first().getAttribute("href"), BASE).searchParams.get("t");
const unread = await page.request.post(`${BASE}/api/v1/threads/${firstThread}/actions`, { data: { action: "unread" }, headers: { Origin: BASE } });
ok("a thread can be marked unread", unread.ok(), String(unread.status()));
const opened = page.waitForResponse(r => /\/api\/v1\/threads\/[0-9a-f-]{36}$/.test(new URL(r.url()).pathname) && r.request().method() === "GET", { timeout: 30_000 });
await page.getByTestId("thread-row").first().click();
const thread = await (await opened).json();
const body = thread.messages?.[0]?.text ?? "";
ok("a message opens and its sealed body decrypts", body.length > 0, `${thread.messages?.length} messages, ${body.length} characters`);
await page.waitForTimeout(1500);

await page.goto(`${BASE}/app/focus`);
await page.getByTestId("thread-row").first().waitFor({ timeout: 30_000 });
await page.getByRole("button", { name: "Send me a test email" }).click();
await page.getByText(/real pipeline/).first().waitFor({ timeout: 30_000 });
ok("simulated mail goes through the worker", true);

for (const [path, expected] of [
  ["/app/security", /Security/i], ["/app/tasks", /Tasks|Up next/i], ["/app/rules", /Rule/i], ["/app/privacy", /Privacy|encrypt/i],
  ["/app/settings/accounts", /demo|mailbox|account/i], ["/app/settings/security", /Password|Recovery|Passkey/i],
  ["/app/org", /Organi[sz]ation|Members|member/i], ["/app/org/audit", /Audit/i], ["/app/connect", /Gmail|Google|Microsoft|connect/i],
]) await visit(path, expected);

await context.clearCookies();
await signIn("operator@demo.aegis.example");
for (const [path, expected] of [["/admin", /Tenant|Operator|Admin/i], ["/admin/tenants", /Tenant|Workspace/i], ["/admin/health", /Health|Queue|demo/i], ["/admin/jobs", /Job/i], ["/admin/audit", /Audit/i]]) await visit(path, expected);

// A new account, and the mail it's sent. Verifies the worker's mail queue end to end, without any mail leaving the server.
await context.clearCookies();
const email = `smoke-${Date.now()}@example.com`;
await page.goto(`${BASE}/sign-up`);
await page.getByLabel("Email").fill(email);
await page.getByRole("button", { name: "Continue" }).click();
await page.getByLabel("Password").fill("correct-horse-battery-staple-9");
await page.getByRole("button", { name: "Continue" }).click();
await page.getByLabel("Name").fill("Smoke Test");
await page.getByRole("button", { name: /create|sign up|get started/i }).click();
await page.waitForURL(/\/app\/onboarding/, { timeout: 30_000 });
ok("sign-up reaches onboarding", true, email);
let delivered = false;
for (let i = 0; i < 20 && !delivered; i++) {
  await page.goto(`${BASE}/dev/outbox`);
  delivered = (await page.locator("body").innerText()).includes(email);
  if (!delivered) await page.waitForTimeout(1500);
}
ok("the worker delivered the verification mail to the dev outbox", delivered);

console.log(`note  404s seen: ${[...missing].join(", ") || "none"}`);
const unique = [...new Set(problems)];
ok("no script errors, CSP violations or 5xx on any page", unique.length === 0, unique.slice(0, 8).join(" | "));
await browser.close();
await anon.dispose();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
