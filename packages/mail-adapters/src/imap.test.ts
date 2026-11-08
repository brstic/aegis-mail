import hoodiecrow from "hoodiecrow-imap";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorExpiredError, UnsupportedOperationError, CAPABILITIES, type OutboundMessage } from "@aegis/domain/mail";
import {
  HostBlockedError, ImapError, MAX_TRACKED_UIDS, classifyConnectionError, connectImap, createAdapter, createHostGuard, createImapAdapter,
  encodeImapRemoteId, fullSyncFolder, imapFlowPort, imapFolderRole, incrementalSyncFolder, parseImapCursor, parseImapRemoteId, reconcileFolder,
  type ImapFetched, type ImapFlagRow, type ImapMailbox, type ImapMailboxStatus, type ImapPort,
} from "./index";
import { TEST_HOST, loopbackGuard, testCert } from "./test-tls";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const nowMs = NOW;
const flags = { seen: ["\\Seen"], none: [], starred: ["\\Flagged"], both: ["\\Seen", "\\Flagged"] };

interface FakeMessage { uid: number; flags: string[]; modseq?: number; date?: string }
interface FakeBox { uidValidity: string; uidNext: number; modseq?: number; messages: FakeMessage[] }

/** An in-memory ImapPort with real UID semantics, including the "n:*" quirk. Records every call. */
class FakePort implements ImapPort {
  calls: string[] = [];
  current: string | undefined;
  openedReadOnly: boolean[] = [];
  closed = 0;
  constructor(public boxes: Record<string, FakeBox>, public mailboxes: ImapMailbox[] = Object.keys(boxes).map((p) => ({ path: p, name: p, flags: [] }))) {}
  get box(): FakeBox { return this.boxes[this.current!]!; }
  #range(range: string): (uid: number) => boolean {
    const [a, b] = range.split(":");
    const lo = Number(a);
    const hi = b === "*" ? Infinity : Number(b ?? a);
    const top = Math.max(0, ...this.box.messages.map((m) => m.uid));
    // RFC 3501: "n:*" includes the highest UID even when n is above it.
    return (uid) => (uid >= lo && uid <= hi) || (b === "*" && uid === top);
  }
  async list() { this.calls.push("list"); return this.mailboxes; }
  async open(path: string, { readOnly }: { readOnly: boolean }): Promise<ImapMailboxStatus> {
    this.calls.push(`open ${path}`);
    this.openedReadOnly.push(readOnly);
    this.current = path;
    const b = this.box;
    return { uidValidity: b.uidValidity, uidNext: b.uidNext, ...(b.modseq !== undefined ? { highestModseq: String(b.modseq) } : {}) };
  }
  async searchUids({ since, uidRange }: { since?: Date; uidRange?: string }) {
    this.calls.push(`search ${uidRange ?? ""}`);
    const inRange = uidRange ? this.#range(uidRange) : () => true;
    return this.box.messages
      .filter((m) => inRange(m.uid) && (!since || Date.parse(m.date ?? "2026-11-05T00:00:00Z") >= since.getTime()))
      .map((m) => m.uid);
  }
  async fetchFlags(uidRange: string, changedSince?: string): Promise<ImapFlagRow[]> {
    this.calls.push(`flags ${uidRange}${changedSince ? ` since ${changedSince}` : ""}`);
    const inRange = this.#range(uidRange);
    return this.box.messages
      .filter((m) => inRange(m.uid) && (!changedSince || (m.modseq ?? 0) > Number(changedSince)))
      .map((m) => ({ uid: m.uid, flags: m.flags }));
  }
  async fetchMessages(uids: number[]): Promise<ImapFetched[]> {
    this.calls.push(`fetch ${uids.join(",")}`);
    return this.box.messages.filter((m) => uids.includes(m.uid)).map((m) => ({
      uid: m.uid, flags: m.flags, internalDate: new Date(m.date ?? "2026-11-05T00:00:00Z"), raw: new TextEncoder().encode(`raw ${m.uid}`),
    }));
  }
  async findByMessageId(id: string) { this.calls.push(`find ${id}`); return this.box.messages.length ? [this.box.messages[0]!.uid] : []; }
  async addFlags(uid: number, f: string[]) { this.calls.push(`add ${uid} ${f}`); }
  async removeFlags(uid: number, f: string[]) { this.calls.push(`remove ${uid} ${f}`); }
  async move(uid: number, dest: string) { this.calls.push(`move ${uid} ${dest}`); }
  async close() { this.closed++; }
}

const box = (over: Partial<ImapMailbox> = {}): ImapMailbox => ({ path: "INBOX", name: "INBOX", flags: [], ...over });
const since = new Date(NOW - 30 * 86_400_000);

function imapAdapter(port: ImapPort, over: { readOnly?: boolean; smtp?: boolean } = {}) {
  const connectPort = vi.fn(async () => port);
  const a = createImapAdapter({
    account: { email: "me@example.com", readOnly: over.readOnly ?? false },
    username: "me@example.com",
    password: "pw-SENTINEL",
    imap: { host: "imap.example.com", port: 993, security: "tls" },
    ...(over.smtp ? { smtp: { host: "smtp.example.com", port: 587, security: "starttls" as const } } : {}),
    now: () => NOW,
    connectPort,
  });
  return { a, connectPort };
}

describe("remote ids", () => {
  it("round trips, including folder paths containing colons", () => {
    expect(encodeImapRemoteId("INBOX", "77", 5)).toBe("INBOX:77:5");
    expect(parseImapRemoteId("INBOX:77:5")).toEqual({ folder: "INBOX", uidValidity: "77", uid: 5 });
    expect(parseImapRemoteId("Archive:2026:Q1:77:5")).toEqual({ folder: "Archive:2026:Q1", uidValidity: "77", uid: 5 });
    expect(() => parseImapRemoteId("nope")).toThrow(TypeError);
  });
});

