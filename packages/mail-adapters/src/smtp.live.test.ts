import { readFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundMessage } from "@aegis/domain/mail";
import { createAdapter, type AdapterCredential } from "./index";
import { SmtpError, createSmtpSender } from "./smtp";
import type { HostGuard } from "./ssrf";

/**
 * The real sender through real Postfix (SASL by Dovecot, delivery by LMTP) into a real mailbox, read back over IMAP.
 * Skipped unless IMAP_TEST_HOST and SMTP_TEST_PORT are set: see infra/local/live-servers.sh. That server has one hosted
 * domain, example.net, and anything else bounces inside the container.
 */
const env = process.env;
const host = env.IMAP_TEST_HOST;
const smtpsPort = Number(env.SMTP_TEST_PORT);
const starttlsPort = Number(env.SMTP_TEST_STARTTLS_PORT);
const imapPort = Number(env.IMAP_TEST_PORT);
const servername = env.IMAP_TEST_SERVERNAME ?? "localhost";
const password = env.IMAP_TEST_PASS ?? "";
const ca = env.IMAP_TEST_CA_FILE ? readFileSync(env.IMAP_TEST_CA_FILE) : undefined;
const SENDER = "smtpsender@example.net", RCPT = "smtprcpt@example.net", BCC = "smtpbcc@example.net";

const guard = (name = servername): HostGuard => ({ checkHost: async (_h, p) => ({ ip: host as string, family: 4, port: p, hostname: name, servername: name }) });
const sender = (over: { security?: "tls" | "starttls"; password?: string; guard?: HostGuard; ca?: Buffer | null } = {}) => {
  const security = over.security ?? "tls";
  return createSmtpSender({ host: servername, port: security === "tls" ? smtpsPort : starttlsPort, security }, { username: SENDER, password: over.password ?? password, email: SENDER }, { hostGuard: over.guard ?? guard(), ...(over.ca === null ? {} : { ca: over.ca ?? ca }) });
};

let serial = 0;
const addr = (address: string) => ({ address });
const outbound = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({ from: addr(SENDER), to: [addr(RCPT)], subject: "Hello from the live test", text: "Plain body.\n", messageId: `<smtp-live-${Date.now()}-${++serial}@example.net>`, ...over });

async function mailbox<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = new ImapFlow({ host: host as string, port: imapPort, secure: true, servername, auth: { user, pass: password }, tls: { ca }, logger: false, disableAutoIdle: true });
  c.on("error", () => undefined);
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}
const clear = (user: string) => mailbox(user, async c => { await c.mailboxOpen("INBOX"); await c.messageDelete("1:*").catch(() => undefined); });
/** Polls, because delivery happens after Postfix accepts. Returns the raw message with this Message-ID. */
async function delivered(user: string, messageId: string, waitMs = 15_000): Promise<string | null> {
  const end = Date.now() + waitMs;
  for (;;) {
    const raw = await mailbox(user, async c => {
      await c.mailboxOpen("INBOX");
      const uids = await c.search({ header: { "message-id": messageId } }, { uid: true });
      if (!uids || !uids.length) return null;
      const row = await c.fetchOne(String(uids[0]), { source: true }, { uid: true });
      return row ? (row.source as Buffer).toString("utf8") : null;
    });
    if (raw || Date.now() > end) return raw;
    await new Promise(r => setTimeout(r, 200));
  }
}

