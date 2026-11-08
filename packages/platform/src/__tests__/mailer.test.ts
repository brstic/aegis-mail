import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generate } from "selfsigned";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { LocalDevKms } from "@aegis/cryptography";
import { createSmtpMailer, drainJobs, MailConfigError, openUnderKms, queueMail, resolveMailer, sealUnderKms, smtpTransportOptions, type Platform, makeLogger } from "../index";
import { testPlatform } from "./harness";

const servers: SMTPServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });

let pems: { key: string; cert: string };
beforeAll(async () => {
  const g = await generate([{ name: "commonName", value: "smtp.relay.example" }], { algorithm: "sha256", keySize: 2048, extensions: [{ name: "basicConstraints", cA: true, critical: true }, { name: "subjectAltName", altNames: [{ type: 2, value: "smtp.relay.example" }] }] } as never);
  pems = { key: g.private, cert: g.cert };
});

async function smtpServer(opts: Partial<SMTPServerOptions> = {}) {
  const received: { from: string; to: string[]; raw: string; secure: boolean }[] = [];
  const logins: { secure: boolean }[] = [];
  const server = new SMTPServer({
    logger: false, authOptional: true, key: pems.key, cert: pems.cert,
    onAuth(_a, session, cb) { logins.push({ secure: session.secure }); cb(null, { user: "u" }); },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => { received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map(r => r.address), raw: Buffer.concat(chunks).toString(), secure: session.secure }); cb(); });
    },
    ...opts,
  });
  servers.push(server);
  server.on("error", () => undefined);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.server.address() as { port: number }).port, received, logins };
}
const mail = { to: "you@example.org", subject: "Hello", text: "Body with a link https://app.example/x" };

describe("TLS rules", () => {
  it("requires STARTTLS and verifies certificates for a remote relay", () => {
    expect(smtpTransportOptions("smtp://user:p%40ss@smtp.relay.example:587")).toMatchObject({ host: "smtp.relay.example", port: 587, secure: false, requireTLS: true, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" }, auth: { user: "user", pass: "p@ss" } });
  });
  it("uses implicit TLS for smtps", () => {
    expect(smtpTransportOptions("smtps://smtp.relay.example")).toMatchObject({ port: 465, secure: true, requireTLS: false, tls: { rejectUnauthorized: true } });
  });
  it("only relaxes for this machine", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) expect(smtpTransportOptions(`smtp://${host}:2525`)).toMatchObject({ requireTLS: false });
    for (const host of ["127.0.0.1.nip.io", "localhost.evil.example", "10.0.0.1", "192.168.1.1"]) expect(smtpTransportOptions(`smtp://${host}:587`)).toMatchObject({ requireTLS: true });
  });
  it("the URL can't turn TLS off", () => {
    expect(() => smtpTransportOptions("smtp://smtp.relay.example:587?ignoreTLS=true")).toThrow(MailConfigError);
    expect(() => smtpTransportOptions("smtp://smtp.relay.example:587?secure=false")).toThrow(MailConfigError);
    expect(() => smtpTransportOptions("http://smtp.relay.example")).toThrow(MailConfigError);
    expect(() => smtpTransportOptions("not a url")).toThrow(MailConfigError);
  });
  it("refuses a from address that could inject headers", () => {
    expect(() => createSmtpMailer("smtp://localhost:2525", "a@b.example\r\nBcc: x@y.example")).toThrow(MailConfigError);
    expect(() => createSmtpMailer("smtp://localhost:2525", "nope")).toThrow(MailConfigError);
  });
});

