import { PNG } from "pngjs";
import jsQR from "jsqr";
import type { Evidence } from "@aegis/domain";
import { inspectFile, type FileBrief } from "./files";

export interface AttachmentInput { filename: string; contentType: string; size: number; sha256: string; content: Buffer }
export type ScanStatus = "clean" | "infected" | "unscannable" | "not_scanned" | "error";
export interface ScanVerdict { status: ScanStatus; signature?: string; engine: string }

/** Maintained-engine boundary. Absence of a real engine must never read as "clean". */
export interface MalwareScanner {
  readonly id: string;
  readonly maintained: boolean;
  scan(a: AttachmentInput): Promise<ScanVerdict>;
}

/** Baseline only: EICAR test signature and tenant hash blocklist. NOT a substitute for an AV engine. */
export class BaselineScanner implements MalwareScanner {
  readonly id = "baseline-signatures";
  readonly maintained = false;
  constructor(private blockedHashes: Set<string> = new Set()) {}
  async scan(a: AttachmentInput): Promise<ScanVerdict> {
    if (a.content.includes("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")) return { status: "infected", signature: "EICAR-Test", engine: this.id };
    if (this.blockedHashes.has(a.sha256)) return { status: "infected", signature: "tenant-blocklist", engine: this.id };
    return { status: "not_scanned", engine: this.id };
  }
}

/** Longest reply clamd has any reason to send. A longer one is treated as a protocol failure, and never buffered. */
const CLAMD_MAX_REPLY_BYTES = 4 * 1024;

/**
 * Reads one reply to `zINSTREAM`, exactly: `stream: OK\0`, `stream: <signature> FOUND\0`, or anything else, which is an
 * error. Substring checks here would be fail-open: an error reply that merely contains "OK" must not read as clean.
 * `Heuristics.Limits.Exceeded.*` (clamd with `AlertExceedsMax yes`) means clamd stopped reading, so nothing is known
 * about the file. It's neither infected nor clean.
 */
export function parseClamdReply(reply: Buffer): Pick<ScanVerdict, "status" | "signature"> {
  if (reply.length < 2 || reply[reply.length - 1] !== 0) return { status: "error" };
  const line = reply.toString("latin1", 0, reply.length - 1);
  if (line.includes("\0") || /[\r\n]/.test(line)) return { status: "error" };
  if (line === "stream: OK") return { status: "clean" };
  const found = /^stream: (\S.{0,199}) FOUND$/.exec(line);
  if (!found) return { status: "error" };
  const signature = (found[1] as string).slice(0, 120);
  if (/^Heuristics\.Limits\.Exceeded\b/i.test(signature)) return { status: "unscannable", signature };
  return { status: "infected", signature };
}

/**
 * clamd INSTREAM client. Connection failures and any reply that isn't a definite verdict return "error", which reduces
 * evidence completeness. Over clamd's StreamMaxLength clamd replies with an error and closes, which lands there too.
 *
 * Requires `AlertExceedsMax yes` in clamd.conf: without it, clamd answers `OK` for a file past MaxFileSize or MaxScanSize
 * without having scanned it (seen with real clamd 1.5: EICAR plus padding past MaxFileSize comes back `stream: OK`).
 */
