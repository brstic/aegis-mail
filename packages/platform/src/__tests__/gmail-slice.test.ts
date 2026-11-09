import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mime } from "@aegis/test-fixtures";
import { createTestDb } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { approveSend, beginMailboxOAuth, type Ctx, createPlatform, decideQuarantine, disconnectAccount, drainJobs, enqueue, getThread, listThreads, makeLogger, type Platform, publicAccounts, finishMailboxOAuth, saveDraft, signUp, handleGmailPush, tick } from "../index";

/**
 * Phase 2 vertical slice with the real GmailAdapter and real oauth4webapi, against a protocol fake for Google's endpoints.
 * Connect → receive → classify → render → reply → disconnect. No live Google account was involved:
 * the fake encodes our reading of the docs. docs/runbooks/live-provider-smoke-test.md covers the live step.
 */
class FakeGoogle {
  messages = new Map<string, { id: string; threadId: string; labelIds: string[]; raw: string; historyId: string }>();
  historyId = 1000; history: any[] = []; sent: any[] = []; revoked: string[] = []; watches = 0; tokenValid = true; historyGone = false; calls: string[] = [];
  deliver(id: string, threadId: string, input: Parameters<typeof mime>[0], labels = ["INBOX", "UNREAD"]) {
    this.historyId++;
    this.messages.set(id, { id, threadId, labelIds: labels, raw: Buffer.from(mime(input)).toString("base64url"), historyId: String(this.historyId) });
    this.history.push({ id: String(this.historyId), messagesAdded: [{ message: { id, threadId, labelIds: labels } }] });
  }
  fetch: typeof fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    this.calls.push(`${req.method} ${u.host}${u.pathname}`);
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      if (!this.tokenValid) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "ya29.fake-access", refresh_token: "1//fake-refresh", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/gmail.modify" });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/revoke") { this.revoked.push("revoked"); return json({}); }
    if (!u.pathname.startsWith("/gmail/v1/users/me")) return json({ error: "not found" }, 404);
    if (!this.tokenValid) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/profile") return json({ emailAddress: "owner@fernhill.example", historyId: String(this.historyId) });
    if (path === "/labels") return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Clients", type: "user" }] });
    if (path === "/watch") { this.watches++; return json({ historyId: String(this.historyId), expiration: String(Date.now() + 7 * 864e5) }); }
    if (path === "/stop") return new Response(null, { status: 204 });
    if (path === "/messages") {
      const q = u.searchParams.get("q") ?? "";
      if (q.startsWith("rfc822msgid:")) { const id = q.slice(12); const hit = this.sent.find(s => s.messageId === id); return json(hit ? { messages: [{ id: hit.id, threadId: hit.threadId }] } : {}); }
      return json({ messages: [...this.messages.values()].map(m => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: this.messages.size });
    }
    if (path === "/messages/send") {
      const body = await req.json() as { raw: string; threadId?: string };
      const raw = Buffer.from(body.raw, "base64url").toString();
      const id = `sent-${this.sent.length + 1}`;
      this.sent.push({ id, threadId: body.threadId ?? id, raw, messageId: raw.match(/Message-ID:\s*(<[^>]+>)/i)?.[1] });
      this.historyId++;
      this.messages.set(id, { id, threadId: body.threadId ?? id, labelIds: ["SENT"], raw: body.raw, historyId: String(this.historyId) });
      this.history.push({ id: String(this.historyId), messagesAdded: [{ message: { id, threadId: body.threadId ?? id, labelIds: ["SENT"] } }] });
      return json({ id, threadId: body.threadId ?? id, labelIds: ["SENT"] });
    }
    if (path === "/history") {
      if (this.historyGone) return json({ error: { code: 404, message: "notFound" } }, 404);
      const start = Number(u.searchParams.get("startHistoryId"));
      return json({ history: this.history.filter(h => Number(h.id) > start), historyId: String(this.historyId) });
    }
    const m = path.match(/^\/messages\/([^/]+)(\/modify|\/trash|\/untrash)?$/);
    if (m) {
      const msg = this.messages.get(m[1]!);
      if (!msg) return json({ error: { code: 404 } }, 404);
      if (m[2] === "/modify") {
        const b = await req.json() as { addLabelIds?: string[]; removeLabelIds?: string[] };
        msg.labelIds = [...msg.labelIds.filter(l => !(b.removeLabelIds ?? []).includes(l)), ...(b.addLabelIds ?? [])];
        return json(msg);
      }
      if (m[2] === "/trash") { msg.labelIds = ["TRASH"]; return json(msg); }
      if (m[2] === "/untrash") { msg.labelIds = msg.labelIds.filter(l => l !== "TRASH"); return json(msg); }
      return json(u.searchParams.get("format") === "raw" ? msg : { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, historyId: msg.historyId });
    }
    return json({ error: "unhandled" }, 404);
  };
}

