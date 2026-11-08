import { describe, expect, it, vi } from "vitest";
import {
  CursorExpiredError, GrantRevokedError, RateLimitedError, SendOutcomeUnknownError, UnsupportedOperationError,
  CAPABILITIES, type OutboundMessage,
} from "@aegis/domain/mail";
import { ProviderHttpError, createAdapter, gmailFolderRole, parseGmailPush } from "./index";
import { NOW, OAUTH_CONFIG, fakeFetch, json, oauthCred, sequence, type Route } from "./test-support";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64 = (s: string) => Buffer.from(s).toString("base64url");

function adapter(routes: Route[], opts: { readOnly?: boolean; topic?: string } = {}) {
  const f = fakeFetch(routes);
  const a = createAdapter("gmail", { email: "me@gmail.com", readOnly: opts.readOnly ?? false }, oauthCred("gmail"), {
    fetch: f, oauth: OAUTH_CONFIG, now: () => NOW, ...(opts.topic ? { gmailPubsubTopic: opts.topic } : {}),
  });
  return { a, f };
}

const LABELS: Route = ["GET", `${API}/labels`, json({ labels: [
  { id: "INBOX", name: "INBOX", type: "system" }, { id: "SENT", name: "SENT", type: "system" }, { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" }, { id: "TRASH", name: "TRASH", type: "system" }, { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" }, { id: "Label_1", name: "Work/Clients", type: "user" },
] })];

const msg = (id: string, labelIds: string[], body = `raw ${id}`) => json({
  id, threadId: `t-${id}`, labelIds, internalDate: String(NOW - 1000), raw: b64(body),
});
const sample: OutboundMessage = {
  from: { name: "Me", address: "me@gmail.com" },
  to: [{ address: "you@example.com" }],
  bcc: [{ address: "hidden@example.com" }],
  subject: "Hello",
  text: "BODY-SENTINEL",
  messageId: "<our-id-1@aegis.test>",
};

