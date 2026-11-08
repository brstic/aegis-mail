import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CursorExpiredError, UnsupportedOperationError, type MailAdapter, type MailChange, type SyncPage } from "@aegis/domain/mail";
import { createAdapter, type AdapterCredential } from "./index";
import { HostBlockedError, type HostGuard } from "./ssrf";

/**
 * The real adapter against a real Dovecot. Skipped unless IMAP_TEST_HOST is set. Start the server and print the
 * variables with infra/local/live-servers.sh. Nothing in here is faked except the host guard, which has to allow
 * loopback. It's defined only in this file and still pins the address and name, like the strict one.
 */
const env = process.env;
const host = env.IMAP_TEST_HOST;
const port = Number(env.IMAP_TEST_PORT);
const starttlsPort = Number(env.IMAP_TEST_STARTTLS_PORT);
const servername = env.IMAP_TEST_SERVERNAME ?? "localhost";
const password = env.IMAP_TEST_PASS ?? "";
const user = "imaptest@example.net";
const ca = env.IMAP_TEST_CA_FILE ? readFileSync(env.IMAP_TEST_CA_FILE) : undefined;

const loopbackGuard = (name = servername): HostGuard => ({
  checkHost: async (_h, p) => ({ ip: host as string, family: 4, port: p, hostname: name, servername: name }),
});

const cred = (over: Partial<Extract<AdapterCredential, { kind: "password" }>> = {}): AdapterCredential => ({
  kind: "password", username: user, password, imap: { host: servername, port, security: "tls" }, ...over,
});
const adapter = (over: { cred?: AdapterCredential; readOnly?: boolean; guard?: HostGuard; ca?: Buffer | null } = {}): MailAdapter =>
  createAdapter("imap", { email: user, readOnly: over.readOnly ?? false }, over.cred ?? cred(), {
    hostGuard: over.guard ?? loopbackGuard(),
    ...(over.ca === null ? {} : { ca: over.ca ?? ca }),
  });

/** A second client, standing in for the user's phone. Everything it does goes through Dovecot too. */
async function other<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: host as string, port, secure: true, servername, auth: { user, pass: password }, tls: { ca }, logger: false, disableAutoIdle: true });
  c.on("error", () => undefined);
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}

let serial = 0;
const message = (subject: string, body = "Hello there.\r\n", extra = "") => {
  const id = `<live-${Date.now()}-${++serial}@example.net>`;
  return { id, raw: Buffer.from(`From: Pat <pat@example.org>\r\nTo: ${user}\r\nSubject: ${subject}\r\nMessage-ID: ${id}\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n${extra}\r\n${body}`) };
};
async function append(folder: string, subject: string, opts: { flags?: string[]; date?: Date; body?: string } = {}) {
  const m = message(subject, opts.body);
  const res = await other(c => c.append(folder, m.raw, opts.flags ?? [], opts.date ?? new Date()));
  if (!res) throw new Error("APPEND refused");
  return { ...m, uid: res.uid as number, uidValidity: String(res.uidValidity) };
}
const flagsOf = (folder: string, uid: number) => other(async c => {
  await c.mailboxOpen(folder);
  const row = await c.fetchOne(String(uid), { flags: true }, { uid: true });
  return row ? [...(row.flags ?? [])] : null;
});
const uidsIn = (folder: string) => other(async c => { await c.mailboxOpen(folder); return (await c.search({ all: true }, { uid: true })) || []; });

