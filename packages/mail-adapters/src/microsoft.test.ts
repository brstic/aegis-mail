import { describe, expect, it } from "vitest";
import {
  CursorExpiredError, GrantRevokedError, RateLimitedError, SendOutcomeUnknownError, UnsupportedOperationError, CAPABILITIES,
  type OutboundMessage,
} from "@aegis/domain/mail";
import { GRAPH_SUBSCRIPTION_MINUTES, ProviderHttpError, createAdapter, graphValidationResponse, validateGraphNotification } from "./index";
import { NOW, OAUTH_CONFIG, fakeFetch, json, oauthCred, type Route } from "./test-support";

const API = "https://graph.microsoft.com/v1.0";
const link = (kind: string, id: string) => `${API}/me/mailFolders/${id}/messages/delta?$${kind}=tok-${id}`;

const FOLDER_ROUTES: Route[] = [
  ["GET", `${API}/me/mailFolders/inbox?`, json({ id: "FI", displayName: "Inbox" })],
  ["GET", `${API}/me/mailFolders/sentitems?`, json({ id: "FS", displayName: "Sent Items" })],
  ["GET", `${API}/me/mailFolders/drafts?`, json({ id: "FD", displayName: "Drafts" })],
  ["GET", `${API}/me/mailFolders/archive?`, json({ error: { code: "ErrorItemNotFound" } }, 404)],
  ["GET", `${API}/me/mailFolders/junkemail?`, json({ id: "FJ", displayName: "Junk Email" })],
  ["GET", `${API}/me/mailFolders/deleteditems?`, json({ id: "FT", displayName: "Deleted Items" })],
];

function adapter(routes: Route[], opts: { readOnly?: boolean; push?: boolean } = {}) {
  const f = fakeFetch([...routes, ...FOLDER_ROUTES]);
  const a = createAdapter("microsoft", { email: "me@outlook.com", readOnly: opts.readOnly ?? false }, oauthCred("microsoft"), {
    fetch: f, oauth: OAUTH_CONFIG, now: () => NOW,
    ...(opts.push ? { graphWebhookUrl: "https://hook.test/graph", graphClientState: "state-SENTINEL" } : {}),
  });
  return { a, f };
}

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, conversationId: `c-${id}`, isRead: false, flag: { flagStatus: "notFlagged" }, receivedDateTime: "2026-11-01T00:00:00Z", parentFolderId: "FI", ...over,
});
const emptyDelta = (id: string) => json({ value: [], "@odata.deltaLink": link("deltatoken", id) });
const emptyFolders = (...ids: string[]): Route[] => ids.map((id) => ["GET", `/mailFolders/${id}/messages/delta`, emptyDelta(id)] as Route);
const mime = (id: string): Route => ["GET", `${API}/me/messages/${id}/$value`, new Response(`MIME ${id}`)];

const sample: OutboundMessage = {
  from: { address: "me@outlook.com" }, to: [{ address: "you@example.com" }], bcc: [{ address: "hidden@example.com" }],
  subject: "Hello", text: "BODY-SENTINEL", messageId: "<our-id-1@aegis.test>",
};

describe("folder discovery", () => {
  it("looks up well-known names, tolerates a missing archive, and caches", async () => {
    const { a, f } = adapter([]);
    const folders = await a.listFolders();
    expect(folders).toEqual([
      { remoteId: "FI", name: "Inbox", role: "inbox" }, { remoteId: "FS", name: "Sent Items", role: "sent" },
      { remoteId: "FD", name: "Drafts", role: "drafts" }, { remoteId: "FJ", name: "Junk Email", role: "spam" },
      { remoteId: "FT", name: "Deleted Items", role: "trash" },
    ]);
    await a.listFolders();
    expect(f.calls).toHaveLength(6);
    expect(await a.testConnection()).toEqual({ ok: true, folders: 5 });
  });
});

