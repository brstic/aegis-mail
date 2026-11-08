import { afterEach, describe, expect, it } from "vitest";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { SendOutcomeUnknownError, type OutboundMessage } from "@aegis/domain/mail";
import { HostBlockedError, SmtpError, classifyConnectionError, createHostGuard, createSmtpSender } from "./index";
import { TEST_HOST, loopbackGuard, testCert } from "./test-tls";

const servers: SMTPServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface Received { from: string; to: string[]; raw: string }

async function start(opts: Partial<SMTPServerOptions> = {}, onData?: SMTPServerOptions["onData"]) {
  const { key, cert } = await testCert();
  const received: Received[] = [];
  const logins: Array<{ user: string | undefined; secure: boolean }> = [];
  const server = new SMTPServer({
    key, cert,
    logger: false,
    authOptional: false,
    onAuth(auth, session, cb) {
      logins.push({ user: auth.username, secure: session.secure });
      if (auth.password === "right-pass") cb(null, { user: auth.username });
      else cb(Object.assign(new Error("Invalid credentials"), { responseCode: 535 }));
    },
    onData: onData ?? ((stream, session, cb) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? (session.envelope.mailFrom.address) : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString(),
        });
        cb();
      });
    }),
    ...opts,
  });
  servers.push(server);
  server.on("error", () => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.server.address() as { port: number }).port;
  return { port, received, logins, cert };
}

const message: OutboundMessage = {
  from: { name: "Me", address: "me@example.com" },
  to: [{ address: "you@example.org" }],
  bcc: [{ address: "hidden@example.org" }],
  subject: "Hello",
  text: "BODY-SENTINEL",
  messageId: "<our-id-1@aegis.test>",
};

function sender(port: number, cert: string, over: Partial<{ security: "tls" | "starttls"; password: string; timeoutMs: number; hostname: string }> = {}) {
  return createSmtpSender(
    { host: TEST_HOST, port: 587, security: over.security ?? "starttls" },
    { username: "me@example.com", password: over.password ?? "right-pass", email: "me@example.com" },
    { hostGuard: loopbackGuard(port, over.hostname ? { hostname: over.hostname } : {}), ca: cert, now: () => 1_000, ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}) },
  );
}