describe("folder roles", () => {
  it.each([
    [{ path: "INBOX", name: "INBOX" }, "inbox"], [{ path: "inbox", name: "inbox" }, "inbox"],
    [{ path: "S", name: "S", specialUse: "\\Sent" }, "sent"], [{ path: "D", name: "D", specialUse: "\\Drafts" }, "drafts"],
    [{ path: "A", name: "A", specialUse: "\\Archive" }, "archive"], [{ path: "J", name: "J", specialUse: "\\Junk" }, "spam"], [{ path: "T", name: "T", specialUse: "\\Trash" }, "trash"],
    [{ path: "Sent Messages", name: "Sent Messages" }, "sent"], [{ path: "Sent Items", name: "Sent Items" }, "sent"], [{ path: "Junk E-mail", name: "Junk E-mail" }, "spam"],
    [{ path: "Bulk Mail", name: "Bulk Mail" }, "spam"], [{ path: "Deleted Messages", name: "Deleted Messages" }, "trash"], [{ path: "INBOX/Archive", name: "Archive" }, "archive"],
    [{ path: "Receipts", name: "Receipts" }, "custom"],
  ] as const)("%j is %s", (b, role) => {
    expect(imapFolderRole(b)).toBe(role);
  });
});

describe("reconcileFolder", () => {
  const base = { folder: "INBOX", uidValidity: "7" };

  it("reports tracked UIDs that are gone as deletes", () => {
    const { changes, known } = reconcileFolder({ ...base, known: [[1, 0], [2, 0], [3, 0]], presentUids: [1, 3], flagRows: [] });
    expect(changes).toEqual([{ type: "delete", remoteId: "INBOX:7:2" }]);
    expect(known).toEqual([[1, 0], [3, 0]]);
  });

  it("reports only real flag differences", () => {
    const { changes, known } = reconcileFolder({
      ...base, known: [[1, 0], [2, 1], [3, 3]], presentUids: [1, 2, 3],
      flagRows: [{ uid: 1, flags: flags.seen }, { uid: 2, flags: flags.seen }, { uid: 3, flags: flags.none }],
    });
    expect(changes).toEqual([
      { type: "state", remoteId: "INBOX:7:1", state: { isRead: true, isStarred: false } },
      { type: "state", remoteId: "INBOX:7:3", state: { isRead: false, isStarred: false } },
    ]);
    expect(known).toEqual([[1, 1], [2, 1], [3, 0]]);
  });

  it("is case-insensitive about flags and ignores ones it doesn't map", () => {
    const { changes } = reconcileFolder({ ...base, known: [[1, 1]], presentUids: [1], flagRows: [{ uid: 1, flags: ["\\SEEN", "$Junk"] }] });
    expect(changes).toEqual([]);
  });

  it("doesn't report a state change for a UID that was also expunged", () => {
    const { changes } = reconcileFolder({ ...base, known: [[1, 0]], presentUids: [], flagRows: [{ uid: 1, flags: flags.seen }] });
    expect(changes).toEqual([{ type: "delete", remoteId: "INBOX:7:1" }]);
  });

  it("ignores untracked rows unless told they are CONDSTORE results", () => {
    const row = { uid: 9, flags: flags.seen };
    expect(reconcileFolder({ ...base, known: [], presentUids: [], flagRows: [row] }).changes).toEqual([]);
    expect(reconcileFolder({ ...base, known: [], presentUids: [], flagRows: [row], reportUntracked: true }).changes)
      .toEqual([{ type: "state", remoteId: "INBOX:7:9", state: { isRead: true, isStarred: false } }]);
  });

  it("keeps only the newest UIDs when over the bound", () => {
    const known = Array.from({ length: 10 }, (_, i) => [i + 1, 0] as [number, number]);
    const result = reconcileFolder({ ...base, known, presentUids: known.map(([u]) => u), flagRows: [], maxTracked: 3 });
    expect(result.known.map(([u]) => u)).toEqual([8, 9, 10]);
    expect(MAX_TRACKED_UIDS).toBeGreaterThan(0);
  });
});