describe("fullSync", () => {
  it("runs a filtered per-folder delta, follows nextLink without refiltering, and ends with deltaLinks", async () => {
    const { a, f } = adapter([
      ["GET", /FI\/messages\/delta\?\$skiptoken/, json({ value: [item("m2")], "@odata.deltaLink": link("deltatoken", "FI") })],
      ["GET", "/mailFolders/FI/messages/delta?$select", json({ value: [item("m1", { isRead: true, flag: { flagStatus: "flagged" }, categories: ["Blue"] })], "@odata.nextLink": link("skiptoken", "FI") })],
      ...emptyFolders("FS", "FD", "FJ", "FT"),
      mime("m1"), mime("m2"),
    ]);
    const first = await a.fullSync({ windowDays: 7, pageSize: 1 });
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(first.cursor)).toEqual({ FI: { nextLink: link("skiptoken", "FI") } });

    const firstCall = f.to("/FI/messages/delta")[0]!;
    expect(firstCall.url).toContain("$select=id,conversationId,isRead,flag,receivedDateTime,parentFolderId");
    const since = new Date(NOW - 7 * 86_400_000).toISOString();
    expect(decodeURIComponent(firstCall.url)).toContain(`$filter=receivedDateTime ge ${since}`);
    expect(firstCall.headers.get("prefer")).toBe("odata.maxpagesize=1");

    const c = first.changes[0]!;
    expect(c).toMatchObject({
      type: "upsert", remoteId: "m1", remoteThreadId: "c-m1", internalDate: "2026-11-01T00:00:00Z",
      state: { folderRole: "inbox", isRead: true, isStarred: true, labels: ["Blue"] },
    });
    expect(c.type === "upsert" && Buffer.from(c.raw!).toString()).toBe("MIME m1");

    const second = await a.fullSync({ windowDays: 7, pageSize: 100, cursor: first.cursor });
    const followUp = f.to("/FI/messages/delta")[1]!;
    expect(followUp.url).toBe(link("skiptoken", "FI"));
    expect(followUp.url).not.toContain("$filter");
    expect(followUp.headers.get("prefer")).toBe("odata.maxpagesize=100");
    expect(second.hasMore).toBe(false);
    expect(second.changes.map((x) => x.remoteId)).toEqual(["m2"]);
    expect(Object.keys(JSON.parse(second.cursor)).sort()).toEqual(["FD", "FI", "FJ", "FS", "FT"]);
    for (const entry of Object.values<any>(JSON.parse(second.cursor))) expect(entry.deltaLink).toBeTypeOf("string");
    // A finished cursor does nothing more.
    const again = await a.fullSync({ windowDays: 7, pageSize: 100, cursor: second.cursor });
    expect(again).toMatchObject({ changes: [], hasMore: false });
  });

  it("maps each folder to its role", async () => {
    const { a } = adapter([
      ["GET", "/mailFolders/FI/messages/delta", json({ value: [item("a")], "@odata.deltaLink": link("deltatoken", "FI") })],
      ["GET", "/mailFolders/FS/messages/delta", json({ value: [item("b")], "@odata.deltaLink": link("deltatoken", "FS") })],
      ["GET", "/mailFolders/FD/messages/delta", json({ value: [item("c")], "@odata.deltaLink": link("deltatoken", "FD") })],
      ["GET", "/mailFolders/FJ/messages/delta", json({ value: [item("d")], "@odata.deltaLink": link("deltatoken", "FJ") })],
      ["GET", "/mailFolders/FT/messages/delta", json({ value: [item("e")], "@odata.deltaLink": link("deltatoken", "FT") })],
      mime("a"), mime("b"), mime("c"), mime("d"), mime("e"),
    ]);
    const page = await a.fullSync({ windowDays: 1, pageSize: 100 });
    expect(page.changes.map((c) => c.type === "upsert" && c.state.folderRole)).toEqual(["inbox", "sent", "drafts", "spam", "trash"]);
  });

  it("refuses a nextLink that points anywhere but Graph, so the token can't be sent there", async () => {
    const { a, f } = adapter([]);
    const cursor = JSON.stringify({ FI: { nextLink: "https://evil.example/steal" } });
    await expect(a.fullSync({ windowDays: 1, pageSize: 1, cursor })).rejects.toBeInstanceOf(CursorExpiredError);
    expect(f.to("evil.example")).toHaveLength(0);
  });

  it("refuses an off-origin link returned by the server", async () => {
    const { a } = adapter([
      ["GET", "/mailFolders/FI/messages/delta", json({ value: [], "@odata.nextLink": "https://evil.example/x" })],
      ...emptyFolders("FS", "FD", "FJ", "FT"),
    ]);
    await expect(a.fullSync({ windowDays: 1, pageSize: 1 })).rejects.toBeInstanceOf(CursorExpiredError);
  });
});