export class ClamdScanner implements MalwareScanner {
  readonly id = "clamd";
  readonly maintained = true;
  /** `timeoutMs` is silence on the socket; `deadlineMs` bounds the whole scan, so a trickling server can't hold it open. */
  constructor(readonly host: string, readonly port = 3310, private timeoutMs = 20_000, private deadlineMs = 120_000) {}
  async scan(a: AttachmentInput): Promise<ScanVerdict> {
    const { connect } = await import("node:net");
    return new Promise<ScanVerdict>(resolve => {
      const sock = connect(this.port, this.host);
      const parts: Buffer[] = [];
      let received = 0;
      const deadline = setTimeout(() => done({ status: "error", engine: this.id }), this.deadlineMs);
      const done = (v: ScanVerdict) => { clearTimeout(deadline); sock.destroy(); resolve(v); };
      sock.setTimeout(this.timeoutMs, () => done({ status: "error", engine: this.id }));
      sock.on("error", () => done({ status: "error", engine: this.id }));
      sock.on("connect", () => {
        sock.write("zINSTREAM\0");
        const chunkSize = 64 * 1024;
        for (let i = 0; i < a.content.length; i += chunkSize) {
          const chunk = a.content.subarray(i, i + chunkSize);
          const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length);
          sock.write(len); sock.write(chunk);
        }
        sock.write(Buffer.alloc(4));
      });
      sock.on("data", d => {
        received += d.length;
        if (received > CLAMD_MAX_REPLY_BYTES) return done({ status: "error", engine: this.id });
        parts.push(d);
      });
      sock.on("end", () => done({ ...parseClamdReply(Buffer.concat(parts)), engine: this.id }));
      // Closed without a clean end, and with no error event: no verdict arrived. A no-op after `done`.
      sock.on("close", () => done({ status: "error", engine: this.id }));
    });
  }
}

const EXEC_EXT = /\.(exe|scr|com|pif|bat|cmd|cmdline|vbs|vbe|js|jse|wsf|wsh|ps1|msi|msp|hta|cpl|jar|lnk|reg|dll|apk|app|dmg|pkg|sh)$/i;
const CONTAINER_EXT = /\.(iso|img|vhd|vhdx|udf)$/i;
const ACTIVE_EXT = /\.(html?|xhtml|svg|shtml|mht|mhtml)$/i;
const MACRO_EXT = /\.(docm|xlsm|pptm|dotm|xltm|xlam|ppam|xll)$/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|cab|ace|arj)$/i;
const DOUBLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|txt|jpe?g|png|csv|rtf)\s*\.(exe|scr|com|pif|bat|cmd|vbs|js|jar|lnk|hta|html?)$/i;

function magicType(b: Buffer): string | null {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return "pe";
  if (b.length >= 4 && b.toString("latin1", 0, 4) === "%PDF") return "pdf";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x504b0304) return "zip";
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0) return "ole";
  if (b.length >= 4 && b.readUInt32BE(0) === 0x7f454c46) return "elf";
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  return null;
}

export interface ZipInspection { entries: { name: string; compressed: number; uncompressed: number; encrypted: boolean }[]; truncated: boolean; malformed: boolean }