describe("fullSyncFolder", () => {
  const port = () => new FakePort({ INBOX: { uidValidity: "7", uidNext: 6, modseq: 50, messages: [
    { uid: 1, flags: flags.seen }, { uid: 2, flags: flags.none }, { uid: 3, flags: flags.starred },
    { uid: 4, flags: flags.none, date: "2020-01-01T00:00:00Z" }, { uid: 5, flags: flags.both },
  ] } });

  it("pages through the window and tracks flags, skipping what SINCE excludes", async () => {
    const p = port();
    const first = await fullSyncFolder(p, box(), undefined, { since, budget: 2, nowMs });
    expect(first.changes.map((c) => c.remoteId)).toEqual(["INBOX:7:1", "INBOX:7:2"]);
    expect(first.more).toBe(true);
    expect(first.cursor).toMatchObject({ uidValidity: "7", uidNext: 6, modseq: "50", fullAfter: 2, known: [[1, 1], [2, 0]] });
    expect(p.openedReadOnly).toEqual([true]);

    const second = await fullSyncFolder(p, box(), first.cursor, { since, budget: 10, nowMs });
    expect(second.changes.map((c) => c.remoteId)).toEqual(["INBOX:7:3", "INBOX:7:5"]);
    expect(second.more).toBe(false);
    expect(second.cursor.fullAfter).toBeUndefined();
    expect(second.cursor.known).toEqual([[1, 1], [2, 0], [3, 2], [5, 3]]);
    expect(second.changes[0]).toMatchObject({ type: "upsert", state: { folderRole: "inbox", labels: [], isRead: false, isStarred: true } });
  });

  it("leaves UIDs past the snapshot to incremental sync", async () => {
    const p = port();
    const first = await fullSyncFolder(p, box(), undefined, { since, budget: 1, nowMs });
    p.boxes.INBOX!.messages.push({ uid: 6, flags: flags.none });
    p.boxes.INBOX!.uidNext = 7;
    const rest = await fullSyncFolder(p, box(), first.cursor, { since, budget: 100, nowMs });
    expect(rest.changes.map((c) => c.remoteId)).not.toContain("INBOX:7:6");
    expect(rest.cursor.uidNext).toBe(6);
    const next = await incrementalSyncFolder(p, box(), rest.cursor, { budget: 10, nowMs });
    expect(next.changes.filter((c) => c.type === "upsert").map((c) => c.remoteId)).toEqual(["INBOX:7:6"]);
  });

  it("detects UIDVALIDITY changing mid-sync", async () => {
    const p = port();
    const first = await fullSyncFolder(p, box(), undefined, { since, budget: 1, nowMs });
    p.boxes.INBOX!.uidValidity = "8";
    await expect(fullSyncFolder(p, box(), first.cursor, { since, budget: 1, nowMs })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("handles an empty folder", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 1, messages: [] } });
    const result = await fullSyncFolder(p, box(), undefined, { since, budget: 5, nowMs });
    expect(result).toMatchObject({ changes: [], more: false, cursor: { uidValidity: "7", uidNext: 1, known: [] } });
  });
});

describe("incrementalSyncFolder", () => {
  const cursor = { uidValidity: "7", uidNext: 4, known: [[1, 0], [2, 0], [3, 1]] as Array<[number, number]> };
  const messages = (): FakeMessage[] => [{ uid: 1, flags: flags.none }, { uid: 2, flags: flags.none }, { uid: 3, flags: flags.seen }];

  it("fails with CursorExpiredError when UIDVALIDITY changed, before reading anything", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "8", uidNext: 4, messages: messages() } });
    await expect(incrementalSyncFolder(p, box(), cursor, { budget: 10, nowMs })).rejects.toBeInstanceOf(CursorExpiredError);
    expect(p.calls).toEqual(["open INBOX"]);
  });

  it("fetches new UIDs from uidNext", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 6, messages: [...messages(), { uid: 4, flags: flags.none }, { uid: 5, flags: flags.seen }] } });
    const result = await incrementalSyncFolder(p, box(), cursor, { budget: 10, nowMs });
    expect(result.changes.map((c) => [c.type, c.remoteId])).toEqual([["upsert", "INBOX:7:4"], ["upsert", "INBOX:7:5"]]);
    expect(result.cursor.uidNext).toBe(6);
    expect(result.cursor.known).toEqual([[1, 0], [2, 0], [3, 1], [4, 0], [5, 1]]);
    expect(result.more).toBe(false);
  });

  it("filters the highest message that 'n:*' returns even when it's old", async () => {
    // uidNext moved (a message came and went) so a range search runs, and the server returns UID 3 for "4:*".
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 9, messages: messages() } });
    const result = await incrementalSyncFolder(p, box(), cursor, { budget: 10, nowMs });
    expect(result.changes).toEqual([]);
    expect(p.calls).not.toContain("fetch 3");
    expect(result.cursor.uidNext).toBe(9);
  });

  it("doesn't search for new mail when uidNext hasn't moved", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, messages: messages() } });
    await incrementalSyncFolder(p, box(), cursor, { budget: 10, nowMs });
    expect(p.calls.filter((c) => c.startsWith("search 4:"))).toEqual([]);
  });

  it("pages new mail with the budget, without skipping any", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 7, messages: [...messages(), { uid: 4, flags: [] }, { uid: 5, flags: [] }, { uid: 6, flags: [] }] } });
    const first = await incrementalSyncFolder(p, box(), cursor, { budget: 2, nowMs });
    expect(first.changes.map((c) => c.remoteId)).toEqual(["INBOX:7:4", "INBOX:7:5"]);
    expect(first.more).toBe(true);
    expect(first.cursor.uidNext).toBe(6);
    const second = await incrementalSyncFolder(p, box(), first.cursor, { budget: 2, nowMs });
    expect(second.changes.map((c) => c.remoteId)).toEqual(["INBOX:7:6"]);
    expect(second.more).toBe(false);
    expect(second.cursor.uidNext).toBe(7);
  });

  it("reconciles expunges by comparing known UIDs, with a bounded range", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, messages: [{ uid: 1, flags: flags.none }, { uid: 3, flags: flags.seen }] } });
    const result = await incrementalSyncFolder(p, box(), cursor, { budget: 10, nowMs });
    expect(result.changes).toEqual([{ type: "delete", remoteId: "INBOX:7:2" }]);
    expect(p.calls).toContain("search 1:3");
    expect(result.cursor.known).toEqual([[1, 0], [3, 1]]);
  });

  it("reconciles flags without CONDSTORE by comparing known UIDs", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, messages: [{ uid: 1, flags: flags.starred }, { uid: 2, flags: flags.none }, { uid: 3, flags: flags.seen }] } });
    const result = await incrementalSyncFolder(p, box(), cursor, { budget: 10, nowMs });
    expect(result.changes).toEqual([{ type: "state", remoteId: "INBOX:7:1", state: { isRead: false, isStarred: true } }]);
    expect(p.calls).toContain("flags 1:3");
    expect(result.cursor.known).toEqual([[1, 2], [2, 0], [3, 1]]);
  });

  it("uses CHANGEDSINCE with CONDSTORE and reports a change older than the tracked window", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, modseq: 60, messages: [
      { uid: 1, flags: flags.seen, modseq: 55 }, { uid: 2, flags: flags.none, modseq: 10 }, { uid: 3, flags: flags.seen, modseq: 10 },
    ] } });
    const small = { uidValidity: "7", uidNext: 4, modseq: "50", known: [[2, 0], [3, 1]] as Array<[number, number]> };
    const result = await incrementalSyncFolder(p, box(), small, { budget: 10, nowMs });
    expect(p.calls).toContain("flags 1:* since 50");
    expect(result.changes).toEqual([{ type: "state", remoteId: "INBOX:7:1", state: { isRead: true, isStarred: false } }]);
    expect(result.cursor.modseq).toBe("60");
  });

  it("skips the flag fetch when modseq hasn't moved, but still checks for expunges", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, modseq: 50, messages: [{ uid: 1, flags: [] }, { uid: 3, flags: flags.seen }] } });
    const result = await incrementalSyncFolder(p, box(), { ...cursor, modseq: "50" }, { budget: 10, nowMs });
    expect(p.calls.some((c) => c.startsWith("flags"))).toBe(false);
    expect(result.changes).toEqual([{ type: "delete", remoteId: "INBOX:7:2" }]);
  });

  it("doesn't report new mail twice when CHANGEDSINCE also returns it", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 5, modseq: 60, messages: [...messages(), { uid: 4, flags: flags.none, modseq: 60 }] } });
    const result = await incrementalSyncFolder(p, box(), { ...cursor, modseq: "50" }, { budget: 10, nowMs });
    expect(result.changes.map((c) => [c.type, c.remoteId])).toEqual([["upsert", "INBOX:7:4"]]);
  });

  it("starts a newly seen folder from its first UID", async () => {
    const p = new FakePort({ New: { uidValidity: "3", uidNext: 3, messages: [{ uid: 1, flags: [] }, { uid: 2, flags: [] }] } });
    const result = await incrementalSyncFolder(p, box({ path: "New", name: "New" }), undefined, { budget: 10, nowMs });
    expect(result.changes.map((c) => c.remoteId)).toEqual(["New:3:1", "New:3:2"]);
    expect(result.changes[0]).toMatchObject({ state: { folderRole: "custom" } });
  });

  it("refuses a full sync cursor that hasn't finished", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, messages: [] } });
    await expect(incrementalSyncFolder(p, box(), { ...cursor, fullAfter: 1 }, { budget: 1, nowMs })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("opens folders read-only for sync", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 4, messages: messages() } });
    await incrementalSyncFolder(p, box(), cursor, { budget: 1, nowMs });
    expect(p.openedReadOnly).toEqual([true]);
  });
});