describe("label mapping", () => {
  it.each([
    [["INBOX"], "inbox"], [["SENT"], "sent"], [["DRAFT"], "drafts"], [["SPAM"], "spam"], [["TRASH"], "trash"],
    [["UNREAD", "Label_1"], "archive"], [[], "archive"],
    [["INBOX", "SENT"], "inbox"], [["TRASH", "SENT"], "trash"], [["SPAM", "INBOX"], "spam"],
  ])("%j maps to %s", (labels, role) => {
    expect(gmailFolderRole(labels)).toBe(role);
  });

  it("builds RemoteState with names for other labels, and the labels list is cached", async () => {
    const { a, f } = adapter([
      LABELS,
      ["GET", `${API}/profile`, json({ historyId: "100" })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "m1" }, { id: "m2" }] })],
      ["GET", `${API}/messages/m1`, msg("m1", ["INBOX", "UNREAD", "STARRED", "Label_1", "CATEGORY_UPDATES"])],
      ["GET", `${API}/messages/m2`, msg("m2", ["SENT", "Label_1"])],
    ]);
    const page = await a.fullSync({ windowDays: 30, pageSize: 50 });
    expect(page.changes[0]).toMatchObject({
      type: "upsert", remoteId: "m1", remoteThreadId: "t-m1",
      state: { folderRole: "inbox", labels: ["Work/Clients", "CATEGORY_UPDATES"], isRead: false, isStarred: true },
    });
    expect(page.changes[1]).toMatchObject({ state: { folderRole: "sent", labels: ["Work/Clients"], isRead: true, isStarred: false } });
    expect(f.to(`${API}/labels`)).toHaveLength(1);
  });

  it("reloads the label cache once for an unseen label", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/labels`, sequence(json({ labels: [] }), json({ labels: [{ id: "Label_9", name: "New" }] }))],
      ["GET", `${API}/profile`, json({ historyId: "1" })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "m1" }] })],
      ["GET", `${API}/messages/m1`, msg("m1", ["Label_9"])],
    ]);
    const page = await a.fullSync({ windowDays: 1, pageSize: 1 });
    expect(page.changes[0]).toMatchObject({ state: { labels: ["New"] } });
    expect(f.to(`${API}/labels`)).toHaveLength(2);
  });
});

describe("fullSync", () => {
  it("pages with a cursor holding pageToken and the historyId captured before listing", async () => {
    const routes: Route[] = [
      ["GET", `${API}/profile`, json({ historyId: "555" })],
      ["GET", /messages\?.*pageToken=p2/, json({ messages: [{ id: "m2" }] })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "m1" }], nextPageToken: "p2" })],
      ["GET", `${API}/messages/m1`, msg("m1", ["INBOX"], "hello one")],
      ["GET", `${API}/messages/m2`, msg("m2", ["INBOX"], "hello two")],
    ];
    const { a, f } = adapter(routes);
    const first = await a.fullSync({ windowDays: 14, pageSize: 25 });
    expect(first.hasMore).toBe(true);
    expect(JSON.parse(first.cursor)).toMatchObject({ pageToken: "p2", historyId: "555" });
    const listUrl = new URL(f.to(`${API}/messages?`)[0]!.url);
    expect(listUrl.searchParams.get("q")).toBe("newer_than:14d");
    expect(listUrl.searchParams.get("maxResults")).toBe("25");
    expect(listUrl.searchParams.get("includeSpamTrash")).toBe("true");
    // The profile is read before the listing.
    expect(f.calls[0]!.url).toContain("/profile");
    expect(f.calls[1]!.url).toContain("/messages?");

    const first0 = first.changes[0];
    expect(first0?.type === "upsert" && Buffer.from(first0.raw!).toString()).toBe("hello one");
    expect(first0).toMatchObject({ internalDate: new Date(NOW - 1000).toISOString() });

    const second = await a.fullSync({ windowDays: 14, pageSize: 25, cursor: first.cursor });
    expect(second.hasMore).toBe(false);
    expect(second.cursor).toBe("555");
    expect(second.changes.map((c) => c.remoteId)).toEqual(["m2"]);
    expect(f.to("/profile")).toHaveLength(1);
  });

  it("decodes base64url, including the characters that differ from base64", async () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x3e, 0x3f]);
    const { a } = adapter([
      ["GET", `${API}/profile`, json({ historyId: "1" })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "m1" }] })],
      ["GET", `${API}/messages/m1`, json({ id: "m1", labelIds: [], internalDate: "0", raw: bytes.toString("base64url") })],
    ]);
    const page = await a.fullSync({ windowDays: 1, pageSize: 1 });
    const c = page.changes[0]!;
    expect(c.type === "upsert" && Buffer.from(c.raw!).equals(bytes)).toBe(true);
  });

  it("reports a message that vanished between list and get as a delete", async () => {
    const { a } = adapter([
      ["GET", `${API}/profile`, json({ historyId: "1" })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "gone" }, { id: "m1" }] })],
      ["GET", `${API}/messages/gone`, json({ error: { code: 404 } }, 404)],
      ["GET", `${API}/messages/m1`, msg("m1", ["INBOX"])],
    ]);
    const page = await a.fullSync({ windowDays: 1, pageSize: 2 });
    expect(page.changes.map((c) => [c.type, c.remoteId])).toEqual([["delete", "gone"], ["upsert", "m1"]]);
  });

  it("fails the page rather than skip a message on a server error, so the cursor can't pass it", async () => {
    const { a } = adapter([
      ["GET", `${API}/profile`, json({ historyId: "1" })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "m1" }] })],
      ["GET", `${API}/messages/m1`, json({}, 500)],
    ]);
    await expect(a.fullSync({ windowDays: 1, pageSize: 1 })).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("handles an empty mailbox and a finished cursor", async () => {
    const { a } = adapter([
      ["GET", `${API}/profile`, json({ historyId: "9" })],
      ["GET", `${API}/messages?`, json({ resultSizeEstimate: 0 })],
    ]);
    expect(await a.fullSync({ windowDays: 1, pageSize: 1 })).toEqual({ changes: [], cursor: "9", hasMore: false });
    expect(await a.fullSync({ windowDays: 1, pageSize: 1, cursor: "9" })).toEqual({ changes: [], cursor: "9", hasMore: false });
  });

  it("rejects a window that isn't a positive integer", async () => {
    const { a } = adapter([]);
    await expect(a.fullSync({ windowDays: 1.5, pageSize: 1 })).rejects.toThrow(TypeError);
  });
});

describe("incrementalSync", () => {
  it("asks for the four history types and pages", async () => {
    const { a, f } = adapter([
      ["GET", /history\?.*pageToken=h2/, json({ historyId: "900", history: [{ messagesDeleted: [{ message: { id: "m9" } }] }] })],
      ["GET", `${API}/history?`, json({ historyId: "800", nextPageToken: "h2", history: [{ messagesAdded: [{ message: { id: "m1" } }] }] })],
      ["GET", `${API}/messages/m1`, msg("m1", ["INBOX"])],
    ]);
    const first = await a.incrementalSync("500", { pageSize: 10 });
    expect(first.hasMore).toBe(true);
    expect(first.changes.map((c) => c.type)).toEqual(["upsert"]);
    const url = new URL(f.to("/history?")[0]!.url);
    expect(url.searchParams.get("startHistoryId")).toBe("500");
    expect(url.searchParams.getAll("historyTypes").sort()).toEqual(["labelAdded", "labelRemoved", "messageAdded", "messageDeleted"]);

    const second = await a.incrementalSync(first.cursor, { pageSize: 10 });
    expect(new URL(f.to("/history?")[1]!.url).searchParams.get("startHistoryId")).toBe("500");
    expect(second).toMatchObject({ hasMore: false, cursor: "900" });
    expect(second.changes).toEqual([{ type: "delete", remoteId: "m9" }]);
  });

  it("dedupes per page and fetches each message once", async () => {
    const { a, f } = adapter([
      LABELS,
      ["GET", `${API}/history?`, json({ historyId: "2", history: [
        { messagesAdded: [{ message: { id: "m1" } }], labelsAdded: [{ message: { id: "m1" } }] },
        { labelsRemoved: [{ message: { id: "m1" } }, { message: { id: "m2" } }], labelsAdded: [{ message: { id: "m2" } }] },
      ] })],
      ["GET", `${API}/messages/m1`, msg("m1", ["INBOX"])],
      ["GET", `${API}/messages/m2`, json({ id: "m2", labelIds: ["SENT", "STARRED"] })],
    ]);
    const page = await a.incrementalSync("1", { pageSize: 10 });
    expect(page.changes.map((c) => [c.type, c.remoteId])).toEqual([["upsert", "m1"], ["state", "m2"]]);
    expect(page.changes[1]).toMatchObject({ state: { folderRole: "sent", isRead: true, isStarred: true } });
    expect(f.to(`${API}/messages/m1`)).toHaveLength(1);
    expect(f.to(`${API}/messages/m2`)[0]!.url).toContain("format=minimal");
  });

  it("doesn't fetch a message added and then deleted in the same page", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/history?`, json({ historyId: "2", history: [
        { messagesAdded: [{ message: { id: "m1" } }] },
        { messagesDeleted: [{ message: { id: "m1" } }] },
      ] })],
    ]);
    const page = await a.incrementalSync("1", { pageSize: 10 });
    expect(page.changes).toEqual([{ type: "delete", remoteId: "m1" }]);
    expect(f.to("/messages/")).toHaveLength(0);
  });

  it("treats a 404 on get as a delete instead of failing the batch", async () => {
    const { a } = adapter([
      ["GET", `${API}/history?`, json({ historyId: "2", history: [
        { messagesAdded: [{ message: { id: "gone" } }, { message: { id: "ok" } }], labelsAdded: [{ message: { id: "gone2" } }] },
      ] })],
      ["GET", `${API}/messages/gone2`, json({}, 404)],
      ["GET", `${API}/messages/gone`, json({}, 404)],
      ["GET", `${API}/messages/ok`, msg("ok", ["INBOX"])],
    ]);
    const page = await a.incrementalSync("1", { pageSize: 10 });
    expect(page.changes.map((c) => [c.type, c.remoteId])).toEqual([["delete", "gone"], ["upsert", "ok"], ["delete", "gone2"]]);
  });

  it("maps a stale history 404 to CursorExpiredError", async () => {
    const { a } = adapter([["GET", `${API}/history?`, json({ error: { code: 404 } }, 404)]]);
    await expect(a.incrementalSync("1", { pageSize: 1 })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("keeps the cursor when nothing has changed", async () => {
    const { a } = adapter([["GET", `${API}/history?`, json({ historyId: "77" })]]);
    expect(await a.incrementalSync("70", { pageSize: 1 })).toEqual({ changes: [], cursor: "77", hasMore: false });
  });

  it.each(["garbage", "{}", '{"phase":"history"}', '{"phase":"full","historyId":"1","pageToken":"p"}'])(
    "rejects the unusable cursor %s", async (cursor) => {
      const { a, f } = adapter([]);
      await expect(a.incrementalSync(cursor, { pageSize: 1 })).rejects.toBeInstanceOf(CursorExpiredError);
      expect(f.calls).toHaveLength(0);
    },
  );
});

describe("errors", () => {
  it("maps 429 to RateLimitedError with Retry-After", async () => {
    const { a } = adapter([["GET", `${API}/labels`, json({}, 429, { "retry-after": "37" })]]);
    const err = await a.listFolders().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(37);
  });

  it.each(["rateLimitExceeded", "userRateLimitExceeded"])("maps 403 %s to RateLimitedError", async (reason) => {
    const { a } = adapter([["GET", `${API}/labels`, json({ error: { errors: [{ reason }] } }, 403, { "retry-after": "5" })]]);
    const err = await a.listFolders().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(5);
  });

  it("leaves other 403s as plain errors, with no provider text", async () => {
    const { a } = adapter([["GET", `${API}/labels`, json({ error: { message: "BODY-SENTINEL", errors: [{ reason: "insufficientPermissions" }] } }, 403)]]);
    const err = await a.listFolders().catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.message).toContain("insufficientPermissions");
    expect(err.message).not.toContain("SENTINEL");
  });

  it("surfaces a revoked token as GrantRevokedError", async () => {
    const { a } = adapter([
      ["GET", `${API}/labels`, json({}, 401)],
      ["GET", `${API}/profile`, json({}, 401)],
      ["POST", "oauth2.googleapis.com/token", json({ error: "invalid_grant" }, 400)],
    ]);
    await expect(a.listFolders()).rejects.toBeInstanceOf(GrantRevokedError);
    const result = await a.testConnection();
    expect(result).toMatchObject({ ok: false, problem: "oauth_revoked" });
  });

  it("doesn't let a malformed body quote itself into an error", async () => {
    const { a } = adapter([["GET", `${API}/labels`, new Response("<html>BODY-SENTINEL", { status: 200 })]]);
    const err = await a.listFolders().catch((e) => e);
    expect(err.message).not.toContain("SENTINEL");
  });
});

