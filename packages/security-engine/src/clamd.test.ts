import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeAttachments, ClamdScanner, parseClamdReply, type AttachmentInput } from "./attachments";

const attachment = (content: Buffer, filename = "a.bin"): AttachmentInput => ({ filename, contentType: "application/octet-stream", size: content.length, sha256: `sha-${filename}`, content });

/** Decodes what clamd would see: the command, then length-prefixed chunks up to a zero-length terminator. */
class InstreamDecoder {
  #buffer = Buffer.alloc(0);
  command: string | undefined;
  chunks: Buffer[] = [];
  terminated = false;
  push(data: Buffer) {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    if (this.command === undefined) {
      const nul = this.#buffer.indexOf(0);
      if (nul < 0) return;
      this.command = this.#buffer.toString("latin1", 0, nul);
      this.#buffer = this.#buffer.subarray(nul + 1);
    }
    while (!this.terminated && this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0) { this.terminated = true; this.#buffer = this.#buffer.subarray(4); return; }
      if (this.#buffer.length < 4 + length) return;
      this.chunks.push(this.#buffer.subarray(4, 4 + length));
      this.#buffer = this.#buffer.subarray(4 + length);
    }
  }
}

type Behaviour = (socket: Socket, decoder: InstreamDecoder) => void;
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r)))); });

/** An in-process server that speaks the framing, then acts out the behaviour once the terminator arrives. */
async function fakeClamd(onDone: Behaviour, decoders: InstreamDecoder[] = []): Promise<number> {
  const server = createServer(socket => {
    socket.on("error", () => undefined);
    const decoder = new InstreamDecoder();
    decoders.push(decoder);
    socket.on("data", data => { const was = decoder.terminated; decoder.push(data); if (!was && decoder.terminated) onDone(socket, decoder); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
const reply = (text: string): Behaviour => socket => { socket.end(text); };

describe("ClamdScanner framing", () => {
  it("sends zINSTREAM, big-endian length-prefixed chunks of at most 64 KiB, and a zero terminator", async () => {
    const decoders: InstreamDecoder[] = [];
    const content = Buffer.alloc(200 * 1024, 0x61);
    const port = await fakeClamd(reply("stream: OK\0"), decoders);
    expect(await new ClamdScanner("127.0.0.1", port).scan(attachment(content))).toEqual({ status: "clean", engine: "clamd" });
    const [d] = decoders;
    expect(d?.command).toBe("zINSTREAM");
    expect(d?.terminated).toBe(true);
    expect(d?.chunks.length).toBe(4);
    expect(d?.chunks.every(c => c.length <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(d?.chunks ?? []).equals(content)).toBe(true);
  });
  it("an empty attachment sends only the terminator", async () => {
    const decoders: InstreamDecoder[] = [];
    const port = await fakeClamd(reply("stream: OK\0"), decoders);
    expect((await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.alloc(0)))).status).toBe("clean");
    expect(decoders[0]?.chunks).toEqual([]);
  });
  it("reports the signature from a FOUND reply", async () => {
    const port = await fakeClamd(reply("stream: Win.Test.EICAR_HDB-1 FOUND\0"));
    expect(await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.from("x")))).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1", engine: "clamd" });
  });
});

describe("ClamdScanner never reads an uncertain answer as clean", () => {
  it.each([
    ["an error that contains OK", "stream: BROKEN pipe ERROR\0"],
    ["an error that contains FOUND", "File path NOT FOUND. ERROR\0"],
    ["the size-limit error", "INSTREAM size limit exceeded. ERROR\0"],
    ["a reply cut off before the terminator", "stream: OK"],
    ["a truncated word", "stream: O\0"],
    ["a reply for something other than the stream", "OK\0"],
    ["two replies", "stream: OK\0stream: Eicar FOUND\0"],
    ["an empty reply", ""],
  ])("%s is an error", async (_name, text) => {
    const port = await fakeClamd(reply(text));
    expect((await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.from("x")))).status).toBe("error");
  });
  it("a server that sends more than any real reply is cut off", async () => {
    const port = await fakeClamd(socket => { socket.write(`stream: ${"A".repeat(64 * 1024)}`); });
    expect((await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.from("x")))).status).toBe("error");
  });
  it("connection refused is an error", async () => {
    const port = await fakeClamd(reply("stream: OK\0"));
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(r))));
    expect((await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.from("x")))).status).toBe("error");
  });
  it("a connection reset mid-reply is an error", async () => {
    const port = await fakeClamd(socket => { socket.write("stream: O"); setImmediate(() => socket.resetAndDestroy()); });
    expect((await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.from("x")))).status).toBe("error");
  });
  it("a silent server times out as an error", async () => {
    const port = await fakeClamd(() => undefined);
    expect((await new ClamdScanner("127.0.0.1", port, 50).scan(attachment(Buffer.from("x")))).status).toBe("error");
  });
  it("a server that trickles past the deadline is an error", async () => {
    const port = await fakeClamd(socket => { const t = setInterval(() => { if (socket.destroyed) clearInterval(t); else socket.write("s"); }, 10); });
    expect((await new ClamdScanner("127.0.0.1", port, 1000, 100).scan(attachment(Buffer.from("x")))).status).toBe("error");
  });
  it("closing mid-upload while still sending is an error", async () => {
    const server = createServer(socket => { socket.on("error", () => undefined); socket.once("data", () => socket.end("INSTREAM size limit exceeded. ERROR\0")); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    expect((await new ClamdScanner("127.0.0.1", port).scan(attachment(Buffer.alloc(8 * 1024 * 1024, 0x41)))).status).toBe("error");
  });
});

describe("parseClamdReply", () => {
  it("separates a scan-limit alert from malware", () => {
    expect(parseClamdReply(Buffer.from("stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0"))).toEqual({ status: "unscannable", signature: "Heuristics.Limits.Exceeded.MaxFileSize" });
    expect(parseClamdReply(Buffer.from("stream: Heuristics.Encrypted.Zip FOUND\0")).status).toBe("infected");
  });
  it("refuses control characters in a reply", () => {
    expect(parseClamdReply(Buffer.from("stream: A\nstream: OK\0")).status).toBe("error");
  });
});

describe("analyzeAttachments with a clamd verdict", () => {
  it("a scan-limit alert costs completeness and says so, without calling it malware", async () => {
    const port = await fakeClamd(reply("stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0"));
    const r = await analyzeAttachments([attachment(Buffer.from("x"), "big.pdf")], new ClamdScanner("127.0.0.1", port));
    expect(r.verdicts.get("sha-big.pdf")).toBe("unscannable");
    expect(r.completenessPenalty).toBeGreaterThan(0);
    expect(r.evidence.map(e => e.code)).toContain("ATT_SCAN_LIMIT_EXCEEDED");
    expect(r.evidence.map(e => e.code)).not.toContain("ATT_MALWARE_SIGNATURE");
  });
  it("an unavailable clamd costs completeness", async () => {
    const port = await fakeClamd(reply("stream: BROKEN pipe ERROR\0"));
    const r = await analyzeAttachments([attachment(Buffer.from("x"), "a.pdf")], new ClamdScanner("127.0.0.1", port));
    expect(r.verdicts.get("sha-a.pdf")).toBe("error");
    expect(r.completenessPenalty).toBeGreaterThan(0);
    expect(r.provenance).toContain("clamd:error");
  });
});
