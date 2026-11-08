import { createServer as createTlsServer, type Server, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorExpiredError, UnsupportedOperationError } from "@aegis/domain/mail";
import { HostBlockedError, Pop3Error, POP3_LIMITS, createAdapter, createHostGuard, createPop3Adapter, receivedDate, type Pop3Limits } from "./index";
import { TEST_HOST, loopbackGuard, testCert } from "./test-tls";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

interface Mail { uidl: string; body: string; size?: number }
interface FakePop3Options {
  password?: string;
  messages: Mail[];
  /** Replaces the reply to a command. */
  override?: (command: string, socket: TLSSocket) => string | undefined | null;
}

/** A TLS POP3 server implementing just enough of RFC 1939. Records every command it's sent. */
async function fakePop3(opts: FakePop3Options) {
  const { key, cert } = await testCert();
  const commands: string[] = [];
  const server = createTlsServer({ key, cert }, (socket) => {
    socket.on("error", () => undefined);
    socket.write("+OK ready\r\n");
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      let i: number;
      while ((i = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        commands.push(line);
        const [verb, arg] = line.split(" ");
        const overridden = opts.override?.(line, socket);
        if (overridden !== undefined) { if (overridden !== null) socket.write(overridden); continue; }
        switch (verb) {
          case "USER": socket.write("+OK\r\n"); break;
          case "PASS": socket.write(arg === (opts.password ?? "right-pass") ? "+OK\r\n" : "-ERR bad login for BODY-SENTINEL\r\n"); break;
          case "UIDL": socket.write(`+OK\r\n${opts.messages.map((m, n) => `${n + 1} ${m.uidl}`).join("\r\n")}${opts.messages.length ? "\r\n" : ""}.\r\n`); break;
          case "LIST": {
            const m = opts.messages[Number(arg) - 1];
            socket.write(m ? `+OK ${arg} ${m.size ?? Buffer.byteLength(m.body)}\r\n` : "-ERR no such message\r\n");
            break;
          }
          case "RETR": {
            const m = opts.messages[Number(arg) - 1];
            if (!m) { socket.write("-ERR no such message\r\n"); break; }
            const stuffed = m.body.split("\r\n").map((l) => (l.startsWith(".") ? `.${l}` : l)).join("\r\n");
            socket.write(`+OK\r\n${stuffed}\r\n.\r\n`);
            break;
          }
          case "QUIT": socket.end("+OK bye\r\n"); break;
          default: socket.write("-ERR unknown\r\n");
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, commands, cert };
}

const mail = (uidl: string, extra = "") => ({
  uidl,
  body: `Received: from a by b; Mon, 2 Nov 2026 10:00:00 +0000\r\nDate: Mon, 2 Nov 2026 09:00:00 +0000\r\nSubject: ${uidl}\r\n\r\nbody ${uidl}${extra}`,
});

function adapter(port: number, cert: string, limits: Partial<Pop3Limits> = {}, password = "right-pass") {
  return createPop3Adapter({
    account: { email: "me@example.com", readOnly: false },
    username: "me",
    password,
    server: { host: TEST_HOST, port: 995, security: "tls" },
    hostGuard: loopbackGuard(port),
    ca: cert,
    now: () => NOW,
    limits,
  });
}

describe("sync", () => {
  it("imports over real TLS, verified against the hostname, without ever deleting", async () => {
    const { port, cert, commands } = await fakePop3({ messages: [mail("u1"), mail("u2")] });
    const page = await adapter(port, cert).fullSync({ windowDays: 30, pageSize: 10 });
    expect(page.hasMore).toBe(false);
    expect(page.changes.map((c) => c.remoteId)).toEqual(["u1", "u2"]);
    const first = page.changes[0]!;
    expect(first).toMatchObject({
      type: "upsert", internalDate: "2026-11-02T10:00:00.000Z",
      state: { folderRole: "inbox", labels: [], isRead: false, isStarred: false },
    });
    expect(first.type === "upsert" && Buffer.from(first.raw!).toString()).toContain("body u1");
    expect(commands.map((c) => c.split(" ")[0])).toEqual(["USER", "PASS", "UIDL", "LIST", "RETR", "LIST", "RETR", "QUIT"]);
    expect(commands.some((c) => c.startsWith("DELE"))).toBe(false);
  });

  it("reassembles dot-stuffed lines and keeps exact bytes", async () => {
    const m = { uidl: "u1", body: "Subject: x\r\n\r\n.leading dot\r\n..two dots\r\nend" };
    const { port, cert } = await fakePop3({ messages: [m] });
    const page = await adapter(port, cert).fullSync({ windowDays: 30, pageSize: 1 });
    const c = page.changes[0]!;
    expect(c.type === "upsert" && Buffer.from(c.raw!).toString()).toBe(`${m.body}\r\n`);
  });

  it("pages, then only imports what it hasn't seen", async () => {
    const messages = [mail("u1"), mail("u2"), mail("u3")];
    const { port, cert } = await fakePop3({ messages });
    const a = adapter(port, cert);
    const p1 = await a.fullSync({ windowDays: 30, pageSize: 2 });
    expect(p1.changes.map((c) => c.remoteId)).toEqual(["u1", "u2"]);
    expect(p1.hasMore).toBe(true);
    const p2 = await a.fullSync({ windowDays: 30, pageSize: 2, cursor: p1.cursor });
    expect(p2.changes.map((c) => c.remoteId)).toEqual(["u3"]);
    expect(p2.hasMore).toBe(false);
    const quiet = await a.incrementalSync(p2.cursor, { pageSize: 10 });
    expect(quiet).toMatchObject({ changes: [], hasMore: false });
    messages.push(mail("u4"));
    const inc = await a.incrementalSync(quiet.cursor, { pageSize: 10 });
    expect(inc.changes.map((c) => c.remoteId)).toEqual(["u4"]);
  });

  it("stores hashes rather than UIDLs in the cursor", async () => {
    const { port, cert } = await fakePop3({ messages: [mail("secret-uidl-value")] });
    const page = await adapter(port, cert).fullSync({ windowDays: 30, pageSize: 1 });
    expect(page.cursor).not.toContain("secret-uidl-value");
    expect(JSON.parse(page.cursor).seen).toHaveLength(1);
  });

  it("prunes hashes for messages the server no longer lists", async () => {
    const messages = [mail("u1"), mail("u2")];
    const { port, cert } = await fakePop3({ messages });
    const a = adapter(port, cert);
    const p1 = await a.fullSync({ windowDays: 30, pageSize: 10 });
    messages.shift();
    const p2 = await a.incrementalSync(p1.cursor, { pageSize: 10 });
    expect(p2.changes).toEqual([]);
    expect(JSON.parse(p2.cursor).seen).toHaveLength(1);
  });

  it("skips mail outside the window in full sync, and marks it seen", async () => {
    const old = { uidl: "old", body: "Received: from a by b; Thu, 1 Jan 2015 10:00:00 +0000\r\nSubject: x\r\n\r\nold" };
    const { port, cert } = await fakePop3({ messages: [old, mail("new")] });
    const a = adapter(port, cert);
    const page = await a.fullSync({ windowDays: 30, pageSize: 10 });
    expect(page.changes.map((c) => c.remoteId)).toEqual(["new"]);
    expect(JSON.parse(page.cursor).seen).toHaveLength(2);
  });

  it("doesn't apply a window in incremental sync: new mail can't hide behind an old date", async () => {
    const old = { uidl: "old", body: "Date: Thu, 1 Jan 2015 10:00:00 +0000\r\nSubject: x\r\n\r\nold" };
    const { port, cert } = await fakePop3({ messages: [old] });
    const page = await adapter(port, cert).incrementalSync('{"seen":[]}', { pageSize: 10 });
    expect(page.changes.map((c) => c.remoteId)).toEqual(["old"]);
  });

  it.each(["garbage", "{}", '{"seen":5}', '{"seen":[1]}'])("rejects the unusable cursor %s", async (cursor) => {
    const { port, cert, commands } = await fakePop3({ messages: [] });
    await expect(adapter(port, cert).incrementalSync(cursor, { pageSize: 1 })).rejects.toBeInstanceOf(CursorExpiredError);
    expect(commands).toHaveLength(0);
  });
});

describe("receivedDate", () => {
  const raw = (s: string) => new TextEncoder().encode(s);
  it("prefers the newest Received header over a forged Date", () => {
    const m = "Received: from a\r\n by b; Mon, 2 Nov 2026 10:00:00 +0000\r\nReceived: from x; Thu, 1 Jan 2015 00:00:00 +0000\r\nDate: Thu, 1 Jan 1999 00:00:00 +0000\r\n\r\nx";
    expect(receivedDate(raw(m), NOW).toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });
  it("falls back to Date, then to now", () => {
    expect(receivedDate(raw("Date: Mon, 2 Nov 2026 09:00:00 +0000\r\n\r\nx"), NOW).toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(receivedDate(raw("Subject: none\r\n\r\nDate: Mon, 2 Nov 2026 09:00:00 +0000"), NOW).getTime()).toBe(NOW);
    expect(receivedDate(raw("Date: garbage\r\n\r\nx"), NOW).getTime()).toBe(NOW);
  });
});

describe("limits", () => {
  it("has sane defaults", () => {
    expect(POP3_LIMITS.maxSeen).toBeLessThanOrEqual(POP3_LIMITS.maxUidlEntries);
    expect(POP3_LIMITS.maxMessageBytes).toBeGreaterThan(0);
  });

  it("caps the cursor at maxSeen and considers only the newest messages", async () => {
    const messages = Array.from({ length: 6 }, (_, i) => mail(`u${i}`));
    const { port, cert } = await fakePop3({ messages });
    const a = adapter(port, cert, { maxSeen: 3 });
    const first = await a.fullSync({ windowDays: 30, pageSize: 100 });
    expect(first.changes.map((c) => c.remoteId)).toEqual(["u3", "u4", "u5"]);
    expect(JSON.parse(first.cursor).seen).toHaveLength(3);
    // Stable: the older entries aren't re-imported on the next pass.
    const next = await a.incrementalSync(first.cursor, { pageSize: 100 });
    expect(next.changes).toEqual([]);
    expect(JSON.parse(next.cursor).seen).toHaveLength(3);
    // New mail still arrives once it pushes older entries out.
    messages.push(mail("u6"));
    const after = await a.incrementalSync(next.cursor, { pageSize: 100 });
    expect(after.changes.map((c) => c.remoteId)).toEqual(["u6"]);
    expect(JSON.parse(after.cursor).seen).toHaveLength(3);
  });

  it("refuses a UIDL listing over the limit", async () => {
    const { port, cert } = await fakePop3({ messages: Array.from({ length: 5 }, (_, i) => mail(`u${i}`)) });
    const err = await adapter(port, cert, { maxUidlEntries: 4 }).fullSync({ windowDays: 30, pageSize: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(Pop3Error);
    expect(err.problem).toBe("protocol_error");
  });

  it("reports an oversized message without content and doesn't retrieve it", async () => {
    const { port, cert, commands } = await fakePop3({ messages: [{ uidl: "big", body: "x", size: 5_000 }, mail("ok")] });
    const page = await adapter(port, cert, { maxMessageBytes: 4_000 }).fullSync({ windowDays: 30, pageSize: 10 });
    expect(page.changes[0]).toMatchObject({ type: "upsert", remoteId: "big" });
    expect(page.changes[0]).not.toHaveProperty("raw");
    expect(page.changes[1]).toHaveProperty("raw");
    expect(commands.filter((c) => c === "RETR 1")).toHaveLength(0);
    expect(JSON.parse(page.cursor).seen).toHaveLength(2);
  });

  it("stops reading a server that lies about the size", async () => {
    const liar = { uidl: "liar", body: `Subject: x\r\n\r\n${"y\r\n".repeat(2000)}`, size: 10 };
    const { port, cert } = await fakePop3({ messages: [liar] });
    const err = await adapter(port, cert, { maxMessageBytes: 1000 }).fullSync({ windowDays: 30, pageSize: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(Pop3Error);
    expect(err.message).toMatch(/size limit/);
  });

  it("refuses an oversized status line", async () => {
    const { port, cert } = await fakePop3({ messages: [], override: (c) => (c.startsWith("USER") ? `+OK ${"z".repeat(5000)}\r\n` : undefined) });
    const err = await adapter(port, cert, { maxLineBytes: 1000 }).testConnection();
    expect(err).toMatchObject({ ok: false, problem: "protocol_error" });
  });

  it("refuses an endless line with no terminator", async () => {
    const { port, cert } = await fakePop3({ messages: [], override: (c) => (c.startsWith("USER") ? "z".repeat(5000) : undefined) });
    expect(await adapter(port, cert, { maxLineBytes: 1000 }).testConnection()).toMatchObject({ ok: false, problem: "protocol_error" });
  });

  it("times out on a silent server", async () => {
    const { port, cert } = await fakePop3({ messages: [], override: (c) => (c.startsWith("USER") ? null : undefined) });
    expect(await adapter(port, cert, { idleTimeoutMs: 100 }).testConnection()).toMatchObject({ ok: false, problem: "timeout" });
  });

  it("rejects a malformed UIDL line", async () => {
    const { port, cert } = await fakePop3({ messages: [], override: (c) => (c === "UIDL" ? "+OK\r\n1 bad uidl with spaces\r\n.\r\n" : undefined) });
    await expect(adapter(port, cert).fullSync({ windowDays: 30, pageSize: 1 })).rejects.toThrow(/invalid UIDL/);
  });

  it("collapses a duplicate UIDL", async () => {
    const { port, cert } = await fakePop3({ messages: [mail("dup"), mail("dup")] });
    const page = await adapter(port, cert).fullSync({ windowDays: 30, pageSize: 10 });
    expect(page.changes).toHaveLength(1);
  });

  it("reports a server without UIDL", async () => {
    const { port, cert } = await fakePop3({ messages: [], override: (c) => (c === "UIDL" ? "-ERR no\r\n" : undefined) });
    await expect(adapter(port, cert).fullSync({ windowDays: 30, pageSize: 1 })).rejects.toThrow(/doesn't support UIDL/);
  });
});

describe("connection problems", () => {
  it("classifies a bad password, never quoting the server or the password", async () => {
    const { port, cert } = await fakePop3({ messages: [] });
    const result = await adapter(port, cert, {}, "wrong-pass-SENTINEL").testConnection();
    expect(result).toMatchObject({ ok: false, problem: "auth_failed" });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    const err = await adapter(port, cert, {}, "wrong-pass-SENTINEL").fullSync({ windowDays: 1, pageSize: 1 }).catch((e) => e);
    expect(err.problem).toBe("auth_failed");
    expect(err.message).not.toContain("SENTINEL");
  });

  it("reports success", async () => {
    const { port, cert, commands } = await fakePop3({ messages: [mail("u1")] });
    expect(await adapter(port, cert).testConnection()).toEqual({ ok: true });
    expect(commands.filter((c) => c.startsWith("RETR"))).toHaveLength(0);
  });

  it("rejects a certificate for the wrong name", async () => {
    const { port, cert, commands } = await fakePop3({ messages: [] });
    const a = createPop3Adapter({
      account: { email: "a@b", readOnly: false }, username: "u", password: "right-pass",
      server: { host: TEST_HOST, port: 995, security: "tls" },
      hostGuard: loopbackGuard(port, { hostname: "other.example.net" }), ca: cert,
    });
    expect(await a.testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
    expect(commands).toHaveLength(0);
  });

  it("rejects a certificate it doesn't trust", async () => {
    const { port } = await fakePop3({ messages: [] });
    const a = createPop3Adapter({
      account: { email: "a@b", readOnly: false }, username: "u", password: "right-pass",
      server: { host: TEST_HOST, port: 995, security: "tls" }, hostGuard: loopbackGuard(port),
    });
    expect(await a.testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });

  it("refuses a line break in the credentials, which would be another command", async () => {
    const { port, cert, commands } = await fakePop3({ messages: [] });
    const result = await adapter(port, cert, {}, "x\r\nDELE 1").testConnection();
    expect(result).toMatchObject({ ok: false, problem: "auth_failed" });
    expect(commands).toHaveLength(0);
  });

  it("applies the strict guard: blocked hosts never see a connection", async () => {
    const socketFactory = vi.fn();
    const a = createPop3Adapter({
      account: { email: "a@b", readOnly: false }, username: "u", password: "p",
      server: { host: "mail.example.org", port: 995, security: "tls" },
      hostGuard: createHostGuard({ resolver: async () => [{ address: "169.254.169.254" }] }),
      socketFactory,
    });
    expect(await a.testConnection()).toMatchObject({ ok: false, problem: "host_blocked" });
    await expect(a.fullSync({ windowDays: 1, pageSize: 1 })).rejects.toBeInstanceOf(HostBlockedError);
    expect(socketFactory).not.toHaveBeenCalled();
  });
});

describe("refusals", () => {
  const cred = (host: string, security: "tls" | "starttls" = "tls") => ({ kind: "password" as const, username: "u", password: "p", imap: { host, port: 995, security } });
  const account = { email: "a@b.com", readOnly: false };

  it.each(["pop.mail.me.com", "imap.mail.me.com", "POP.MAIL.ME.COM", "pop.icloud.com", "pop.me.com", "pop.mac.com", "pop.mail.me.com."])("refuses the iCloud host %s", (host) => {
    expect(() => createAdapter("pop3", account, cred(host))).toThrow(new UnsupportedOperationError("iCloud Mail does not support POP"));
  });

  it("allows a host that only looks like iCloud", () => {
    expect(() => createAdapter("pop3", account, cred("pop.notme.com"))).not.toThrow();
  });

  it("sends Outlook hosts to OAuth", () => {
    expect(() => createAdapter("pop3", account, cred("outlook.office365.com"))).toThrow(/Microsoft sign-in/);
  });

  it("refuses STARTTLS and plaintext: TLS only", () => {
    expect(() => createAdapter("pop3", account, cred("mail.example.org", "starttls"))).toThrow(UnsupportedOperationError);
    expect(() => createAdapter("pop3", account, cred("mail.example.org", "none" as "tls"))).toThrow(UnsupportedOperationError);
  });

  it("throws UnsupportedOperationError for everything outside import", async () => {
    const a = createAdapter("pop3", account, cred("mail.example.org"));
    await expect(a.listFolders()).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.fetchRaw("x")).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.applyChange("x", { isRead: true })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.send({} as never)).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(a.findSentByMessageId("x@y")).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(await a.revoke()).toBe(false);
    expect(a.capabilities).toMatchObject({ send: false, labels: "none", twoWaySync: false, flags: false });
  });
});