describe("real SMTP to a local server", () => {
  it("delivers over plain connection only on localhost", async () => {
    const { port, received } = await smtpServer({ disabledCommands: ["STARTTLS"] });
    await createSmtpMailer(`smtp://127.0.0.1:${port}`, "Aegis <no-reply@aegis.example>").send(mail);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: "no-reply@aegis.example", to: ["you@example.org"], secure: false });
    expect(received[0]!.raw).toContain("Subject: Hello");
    expect(received[0]!.raw).toContain("Auto-Submitted: auto-generated");
  });
  it("a remote relay that won't do STARTTLS gets nothing, and never sees the password", async () => {
    const { port, received, logins } = await smtpServer({ hideSTARTTLS: true, disabledCommands: ["STARTTLS"], authOptional: false });
    const m = createSmtpMailer("smtp://user:secret@smtp.relay.example:587", "a@b.example", { host: "127.0.0.1", port, tls: { servername: "smtp.relay.example", ca: pems.cert } });
    await expect(m.send(mail)).rejects.toBeDefined();
    expect(received).toHaveLength(0);
    expect(logins).toHaveLength(0);
  });
  it("a remote relay with a certificate we don't trust gets nothing", async () => {
    const { port, received } = await smtpServer();
    const m = createSmtpMailer("smtp://smtp.relay.example:587", "a@b.example", { host: "127.0.0.1", port, tls: { servername: "smtp.relay.example" } });
    await expect(m.send(mail)).rejects.toBeDefined();
    expect(received).toHaveLength(0);
  });
  it("a certificate for another name gets nothing", async () => {
    const { port, received } = await smtpServer();
    const m = createSmtpMailer("smtp://other.relay.example:587", "a@b.example", { host: "127.0.0.1", port, tls: { servername: "other.relay.example", ca: pems.cert } });
    await expect(m.send(mail)).rejects.toBeDefined();
    expect(received).toHaveLength(0);
  });
  it("delivers over verified STARTTLS", async () => {
    const { port, received } = await smtpServer();
    await createSmtpMailer("smtp://smtp.relay.example:587", "a@b.example", { host: "127.0.0.1", port, tls: { servername: "smtp.relay.example", ca: pems.cert } }).send(mail);
    expect(received).toHaveLength(1);
    expect(received[0]!.secure).toBe(true);
  });
});

describe("which mailer a process gets", () => {
  const deps = { db: {} as never, kms: new LocalDevKms(randomBytes(32)) };
  it("production with no relay gets none", () => expect(resolveMailer({ demoMode: false }, { NODE_ENV: "production" }, deps)).toBeNull());
  it("demo mode records, even with a relay configured and in production, so a demo can't mail real people", () => {
    expect(resolveMailer({ demoMode: true, mail: { smtpUrl: "smtp://smtp.relay.example", from: "a@b.example" } }, { NODE_ENV: "production" }, deps)?.kind).toBe("outbox");
  });
  it("a configured relay is used outside demo mode", () => expect(resolveMailer({ demoMode: false, mail: { smtpUrl: "smtp://smtp.relay.example", from: "a@b.example" } }, { NODE_ENV: "production" }, deps)?.kind).toBe("smtp"));
  it("local development with nothing configured records", () => expect(resolveMailer({ demoMode: false }, {}, deps)?.kind).toBe("outbox"));
});

describe("sealing", () => {
  const kms = new LocalDevKms(randomBytes(32));
  it("round trips, and is bound to its context", async () => {
    const blob = await sealUnderKms(kms, "outbound_mail:a", mail);
    expect(blob.toString("latin1")).not.toContain("Hello");
    expect(await openUnderKms(kms, "outbound_mail:a", blob)).toEqual(mail);
    await expect(openUnderKms(kms, "outbound_mail:b", blob)).rejects.toBeDefined();
  });
});

describe("the queue, end to end to a real SMTP server", () => {
  let p: Platform, drop: () => Promise<void>;
  afterEach(async () => { await drop?.(); });
  const queued = (p: Platform) => p.db.withSystem(t => t.one<any>("SELECT state, content_enc, error_code FROM outbound_mail ORDER BY created_at DESC LIMIT 1"));
  it("delivers through the worker, then wipes the rendered mail", async () => {
    const { port, received } = await smtpServer({ disabledCommands: ["STARTTLS"] });
    ({ p, drop } = await testPlatform({ mailer: createSmtpMailer(`smtp://127.0.0.1:${port}`, "a@b.example") }));
    await queueMail(p, "digest", mail);
    expect((await queued(p)).state).toBe("queued");
    await drainJobs(p);
    expect(received).toHaveLength(1);
    expect(await queued(p)).toMatchObject({ state: "sent", content_enc: null });
  });
  it("retries a failed send, then gives up, wipes it, and logs only a code", async () => {
    const lines: string[] = [];
    ({ p, drop } = await testPlatform({ mailer: createSmtpMailer("smtp://127.0.0.1:1", "a@b.example"), log: makeLogger(l => lines.push(l)) }));
    await queueMail(p, "password_reset", { to: "secret-person@example.org", subject: "S", text: "https://app.example/reset-password/TOKENVALUE" });
    await drainJobs(p);
    expect((await queued(p)).state).toBe("queued");
    const job = await p.db.withSystem(t => t.one<any>("SELECT id, attempts, last_error_code FROM jobs WHERE kind='mail.send'"));
    expect(job.attempts).toBe(1);
    await p.db.withSystem(t => t.query("UPDATE jobs SET attempts=max_attempts - 1, run_at=now() WHERE id=$1", [job.id]));
    await drainJobs(p);
    expect(await queued(p)).toMatchObject({ state: "failed", content_enc: null });
    expect(lines.join("\n")).not.toContain("TOKENVALUE");
    expect(lines.join("\n")).not.toContain("secret-person");
  });
});
