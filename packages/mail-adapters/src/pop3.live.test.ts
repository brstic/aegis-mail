import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { beforeEach, describe, expect, it } from "vitest";
import { UnsupportedOperationError, type MailAdapter, type MailChange } from "@aegis/domain/mail";
import { createAdapter, type AdapterCredential } from "./index";
import type { HostGuard } from "./ssrf";

/**
 * The real adapter against real Dovecot POP3. Skipped unless IMAP_TEST_HOST and POP3_TEST_PORT are set: see
 * infra/local/live-servers.sh. Mail is placed over IMAP, which shares the mailbox with POP3.
 */
const env = process.env;
const host = env.IMAP_TEST_HOST;
const pop3Port = Number(env.POP3_TEST_PORT);
const imapPort = Number(env.IMAP_TEST_PORT);
const servername = env.IMAP_TEST_SERVERNAME ?? "localhost";
const password = env.IMAP_TEST_PASS ?? "";
const user = "pop3test@example.net";
const ca = env.IMAP_TEST_CA_FILE ? readFileSync(env.IMAP_TEST_CA_FILE) : undefined;

const guard = (name = servername): HostGuard => ({ checkHost: async (_h, p) => ({ ip: host as string, family: 4, port: p, hostname: name, servername: name }) });
const cred = (over: Partial<Extract<AdapterCredential, { kind: "password" }>> = {}): AdapterCredential => ({ kind: "password", username: user, password, imap: { host: servername, port: pop3Port, security: "tls" }, ...over });
const adapter = (over: { cred?: AdapterCredential; guard?: HostGuard; ca?: Buffer | null } = {}): MailAdapter =>
  createAdapter("pop3", { email: user, readOnly: true }, over.cred ?? cred(), { hostGuard: over.guard ?? guard(), ...(over.ca === null ? {} : { ca: over.ca ?? ca }) });

async function other<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: host as string, port: imapPort, secure: true, servername, auth: { user, pass: password }, tls: { ca }, logger: false, disableAutoIdle: true });
  c.on("error", () => undefined);
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}
const message = (subject: string, body = "Hello.\r\n", extra = "") => Buffer.from(`Received: from a.example.org by mail.example.net; ${new Date().toUTCString()}\r\nFrom: Pat <pat@example.org>\r\nTo: ${user}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\n${extra}\r\n${body}`);
const append = async (subject: string, body?: string, extra?: string) => {
  const raw = message(subject, body, extra);
  await other(c => c.append("INBOX", raw));
  return raw;
};
const ups = (c: MailChange[]) => c.filter((x): x is Extract<MailChange, { type: "upsert" }> => x.type === "upsert");