async function fullSyncAll(a: MailAdapter, pageSize = 25, windowDays = 30) {
  const changes: MailChange[] = [];
  const pages: SyncPage[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await a.fullSync({ windowDays, pageSize, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    changes.push(...page.changes);
    cursor = page.cursor;
    if (!page.hasMore) return { changes, cursor: cursor as string, pages };
  }
  throw new Error("full sync didn't finish");
}
async function incrementalAll(a: MailAdapter, cursor: string, pageSize = 25) {
  const changes: MailChange[] = [];
  let next = cursor;
  let pages = 0;
  for (; pages < 50; pages++) {
    const page = await a.incrementalSync(next, { pageSize });
    changes.push(...page.changes);
    next = page.cursor;
    if (!page.hasMore) return { changes, cursor: next, pages: pages + 1 };
  }
  throw new Error("incremental sync didn't finish");
}
const upserts = (c: MailChange[]) => c.filter((x): x is Extract<MailChange, { type: "upsert" }> => x.type === "upsert");
const id = (m: { uid: number; uidValidity: string }, folder = "INBOX") => `${folder}:${m.uidValidity}:${m.uid}`;

const ROLE_FOLDERS = ["INBOX", "Drafts", "Sent", "Junk", "Trash", "Archive", "All Mail"];

describe.skipIf(!host)("IMAP adapter against real Dovecot", () => {
  beforeEach(async () => {
    await other(async c => {
      for (const box of await c.list()) {
        if (!ROLE_FOLDERS.includes(box.path)) { await c.mailboxDelete(box.path).catch(() => undefined); continue; }
        const lock = await c.getMailboxLock(box.path);
        try { await c.messageDelete("1:*"); } catch { /* empty */ } finally { lock.release(); }
      }
    });
  });

  describe("connecting", () => {
    it("connects over direct TLS, verifying the certificate, and counts syncable folders", async () => {
      expect(await adapter().testConnection()).toEqual({ ok: true, folders: 6 });
    });
    it("connects over STARTTLS, which the server requires before login", async () => {
      const a = adapter({ cred: cred({ imap: { host: servername, port: starttlsPort, security: "starttls" } }) });
      expect((await a.testConnection()).ok).toBe(true);
      await append("INBOX", "over starttls");
      expect((await fullSyncAll(a)).changes.length).toBe(1);
    });
    it("reports capabilities with no push: new mail arrives by polling", async () => {
      expect(adapter().capabilities.pushNotifications).toBe(false);
    });
    it("the real host guard refuses this server, since it's on loopback", async () => {
      const a = createAdapter("imap", { email: user, readOnly: false }, cred({ imap: { host: "127.0.0.1", port: 993, security: "tls" } }), { ...(ca ? { ca } : {}) });
      expect(await a.testConnection()).toMatchObject({ ok: false, problem: "host_blocked" });
      await expect(a.listFolders()).rejects.toBeInstanceOf(HostBlockedError);
    });
  });

  describe("TLS verification", () => {
    it("refuses a certificate that doesn't chain to a trusted root", async () => {
      expect(await adapter({ ca: null }).testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
    });
    it("refuses a trusted certificate for a different name", async () => {
      const a = adapter({ guard: loopbackGuard("mail.example.net") });
      expect(await a.testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
    });
    it("refuses over STARTTLS too, before sending the password", async () => {
      const a = adapter({ ca: null, cred: cred({ imap: { host: servername, port: starttlsPort, security: "starttls" } }) });
      expect(await a.testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
    });
    it("doesn't fall back to plaintext when direct TLS meets a plaintext port", async () => {
      const a = adapter({ cred: cred({ imap: { host: servername, port: starttlsPort, security: "tls" } }) });
      const r = await a.testConnection();
      expect(r.ok).toBe(false);
      expect(["tls_failed", "protocol_error", "timeout"]).toContain((r as { problem: string }).problem);
    });
  });

  describe("wrong credentials", () => {
    it("a wrong password is auth_failed and quotes nothing from the server", async () => {
      const r = await adapter({ cred: cred({ password: "not-the-password" }) }).testConnection();
      expect(r).toMatchObject({ ok: false, problem: "auth_failed", detail: "The server rejected the username or password." });
    });
    it("an unknown user is auth_failed", async () => {
      expect(await adapter({ cred: cred({ username: "nobody@example.net" }) }).testConnection()).toMatchObject({ ok: false, problem: "auth_failed" });
    });
    it("sync throws a classified error that doesn't echo the password", async () => {
      const err = await adapter({ cred: cred({ password: "SENTINEL-not-the-password" }) }).fullSync({ windowDays: 30, pageSize: 5 }).catch(e => e);
      expect(err).toMatchObject({ name: "ImapError", problem: "auth_failed" });
      expect(String(err.message)).not.toContain("SENTINEL");
    });
  });

  describe("folders", () => {
    it("maps special-use flags to roles and leaves out \\All", async () => {
      const folders = await adapter().listFolders();
      const roles = Object.fromEntries(folders.map(f => [f.remoteId, f.role]));
      expect(roles).toEqual({ INBOX: "inbox", Drafts: "drafts", Sent: "sent", Junk: "spam", Trash: "trash", Archive: "archive" });
    });
    it("custom and nested folders are custom, and a role-named folder with no flag is mapped by name", async () => {
      await other(async c => { await c.mailboxCreate("Projects"); await c.mailboxCreate("Projects/2026"); await c.mailboxCreate("Spam"); });
      const roles = Object.fromEntries((await adapter().listFolders()).map(f => [f.remoteId, f.role]));
      expect(roles).toMatchObject({ Projects: "custom", "Projects/2026": "custom", Spam: "spam", Junk: "spam" });
    });
    it("moving to spam prefers the flagged folder over a same-role folder matched by name", async () => {
      await other(c => c.mailboxCreate("Spam"));
      const m = await append("INBOX", "two spam folders");
      await adapter().applyChange(id(m), { moveToRole: "spam" });
      expect((await uidsIn("Junk")).length).toBe(1);
      expect((await uidsIn("Spam")).length).toBe(0);
    });
    it("handles names needing modified UTF-7, a colon and spaces, through sync and fetch", async () => {
      const names = ["Déjà vu", "Colon: here", "日本語", "With Space"];
      await other(async c => { for (const n of names) await c.mailboxCreate(n); });
      const placed = await Promise.all(names.map(async n => ({ n, m: await append(n, `in ${n}`) })));
      const { changes } = await fullSyncAll(adapter());
      const a = adapter();
      for (const { n, m } of placed) {
        const remoteId = id(m, n);
        expect(upserts(changes).map(c => c.remoteId)).toContain(remoteId);
        expect(Buffer.from(await a.fetchRaw(remoteId)).equals(m.raw)).toBe(true);
      }
    });
  });

  describe("full sync", () => {
    it("returns every message byte for byte, with role, flags and date, and doesn't mark anything read", async () => {
      const when = new Date(Date.now() - 3 * 86_400_000);
      when.setMilliseconds(0);
      const a1 = await append("INBOX", "first", { date: when });
      const a2 = await append("INBOX", "seen and starred", { flags: ["\\Seen", "\\Flagged"] });
      const a3 = await append("Sent", "from me", { flags: ["\\Seen"] });
      const a4 = await append("Junk", "junk");
      await other(c => c.mailboxCreate("Projects"));
      const a5 = await append("Projects", "custom");
      const { changes, cursor } = await fullSyncAll(adapter());
      const byId = new Map(upserts(changes).map(c => [c.remoteId, c]));
      expect(byId.size).toBe(5);
      expect(changes.length).toBe(5);
      const first = byId.get(id(a1));
      expect(first?.state).toMatchObject({ folderRole: "inbox", isRead: false, isStarred: false });
      expect(first?.internalDate).toBe(when.toISOString());
      expect(Buffer.from(first?.raw as Uint8Array).equals(a1.raw)).toBe(true);
      expect(byId.get(id(a2))?.state).toMatchObject({ isRead: true, isStarred: true });
      expect(byId.get(id(a3, "Sent"))?.state).toMatchObject({ folderRole: "sent", isRead: true });
      expect(byId.get(id(a4, "Junk"))?.state.folderRole).toBe("spam");
      expect(byId.get(id(a5, "Projects"))?.state.folderRole).toBe("custom");
      expect(await flagsOf("INBOX", a1.uid)).not.toContain("\\Seen");
      expect(Object.keys(JSON.parse(cursor)).sort()).toEqual(["Archive", "Drafts", "INBOX", "Junk", "Projects", "Sent", "Trash"]);
    });
    it("excludes mail older than the window, and \\All", async () => {
      await append("INBOX", "ancient", { date: new Date(Date.now() - 90 * 86_400_000) });
      const recent = await append("INBOX", "recent");
      const view = await append("All Mail", "in the all-mail view");
      const ids = upserts((await fullSyncAll(adapter())).changes).map(c => c.remoteId);
      expect(ids).toEqual([id(recent)]);
      expect(ids).not.toContain(id(view, "All Mail"));
    });
    it("pages through a folder without loss or duplicates", async () => {
      const placed = [];
      for (let i = 0; i < 7; i++) placed.push(await append("INBOX", `page ${i}`));
      const { changes, pages } = await fullSyncAll(adapter(), 3);
      expect(pages.length).toBeGreaterThanOrEqual(3);
      expect(upserts(changes).map(c => c.remoteId).sort()).toEqual(placed.map(m => id(m)).sort());
    });
    it("a large message with bytes that aren't valid UTF-8 survives intact", async () => {
      const body = Buffer.concat([Buffer.from("From: a@example.org\r\nSubject: big\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: 8bit\r\n\r\n"), Buffer.alloc(6 * 1024 * 1024, Buffer.from([0xff, 0xfe, 0x41, 0x0d, 0x0a]))]);
      const res = await other(c => c.append("INBOX", body, [], new Date()));
      const { changes } = await fullSyncAll(adapter());
      expect(upserts(changes)[0]?.remoteId).toBe(`INBOX:${res && res.uidValidity}:${res && res.uid}`);
      expect(Buffer.from(upserts(changes)[0]?.raw as Uint8Array).equals(body)).toBe(true);
    }, 60_000);
    it("mail arriving between pages is picked up by the next incremental sync, once", async () => {
      for (let i = 0; i < 4; i++) await append("INBOX", `before ${i}`);
      const a = adapter();
      const p1 = await a.fullSync({ windowDays: 30, pageSize: 2 });
      expect(p1.hasMore).toBe(true);
      const mid = await append("INBOX", "arrived mid sync");
      let cursor = p1.cursor;
      const seen = [...p1.changes];
      for (let i = 0; i < 10; i++) {
        const p = await a.fullSync({ windowDays: 30, pageSize: 2, cursor });
        seen.push(...p.changes);
        cursor = p.cursor;
        if (!p.hasMore) break;
      }
      expect(upserts(seen).map(c => c.remoteId)).not.toContain(id(mid));
      const inc = await incrementalAll(a, cursor);
      expect(upserts(inc.changes).map(c => c.remoteId)).toEqual([id(mid)]);
    });
  });

  describe("incremental sync and polling", () => {
    it("reports nothing when nothing changed", async () => {
      await append("INBOX", "quiet");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      expect((await incrementalAll(a, cursor)).changes).toEqual([]);
    });
    it("polling with no IDLE finds new mail on each pass, exactly once", async () => {
      const a = adapter();
      let { cursor } = await fullSyncAll(a);
      for (let i = 0; i < 3; i++) {
        const m = await append("INBOX", `poll ${i}`);
        const pass = await incrementalAll(a, cursor);
        expect(pass.changes.map(c => c.remoteId)).toEqual([id(m)]);
        cursor = pass.cursor;
        expect((await incrementalAll(a, cursor)).changes).toEqual([]);
      }
    });
    it("pages through a burst of new mail", async () => {
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      const placed = [];
      for (let i = 0; i < 5; i++) placed.push(await append("INBOX", `burst ${i}`));
      const inc = await incrementalAll(a, cursor, 2);
      expect(inc.pages).toBeGreaterThan(1);
      expect(upserts(inc.changes).map(c => c.remoteId)).toEqual(placed.map(m => id(m)));
    });
    it("sees flags changed by another client, and only those", async () => {
      const m1 = await append("INBOX", "will be read");
      const m2 = await append("INBOX", "will be starred");
      const m3 = await append("INBOX", "untouched");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await other(async c => {
        await c.mailboxOpen("INBOX");
        await c.messageFlagsAdd(String(m1.uid), ["\\Seen"], { uid: true });
        await c.messageFlagsAdd(String(m2.uid), ["\\Flagged"], { uid: true });
      });
      const first = await incrementalAll(a, cursor);
      const states = Object.fromEntries(first.changes.map(c => [c.remoteId, c.type === "state" ? c.state : null]));
      expect(states).toEqual({ [id(m1)]: { isRead: true, isStarred: false }, [id(m2)]: { isRead: false, isStarred: true } });
      expect(Object.keys(states)).not.toContain(id(m3));
      await other(async c => { await c.mailboxOpen("INBOX"); await c.messageFlagsRemove(String(m1.uid), ["\\Seen"], { uid: true }); });
      const second = await incrementalAll(a, first.cursor);
      expect(second.changes).toEqual([{ type: "state", remoteId: id(m1), state: { isRead: false, isStarred: false } }]);
      expect((await incrementalAll(a, second.cursor)).changes).toEqual([]);
    });
    it("a flag change on mail older than the window comes through, tolerated by the caller", async () => {
      const old = await append("INBOX", "old", { date: new Date(Date.now() - 90 * 86_400_000) });
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await other(async c => { await c.mailboxOpen("INBOX"); await c.messageFlagsAdd(String(old.uid), ["\\Seen"], { uid: true }); });
      const inc = await incrementalAll(a, cursor);
      expect(inc.changes).toEqual([{ type: "state", remoteId: id(old), state: { isRead: true, isStarred: false } }]);
    });
    it("sees an expunge by another client as a delete", async () => {
      const keep = await append("INBOX", "keep");
      const gone = await append("INBOX", "gone");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await other(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete(String(gone.uid), { uid: true }); });
      const inc = await incrementalAll(a, cursor);
      expect(inc.changes).toEqual([{ type: "delete", remoteId: id(gone) }]);
      expect(JSON.parse(inc.cursor).INBOX.known.map((k: number[]) => k[0])).toEqual([keep.uid]);
    });
    it("expunging the newest message doesn't report it again or reuse its UID", async () => {
      const a = adapter();
      const keep = await append("INBOX", "keep");
      const newest = await append("INBOX", "newest");
      const { cursor } = await fullSyncAll(a);
      await other(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete(String(newest.uid), { uid: true }); });
      const inc = await incrementalAll(a, cursor);
      expect(inc.changes).toEqual([{ type: "delete", remoteId: id(newest) }]);
      expect((await incrementalAll(a, inc.cursor)).changes).toEqual([]);
      const next = await append("INBOX", "after");
      expect(next.uid).toBeGreaterThan(newest.uid);
      expect((await incrementalAll(a, inc.cursor)).changes.map(c => c.remoteId)).toEqual([id(next)]);
      expect(keep.uid).toBeLessThan(next.uid);
    });
    it("expunging everything in a folder reports every delete", async () => {
      const a = adapter();
      const m1 = await append("INBOX", "one");
      const m2 = await append("INBOX", "two");
      const { cursor } = await fullSyncAll(a);
      await other(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete("1:*"); });
      const { changes } = await incrementalAll(a, cursor);
      expect(changes.map(c => c.remoteId).sort()).toEqual([id(m1), id(m2)].sort());
      expect(changes.every(c => c.type === "delete")).toBe(true);
    });
    it("a new folder is synced from its first message", async () => {
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await other(c => c.mailboxCreate("Later"));
      const m = await append("Later", "filed by a rule");
      expect(upserts((await incrementalAll(a, cursor)).changes).map(c => c.remoteId)).toEqual([id(m, "Later")]);
    });
    it("a deleted folder takes its tracked messages with it", async () => {
      await other(c => c.mailboxCreate("Doomed"));
      const m = await append("Doomed", "going away");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await other(c => c.mailboxDelete("Doomed"));
      const inc = await incrementalAll(a, cursor);
      expect(inc.changes).toEqual([{ type: "delete", remoteId: id(m, "Doomed") }]);
      expect(Object.keys(JSON.parse(inc.cursor))).not.toContain("Doomed");
    });
  });

  describe("writing back", () => {
    it("sets and clears read and star on the server", async () => {
      const m = await append("INBOX", "flags");
      const a = adapter();
      await a.applyChange(id(m), { isRead: true, isStarred: true });
      expect(await flagsOf("INBOX", m.uid)).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));
      await a.applyChange(id(m), { isRead: false, isStarred: false });
      const after = await flagsOf("INBOX", m.uid);
      expect(after).not.toContain("\\Seen");
      expect(after).not.toContain("\\Flagged");
    });
    it("our own flag change is seen by the next sync, and doesn't loop", async () => {
      const m = await append("INBOX", "self");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await a.applyChange(id(m), { isRead: true });
      const inc = await incrementalAll(a, cursor);
      expect(inc.changes).toEqual([{ type: "state", remoteId: id(m), state: { isRead: true, isStarred: false } }]);
      expect((await incrementalAll(a, inc.cursor)).changes).toEqual([]);
    });
    it.each([["archive", "Archive"], ["trash", "Trash"], ["spam", "Junk"], ["inbox", "INBOX"]] as const)("moves to the %s folder on the server", async (role, folder) => {
      const from = role === "inbox" ? "Archive" : "INBOX";
      const m = await append(from, `to ${role}`);
      await adapter().applyChange(id(m, from), { moveToRole: role });
      expect(await uidsIn(from)).toEqual([]);
      expect((await uidsIn(folder)).length).toBe(1);
    });
    it("a move to the folder it's already in does nothing", async () => {
      const m = await append("Archive", "stay");
      await adapter().applyChange(id(m, "Archive"), { moveToRole: "archive" });
      expect(await uidsIn("Archive")).toEqual([m.uid]);
    });
    it("after a move, sync reports the old id deleted and a new id in the new folder", async () => {
      const m = await append("INBOX", "moving");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await a.applyChange(id(m), { moveToRole: "archive" });
      const { changes } = await incrementalAll(a, cursor);
      expect(changes.filter(c => c.type === "delete").map(c => c.remoteId)).toEqual([id(m)]);
      const moved = upserts(changes);
      expect(moved.length).toBe(1);
      expect(moved[0]?.remoteId).toMatch(/^Archive:\d+:\d+$/);
      expect(moved[0]?.state.folderRole).toBe("archive");
      expect(Buffer.from(moved[0]?.raw as Uint8Array).equals(m.raw)).toBe(true);
    });
    it("replaying a move is a no-op, so a job retried after a crash can't fail or duplicate", async () => {
      const m = await append("INBOX", "moved twice");
      const a = adapter();
      await a.applyChange(id(m), { moveToRole: "archive" });
      await a.applyChange(id(m), { moveToRole: "archive" });
      expect((await uidsIn("Archive")).length).toBe(1);
      expect(await uidsIn("INBOX")).toEqual([]);
    });
    it("refuses labels and read-only writes without touching the server", async () => {
      const m = await append("INBOX", "ro");
      await expect(adapter().applyChange(id(m), { addLabels: ["x"] })).rejects.toBeInstanceOf(UnsupportedOperationError);
      await expect(adapter({ readOnly: true }).applyChange(id(m), { isRead: true })).rejects.toBeInstanceOf(UnsupportedOperationError);
      expect(await flagsOf("INBOX", m.uid)).not.toContain("\\Seen");
    });
    it("fetchRaw on an expunged message is a classified failure", async () => {
      const m = await append("INBOX", "fetch gone");
      await other(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete(String(m.uid), { uid: true }); });
      await expect(adapter().fetchRaw(id(m))).rejects.toMatchObject({ name: "ImapError" });
    });
  });

  describe("UIDVALIDITY", () => {
    it("a recreated folder expires the cursor, refuses stale writes, and a fresh full sync recovers", async () => {
      await other(c => c.mailboxCreate("Volatile"));
      const m = await append("Volatile", "old generation");
      const a = adapter();
      const { cursor } = await fullSyncAll(a);
      await other(async c => { await c.mailboxDelete("Volatile"); await c.mailboxCreate("Volatile"); });
      const next = await append("Volatile", "new generation");
      expect(next.uidValidity).not.toBe(m.uidValidity);
      await expect(a.incrementalSync(cursor, { pageSize: 25 })).rejects.toBeInstanceOf(CursorExpiredError);
      // The same UID could now name a different message, so nothing may act on the old id.
      await expect(a.fetchRaw(id(m, "Volatile"))).rejects.toBeInstanceOf(CursorExpiredError);
      await expect(a.applyChange(id(m, "Volatile"), { isRead: true })).rejects.toBeInstanceOf(CursorExpiredError);
      expect(await flagsOf("Volatile", next.uid)).not.toContain("\\Seen");
      const { changes } = await fullSyncAll(a);
      expect(upserts(changes).map(c => c.remoteId)).toEqual([id(next, "Volatile")]);
    });
    it("a corrupt cursor expires rather than resyncing wrongly", async () => {
      await expect(adapter().incrementalSync("{not json", { pageSize: 5 })).rejects.toBeInstanceOf(CursorExpiredError);
    });
  });

  describe("sent mail reconciliation", () => {
    it("finds a sent message by Message-ID, and only that one", async () => {
      const m = await append("Sent", "reconcile me", { flags: ["\\Seen"] });
      await append("INBOX", "decoy");
      const a = adapter();
      expect(await a.findSentByMessageId(m.id)).toEqual({ remoteId: id(m, "Sent") });
      expect(await a.findSentByMessageId("<never-sent@example.net>")).toBeNull();
    });
  });

  afterAll(async () => { if (host) await other(async c => { for (const box of await c.list()) if (!ROLE_FOLDERS.includes(box.path)) await c.mailboxDelete(box.path).catch(() => undefined); }); });
});