describe("incrementalSync", () => {
  const start = JSON.stringify({ FI: { deltaLink: link("deltatoken", "FI") }, FS: { deltaLink: link("deltatoken", "FS") } });

  it("reports @removed as a delete and upserts with MIME", async () => {
    const { a, f } = adapter([
      ["GET", "/mailFolders/FI/messages/delta", json({ value: [{ id: "gone", "@removed": { reason: "deleted" } }, item("m1")], "@odata.deltaLink": link("deltatoken2", "FI") })],
      ["GET", "/mailFolders/FS/messages/delta", json({ value: [], "@odata.deltaLink": link("deltatoken2", "FS") })],
      mime("m1"),
    ]);
    const page = await a.incrementalSync(start, { pageSize: 50 });
    expect(page.changes.map((c) => [c.type, c.remoteId])).toEqual([["delete", "gone"], ["upsert", "m1"]]);
    expect(page.hasMore).toBe(false);
    expect(JSON.parse(page.cursor)).toEqual({ FI: { deltaLink: link("deltatoken2", "FI") }, FS: { deltaLink: link("deltatoken2", "FS") } });
    expect(f.to("gone")).toHaveLength(0);
  });

  it("treats a 404 on MIME as a delete", async () => {
    const { a } = adapter([
      ["GET", "/mailFolders/FI/messages/delta", json({ value: [item("m1")], "@odata.deltaLink": link("deltatoken2", "FI") })],
      ["GET", "/mailFolders/FS/messages/delta", json({ value: [], "@odata.deltaLink": link("deltatoken2", "FS") })],
      ["GET", `${API}/me/messages/m1/$value`, json({ error: { code: "ErrorItemNotFound" } }, 404)],
    ]);
    const page = await a.incrementalSync(start, { pageSize: 5 });
    expect(page.changes).toEqual([{ type: "delete", remoteId: "m1" }]);
  });

  it("stays on a nextLink until the folder is done", async () => {
    const { a, f } = adapter([
      ["GET", /FI\/messages\/delta\?\$skiptoken/, json({ value: [], "@odata.deltaLink": link("deltatoken2", "FI") })],
      ["GET", /FI\/messages\/delta\?\$deltatoken/, json({ value: [], "@odata.nextLink": link("skiptoken", "FI") })],
      ["GET", "/mailFolders/FS/messages/delta", json({ value: [], "@odata.deltaLink": link("deltatoken2", "FS") })],
    ]);
    const first = await a.incrementalSync(start, { pageSize: 5 });
    expect(first.hasMore).toBe(true);
    const second = await a.incrementalSync(first.cursor, { pageSize: 5 });
    expect(f.calls.some((c) => c.url === link("skiptoken", "FI"))).toBe(true);
    expect(second.hasMore).toBe(false);
  });

  it("stops at the page budget and leaves the rest for the next call", async () => {
    const { a, f } = adapter([
      ["GET", "/mailFolders/FI/messages/delta", json({ value: [item("m1")], "@odata.deltaLink": link("deltatoken2", "FI") })],
      mime("m1"),
    ]);
    const page = await a.incrementalSync(start, { pageSize: 1 });
    expect(page.hasMore).toBe(true);
    expect(f.to("/FS/messages/delta")).toHaveLength(0);
    expect(JSON.parse(page.cursor).FS).toEqual({ deltaLink: link("deltatoken", "FS") });
  });

  it("maps 410 to CursorExpiredError", async () => {
    const { a } = adapter([["GET", "/mailFolders/FI/messages/delta", json({ error: { code: "SyncStateNotFound" } }, 410)]]);
    await expect(a.incrementalSync(start, { pageSize: 5 })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it.each(["syncStateNotFound", "SyncStateNotFound", "resyncRequired"])("maps the code %s to CursorExpiredError on any status", async (code) => {
    const { a } = adapter([["GET", "/mailFolders/FI/messages/delta", json({ error: { code } }, 400)]]);
    await expect(a.incrementalSync(start, { pageSize: 5 })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("maps 429 with Retry-After to RateLimitedError", async () => {
    const { a } = adapter([["GET", "/mailFolders/FI/messages/delta", json({}, 429, { "retry-after": "42" })]]);
    const err = await a.incrementalSync(start, { pageSize: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(42);
  });

  it("maps 503 with an HTTP-date Retry-After to RateLimitedError", async () => {
    const at = new Date(NOW + 90_000).toUTCString();
    const { a } = adapter([["GET", "/mailFolders/FI/messages/delta", json({}, 503, { "retry-after": at })]]);
    const err = await a.incrementalSync(start, { pageSize: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(90);
  });

  it("leaves other server errors as plain errors", async () => {
    const { a } = adapter([["GET", "/mailFolders/FI/messages/delta", json({ error: { code: "generalException", message: "BODY-SENTINEL" } }, 500)]]);
    const err = await a.incrementalSync(start, { pageSize: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.message).not.toContain("SENTINEL");
  });

  it.each(["garbage", "[]", '{"FI":{}}', '{"FI":{"deltaLink":5}}'])("rejects the unusable cursor %s", async (cursor) => {
    const { a } = adapter([]);
    await expect(a.incrementalSync(cursor, { pageSize: 1 })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("refuses a cursor link to another host", async () => {
    const { a, f } = adapter([]);
    const cursor = JSON.stringify({ FI: { deltaLink: "https://graph.microsoft.com.evil.example/x" } });
    await expect(a.incrementalSync(cursor, { pageSize: 1 })).rejects.toBeInstanceOf(CursorExpiredError);
    expect(f.to("evil.example")).toHaveLength(0);
  });

  it("surfaces a revoked grant", async () => {
    const { a } = adapter([
      ["GET", "/mailFolders/inbox?", json({}, 401)],
      ["POST", "login.microsoftonline.com", json({ error: "invalid_grant" }, 400)],
    ]);
    await expect(a.listFolders()).rejects.toBeInstanceOf(GrantRevokedError);
  });
});

describe("applyChange", () => {
  it("reports the new id a move gives the message, so the caller can follow it", async () => {
    const { a } = adapter([["POST", `${API}/me/messages/m1/move`, json({ id: "m1-new" })]]);
    await expect(a.applyChange("m1", { moveToRole: "archive" })).resolves.toEqual({ remoteId: "m1-new" });
  });

  it("patches read and flag, then moves last because a move changes the id", async () => {
    const { a, f } = adapter([
      ["PATCH", `${API}/me/messages/m1`, json({})],
      ["POST", `${API}/me/messages/m1/move`, json({ id: "m1-new" })],
    ]);
    await a.applyChange("m1", { isRead: true, isStarred: true, moveToRole: "archive" });
    expect(f.calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ isRead: true, flag: { flagStatus: "flagged" } });
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ destinationId: "archive" });
  });

  it.each([["inbox", "inbox"], ["spam", "junkemail"], ["trash", "deleteditems"], ["archive", "archive"]] as const)("moves to %s via %s", async (role, dest) => {
    const { a, f } = adapter([["POST", `${API}/me/messages/m1/move`, json({})]]);
    await a.applyChange("m1", { moveToRole: role });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ destinationId: dest });
  });

  it("merges categories", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/me/messages/m1?$select=categories`, json({ categories: ["A", "B"] })],
      ["PATCH", `${API}/me/messages/m1`, json({})],
    ]);
    await a.applyChange("m1", { addLabels: ["C"], removeLabels: ["A"] });
    expect(JSON.parse(f.to("/me/messages/m1").find((c) => c.method === "PATCH")!.body!)).toEqual({ categories: ["B", "C"] });
  });

  it("encodes ids in paths", async () => {
    const { a, f } = adapter([["PATCH", /\/me\/messages\/a%2Fb%3D/, json({})]]);
    await a.applyChange("a/b=", { isRead: false });
    expect(f.calls[0]!.url).toBe(`${API}/me/messages/a%2Fb%3D`);
  });

  it("refuses a role with no well-known folder", async () => {
    const { a } = adapter([]);
    await expect(a.applyChange("m1", { moveToRole: "custom" })).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});

describe("read-only accounts", () => {
  it("refuse writes without calling Graph and say so in capabilities", async () => {
    const { a, f } = adapter([], { readOnly: true });
    await expect(a.applyChange("m1", { isRead: true })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.send(sample)).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(f.calls).toHaveLength(0);
    expect(a.capabilities).toMatchObject({ send: false, flags: false });
  });
});

describe("send", () => {
  const SEND = `${API}/me/sendMail`;

  it("posts base64 MIME as text/plain with our Message-ID", async () => {
    const { a, f } = adapter([["POST", SEND, new Response(null, { status: 202 })]]);
    const result = await a.send(sample);
    expect(result).toEqual({ acceptedAt: new Date(NOW).toISOString() });
    const call = f.calls[0]!;
    expect(call.headers.get("content-type")).toBe("text/plain");
    const decoded = Buffer.from(call.body!, "base64").toString();
    expect(decoded).toMatch(/^Message-ID: <our-id-1@aegis\.test>\r?$/m);
    expect(decoded).toMatch(/^Bcc: hidden@example\.com\r?$/m);
    expect(decoded).toContain("BODY-SENTINEL");
  });

  it.each([500, 503, 504])("maps %i to SendOutcomeUnknownError, not rate limiting", async (status) => {
    const { a } = adapter([["POST", SEND, json({}, status, { "retry-after": "1" })]]);
    await expect(a.send(sample)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("maps a timeout to SendOutcomeUnknownError", async () => {
    const { a } = adapter([["POST", SEND, new DOMException("t", "TimeoutError")]]);
    await expect(a.send(sample)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("maps 429 to RateLimitedError and 400 to a plain error", async () => {
    const limited = adapter([["POST", SEND, json({}, 429, { "retry-after": "3" })]]);
    await expect(limited.a.send(sample)).rejects.toBeInstanceOf(RateLimitedError);
    const bad = adapter([["POST", SEND, json({ error: { code: "ErrorInvalidRecipients" } }, 400)]]);
    const err = await bad.a.send(sample).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError);
  });
});

describe("findSentByMessageId", () => {
  it("filters sent items, escaping quotes", async () => {
    const { a, f } = adapter([["GET", "/mailFolders/sentitems/messages", json({ value: [{ id: "s1" }] })]]);
    expect(await a.findSentByMessageId("<o'brien'@aegis.test>")).toEqual({ remoteId: "s1" });
    expect(decodeURIComponent(f.calls[0]!.url)).toContain("$filter=internetMessageId eq '<o''brien''@aegis.test>'");
  });

  it("adds the angle brackets Graph stores", async () => {
    const { a, f } = adapter([["GET", "/mailFolders/sentitems/messages", json({ value: [] })]]);
    expect(await a.findSentByMessageId("bare@aegis.test")).toBeNull();
    expect(decodeURIComponent(f.calls[0]!.url)).toContain("eq '<bare@aegis.test>'");
  });
});

describe("push", () => {
  const created = { id: "sub1", expirationDateTime: "2026-11-12T12:00:00Z" };

  it("creates a subscription under the limit when none exists", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/subscriptions`, json({ value: [{ id: "other", notificationUrl: "https://other.test/" }] })],
      ["POST", `${API}/subscriptions`, json(created)],
    ], { push: true });
    expect(await a.renewPush!()).toEqual({ expiresAt: created.expirationDateTime, state: { subscriptionId: "sub1" } });
    const body = JSON.parse(f.to("/subscriptions").find((c) => c.method === "POST")!.body!);
    expect(body).toMatchObject({
      changeType: "created,updated,deleted", resource: "/me/messages", clientState: "state-SENTINEL",
      notificationUrl: "https://hook.test/graph", lifecycleNotificationUrl: "https://hook.test/graph",
    });
    expect(body.includeResourceData).toBeUndefined();
    const minutes = (Date.parse(body.expirationDateTime) - NOW) / 60_000;
    expect(minutes).toBe(GRAPH_SUBSCRIPTION_MINUTES);
    expect(minutes).toBeLessThan(10_080);
  });

  it("patches the subscription it holds", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/subscriptions`, json({ value: [] })],
      ["POST", `${API}/subscriptions`, json(created)],
      ["PATCH", `${API}/subscriptions/sub1`, json({ id: "sub1", expirationDateTime: "2026-11-13T00:00:00Z" })],
    ], { push: true });
    await a.renewPush!();
    expect((await a.renewPush!())?.expiresAt).toBe("2026-11-13T00:00:00Z");
    expect(f.to("/subscriptions").filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("finds and patches an existing subscription from a fresh adapter instead of leaking a new one", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/subscriptions`, json({ value: [{ id: "sub9", notificationUrl: "https://hook.test/graph" }] })],
      ["PATCH", `${API}/subscriptions/sub9`, json({ id: "sub9", expirationDateTime: "2026-11-13T00:00:00Z" })],
    ], { push: true });
    expect(await a.renewPush!()).toMatchObject({ state: { subscriptionId: "sub9" } });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("creates a new one when the known subscription has gone", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/subscriptions`, json({ value: [{ id: "old", notificationUrl: "https://hook.test/graph" }] })],
      ["PATCH", `${API}/subscriptions/old`, json({ error: { code: "ResourceNotFound" } }, 404)],
      ["POST", `${API}/subscriptions`, json(created)],
    ], { push: true });
    expect(await a.renewPush!()).toMatchObject({ state: { subscriptionId: "sub1" } });
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("stopPush deletes it", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/subscriptions`, json({ value: [{ id: "sub9", notificationUrl: "https://hook.test/graph" }] })],
      ["DELETE", `${API}/subscriptions/sub9`, new Response(null, { status: 204 })],
    ], { push: true });
    await a.stopPush!();
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("returns null and reports no push without a webhook", async () => {
    const { a, f } = adapter([]);
    expect(await a.renewPush!()).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(a.capabilities.pushNotifications).toBe(false);
  });

  it("reports the published capabilities when configured, including no revoke", async () => {
    const { a } = adapter([], { push: true });
    expect(a.capabilities).toEqual(CAPABILITIES.microsoft);
    expect(await a.revoke()).toBe(false);
  });
});

describe("validateGraphNotification", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    subscriptionId: "sub1", clientState: "secret", changeType: "created", resource: "Users/1/Messages/m1", resourceData: { id: "m1", "@odata.type": "#Microsoft.Graph.Message" }, ...over,
  });

  it("returns well-formed notifications, reduced to IDs", () => {
    expect(validateGraphNotification({ value: [change({ extra: "BODY-SENTINEL" })] }, "secret")).toEqual([
      { kind: "change", subscriptionId: "sub1", changeType: "created", resource: "Users/1/Messages/m1", messageId: "m1" },
    ]);
  });

  it("rejects a clientState mismatch", () => {
    expect(validateGraphNotification({ value: [change({ clientState: "wrong" })] }, "secret")).toEqual([]);
    expect(validateGraphNotification({ value: [change({ clientState: "secre" })] }, "secret")).toEqual([]);
    expect(validateGraphNotification({ value: [change({ clientState: "secretsecret" })] }, "secret")).toEqual([]);
  });

  it("keeps the good ones in a mixed batch", () => {
    const out = validateGraphNotification({ value: [change({ clientState: "wrong" }), change({ subscriptionId: "good" })] }, "secret");
    expect(out.map((n) => n.subscriptionId)).toEqual(["good"]);
  });

  it("passes lifecycle notifications through", () => {
    const n = { subscriptionId: "sub1", clientState: "secret", lifecycleEvent: "reauthorizationRequired", resource: "x" };
    expect(validateGraphNotification({ value: [n] }, "secret")).toEqual([
      { kind: "lifecycle", subscriptionId: "sub1", lifecycleEvent: "reauthorizationRequired" },
    ]);
  });

  it.each<[string, unknown]>([
    ["null", null], ["array", []], ["no value", {}], ["non-array value", { value: {} }],
    ["null item", { value: [null] }], ["string item", { value: ["x"] }],
    ["no subscription", { value: [change({ subscriptionId: undefined })] }],
    ["unknown changeType", { value: [change({ changeType: "exfiltrated" })] }],
    ["no resource", { value: [change({ resource: undefined })] }],
    ["no clientState", { value: [change({ clientState: undefined })] }],
    ["non-string clientState", { value: [change({ clientState: 7 })] }],
    ["unknown lifecycle", { value: [{ subscriptionId: "s", clientState: "secret", lifecycleEvent: "nope" }] }],
  ])("drops %s", (_name, payload) => {
    expect(validateGraphNotification(payload, "secret")).toEqual([]);
  });

  it("rejects everything when no state is expected", () => {
    expect(validateGraphNotification({ value: [change({ clientState: "" })] }, "")).toEqual([]);
  });
});

describe("graphValidationResponse", () => {
  it("reflects the decoded token as text/plain", async () => {
    const res = graphValidationResponse("https://hook.test/graph?validationToken=Validation%3A%20Testing%20client%3Cscript%3E")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Validation: Testing client<script>");
  });

  it("returns null when it isn't a validation request", () => {
    expect(graphValidationResponse("https://hook.test/graph")).toBeNull();
    expect(graphValidationResponse("not a url")).toBeNull();
    expect(graphValidationResponse(`https://hook.test/?validationToken=${"a".repeat(5000)}`)).toBeNull();
  });
});

