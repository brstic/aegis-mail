import { crc32, deflateRawSync } from "node:zlib";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { analyzeAttachments, ClamdScanner, type AttachmentInput } from "./attachments";

/**
 * Against a real clamd. Skipped unless CLAMD_TEST_HOST is set. See infra/local/live-servers.sh.
 * CLAMD_TEST_STREAM_MAX_BYTES is clamd's StreamMaxLength (default 100 MiB, clamd's own default).
 * CLAMD_TEST_MAX_FILE_BYTES enables the MaxFileSize check, which also needs `AlertExceedsMax yes` on that clamd.
 */
const host = process.env.CLAMD_TEST_HOST;
const port = Number(process.env.CLAMD_TEST_PORT || 3310);
const streamMax = Number(process.env.CLAMD_TEST_STREAM_MAX_BYTES || 100 * 1024 * 1024);
const maxFile = process.env.CLAMD_TEST_MAX_FILE_BYTES ? Number(process.env.CLAMD_TEST_MAX_FILE_BYTES) : undefined;

// Assembled so this file isn't itself quarantined by an antivirus on a developer's machine.
const EICAR = Buffer.from(`X5O!P%@AP[4\\PZX54(P^)7CC)7}$${"EICAR"}-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`);
const input = (content: Buffer, filename = "a.bin"): AttachmentInput => ({ filename, contentType: "application/octet-stream", size: content.length, sha256: `sha-${filename}`, content });

/** One-entry ZIP. Deflated, so clamd has to unpack it to find anything. */
function zipOf(name: string, data: Buffer): Buffer {
  const deflated = deflateRawSync(data);
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  const end = Buffer.alloc(22);
  const centralOffset = local.length + nameBytes.length + deflated.length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, deflated, central, nameBytes, end]);
}

describe.skipIf(!host)("ClamdScanner against real clamd", () => {
  const scanner = new ClamdScanner(host as string, port, 60_000, 240_000);

  it("detects EICAR, naming the signature", async () => {
    const v = await scanner.scan(input(EICAR));
    expect(v.status).toBe("infected");
    expect(v.signature).toMatch(/eicar/i);
  });
  it("detects EICAR inside a deflated ZIP", async () => {
    const v = await scanner.scan(input(zipOf("invoice.txt", EICAR), "a.zip"));
    expect(v.status).toBe("infected");
    expect(v.signature).toMatch(/eicar/i);
  });
  it("reports an ordinary file clean", async () => {
    expect((await scanner.scan(input(Buffer.from("Quarterly figures attached, see you on Monday.\n"))))).toEqual({ status: "clean", engine: "clamd" });
  });
  it("reports an empty file clean", async () => {
    expect((await scanner.scan(input(Buffer.alloc(0)))).status).toBe("clean");
  });
  it("handles a file spanning many chunks", async () => {
    expect((await scanner.scan(input(Buffer.alloc(1024 * 1024, "plain text padding\n")))).status).toBe("clean");
  });
  it("past StreamMaxLength, reports error rather than clean", async () => {
    const v = await scanner.scan(input(Buffer.alloc(streamMax + 1024 * 1024, 0x41)));
    expect(v.status).toBe("error");
  }, 120_000);
  it.skipIf(maxFile === undefined)("past MaxFileSize with AlertExceedsMax, reports unscannable rather than clean, even with EICAR inside", async () => {
    const content = Buffer.concat([EICAR, Buffer.from("\n"), Buffer.alloc((maxFile as number) + 1024 * 1024, 0x41)]);
    const v = await scanner.scan(input(content));
    expect(v.status).toBe("unscannable");
    expect(v.signature).toMatch(/Limits\.Exceeded/i);
  }, 120_000);
  it("connection refused reports error rather than clean", async () => {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const closed = (server.address() as { port: number }).port;
    await new Promise(resolve => server.close(resolve));
    expect((await new ClamdScanner("127.0.0.1", closed).scan(input(Buffer.from("x")))).status).toBe("error");
  });
  it("analyzeAttachments raises the hard-floor malware evidence from the real engine", async () => {
    const r = await analyzeAttachments([input(EICAR, "report.pdf"), input(Buffer.from("fine\n"), "notes.txt")], scanner);
    expect(r.verdicts.get("sha-report.pdf")).toBe("infected");
    expect(r.verdicts.get("sha-notes.txt")).toBe("clean");
    expect(r.evidence.find(e => e.code === "ATT_MALWARE_SIGNATURE")?.hardFloor).toBe(true);
    expect(r.provenance).toEqual(expect.arrayContaining(["clamd:infected", "clamd:clean"]));
  });
  it("many concurrent scans all get the right verdict", async () => {
    const verdicts = await Promise.all(Array.from({ length: 12 }, (_, i) => scanner.scan(input(i % 2 ? EICAR : Buffer.from(`clean ${i}\n`)))));
    verdicts.forEach((v, i) => expect(v.status).toBe(i % 2 ? "infected" : "clean"));
  });
});