describe("cursor parsing", () => {
  it.each(["garbage", "[]", '{"INBOX":{}}', '{"INBOX":{"uidValidity":7,"uidNext":1,"known":[]}}', '{"INBOX":{"uidValidity":"7","uidNext":"x","known":[]}}', '{"INBOX":{"uidValidity":"7","uidNext":1,"known":[[1]]}}'])(
    "rejects %s", (c) => { expect(() => parseImapCursor(c)).toThrow(CursorExpiredError); },
  );

  it("stays serializable: modseq and uidValidity are strings, not BigInt", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "7", uidNext: 2, modseq: 5, messages: [{ uid: 1, flags: [] }] } });
    const { a } = imapAdapter(p);
    const page = await a.fullSync({ windowDays: 30, pageSize: 10 });
    expect(JSON.parse(page.cursor)).toEqual({ INBOX: { uidValidity: "7", uidNext: 2, modseq: "5", known: [[1, 0]] } });
  });
});

describe("adapter over a fake port", () => {
  const mailboxes: ImapMailbox[] = [
    box(), box({ path: "Sent", name: "Sent", specialUse: "\\Sent" }), box({ path: "Sent Items", name: "Sent Items" }),
    box({ path: "Trash", name: "Trash", specialUse: "\\Trash" }), box({ path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" }),
    box({ path: "[Gmail]", name: "[Gmail]", flags: ["\\Noselect"] }),
  ];
  const empty = (uidValidity = "7"): FakeBox => ({ uidValidity, uidNext: 1, messages: [] });
  const port = () => new FakePort({ INBOX: { uidValidity: "7", uidNext: 3, messages: [{ uid: 1, flags: [] }, { uid: 2, flags: [] }] }, Sent: { uidValidity: "8", uidNext: 2, messages: [{ uid: 1, flags: flags.seen }] }, "Sent Items": empty(), Trash: empty(), "[Gmail]/All Mail": empty() }, mailboxes);

  it("lists selectable folders with roles, skipping virtual views", async () => {
    const { a } = imapAdapter(port());
    expect(await a.listFolders()).toEqual([
      { remoteId: "INBOX", name: "INBOX", role: "inbox" }, { remoteId: "Sent", name: "Sent", role: "sent" },
      { remoteId: "Sent Items", name: "Sent Items", role: "sent" }, { remoteId: "Trash", name: "Trash", role: "trash" },
    ]);
  });

  it("walks the full sync across folders and finishes", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    const first = await a.fullSync({ windowDays: 30, pageSize: 2 });
    expect(first.changes.map((c) => c.remoteId)).toEqual(["INBOX:7:1", "INBOX:7:2"]);
    expect(first.hasMore).toBe(true);
    const second = await a.fullSync({ windowDays: 30, pageSize: 2, cursor: first.cursor });
    expect(second.changes.map((c) => c.remoteId)).toEqual(["Sent:8:1"]);
    expect(second.changes[0]).toMatchObject({ state: { folderRole: "sent", isRead: true } });
    expect(second.hasMore).toBe(false);
    expect(p.calls.some((c) => c.includes("All Mail"))).toBe(false);
  });

  it("surfaces a UIDVALIDITY change from incrementalSync", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    const full = await a.fullSync({ windowDays: 30, pageSize: 100 });
    p.boxes.Sent!.uidValidity = "99";
    await expect(a.incrementalSync(full.cursor, { pageSize: 100 })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("deletes tracked messages when a folder goes away", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    const full = await a.fullSync({ windowDays: 30, pageSize: 100 });
    p.mailboxes = p.mailboxes.filter((m) => m.path !== "Sent");
    const page = await a.incrementalSync(full.cursor, { pageSize: 100 });
    expect(page.changes).toContainEqual({ type: "delete", remoteId: "Sent:8:1" });
    expect(JSON.parse(page.cursor).Sent).toBeUndefined();
  });

  it("doesn't read a folder list without INBOX as everything having been deleted", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    const full = await a.fullSync({ windowDays: 30, pageSize: 100 });
    p.mailboxes = [];
    await expect(a.incrementalSync(full.cursor, { pageSize: 100 })).rejects.toBeInstanceOf(ImapError);
  });

  it("caps folders with the inbox kept, and doesn't take a capped folder for a deleted one", async () => {
    const customs = Array.from({ length: 150 }, (_, i) => box({ path: `C${i}`, name: `C${i}` }));
    const boxes: Record<string, FakeBox> = Object.fromEntries(customs.map((c) => [c.path, empty()]));
    boxes.INBOX = empty();
    const p = new FakePort(boxes, [...customs, box()]);
    const { a } = imapAdapter(p);
    const full = await a.fullSync({ windowDays: 30, pageSize: 100 });
    const cursor = JSON.parse(full.cursor);
    expect(cursor.INBOX).toBeDefined();
    expect(Object.keys(cursor)).toHaveLength(100);
    cursor.C149 = { uidValidity: "7", uidNext: 2, known: [[1, 0]] };
    const page = await a.incrementalSync(JSON.stringify(cursor), { pageSize: 100 });
    expect(page.changes).toEqual([]);
    expect(JSON.parse(page.cursor).C149).toBeDefined();
  });

  it("closes the connection after each operation, even on failure", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    await a.listFolders();
    await a.incrementalSync("{}", { pageSize: 100 });
    p.boxes.INBOX!.uidValidity = "99";
    await a.fetchRaw("INBOX:7:1").catch(() => undefined);
    expect(p.closed).toBe(3);
  });

  it("applies flags and moves, opening read-write", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    await a.applyChange("INBOX:7:2", { isRead: true, isStarred: false, moveToRole: "trash" });
    expect(p.openedReadOnly).toEqual([false]);
    expect(p.calls).toEqual(["open INBOX", "add 2 \\Seen", "remove 2 \\Flagged", "list", "move 2 Trash"]);
  });

  it("prefers the special-use folder over a name match", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    await a.applyChange("INBOX:7:2", { moveToRole: "sent" });
    expect(p.calls).toContain("move 2 Sent");
  });

  it("reports where a move landed, when the server says, so the caller can follow the message", async () => {
    const p = port();
    (p as unknown as { move: ImapPort["move"] }).move = async () => ({ uid: 91, uidValidity: "55" });
    await expect(imapAdapter(p).a.applyChange("INBOX:7:2", { moveToRole: "trash" })).resolves.toEqual({ remoteId: "Trash:55:91" });
  });

  it("reports nothing when a move doesn't say where it landed, or nothing moved", async () => {
    const { a } = imapAdapter(port());
    await expect(a.applyChange("INBOX:7:2", { moveToRole: "trash" })).resolves.toBeUndefined();
    await expect(a.applyChange("INBOX:7:2", { isRead: true })).resolves.toBeUndefined();
  });

  it("an id is current only under its folder's UIDVALIDITY in the cursor", () => {
    const { a } = imapAdapter(port());
    const cursor = JSON.stringify({ INBOX: { uidValidity: "7", uidNext: 9, known: [] } });
    expect(a.isRemoteIdCurrent?.("INBOX:7:2", cursor)).toBe(true);
    expect(a.isRemoteIdCurrent?.("INBOX:6:2", cursor)).toBe(false);
    expect(a.isRemoteIdCurrent?.("Gone:7:2", cursor)).toBe(false);
  });

  it("doesn't move to the folder it's already in", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    await a.applyChange("Trash:7:2", { moveToRole: "trash" });
    expect(p.calls.some((c) => c.startsWith("move"))).toBe(false);
  });

  it("won't touch a message under a stale UIDVALIDITY, where the UID may be another message", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    await expect(a.applyChange("INBOX:6:2", { isRead: true })).rejects.toBeInstanceOf(CursorExpiredError);
    expect(p.calls).toEqual(["open INBOX"]);
    await expect(a.fetchRaw("INBOX:6:2")).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("throws UnsupportedOperationError rather than faking what it can't do", async () => {
    const { a } = imapAdapter(port());
    await expect(a.applyChange("INBOX:7:1", { addLabels: ["x"] })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.applyChange("INBOX:7:1", { moveToRole: "custom" })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.applyChange("INBOX:7:1", { moveToRole: "archive" })).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(await a.revoke()).toBe(false);
  });

  it("refuses writes for read-only accounts", async () => {
    const p = port();
    const { a, connectPort } = imapAdapter(p, { readOnly: true, smtp: true });
    await expect(a.applyChange("INBOX:7:1", { isRead: true })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.send({} as OutboundMessage)).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(connectPort).not.toHaveBeenCalled();
    expect(a.capabilities).toMatchObject({ send: false, flags: false, archive: false });
  });

  it("refuses to send without SMTP settings and says so in capabilities", async () => {
    const { a } = imapAdapter(port());
    await expect(a.send({} as OutboundMessage)).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(a.capabilities.send).toBe(false);
    expect(imapAdapter(port(), { smtp: true }).a.capabilities).toEqual(CAPABILITIES.imap);
  });

  it("finds a sent message in the Sent folder", async () => {
    const p = port();
    const { a } = imapAdapter(p);
    expect(await a.findSentByMessageId("abc@x")).toEqual({ remoteId: "Sent:8:1" });
    expect(p.calls).toContain("open Sent");
    expect(p.calls).toContain("find <abc@x>");
  });

  it("returns null with no Sent folder or no match", async () => {
    const none = new FakePort({ INBOX: empty() });
    expect(await imapAdapter(none).a.findSentByMessageId("abc@x")).toBeNull();
    const noMatch = new FakePort({ Sent: empty() }, [box({ path: "Sent", name: "Sent" })]);
    expect(await imapAdapter(noMatch).a.findSentByMessageId("abc@x")).toBeNull();
  });

  it("rejects a Message-ID that could inject a search", async () => {
    const { a, connectPort } = imapAdapter(port());
    await expect(a.findSentByMessageId('x" OR ALL')).rejects.toThrow(TypeError);
    expect(connectPort).not.toHaveBeenCalled();
  });

  it("refuses Outlook hosts, which take OAuth only", () => {
    expect(() => createAdapter("imap", { email: "a@outlook.com", readOnly: false }, {
      kind: "password", username: "u", password: "p", imap: { host: "outlook.office365.com", port: 993, security: "tls" },
    })).toThrow(/Microsoft sign-in/);
  });
});