/** Reads the ZIP central directory only. Never inflates, so bombs cost bounded memory and CPU. */
export function inspectZip(b: Buffer, maxEntries = 5000): ZipInspection {
  const out: ZipInspection = { entries: [], truncated: false, malformed: false };
  const minEocd = 22;
  if (b.length < minEocd) { out.malformed = true; return out; }
  let eocd = -1;
  const floor = Math.max(0, b.length - 65_557);
  for (let i = b.length - minEocd; i >= floor; i--) { if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) { out.malformed = true; return out; }
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (i >= maxEntries) { out.truncated = true; break; }
    if (p < 0 || p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) { out.malformed = true; break; }
    const flags = b.readUInt16LE(p + 8);
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    out.entries.push({
      name: b.toString("utf8", p + 46, Math.min(p + 46 + nameLen, b.length)).slice(0, 512),
      compressed: b.readUInt32LE(p + 20), uncompressed: b.readUInt32LE(p + 24), encrypted: (flags & 1) === 1,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const MAX_DECODE_BYTES = 8 * 1024 * 1024;
const MAX_QR_PIXELS = 8_000_000;
export function decodeQr(a: AttachmentInput): string | null {
  if (a.size > MAX_DECODE_BYTES || magicType(a.content) !== "png") return null;
  try {
    // Check dimensions from IHDR before decoding, to avoid decompression bombs.
    const w = a.content.readUInt32BE(16), h = a.content.readUInt32BE(20);
    if (w * h > MAX_QR_PIXELS) return null;
    const png = PNG.sync.read(a.content);
    return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
  } catch { return null; }
}

export interface AttachmentAnalysis { evidence: Evidence[]; completenessPenalty: number; provenance: string[]; qrUrls: string[]; verdicts: Map<string, ScanStatus>; files: FileBrief[]; fileUrls: string[] }

export async function analyzeAttachments(items: AttachmentInput[], scanner: MalwareScanner): Promise<AttachmentAnalysis> {
  const evidence: Evidence[] = [];
  const verdicts = new Map<string, ScanStatus>();
  const qrUrls: string[] = [];
  const files: FileBrief[] = [];
  const fileUrls: string[] = [];
  let penalty = 0;
  const provenance = new Set<string>();
  for (const a of items) {
    const name = a.filename.toLowerCase().trim();
    const magic = magicType(a.content);
    let verdict: ScanVerdict;
    try { verdict = await scanner.scan(a); } catch { verdict = { status: "error", engine: scanner.id }; }
    verdicts.set(a.sha256, verdict.status);
    provenance.add(`${scanner.id}:${verdict.status}`);
    if (verdict.status === "infected") {
      evidence.push({ code: "ATT_MALWARE_SIGNATURE", weight: 6, category: "malware", source: "attachment", hardFloor: true, explanation: `The attachment "${a.filename}" matched a malware signature.` });
    } else if (verdict.status === "unscannable") {
      penalty = Math.max(penalty, 0.35);
      evidence.push({ code: "ATT_SCAN_LIMIT_EXCEEDED", weight: 1.2, source: "attachment", explanation: `"${a.filename}" is too large or too deeply nested for the malware scanner to read, so it wasn't fully scanned.` });
    } else if (verdict.status === "error") {
      penalty = Math.max(penalty, 0.25);
    } else if (verdict.status === "not_scanned") {
      penalty = Math.max(penalty, 0.15);
    }
    if (DOUBLE_EXT.test(name)) {
      evidence.push({ code: "ATT_DOUBLE_EXTENSION", weight: 4, category: "malware", source: "attachment", hardFloor: true, explanation: `"${a.filename}" disguises a program as a document with a double file extension.` });
    } else if (EXEC_EXT.test(name) || magic === "pe" || magic === "elf") {
      evidence.push({ code: "ATT_EXECUTABLE", weight: 3.5, category: "malware", source: "attachment", hardFloor: true, explanation: `"${a.filename}" is an executable or script. Email is rarely a legitimate way to receive these.` });
    }
    if (CONTAINER_EXT.test(name)) evidence.push({ code: "ATT_DISK_IMAGE", weight: 3, category: "malware", source: "attachment", explanation: `"${a.filename}" is a disk image, a format often used to get malware past filters.` });
    if (ACTIVE_EXT.test(name)) evidence.push({ code: "ATT_ACTIVE_DOCUMENT", weight: 2.2, category: "credential_phish", source: "attachment", explanation: `"${a.filename}" is a web file that can display a fake sign-in page when opened.` });
    if (MACRO_EXT.test(name)) evidence.push({ code: "ATT_MACRO_DOCUMENT", weight: 2.5, category: "malware", source: "attachment", explanation: `"${a.filename}" is an Office document type that can run macros.` });
    if (magic === "ole" && /\.(doc|xls|ppt)$/.test(name)) evidence.push({ code: "ATT_LEGACY_OFFICE", weight: 1.0, category: "malware", source: "attachment", explanation: `"${a.filename}" uses a legacy Office format that can carry macros and couldn't be inspected in depth.` });
    if (/\.(pdf|docx?|xlsx?|txt|jpe?g|png)$/i.test(name) && (magic === "pe" || magic === "elf")) {
      evidence.push({ code: "ATT_TYPE_MISMATCH", weight: 4, category: "malware", source: "attachment", hardFloor: true, explanation: `"${a.filename}" isn't what its name says: the file contents are a program.` });
    }
    // Opened the way its viewer would: decoded streams, package parts, scripts. See files.ts.
    const inspected = inspectFile(a.filename, a.contentType, a.content);
    evidence.push(...inspected.evidence);
    if (inspected.brief) {
      files.push(inspected.brief);
      provenance.add(`inspect:${inspected.brief.kind}`);
      for (const u of inspected.brief.urls) if (fileUrls.length < 100 && !fileUrls.includes(u)) fileUrls.push(u);
      if (inspected.brief.partial) penalty = Math.max(penalty, 0.2);
    }
    if (magic === "pdf") {
      const head = a.content.toString("latin1", 0, Math.min(a.content.length, 2_000_000));
      if (/\/Encrypt\b/.test(head)) {
        penalty = Math.max(penalty, 0.35);
        evidence.push({ code: "ATT_ENCRYPTED_UNSCANNABLE", weight: 1.2, source: "attachment", explanation: `"${a.filename}" is password protected, so it couldn't be inspected.` });
      }
    }
    if (ARCHIVE_EXT.test(name) || magic === "zip") {
      if (magic === "zip") {
        const z = inspectZip(a.content);
        const totalU = z.entries.reduce((s, e) => s + e.uncompressed, 0);
        const totalC = z.entries.reduce((s, e) => s + e.compressed, 0);
        if (z.entries.some(e => e.encrypted)) {
          penalty = Math.max(penalty, 0.35);
          evidence.push({ code: "ATT_ENCRYPTED_UNSCANNABLE", weight: 1.6, source: "attachment", explanation: `"${a.filename}" is a password-protected archive, so its contents couldn't be inspected.` });
        }
        if (totalU > 1024 ** 3 || (totalC > 0 && totalU / totalC > 200) || z.truncated) {
          evidence.push({ code: "ATT_ARCHIVE_BOMB", weight: 3.5, category: "malware", source: "attachment", hardFloor: true, explanation: `"${a.filename}" expands to an abnormal size, a pattern used to overwhelm scanners. It wasn't unpacked.` });
        }
        const hit = z.entries.find(e => EXEC_EXT.test(e.name) || DOUBLE_EXT.test(e.name) || CONTAINER_EXT.test(e.name));
        if (hit) evidence.push({ code: "ATT_ARCHIVE_EXECUTABLE", weight: 3.5, category: "malware", source: "attachment", hardFloor: true, explanation: `The archive "${a.filename}" contains a program or script.` });
        if (z.malformed) { penalty = Math.max(penalty, 0.3); evidence.push({ code: "ATT_ARCHIVE_MALFORMED", weight: 1, source: "attachment", explanation: `"${a.filename}" is a damaged archive and couldn't be fully inspected.` }); }
      } else {
        penalty = Math.max(penalty, 0.25);
        evidence.push({ code: "ATT_ARCHIVE_UNINSPECTED", weight: 0.7, source: "attachment", explanation: `"${a.filename}" is an archive format this system can't inspect yet.` });
      }
    }
    const qr = decodeQr(a);
    if (qr) { provenance.add("qr"); if (/^https?:/i.test(qr)) qrUrls.push(qr); }
  }
  return { evidence, completenessPenalty: penalty, provenance: [...provenance], qrUrls, verdicts, files, fileUrls };
}

const MAX_EXTRACT = 200_000;
/**
 * Best-effort text from attachments, used only to screen for instructions aimed at an AI. Handles text formats and PDF
 * literal strings. Compressed PDF streams and Office files aren't decoded, so this can miss content there. That's
 * acceptable because attachment content is never given to a model, and actions are enforced outside any model.
 */
export function extractAttachmentText(a: { contentType: string; filename: string; content: Buffer }): string {
  const name = a.filename.toLowerCase();
  if (/^text\//.test(a.contentType) || /\.(txt|csv|md|html?|eml|json|xml)$/.test(name)) return a.content.toString("utf8", 0, Math.min(a.content.length, MAX_EXTRACT));
  if (magicType(a.content) === "pdf") {
    const head = a.content.toString("latin1", 0, Math.min(a.content.length, 2_000_000));
    const literals = [...head.matchAll(/\(((?:[^()\\]|\\.){4,500})\)\s*T[jJ]/g)].map(m => m[1]!).join(" ");
    const printable = head.match(/[A-Za-z][A-Za-z ,.:'-]{24,}/g)?.join(" ") ?? "";
    return `${literals} ${printable}`.slice(0, MAX_EXTRACT);
  }
  return "";
}