describe.skipIf(!host || !env.SMTP_TEST_PORT)("SMTP sender against real Postfix", () => {
  beforeEach(async () => { await clear(RCPT); await clear(BCC); });

  it("authenticates over direct TLS and over STARTTLS, without sending", async () => {
    expect(await sender().test()).toEqual({ ok: true });
    expect(await sender({ security: "starttls" }).test()).toEqual({ ok: true });
  });
  it("a wrong password is auth_failed", async () => {
    expect(await sender({ password: "nope" }).test()).toMatchObject({ ok: false, problem: "auth_failed" });
  });
  it("refuses an untrusted certificate, on either port", async () => {
    expect(await sender({ ca: null }).test()).toMatchObject({ ok: false, problem: "tls_failed" });
    expect(await sender({ ca: null, security: "starttls" }).test()).toMatchObject({ ok: false, problem: "tls_failed" });
  });
  it("refuses a trusted certificate for a different name", async () => {
    expect(await sender({ guard: guard("mail.example.net") }).test()).toMatchObject({ ok: false, problem: "tls_failed" });
  });
  it.each(["tls", "starttls"] as const)("delivers over %s, keeping our Message-ID and exact body", async security => {
    const m = outbound({ text: "Line one.\nA line with a leading dot:\n.dot\nDone.\n" });
    const result = await sender({ security }).send(m);
    expect(Date.parse(result.acceptedAt)).not.toBeNaN();
    const raw = await delivered(RCPT, m.messageId);
    expect(raw).toContain(`Message-ID: ${m.messageId}`);
    expect(raw).toContain("\n.dot\r\n");
    // Proof it went through the MTA, not around it.
    expect(raw).toMatch(/Received: from .*\r?\n?.*by localhost \(Postfix\)/);
  });
  it("delivers Bcc without leaking it into the message", async () => {
    const m = outbound({ bcc: [addr(BCC)] });
    await sender().send(m);
    const seenByTo = await delivered(RCPT, m.messageId);
    const seenByBcc = await delivered(BCC, m.messageId);
    expect(seenByTo).not.toBeNull();
    expect(seenByBcc).not.toBeNull();
    for (const raw of [seenByTo, seenByBcc]) {
      expect(raw).not.toMatch(/^Bcc:/im);
      expect(raw).not.toContain(BCC.split("@")[0] + "@example.net\r\nSubject");
    }
    expect(seenByTo).not.toContain(BCC);
  });
  it("a non-ASCII subject and body survive", async () => {
    const m = outbound({ subject: "Über naïve 日本語", text: "Grüße 日本語\n" });
    await sender().send(m);
    const raw = await delivered(RCPT, m.messageId);
    expect(raw).toMatch(/Subject: =\?UTF-8\?/);
  });
  it("a refused recipient, when it's the only one, fails with the server's code and no server text", async () => {
    const err = await sender().send(outbound({ to: [addr("nobody@example.net")] })).catch(e => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).responseCode).toBeGreaterThanOrEqual(500);
    expect((err as SmtpError).message).not.toContain("nobody");
  });
  it("a sender this login doesn't own is refused by the server", async () => {
    const err = await sender().send(outbound({ from: addr(RCPT) })).catch(e => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).responseCode).toBeGreaterThanOrEqual(500);
  });
  it("partial recipient refusal is reported, not swallowed", async () => {
    const m = outbound({ to: [addr(RCPT), addr("nobody@example.net")] });
    const result = await sender().send(m);
    expect(await delivered(RCPT, m.messageId)).not.toBeNull();
    expect(result.rejectedRecipients).toEqual(["nobody@example.net"]);
  });
  it("the IMAP adapter sends through it, and refuses for a read-only account", async () => {
    const cred: AdapterCredential = { kind: "password", username: SENDER, password, imap: { host: servername, port: imapPort, security: "tls" }, smtp: { host: servername, port: smtpsPort, security: "tls" } };
    const deps = { hostGuard: guard(), ...(ca ? { ca } : {}) };
    const a = createAdapter("imap", { email: SENDER, readOnly: false }, cred, deps);
    expect(await a.testConnection()).toMatchObject({ ok: true });
    const m = outbound();
    await a.send(m);
    expect(await delivered(RCPT, m.messageId)).not.toBeNull();
    await expect(createAdapter("imap", { email: SENDER, readOnly: true }, cred, deps).send(outbound())).rejects.toThrow(/read-only/);
  });
  it("mail to a domain this server doesn't host goes nowhere: refused outright", async () => {
    const err = await sender().send(outbound({ to: [addr("someone@elsewhere.invalid")] })).catch(e => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).responseCode).toBeGreaterThanOrEqual(500);
  });
});