describe("iCloud", () => {
  const authFail = () => Object.assign(new Error("Authentication failed"), { authenticationFailed: true });

  function icloud(connectPort: (l: { user: string }) => Promise<ImapPort>, username: string) {
    return createImapAdapter({
      account: { email: "jane@icloud.com", readOnly: false }, username, password: "p",
      imap: { host: "imap.mail.me.com", port: 993, security: "tls" }, connectPort,
    });
  }

  it("tries the local part first, falls back to the full address, then remembers it", async () => {
    const p = new FakePort({ INBOX: { uidValidity: "1", uidNext: 1, messages: [] } });
    const connectPort = vi.fn(async ({ user }: { user: string }) => { if (user === "jane") throw authFail(); return p; });
    const a = icloud(connectPort, "jane@icloud.com");
    await a.listFolders();
    expect(connectPort.mock.calls.map(([l]) => l.user)).toEqual(["jane", "jane@icloud.com"]);
    await a.listFolders();
    expect(connectPort.mock.calls.map(([l]) => l.user)).toEqual(["jane", "jane@icloud.com", "jane@icloud.com"]);
  });

  it("gives app-specific password guidance when both are refused", async () => {
    const a = icloud(async () => { throw authFail(); }, "jane");
    const result = await a.testConnection();
    expect(result).toMatchObject({ ok: false, problem: "auth_failed" });
    expect(result.detail).toMatch(/app-specific password/);
  });

  it("only tries once on other hosts", async () => {
    const connectPort = vi.fn(async () => { throw authFail(); });
    const a = createImapAdapter({
      account: { email: "a@b.com", readOnly: false }, username: "a@b.com", password: "p",
      imap: { host: "imap.b.com", port: 993, security: "tls" }, connectPort,
    });
    const result = await a.testConnection();
    expect(connectPort).toHaveBeenCalledOnce();
    expect(result.detail).not.toMatch(/app-specific/);
  });

  it("doesn't retry a non-auth failure", async () => {
    const connectPort = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "ECONNREFUSED" }); });
    const result = await icloud(connectPort, "jane").testConnection();
    expect(connectPort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, problem: "host_unreachable" });
  });
});