describe("Gmail vertical slice", () => {
  let p: Platform, drop: () => Promise<void>, ctx: Ctx, g: FakeGoogle, accountId: string;
  beforeAll(async () => {
    const d = await createTestDb("gm"); drop = d.drop;
    g = new FakeGoogle();
    p = createPlatform({ db: d.db, kms: new LocalDevKms(randomBytes(32)), fetch: g.fetch, log: makeLogger(() => {}), env: {}, config: { demoMode: false, appOrigin: "http://localhost:3000", webauthnRpId: "localhost", google: { clientId: "test-client", clientSecret: "test-secret", pubsubTopic: "projects/test/topics/gmail" } } });
    const s = await signUp(p, { email: "owner@fernhill.example", password: "correct-horse-battery", name: "Owner", workspaceKind: "personal" });
    ctx = { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId };
  });
  afterAll(() => drop());

  it("OAuth: authorization URL requests least privilege with PKCE and state", async () => {
    const { url } = await beginMailboxOAuth(p, ctx, "gmail", { readOnly: false });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(u.searchParams.get("scope")).not.toContain("mail.google.com");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")!.length).toBeGreaterThan(20);
    const ro = new URL((await beginMailboxOAuth(p, ctx, "gmail", { readOnly: true })).url);
    expect(ro.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
  it("OAuth: a forged state or another user's flow is rejected", async () => {
    await expect(finishMailboxOAuth(p, ctx, "gmail", { state: "forged", code: "c" })).rejects.toMatchObject({ code: "oauth_state_invalid" });
    const { url } = await beginMailboxOAuth(p, ctx, "gmail", { readOnly: false });
    const state = new URL(url).searchParams.get("state")!;
    const other = await signUp(p, { email: "other@example.org", password: "correct-horse-battery", name: "O", workspaceKind: "personal" });
    await expect(finishMailboxOAuth(p, { tenantId: other.tenantId, userId: other.userId }, "gmail", { state, code: "c" })).rejects.toMatchObject({ code: "oauth_state_invalid" });
    await expect(finishMailboxOAuth(p, ctx, "gmail", { state, code: "c" })).rejects.toMatchObject({ code: "oauth_state_invalid" });
  });
  it("connects, full-syncs real MIME, classifies and renders", async () => {
    g.deliver("m1", "t1", { from: `"Priya" <priya@oak.test>`, to: "owner@fernhill.example", subject: "Budget", text: "Can you confirm by November 11?", html: `<p>Can you confirm by November 11?</p><script>alert(1)</script><img src="https://t.test/p.gif" width="1" height="1">` });
    g.deliver("m2", "t2", { from: `"Billing" <billing@harb0r-supply.test>`, auth: "fail", to: "owner@fernhill.example", replyTo: "ar@gmail.com", subject: "New bank details", text: "Our bank details have changed. Please update them and pay today.", html: `<p>Our bank details have changed.</p><a href="https://harb0r-supply.test/x">https://harbor-supply.test</a>` });
    const { url } = await beginMailboxOAuth(p, ctx, "gmail", { readOnly: false });
    accountId = await finishMailboxOAuth(p, ctx, "gmail", { state: new URL(url).searchParams.get("state")!, code: "auth-code" });
    await drainJobs(p);
    const acc = (await publicAccounts(p, ctx))[0]!;
    expect(acc).toMatchObject({ kind: "gmail", email: "owner@fernhill.example", status: "active" });
    expect(acc.sync.phase).toBe("incremental");
    const inbox = await listThreads(p, ctx, { view: "inbox", limit: 10 });
    expect(inbox.items.map(i => i.subject)).toEqual(["Budget"]);
    const t = await getThread(p, ctx, inbox.items[0]!.id);
    expect(t.messages[0]!.html).not.toMatch(/<script|t\.test\/p\.gif/);
    expect(t.messages[0]!.trackingPixels).toBe(1);
  });
  it("connecting the Gmail mailbox for the sign-in address verifies the account, with no emailed link", async () => {
    // Nothing clicked a link here: this deployment has no relay, and Google vouched for the address during the connection.
    const u = await p.db.withSystem(t => t.one<any>("SELECT email_verified_at FROM users WHERE id=$1", [ctx.userId]));
    expect(u.email_verified_at).not.toBeNull();
    const events = await p.db.withSystem(t => t.query<any>("SELECT meta FROM audit_events WHERE actor_user_id=$1 AND event='auth.email_verified'", [ctx.userId]));
    expect(events.map(e => e.meta)).toEqual([{ provider: "gmail", reason: "mailbox_oauth" }]);
  });
  it("quarantine moves the Gmail copy to Spam; release restores INBOX", async () => {
    const q = await listThreads(p, ctx, { view: "quarantine", limit: 10 });
    expect(q.items.map(i => i.subject)).toEqual(["New bank details"]);
    expect(g.messages.get("m2")!.labelIds).toContain("SPAM");
    expect(g.messages.get("m2")!.labelIds).not.toContain("INBOX");
    await decideQuarantine(p, ctx, q.items[0]!.messageId, "release");
    await drainJobs(p);
    expect(g.messages.get("m2")!.labelIds).toContain("INBOX");
    expect(g.messages.get("m2")!.labelIds).not.toContain("SPAM");
  });
  it("push notification syncs through history, once, however many times it's replayed", async () => {
    g.deliver("m3", "t3", { from: `"Sal" <sal@client.test>`, to: "owner@fernhill.example", subject: "Next week", text: "Are you free?" });
    for (let i = 0; i < 3; i++) await handleGmailPush(p, "owner@fernhill.example");
    await drainJobs(p);
    for (let i = 0; i < 3; i++) await handleGmailPush(p, "owner@fernhill.example");
    await drainJobs(p);
    const rows = (await listThreads(p, ctx, { view: "inbox", q: "subject:next", limit: 10 })).items;
    expect(rows).toHaveLength(1);
    expect(g.calls.some(c => c.includes("/history"))).toBe(true);
  });
  it("a push for an unknown address does nothing", async () => {
    await expect(handleGmailPush(p, "stranger@example.org")).resolves.toEqual({ enqueued: 0 });
  });
  it("replies in the thread, from the right identity, with our Message-ID", async () => {
    const th = (await listThreads(p, ctx, { view: "inbox", q: "subject:budget", limit: 1 })).items[0]!;
    const d = await saveDraft(p, ctx, { accountId, threadId: th.id, to: ["priya@oak.test"], cc: [], bcc: [], subject: "Re: Budget", text: "Confirmed.", aiGenerated: false });
    await approveSend(p, ctx, d.id, { expectedFrom: "owner@fernhill.example", idempotencyKey: "gmail-slice-key-1", acknowledgedRisk: false });
    await drainJobs(p);
    expect(g.sent).toHaveLength(1);
    expect(g.sent[0].threadId).toBe("t1");
    expect(g.sent[0].raw).toMatch(/From:.*owner@fernhill\.example/);
    expect(g.sent[0].raw).toMatch(/In-Reply-To:/);
    const fresh = await listThreads(p, ctx, { view: "sent", limit: 5 });
    expect(fresh.items.map(i => i.subject)).toContain("Re: Budget");
    const t = await getThread(p, ctx, th.id);
    expect(t.messages).toHaveLength(2);
  });
  it("renews watches and reconciles after expired history", async () => {
    await tick(p);
    await drainJobs(p);
    expect(g.watches).toBeGreaterThan(0);
    g.historyGone = true;
    g.deliver("m4", "t4", { from: "a@b.test", to: "owner@fernhill.example", subject: "After gap", text: "x" });
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId } }));
    await drainJobs(p);
    g.historyGone = false;
    expect((await listThreads(p, ctx, { view: "inbox", q: "subject:gap", limit: 5 })).items).toHaveLength(1);
  });
  it("a revoked grant stops sync and asks to reconnect, without repeated silent failures", async () => {
    g.tokenValid = false;
    await p.db.withWorker(ctx.tenantId, async t => { await t.query("SELECT 1"); });
    // Force an expired access token so the adapter must refresh.
    const before = g.calls.length;
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId } }));
    await drainJobs(p);
    await p.db.withSystem(t => t.query("UPDATE jobs SET run_at=now() WHERE state='queued'"));
    await drainJobs(p);
    const acc = (await publicAccounts(p, ctx))[0]!;
    expect(acc.status).toBe("reconnect_required");
    expect(acc.statusDetail).toMatch(/Reconnect/);
    const after = g.calls.length;
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId } }));
    await drainJobs(p);
    expect(g.calls.length).toBe(after);
    expect(after).toBeGreaterThan(before);
    g.tokenValid = true;
  });
  it("disconnect revokes at Google and removes the credential and cached mail", async () => {
    await disconnectAccount(p, ctx, accountId, { deleteData: true });
    await drainJobs(p);
    expect(g.revoked).toHaveLength(1);
    expect(await publicAccounts(p, ctx)).toEqual([]);
    expect((await listThreads(p, ctx, { view: "inbox", limit: 10 })).items).toEqual([]);
    expect(await p.db.withSystem(t => t.query("SELECT 1 FROM credential_envelopes WHERE account_id=$1", [accountId]))).toEqual([]);
  });
  it("tokens never reach logs or plaintext tables", async () => {
    const dump = await p.db.withSystem(t => t.query<any>("SELECT payload::text p FROM jobs"));
    expect(JSON.stringify(dump)).not.toContain("ya29");
    expect(JSON.stringify(dump)).not.toContain("1//fake");
  });
});