describe.skipIf(!host || !env.POP3_TEST_PORT)("POP3 adapter against real Dovecot", () => {
  beforeEach(async () => {
    await other(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete("1:*").catch(() => undefined); });
  });

  it("connects, verifying the certificate", async () => {
    expect(await adapter().testConnection()).toEqual({ ok: true });
  });
  it("a wrong password is auth_failed", async () => {
    expect(await adapter({ cred: cred({ password: "nope" }) }).testConnection()).toMatchObject({ ok: false, problem: "auth_failed" });
  });
  it("sync surfaces a wrong password as a classified error", async () => {
    await expect(adapter({ cred: cred({ password: "nope" }) }).fullSync({ windowDays: 30, pageSize: 5 })).rejects.toMatchObject({ name: "Pop3Error", problem: "auth_failed" });
  });
  it("refuses an untrusted certificate", async () => {
    expect(await adapter({ ca: null }).testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });
  it("refuses a trusted certificate for a different name", async () => {
    expect(await adapter({ guard: guard("mail.example.net") }).testConnection()).toMatchObject({ ok: false, problem: "tls_failed" });
  });
  it("a plain mailbox is empty, not an error", async () => {
    const page = await adapter().fullSync({ windowDays: 30, pageSize: 5 });
    expect(page.changes).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
  it("imports byte for byte, undoing dot-stuffing", async () => {
    const raw = await append("Dots", ".leading dot\r\n..two dots\r\n.\r\nafter a lone dot\r\n");
    const { changes } = await adapter().fullSync({ windowDays: 30, pageSize: 5 });
    expect(Buffer.from(ups(changes)[0]?.raw as Uint8Array).equals(raw)).toBe(true);
    expect(ups(changes)[0]?.state.folderRole).toBe("inbox");
  });
  it("carries bytes that aren't valid UTF-8", async () => {
    const raw = Buffer.concat([Buffer.from(`From: a@example.org\r\nSubject: bin\r\n\r\n`), Buffer.from([0xff, 0xfe, 0x80, 0x0d, 0x0a])]);
    await other(c => c.append("INBOX", raw));
    const { changes } = await adapter().fullSync({ windowDays: 30, pageSize: 5 });
    expect(Buffer.from(ups(changes)[0]?.raw as Uint8Array).equals(raw)).toBe(true);
  });
  it("pages oldest first, without loss or repeats, and the cursor stops re-import", async () => {
    for (let i = 0; i < 5; i++) await append(`m${i}`);
    const a = adapter();
    const subjects: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await a.fullSync({ windowDays: 30, pageSize: 2, ...(cursor ? { cursor } : {}) });
      subjects.push(...ups(page.changes).map(c => /Subject: (\S+)/.exec(Buffer.from(c.raw as Uint8Array).toString())?.[1] as string));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(subjects).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    const again = await a.incrementalSync(cursor as string, { pageSize: 10 });
    expect(again.changes).toEqual([]);
    expect(again.hasMore).toBe(false);
  });
  it("incremental polling finds only new mail", async () => {
    await append("before");
    const a = adapter();
    const first = await a.fullSync({ windowDays: 30, pageSize: 10 });
    await append("after");
    const next = await a.incrementalSync(first.cursor, { pageSize: 10 });
    expect(ups(next.changes).length).toBe(1);
    expect(Buffer.from(ups(next.changes)[0]?.raw as Uint8Array).toString()).toContain("Subject: after");
  });
  it("UIDLs are stable across sessions, and an id is the UIDL", async () => {
    await append("stable");
    const a = adapter();
    const one = await a.fullSync({ windowDays: 30, pageSize: 10 });
    const two = await a.fullSync({ windowDays: 30, pageSize: 10 });
    expect(ups(two.changes)[0]?.remoteId).toBe(ups(one.changes)[0]?.remoteId);
  });
  it("leaves mail on the server: a POP3 import deletes nothing", async () => {
    await append("stays");
    await adapter().fullSync({ windowDays: 30, pageSize: 10 });
    expect(await other(async c => { await c.mailboxOpen("INBOX"); return c.mailbox && (c.mailbox as { exists: number }).exists; })).toBe(1);
  });
  it("the seen list forgets what the server no longer lists", async () => {
    await append("gone");
    await append("kept");
    const a = adapter();
    const first = await a.fullSync({ windowDays: 30, pageSize: 10 });
    expect(JSON.parse(first.cursor).seen.length).toBe(2);
    await other(async c => { await c.mailboxOpen("INBOX"); await c.messageDelete("1"); });
    const next = await a.incrementalSync(first.cursor, { pageSize: 10 });
    expect(next.changes).toEqual([]);
    expect(JSON.parse(next.cursor).seen.length).toBe(1);
  });
  it("the sync window applies, by the server's Received date rather than the sender's Date", async () => {
    const old = new Date(Date.now() - 90 * 86_400_000).toUTCString();
    await other(c => c.append("INBOX", Buffer.from(`Received: from a by b; ${old}\r\nFrom: a@example.org\r\nSubject: old\r\nDate: ${new Date().toUTCString()}\r\n\r\nx\r\n`)));
    await other(c => c.append("INBOX", Buffer.from(`Received: from a by b; ${new Date().toUTCString()}\r\nFrom: a@example.org\r\nSubject: backdated\r\nDate: ${old}\r\n\r\nx\r\n`)));
    const { changes } = await adapter().fullSync({ windowDays: 30, pageSize: 10 });
    const got = ups(changes).map(c => /Subject: (\S+)/.exec(Buffer.from(c.raw as Uint8Array).toString())?.[1]);
    expect(got).toEqual(["backdated"]);
  });
  it("write operations stay refused", async () => {
    await expect(adapter().applyChange("x", { isRead: true })).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(adapter().send({ from: { address: user }, to: [{ address: user }], subject: "x", text: "x", messageId: "<x@example.net>" })).rejects.toBeInstanceOf(UnsupportedOperationError);
  });
});