describe("error classification", () => {
  it.each<[unknown, string]>([
    [{ authenticationFailed: true }, "auth_failed"], [{ tlsFailed: true }, "tls_failed"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "tls_failed"], [{ code: "CERT_HAS_EXPIRED" }, "tls_failed"], [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "tls_failed"], [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "tls_failed"], [{ code: "EPROTO" }, "tls_failed"], [{ code: "STARTTLS_INJECTION" }, "tls_failed"],
    [{ code: "ENOTFOUND" }, "host_unreachable"], [{ code: "ECONNREFUSED" }, "host_unreachable"], [{ code: "EHOSTUNREACH" }, "host_unreachable"], [{ code: "NoConnection" }, "host_unreachable"],
    [{ code: "ETIMEDOUT" }, "timeout"], [{ code: "CONNECT_TIMEOUT" }, "timeout"], [{ code: "GREETING_TIMEOUT" }, "timeout"],
    [new HostBlockedError("reserved_address"), "host_blocked"],
    [{ code: "InvalidResponse" }, "protocol_error"], [new Error("whatever"), "protocol_error"],
  ])("%j is %s", (err, problem) => {
    expect(classifyConnectionError(err)).toBe(problem);
  });

  it("doesn't let library text through", async () => {
    const leaky: ImapPort = Object.assign(new FakePort({}), {
      list: async () => { throw new Error("server said pw-SENTINEL and BODY-SENTINEL"); },
    });
    const { a } = imapAdapter(leaky);
    const err = await a.listFolders().catch((e) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect(err.message).not.toContain("SENTINEL");
    const result = await a.testConnection();
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  it("passes a blocked host through as HostBlockedError", async () => {
    const a = createImapAdapter({
      account: { email: "a@b.com", readOnly: false }, username: "a", password: "p",
      imap: { host: "imap.example.org", port: 993, security: "tls" },
      hostGuard: createHostGuard({ resolver: async () => [{ address: "169.254.169.254" }] }),
    });
    await expect(a.listFolders()).rejects.toBeInstanceOf(HostBlockedError);
    expect(await a.testConnection()).toMatchObject({ ok: false, problem: "host_blocked" });
  });

  it("refuses plaintext settings", async () => {
    expect(() => createImapAdapter({
      account: { email: "a@b.com", readOnly: false }, username: "a", password: "p", imap: { host: "imap.example.org", port: 143, security: "none" as "tls" },
    })).toThrow(TypeError);
    await expect(connectImap({ host: "h", port: 143, security: "none" as "tls" }, { user: "u", pass: "p" }, { hostGuard: createHostGuard() })).rejects.toThrow(TypeError);
  });
});

describe("imapflow binding", () => {
  const stub = (over: Record<string, unknown>) => imapFlowPort(over as never);

  it("treats a refused SEARCH as an error, never as no results", async () => {
    await expect(stub({ search: async () => false }).searchUids({ uidRange: "1:5" })).rejects.toBeInstanceOf(ImapError);
    await expect(stub({ search: async () => undefined }).findByMessageId("<a@b>")).rejects.toBeInstanceOf(ImapError);
  });

  it("treats a refused STORE or MOVE as an error, never as done", async () => {
    await expect(stub({ messageFlagsAdd: async () => false }).addFlags(1, ["\\\\Seen"])).rejects.toBeInstanceOf(ImapError);
    await expect(stub({ messageFlagsRemove: async () => false }).removeFlags(1, ["\\\\Seen"])).rejects.toBeInstanceOf(ImapError);
    await expect(stub({ messageMove: async () => false }).move(1, "Trash")).rejects.toBeInstanceOf(ImapError);
  });

  it("reports no modseq when CONDSTORE wasn't enabled, so it can't do a full fetch by accident", async () => {
    const mailboxOpen = async () => ({ uidValidity: 7n, uidNext: 2, highestModseq: 9n });
    expect(await stub({ mailboxOpen, enabled: new Set() }).open("INBOX", { readOnly: true })).toEqual({ uidValidity: "7", uidNext: 2 });
    expect(await stub({ mailboxOpen, enabled: new Set(["CONDSTORE"]) }).open("INBOX", { readOnly: true })).toEqual({ uidValidity: "7", uidNext: 2, highestModseq: "9" });
  });

  it("drops the content of a message over the size limit instead of delivering part of it", async () => {
    const fetchAll = async () => [{ uid: 1, flags: new Set<string>(), size: 60 * 1024 * 1024, source: Buffer.from("partial") }];
    const [row] = await stub({ fetchAll }).fetchMessages([1]);
    expect(row).toEqual({ uid: 1, flags: [] });
  });
});

describe("imapflow against a real IMAP server (hoodiecrow-imap on localhost)", () => {
  const stops: Array<() => Promise<void>> = [];
  afterEach(async () => { await Promise.all(stops.splice(0).map((s) => s())); });

  const RAW1 = "Subject: one\r\nMessage-ID: <one@aegis.test>\r\nDate: Thu, 5 Nov 2026 10:00:00 +0000\r\n\r\nbody one";
  const RAW2 = "Subject: two\r\nDate: Thu, 5 Nov 2026 11:00:00 +0000\r\n\r\nbody two";

  async function server(opts: { secure?: boolean; plugins?: string[]; uidvalidity?: number } = {}) {
    const credentials = await testCert();
    const srv = hoodiecrow({
      plugins: opts.plugins ?? ["STARTTLS", "SPECIAL-USE", "CONDSTORE", "ENABLE", "UIDPLUS", "MOVE"],
      secureConnection: opts.secure ?? false,
      credentials,
      storage: {
        INBOX: { uidvalidity: opts.uidvalidity ?? 77, messages: [
          { raw: RAW1, flags: ["\\Seen"], internaldate: new Date("2026-11-05T10:00:00Z") },
          { raw: RAW2, flags: [], internaldate: new Date("2026-11-05T11:00:00Z") },
        ] },
        "": { separator: "/", folders: {
          Sent: { "special-use": "\\Sent", uidvalidity: 5, messages: [{ raw: RAW1, flags: ["\\Seen"], internaldate: new Date("2026-11-05T10:00:00Z") }] },
          Trash: { "special-use": "\\Trash", messages: [] },
          Receipts: { messages: [] },
        } },
      },
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    stops.push(() => new Promise<void>((r) => srv.close(() => r())));
    return { port: srv.server.address().port, cert: credentials.cert };
  }

  function live(port: number, cert: string, over: { security?: "tls" | "starttls"; password?: string; hostname?: string; readOnly?: boolean } = {}) {
    return createImapAdapter({
      account: { email: "testuser@example.com", readOnly: over.readOnly ?? false },
      username: "testuser",
      password: over.password ?? "testpass",
      imap: { host: TEST_HOST, port: 143, security: over.security ?? "starttls" },
      hostGuard: loopbackGuard(port, over.hostname ? { hostname: over.hostname } : {}),
      ca: cert,
      now: () => NOW,
    });
  }

  it("connects over STARTTLS, lists folders and maps special-use", async () => {
    const { port, cert } = await server();
    const a = live(port, cert);
    expect(await a.testConnection()).toEqual({ ok: true, folders: 4 });
    const folders = await a.listFolders();
    expect(folders.find((f) => f.remoteId === "INBOX")?.role).toBe("inbox");
    expect(folders.find((f) => f.remoteId === "Sent")?.role).toBe("sent");
    expect(folders.find((f) => f.remoteId === "Trash")?.role).toBe("trash");
    expect(folders.find((f) => f.remoteId === "Receipts")?.role).toBe("custom");
  });

  it("connects over implicit TLS", async () => {
    const { port, cert } = await server({ secure: true, plugins: ["SPECIAL-USE"] });
    expect(await live(port, cert, { security: "tls" }).testConnection()).toMatchObject({ ok: true });
  });

  it("fetches exact raw bytes, flags, dates and stable ids in a full sync", async () => {
    const { port, cert } = await server();
    const a = live(port, cert);
    const page = await a.fullSync({ windowDays: 30, pageSize: 100 });
    expect(page.hasMore).toBe(false);
    const ids = page.changes.map((c) => c.remoteId);
    expect(ids).toContain("INBOX:77:1");
    expect(ids).toContain("INBOX:77:2");
    const first = page.changes.find((c) => c.remoteId === "INBOX:77:1")!;
    expect(first).toMatchObject({ type: "upsert", internalDate: "2026-11-05T10:00:00.000Z", state: { folderRole: "inbox", isRead: true, isStarred: false } });
    expect(first.type === "upsert" && Buffer.from(first.raw!).toString()).toBe(RAW1);
    const cursor = JSON.parse(page.cursor);
    expect(cursor.INBOX).toMatchObject({ uidValidity: "77", uidNext: 3, known: [[1, 1], [2, 0]] });
    expect(cursor.INBOX.modseq).toBeTypeOf("string");
    expect(Buffer.from(await a.fetchRaw("INBOX:77:2")).toString()).toBe(RAW2);
  });

  it("doesn't mark mail as read by syncing it", async () => {
    const { port, cert } = await server();
    const a = live(port, cert);
    const first = await a.fullSync({ windowDays: 30, pageSize: 100 });
    await a.fetchRaw("INBOX:77:2");
    const again = await a.fullSync({ windowDays: 30, pageSize: 100 });
    const m = again.changes.find((c) => c.remoteId === "INBOX:77:2");
    expect(m).toMatchObject({ state: { isRead: false } });
    expect(first.changes.find((c) => c.remoteId === "INBOX:77:2")).toMatchObject({ state: { isRead: false } });
  });

  it("applies flags and a move on the wire, and incremental sync observes them", async () => {
    const { port, cert } = await server();
    const a = live(port, cert);
    const full = await a.fullSync({ windowDays: 30, pageSize: 100 });
    await a.applyChange("INBOX:77:2", { isRead: true, isStarred: true });
    const flagged = await a.incrementalSync(full.cursor, { pageSize: 100 });
    expect(flagged.changes).toContainEqual({ type: "state", remoteId: "INBOX:77:2", state: { isRead: true, isStarred: true } });
    await a.applyChange("INBOX:77:2", { moveToRole: "trash" });
    const moved = await a.incrementalSync(flagged.cursor, { pageSize: 100 });
    expect(moved.changes).toContainEqual({ type: "delete", remoteId: "INBOX:77:2" });
    const upsert = moved.changes.find((c) => c.type === "upsert" && c.remoteId.startsWith("Trash:"));
    expect(upsert).toMatchObject({ state: { folderRole: "trash", isRead: true, isStarred: true } });
  });

  it("finds a Message-ID on Sent through real SEARCH HEADER", async () => {
    const { port, cert } = await server();
    const a = live(port, cert);
    expect(await a.findSentByMessageId("<one@aegis.test>")).toMatchObject({ remoteId: expect.stringMatching(/^Sent:\d+:1$/) });
    expect(await a.findSentByMessageId("<missing@aegis.test>")).toBeNull();
  });

  it("detects UIDVALIDITY changing on a real server", async () => {
    const first = await server({ uidvalidity: 77 });
    const page = await live(first.port, first.cert).fullSync({ windowDays: 30, pageSize: 100 });
    const second = await server({ uidvalidity: 78 });
    await expect(live(second.port, second.cert).incrementalSync(page.cursor, { pageSize: 100 })).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it("classifies a bad password without quoting it", async () => {
    const { port, cert } = await server();
    const result = await live(port, cert, { password: "wrong-pw-SENTINEL" }).testConnection();
    expect(result).toMatchObject({ ok: false, problem: "auth_failed" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  it("refuses, before any login, a server that doesn't offer STARTTLS", async () => {
    const { port, cert } = await server({ plugins: ["SPECIAL-USE"] });
    expect(await live(port, cert).testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });

  it("refuses a certificate for another hostname, even at the right IP", async () => {
    const { port, cert } = await server();
    expect(await live(port, cert, { hostname: "other.example.net" }).testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });

  it("refuses a certificate for another hostname over implicit TLS too", async () => {
    const { port, cert } = await server({ secure: true, plugins: ["SPECIAL-USE"] });
    expect(await live(port, cert, { security: "tls", hostname: "other.example.net" }).testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });

  it("refuses a certificate it doesn't trust", async () => {
    const { port } = await server();
    const a = createImapAdapter({
      account: { email: "t@example.com", readOnly: false }, username: "testuser", password: "testpass",
      imap: { host: TEST_HOST, port: 143, security: "starttls" }, hostGuard: loopbackGuard(port),
    });
    expect(await a.testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });

  it("classifies a refused connection", async () => {
    const { port, cert } = await server();
    await stops.pop()!();
    expect(await live(port, cert).testConnection()).toMatchObject({ ok: false, problem: "host_unreachable" });
  });

  it("writes nothing to the console while connecting and failing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { port, cert } = await server();
    await live(port, cert).testConnection();
    await live(port, cert, { password: "wrong" }).testConnection();
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});