describe("applyChange", () => {
  const modifyBody = (f: ReturnType<typeof fakeFetch>) => JSON.parse(f.to("/modify")[0]!.body!);
  const minimal: Route = ["GET", `${API}/messages/m1?format=minimal`, json({ id: "m1", labelIds: ["INBOX"] })];
  const modify: Route = ["POST", `${API}/messages/m1/modify`, json({})];

  it.each([
    ["archive", { addLabelIds: [], removeLabelIds: ["INBOX", "SPAM"] }],
    ["spam", { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] }],
    ["inbox", { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }],
  ] as const)("moveToRole %s", async (role, body) => {
    const { a, f } = adapter([minimal, modify]);
    await a.applyChange("m1", { moveToRole: role });
    expect(modifyBody(f)).toEqual(body);
  });

  it("uses the trash endpoint", async () => {
    const { a, f } = adapter([["POST", `${API}/messages/m1/trash`, json({})]]);
    await a.applyChange("m1", { moveToRole: "trash" });
    expect(f.to("/trash")).toHaveLength(1);
    expect(f.to("/modify")).toHaveLength(0);
  });

  it("untrashes before moving out of the trash", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/messages/m1?format=minimal`, json({ labelIds: ["TRASH"] })],
      ["POST", `${API}/messages/m1/untrash`, json({})], modify,
    ]);
    await a.applyChange("m1", { moveToRole: "inbox" });
    expect(f.calls.map((c) => c.url.split("/").pop())).toEqual(["m1?format=minimal", "untrash", "modify"]);
  });

  it("maps read and starred to UNREAD and STARRED", async () => {
    const { a, f } = adapter([modify]);
    await a.applyChange("m1", { isRead: true, isStarred: true });
    expect(modifyBody(f)).toEqual({ addLabelIds: ["STARRED"], removeLabelIds: ["UNREAD"] });
  });

  it("resolves label names, creating one that doesn't exist", async () => {
    const { a, f } = adapter([LABELS, modify, ["POST", `${API}/labels`, json({ id: "Label_2" })]]);
    await a.applyChange("m1", { addLabels: ["Work/Clients", "Brand New"], removeLabels: ["Never Existed"] });
    expect(JSON.parse(f.to(`${API}/labels`).find((c) => c.method === "POST")!.body!)).toEqual({ name: "Brand New" });
    expect(modifyBody(f)).toEqual({ addLabelIds: ["Label_1", "Label_2"], removeLabelIds: [] });
  });

  it.each(["sent", "drafts", "custom"] as const)("refuses moving to %s", async (role) => {
    const { a, f } = adapter([]);
    await expect(a.applyChange("m1", { moveToRole: role })).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(f.calls).toHaveLength(0);
  });
});

describe("read-only accounts", () => {
  it("refuse applyChange and send without calling the API, and say so in capabilities", async () => {
    const { a, f } = adapter([], { readOnly: true });
    await expect(a.applyChange("m1", { isRead: true })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.send(sample)).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(f.calls).toHaveLength(0);
    expect(a.capabilities).toMatchObject({ send: false, archive: false, flags: false, moveToSpam: false, twoWaySync: false });
  });
});

describe("send", () => {
  const decodeRaw = (f: ReturnType<typeof fakeFetch>) => Buffer.from(JSON.parse(f.to("/messages/send")[0]!.body!).raw, "base64url").toString();
  const SEND = `${API}/messages/send`;

  it("sends RFC 5322 with our Message-ID, Bcc and threadId", async () => {
    const { a, f } = adapter([["POST", SEND, json({ id: "sent1", threadId: "t" })]]);
    const result = await a.send({ ...sample, remoteThreadId: "t1", inReplyTo: "<a@b>", references: ["<a@b>"] });
    expect(result).toEqual({ remoteId: "sent1", acceptedAt: new Date(NOW).toISOString() });
    const raw = decodeRaw(f);
    expect(raw).toMatch(/^Message-ID: <our-id-1@aegis\.test>\r?$/m);
    expect(raw).toMatch(/^In-Reply-To: <a@b>\r?$/m);
    // messages.send reads recipients from the headers, so a stripped Bcc would silently not be delivered.
    expect(raw).toMatch(/^Bcc: hidden@example\.com\r?$/m);
    expect(JSON.parse(f.to("/messages/send")[0]!.body!).threadId).toBe("t1");
    expect(f.to("/messages/send")[0]!.body).not.toMatch(/[+/]/);
  });

  it("can't be header-injected through the subject or a display name", async () => {
    const { a, f } = adapter([["POST", SEND, json({ id: "x" })]]);
    await a.send({ ...sample, subject: "hi\r\nBcc: evil@example.com", from: { name: "x\r\nX-Evil: 1", address: "me@gmail.com" } });
    const headers = decodeRaw(f).split(/\r?\n\r?\n/)[0]!;
    expect(headers).not.toMatch(/^Bcc: evil/m);
    expect(headers).not.toMatch(/^X-Evil/m);
  });

  it.each(["<a\r\nBcc: evil@x>", "has space@x", "", "a<b@x"])("rejects the Message-ID %j before any request", async (messageId) => {
    const { a, f } = adapter([]);
    await expect(a.send({ ...sample, messageId })).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });

  it("maps a timeout to SendOutcomeUnknownError", async () => {
    const { a } = adapter([["POST", SEND, new DOMException("timed out", "TimeoutError")]]);
    await expect(a.send(sample)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("maps a connection failure to SendOutcomeUnknownError", async () => {
    const { a } = adapter([["POST", SEND, new TypeError("fetch failed")]]);
    await expect(a.send(sample)).rejects.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it.each([500, 502, 503])("maps %i to SendOutcomeUnknownError", async (status) => {
    const { a } = adapter([["POST", SEND, json({ error: { message: "BODY-SENTINEL" } }, status)]]);
    const err = await a.send(sample).catch((e) => e);
    expect(err).toBeInstanceOf(SendOutcomeUnknownError);
    expect(err.message).not.toContain("SENTINEL");
  });

  it("maps a 4xx to a normal error that isn't SendOutcomeUnknownError", async () => {
    const { a } = adapter([["POST", SEND, json({ error: { errors: [{ reason: "invalidArgument" }] } }, 400)]]);
    const err = await a.send(sample).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError);
  });

  it("maps 429 to RateLimitedError: nothing was sent", async () => {
    const { a } = adapter([["POST", SEND, json({}, 429, { "retry-after": "2" })]]);
    await expect(a.send(sample)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("treats a revoked grant during the 401 retry as a known failure, not an unknown outcome", async () => {
    const { a } = adapter([["POST", SEND, json({}, 401)], ["POST", "oauth2.googleapis.com/token", json({ error: "invalid_grant" }, 400)]]);
    await expect(a.send(sample)).rejects.toBeInstanceOf(GrantRevokedError);
  });

  it("counts an unreadable 200 as accepted", async () => {
    const { a } = adapter([["POST", SEND, new Response("not json", { status: 200 })]]);
    expect(await a.send(sample)).toEqual({ acceptedAt: new Date(NOW).toISOString() });
  });
});

describe("findSentByMessageId", () => {
  it("searches rfc822msgid including trash and confirms the SENT label", async () => {
    const { a, f } = adapter([
      ["GET", `${API}/messages?`, json({ messages: [{ id: "s1" }] })],
      ["GET", `${API}/messages/s1`, json({ labelIds: ["SENT", "TRASH"] })],
    ]);
    expect(await a.findSentByMessageId("<our-id-1@aegis.test>")).toEqual({ remoteId: "s1" });
    const url = new URL(f.calls[0]!.url);
    expect(url.searchParams.get("q")).toBe("rfc822msgid:our-id-1@aegis.test");
    expect(url.searchParams.get("includeSpamTrash")).toBe("true");
  });

  it("returns null when nothing matches or the match is only a draft", async () => {
    const none = adapter([["GET", `${API}/messages?`, json({})]]);
    expect(await none.a.findSentByMessageId("x@y")).toBeNull();
    const draft = adapter([
      ["GET", `${API}/messages?`, json({ messages: [{ id: "d1" }] })],
      ["GET", `${API}/messages/d1`, json({ labelIds: ["DRAFT"] })],
    ]);
    expect(await draft.a.findSentByMessageId("x@y")).toBeNull();
  });

  it("can't have search operators smuggled through the id", async () => {
    const { a, f } = adapter([]);
    await expect(a.findSentByMessageId("x@y from:someone")).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
  });
});

describe("push", () => {
  it("renewPush calls users.watch with the topic and INBOX include", async () => {
    const expiration = NOW + 7 * 86_400_000;
    const { a, f } = adapter([["POST", `${API}/watch`, json({ historyId: "1", expiration: String(expiration) })]], { topic: "projects/p/topics/t" });
    expect(await a.renewPush!()).toEqual({ expiresAt: new Date(expiration).toISOString() });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ topicName: "projects/p/topics/t", labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" });
  });

  it("returns null and reports no push capability without a topic", async () => {
    const { a, f } = adapter([]);
    expect(await a.renewPush!()).toBeNull();
    expect(f.calls).toHaveLength(0);
    expect(a.capabilities.pushNotifications).toBe(false);
  });

  it("reports the published capabilities when fully configured", () => {
    const { a } = adapter([], { topic: "projects/p/topics/t" });
    expect(a.capabilities).toEqual(CAPABILITIES.gmail);
  });

  it("stopPush calls users.stop", async () => {
    const { a, f } = adapter([["POST", `${API}/stop`, new Response(null, { status: 204 })]]);
    await a.stopPush!();
    expect(f.calls).toHaveLength(1);
  });
});

describe("revoke", () => {
  it("revokes the refresh token at Google", async () => {
    const { a, f } = adapter([["POST", "oauth2.googleapis.com/revoke", new Response(null, { status: 200 })]]);
    expect(await a.revoke()).toBe(true);
    expect(f.calls[0]!.body).toBe("token=refresh-token-SENTINEL");
  });
});

describe("listFolders and testConnection", () => {
  it("maps system labels and user labels", async () => {
    const { a } = adapter([LABELS]);
    const folders = await a.listFolders();
    expect(folders.map((f) => f.role).sort()).toEqual(["archive", "custom", "drafts", "inbox", "sent", "spam", "trash"]);
    expect(folders.find((f) => f.role === "custom")).toEqual({ remoteId: "Label_1", name: "Work/Clients", role: "custom" });
  });

  it("testConnection reports success and rate limiting", async () => {
    const ok = adapter([LABELS, ["GET", `${API}/profile`, json({ historyId: "1" })]]);
    expect(await ok.a.testConnection()).toEqual({ ok: true, folders: 7 });
    const limited = adapter([["GET", `${API}/profile`, json({}, 429)]]);
    expect(await limited.a.testConnection()).toMatchObject({ ok: false, problem: "rate_limited" });
    const timeout = adapter([["GET", `${API}/profile`, new DOMException("t", "TimeoutError")]]);
    expect(await timeout.a.testConnection()).toMatchObject({ ok: false, problem: "timeout" });
  });
});

describe("parseGmailPush", () => {
  const encode = (o: unknown, enc: "base64" | "base64url" = "base64url") => Buffer.from(JSON.stringify(o)).toString(enc);
  const envelope = (data: unknown) => ({ message: { data, messageId: "1", publishTime: "t" }, subscription: "s" });

  it("decodes a valid envelope", () => {
    expect(parseGmailPush(envelope(encode({ emailAddress: "a@b.com", historyId: 123 })))).toEqual({ emailAddress: "a@b.com", historyId: "123" });
  });

  it("accepts standard base64, which Pub/Sub's JSON uses, and a string body", () => {
    const body = JSON.stringify(envelope(encode({ emailAddress: "a@b.com", historyId: "9" }, "base64")));
    expect(parseGmailPush(body)).toEqual({ emailAddress: "a@b.com", historyId: "9" });
  });

  it("decodes data containing the url-safe alphabet", () => {
    const data = encode({ emailAddress: "a???>>>@b.com", historyId: "9" });
    expect(data).toMatch(/[-_]/);
    expect(parseGmailPush(envelope(data))).toEqual({ emailAddress: "a???>>>@b.com", historyId: "9" });
  });

  it.each<[string, unknown]>([
    ["null", null], ["number", 7], ["array", []], ["empty object", {}], ["no message", { subscription: "s" }],
    ["unparseable string", "{nope"],
    ["non-string data", envelope(123)], ["empty data", envelope("")], ["bad alphabet", envelope("!!!!")],
    ["not json", envelope(Buffer.from("hello").toString("base64url"))],
    ["json array", envelope(encode([1, 2]))], ["json null", envelope(encode(null))],
    ["missing email", envelope(encode({ historyId: 1 }))], ["missing history", envelope(encode({ emailAddress: "a@b.com" }))],
    ["not an address", envelope(encode({ emailAddress: "nope", historyId: 1 }))],
    ["float history", envelope(encode({ emailAddress: "a@b.com", historyId: 1.5 }))],
    ["negative history", envelope(encode({ emailAddress: "a@b.com", historyId: -1 }))],
    ["non-numeric history", envelope(encode({ emailAddress: "a@b.com", historyId: "12a" }))],
    ["oversized", envelope("A".repeat(5000))],
  ])("returns null for %s", (_name, body) => {
    expect(parseGmailPush(body)).toBeNull();
  });

  it("rejects a history id too large for a JSON number to carry exactly", () => {
    const data = Buffer.from('{"emailAddress":"a@b.com","historyId":18446744073709551615}').toString("base64url");
    expect(parseGmailPush(envelope(data))).toBeNull();
  });
});

describe("logging", () => {
  it("writes nothing to the console through a full flow", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { a } = adapter([
      ["GET", `${API}/profile`, json({ historyId: "1" })],
      ["GET", `${API}/messages?`, json({ messages: [{ id: "m1" }] })],
      ["GET", `${API}/messages/m1`, msg("m1", ["INBOX"], "BODY-SENTINEL")],
      ["POST", `${API}/messages/send`, json({}, 500)],
    ]);
    await a.fullSync({ windowDays: 1, pageSize: 1 });
    await a.send(sample).catch(() => undefined);
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});