describe("send over a real SMTP conversation", () => {
  it("delivers over STARTTLS with our Message-ID, verifying the certificate", async () => {
    const { port, received, logins, cert } = await start();
    const result = await sender(port, cert).send(message);
    expect(result).toEqual({ acceptedAt: new Date(1000).toISOString() });
    expect(received).toHaveLength(1);
    expect(received[0]!.raw).toMatch(/^Message-ID: <our-id-1@aegis\.test>\r?$/m);
    expect(received[0]!.raw).toContain("BODY-SENTINEL");
    expect(received[0]!.from).toBe("me@example.com");
    expect(logins).toEqual([{ user: "me@example.com", secure: true }]);
  });

  it("sends Bcc in the envelope but not in the message", async () => {
    const { port, received, cert } = await start();
    await sender(port, cert).send(message);
    expect(received[0]!.to.sort()).toEqual(["hidden@example.org", "you@example.org"]);
    expect(received[0]!.raw).not.toMatch(/hidden@example\.org/);
  });

  it("delivers over implicit TLS", async () => {
    const { port, received, logins, cert } = await start({ secure: true });
    await sender(port, cert, { security: "tls" }).send(message);
    expect(received).toHaveLength(1);
    expect(logins[0]!.secure).toBe(true);
  });

  it("refuses to continue when the server won't do STARTTLS, and never sends the password", async () => {
    const { port, received, logins, cert } = await start({ hideSTARTTLS: true, disabledCommands: ["STARTTLS"] });
    const err = await sender(port, cert).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.problem).toBe("tls_failed");
    expect(logins).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it("refuses a certificate for another hostname even though the IP is right", async () => {
    const { port, received, logins, cert } = await start();
    const err = await sender(port, cert, { hostname: "other.example.net" }).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.problem).toBe("tls_failed");
    expect(logins).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it("refuses a certificate it doesn't trust, with no permissive setting anywhere", async () => {
    const { port } = await start();
    const err = await createSmtpSender(
      { host: TEST_HOST, port: 587, security: "starttls" },
      { username: "me@example.com", password: "right-pass", email: "me@example.com" },
      { hostGuard: loopbackGuard(port) },
    ).send(message).catch((e) => e);
    expect(err.problem).toBe("tls_failed");
  });

  it("refuses plaintext settings at construction", () => {
    expect(() => createSmtpSender(
      { host: TEST_HOST, port: 25, security: "none" as "tls" },
      { username: "u", password: "p", email: "u@x" },
    )).toThrow(TypeError);
  });
});

describe("failure classification", () => {
  it("classifies a bad password as auth_failed", async () => {
    const { port, received, cert } = await start();
    const err = await sender(port, cert, { password: "wrong-pass-SENTINEL" }).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError);
    expect(err.problem).toBe("auth_failed");
    expect(err.message).not.toContain("SENTINEL");
    expect(received).toHaveLength(0);
  });

  it("test() reports auth failure and success without sending anything", async () => {
    const { port, received, cert } = await start();
    expect(await sender(port, cert, { password: "nope" }).test()).toMatchObject({ ok: false, problem: "auth_failed" });
    expect(await sender(port, cert).test()).toEqual({ ok: true });
    expect(received).toHaveLength(0);
  });

  it("gives an iCloud app-password hint on auth failure", async () => {
    const { port, cert } = await start();
    const icloud = createSmtpSender(
      { host: "smtp.mail.me.com", port: 587, security: "starttls" },
      { username: "jane", password: "nope", email: "jane@icloud.com" },
      { hostGuard: loopbackGuard(port, { hostname: TEST_HOST }), ca: cert },
    );
    const result = await icloud.test();
    expect(result.problem).toBe("auth_failed");
    expect(result.detail).toMatch(/app-specific password/);
  });

  it("logs into iCloud SMTP with the full address, even if IMAP uses the local part", async () => {
    const { port, logins, cert } = await start();
    const icloud = createSmtpSender(
      { host: "smtp.mail.me.com", port: 587, security: "starttls" },
      { username: "jane", password: "right-pass", email: "jane@icloud.com" },
      { hostGuard: loopbackGuard(port, { hostname: TEST_HOST }), ca: cert },
    );
    await icloud.test();
    expect(logins[0]!.user).toBe("jane@icloud.com");
  });

  it("classifies a refused connection and treats it as not sent", async () => {
    const { port, cert } = await start();
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    const err = await sender(port, cert).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.problem).toBe("host_unreachable");
  });

  it("treats rejected recipients as a plain failure", async () => {
    const { port, cert } = await start({
      onRcptTo(_addr, _session, cb) { cb(Object.assign(new Error("No such user"), { responseCode: 550 })); },
    });
    const err = await sender(port, cert).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError);
    expect(err.responseCode).toBe(550);
    expect(err.message).not.toContain("No such user");
  });

  it("reports recipients refused at RCPT when the others were accepted", async () => {
    const { port, cert } = await start({
      onRcptTo(addr, _session, cb) {
        if (addr.address === "refused@example.org") cb(Object.assign(new Error("No such user"), { responseCode: 550 }));
        else cb();
      },
    });
    const result = await sender(port, cert).send({ ...message, to: [{ address: "ok@example.org" }, { address: "refused@example.org" }] });
    expect(result.rejectedRecipients).toEqual(["refused@example.org"]);
    expect(Date.parse(result.acceptedAt)).not.toBeNaN();
  });

  it("leaves rejectedRecipients off a clean send", async () => {
    const { port, cert } = await start();
    expect(await sender(port, cert).send(message)).not.toHaveProperty("rejectedRecipients");
  });

  it("carries the guard's HostBlockedError through untouched", async () => {
    const strict = createHostGuard({ resolver: async () => [{ address: "10.0.0.1" }] });
    const blocked = createSmtpSender(
      { host: "mail.example.org", port: 587, security: "starttls" },
      { username: "u", password: "p", email: "u@x" },
      { hostGuard: strict },
    );
    await expect(blocked.send(message)).rejects.toBeInstanceOf(HostBlockedError);
    expect(await blocked.test()).toMatchObject({ ok: false, problem: "host_blocked" });
  });

  it("classifies by code, not message text", () => {
    expect(classifyConnectionError({ code: "EAUTH" })).toBe("auth_failed");
    expect(classifyConnectionError({ code: "ESOCKET", originalCode: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("tls_failed");
    expect(classifyConnectionError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyConnectionError({ code: "ECONNECTION" })).toBe("host_unreachable");
    expect(classifyConnectionError(new Error("password rejected"))).toBe("protocol_error");
  });
});

describe("send outcome after DATA", () => {
  it("is unknown when the connection drops after the message is written", async () => {
    let sawMessage = false;
    const { port, cert } = await start({}, (stream) => {
      stream.on("data", () => undefined);
      stream.on("end", () => {
        sawMessage = true;
        // End the socket the way a crash would, with no reply to the message.
        for (const c of (servers[servers.length - 1] as unknown as { connections: Set<{ _socket: { destroy(): void } }> }).connections) c._socket.destroy();
      });
    });
    const err = await sender(port, cert).send(message).catch((e) => e);
    expect(sawMessage).toBe(true);
    expect(err).toBeInstanceOf(SendOutcomeUnknownError);
    expect(err.message).not.toContain("SENTINEL");
  });

  it("is unknown when the server goes silent after the message is written", async () => {
    const { port, cert } = await start({}, (stream) => {
      stream.on("data", () => undefined);
      // Never calls back, so the final reply never comes.
    });
    const err = await sender(port, cert, { timeoutMs: 400 }).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SendOutcomeUnknownError);
  });

  it.each([[554, "Rejected as spam BODY-SENTINEL"], [451, "Try again later"]])("is a definite failure when the server replies %i after DATA", async (responseCode, text) => {
    const { port, cert } = await start({}, (stream, _session, cb) => {
      stream.on("data", () => undefined);
      stream.on("end", () => cb(Object.assign(new Error(text), { responseCode })));
    });
    const err = await sender(port, cert).send(message).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err).not.toBeInstanceOf(SendOutcomeUnknownError);
    expect(err.responseCode).toBe(responseCode);
    expect(err.message).not.toContain("SENTINEL");
  });
});
