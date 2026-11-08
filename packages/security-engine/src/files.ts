import { constants, inflateRawSync, inflateSync } from "node:zlib";
import type { Evidence } from "@aegis/domain";

/**
 * Opens attachments the way their viewer would, without running anything: decodes PDF streams and object streams, reads
 * Office packages and RTF, and parses HTML, SVG and scripts. What it finds becomes evidence, and a short structural brief
 * (signal codes plus any embedded code, never document text) is what the AI review sees.
 *
 * Everything is bounded: stream count, inflated bytes per stream and in total, entries read from a package, and the amount
 * of code kept. Hitting a bound is reported, so a file built to exhaust the inspector reads as partly unread, not clean.
 */

export type FileKind = "pdf" | "office" | "rtf" | "web" | "script";
export interface FileBrief {
  filename: string;
  kind: FileKind;
  /** Stable codes for what was found, e.g. PDF_JAVASCRIPT, OFFICE_REMOTE_TEMPLATE. */
  signals: string[];
  /** Embedded or attached code (PDF JavaScript, HTML/SVG script, the script itself), trimmed. */
  code: string[];
  /** Links found inside the file. */
  urls: string[];
  /** A bound was hit, so part of the file wasn't read. */
  partial: boolean;
}
export interface FileInspection { brief: FileBrief | null; evidence: Evidence[] }

const MAX_STREAMS = 400;
const MAX_STREAM_OUT = 2 * 1024 * 1024;
const MAX_TOTAL_OUT = 12 * 1024 * 1024;
const MAX_READ = 4 * 1024 * 1024;
const MAX_CODE = 8_000;
const MAX_URLS = 50;

const EXEC_NAME = /\.(exe|scr|com|pif|bat|cmd|vbs|vbe|js|jse|wsf|wsh|ps1|msi|hta|cpl|jar|lnk|reg|dll|sh|app|dmg|iso|img)$/i;
const SCRIPT_EXT = /\.(js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|bat|cmd|sh)$/i;
const WEB_EXT = /\.(html?|xhtml|shtml|mht|mhtml|svg)$/i;
const OOXML_EXT = /\.(docx|docm|dotx|dotm|xlsx|xlsm|xltx|xltm|xlam|pptx|pptm|potx|potm|ppam|ppsx|ppsm)$/i;
const MACRO_EXT = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|ppsm)$/i;

function ev(code: string, weight: number, category: Evidence["category"], explanation: string, hardFloor = false): Evidence {
  return { code, weight, ...(category ? { category } : {}), source: "attachment", explanation, ...(hardFloor ? { hardFloor } : {}) };
}

/** Longest run of base64 characters. A loop, not a regex: `[A-Za-z0-9+/=]{3000,}` backtracks quadratically on near-misses. */
function longestBase64Run(s: string): number {
  let best = 0, run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const b64 = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 || c === 61;
    run = b64 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Code-level signs of an exploit or dropper. Shared by PDF JavaScript, HTML, SVG and standalone scripts. */
export function codeSignals(code: string): string[] {
  const s = code.slice(0, 400_000);
  const out: string[] = [];
  if (/(%u[0-9a-f]{4}){8,}|(\\u[0-9a-f]{4}){12,}|(\\x[0-9a-f]{2}){40,}/i.test(s) || /unescape\s*\(\s*["']%u/i.test(s)) out.push("CODE_SHELLCODE");
  if (/0x0c0c0c0c|%u0c0c%u0c0c|\\x0c\\x0c\\x0c\\x0c|0x0a0a0a0a|%u9090%u9090/i.test(s) || /while\s*\([^)]{0,60}\.length\s*<\s*0x[0-9a-f]{5,}/i.test(s) || /\.length\s*<\s*\d{6,}/.test(s) && /\+=\s*\w+/.test(s)) out.push("CODE_HEAP_SPRAY");
  if (/util\.printf\s*\(|Collab\.(collectEmailInfo|getIcon)|media\.newPlayer|spell\.customDictionaryOpen|\.getAnnots\s*\(|syncAnnotScan|printSeps\s*\(|XMLData\.parse|doc\.printSeps|app\.setTimeOut/i.test(s)) out.push("CODE_VULNERABLE_API");
  if (/\beval\s*\(/.test(s) && /fromCharCode|unescape\s*\(|atob\s*\(|\\x[0-9a-f]{2}/i.test(s) || longestBase64Run(s) >= 3000 || (s.match(/\\x[0-9a-f]{2}/gi)?.length ?? 0) > 200) out.push("CODE_OBFUSCATED");
  if (/exportDataObject\s*\([^)]*nLaunch|app\.launchURL|\.launch\s*\(|ShellExecute|WScript\.Shell|Shell\.Application|Start-Process|cmd(\.exe)?\s+\/c|powershell(\.exe)?\s+[^\n]{0,40}-(e|ec|enc|encodedcommand|nop|w\s+hidden|windowstyle\s+hidden)\b/i.test(s)) out.push("CODE_EXECUTES");
  if (/DownloadString|DownloadFile|Invoke-WebRequest|\biwr\s|Invoke-RestMethod|bitsadmin|certutil(\.exe)?\s+[^\n]{0,20}-urlcache|MSXML2\.(Server)?XMLHTTP|WinHttp\.WinHttpRequest|ADODB\.Stream|\bcurl\s+-|\bwget\s+http/i.test(s)) out.push("CODE_DOWNLOADS");
  if (/FromBase64String|-enc(odedcommand)?\s+[A-Za-z0-9+/=]{40,}/i.test(s)) out.push("CODE_ENCODED_PAYLOAD");
  if (/new\s+Blob\s*\(/.test(s) && /msSaveOrOpenBlob|createObjectURL|\.download\s*=/.test(s)) out.push("CODE_SMUGGLING");
  return out;
}

function pushCode(list: string[], code: string, budget: { left: number }) {
  const c = code.replace(/\s+/g, " ").trim();
  if (!c || budget.left <= 0) return;
  const piece = c.slice(0, Math.min(budget.left, 3_000));
  budget.left -= piece.length;
  list.push(piece);
}

function cleanUrl(u: string): string | null {
  const t = u.trim().replace(/\\\)/g, ")").replace(/\\\(/g, "(");
  return /^https?:\/\/[^\s"'<>]{3,2000}$/i.test(t) ? t : null;
}

/* ---------------------------------------------------------------- PDF */

/** `/J#61vaScript` is `/JavaScript`: PDF lets names hide behind hex escapes. */
function decodeNames(s: string): { text: string; escaped: boolean } {
  let escaped = false;
  const text = s.replace(/\/[^\s/<>[\]()%{}]{1,127}/g, n => {
    if (!n.includes("#")) return n;
    const d = n.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (/^\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFiles?|URI|SubmitForm|RichMedia|XFA|AcroForm|ObjStm|FlateDecode)$/.test(d)) escaped = true;
    return d;
  });
  return { text, escaped };
}

/** A PDF literal string starting at `i` (the opening paren). Handles nesting and escapes. */
function readLiteral(s: string, i: number, max = 60_000): string {
  let depth = 0, out = "";
  for (let k = i; k < s.length && out.length < max; k++) {
    const c = s[k]!;
    if (c === "\\") {
      const n = s[k + 1] ?? "";
      const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (n in map) { out += map[n]; k++; continue; }
      const oct = /^[0-7]{1,3}/.exec(s.slice(k + 1, k + 4));
      if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); k += oct[0].length; continue; }
      continue;
    }
    if (c === "(") { if (depth++ === 0) continue; }
    else if (c === ")") { if (--depth === 0) break; }
    out += c;
  }
  return out;
}

function readHexString(s: string, i: number): string {
  const end = s.indexOf(">", i);
  const hex = s.slice(i + 1, end < 0 ? i + 1 : Math.min(end, i + 120_000)).replace(/[^0-9a-fA-F]/g, "");
  return Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex").toString("latin1");
}

interface PdfStream { obj: number | null; dict: string; text: string }

function pdfStreams(raw: string, buf: Buffer, budget: { out: number; partial: boolean }): PdfStream[] {
  const out: PdfStream[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (raw.slice(Math.max(0, m.index - 3), m.index) === "end") continue;
    if (out.length >= MAX_STREAMS) { budget.partial = true; break; }
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const before = raw.slice(Math.max(0, m.index - 600), m.index);
    const objAt = before.lastIndexOf(" obj");
    const head = objAt >= 0 ? before.slice(objAt) : before;
    let num: RegExpMatchArray | undefined;
    for (const o of before.matchAll(/(\d+)\s+\d+\s+obj\b/g)) num = o;
    const dict = decodeNames(head).text;
    let data = buf.subarray(start, end);
    let text = "";
    if (/\/FlateDecode|\/Fl\b/.test(dict) && budget.out > 0) {
      const cap = Math.min(MAX_STREAM_OUT, budget.out);
      try { data = inflateSync(data, { maxOutputLength: cap }); }
      catch {
        // A truncated or padded deflate stream still yields its prefix; viewers accept these, so the inspector must too.
        try { data = inflateSync(data, { maxOutputLength: cap, finishFlush: constants.Z_SYNC_FLUSH }); } catch { budget.partial = true; data = Buffer.alloc(0); }
      }
      if (data.length >= cap) budget.partial = true;
      budget.out -= data.length;
      text = data.toString("latin1");
    } else if (!/\/Filter/.test(dict)) {
      text = data.toString("latin1", 0, Math.min(data.length, MAX_STREAM_OUT));
    }
    out.push({ obj: num ? Number(num[1]) : null, dict, text });
    re.lastIndex = end + 9;
  }
  return out;
}

export function inspectPdf(filename: string, buf: Buffer): FileInspection {
  const budget = { out: MAX_TOTAL_OUT, partial: buf.length > MAX_READ * 4 };
  const raw = buf.toString("latin1", 0, Math.min(buf.length, MAX_READ * 4));
  const names = decodeNames(raw);
  const streams = pdfStreams(raw, buf, budget);
  // Object streams hold dictionaries too: decoded, they're scanned like the file body.
  const decoded = streams.map(s => decodeNames(s.text));
  const all = names.text + "\n" + decoded.map(d => d.text).join("\n");
  const escaped = names.escaped || decoded.some(d => d.escaped);
  const signals = new Set<string>();
  const code: string[] = [];
  const urls: string[] = [];
  const codeBudget = { left: MAX_CODE };

  // JavaScript: inline literal, hex string, or a reference to a stream object.
  const jsParts: string[] = [];
  for (const m of all.matchAll(/\/JS\s*(\(|<(?!<)|(\d+)\s+\d+\s+R)/g)) {
    if (jsParts.length > 40) break;
    const at = m.index! + m[0].length - m[1]!.length;
    if (m[1] === "(") jsParts.push(readLiteral(all, at));
    else if (m[1] === "<") jsParts.push(readHexString(all, at));
    else { const s = streams.find(x => x.obj === Number(m[2])); if (s) jsParts.push(s.text.slice(0, MAX_STREAM_OUT)); }
  }
  const hasJs = /\/JavaScript\b|\/JS\b/.test(all);
  if (hasJs) signals.add("PDF_JAVASCRIPT");
  for (const js of jsParts) { pushCode(code, js, codeBudget); for (const c of codeSignals(js)) signals.add(c); }
  if (/\/OpenAction\b|\/AA\s*<</.test(all)) signals.add("PDF_AUTO_ACTION");
  if (/\/Launch\b/.test(all)) signals.add("PDF_LAUNCH");
  if (/\/SubmitForm\b|\/ImportData\b/.test(all)) signals.add("PDF_SUBMITS_DATA");
  if (/\/GoToE\b|\/GoToR\b/.test(all)) signals.add("PDF_REMOTE_GOTO");
  if (/\/RichMedia\b|\/Flash\b/.test(all)) signals.add("PDF_RICH_MEDIA");
  if (/\/XFA\b/.test(all)) signals.add("PDF_XFA");
  if (/\/JBIG2Decode\b/.test(all)) signals.add("PDF_JBIG2");
  if (escaped) signals.add("PDF_OBFUSCATED_NAMES");
  const embeddedNames: string[] = [];
  if (/\/EmbeddedFiles?\b/.test(all)) {
    signals.add("PDF_EMBEDDED_FILE");
    for (const m of all.matchAll(/\/(?:UF|F)\s*\(/g)) {
      if (embeddedNames.length > 20) break;
      const n = readLiteral(all, m.index! + m[0].length - 1, 260).replace(/\0/g, "");
      if (n) embeddedNames.push(n);
    }
    if (embeddedNames.some(n => EXEC_NAME.test(n.trim()))) signals.add("PDF_EMBEDDED_EXECUTABLE");
  }
  for (const m of all.matchAll(/\/URI\s*\(/g)) {
    if (urls.length >= MAX_URLS) break;
    const u = cleanUrl(readLiteral(all, m.index! + m[0].length - 1, 2_100));
    if (u && !urls.includes(u)) urls.push(u);
  }
  if (budget.partial) signals.add("PDF_PARTIALLY_READ");

  const f = `"${filename}"`;
  const evidence: Evidence[] = [];
  const exploit = ["CODE_SHELLCODE", "CODE_HEAP_SPRAY", "CODE_VULNERABLE_API"].filter(c => signals.has(c));
  if (exploit.length) evidence.push(ev("PDF_EXPLOIT_CODE", 5, "malware", `${f} carries JavaScript built to exploit a PDF reader: ${exploit.map(c => EXPLOIT_WORDS[c]).join(", ")}.`, true));
  if (signals.has("PDF_LAUNCH")) evidence.push(ev("PDF_LAUNCH", 3.5, "malware", `${f} tries to start a program on your computer when opened.`, true));
  if (signals.has("PDF_EMBEDDED_EXECUTABLE")) evidence.push(ev("PDF_EMBEDDED_EXECUTABLE", 4, "malware", `${f} has a program hidden inside it${embeddedNames[0] ? ` ("${embeddedNames.find(n => EXEC_NAME.test(n.trim()))}")` : ""}.`, true));
  else if (signals.has("PDF_EMBEDDED_FILE")) evidence.push(ev("PDF_EMBEDDED_FILE", 1, "malware", `${f} has another file packed inside it.`));
  if (signals.has("CODE_EXECUTES") || signals.has("CODE_DOWNLOADS")) evidence.push(ev("PDF_DROPPER", 3.5, "malware", `The JavaScript in ${f} tries to run or download something.`, true));
  if (hasJs && !exploit.length) {
    const auto = signals.has("PDF_AUTO_ACTION");
    evidence.push(ev("PDF_JAVASCRIPT", auto ? 2.4 : 1.6, "malware", auto ? `${f} runs JavaScript as soon as it's opened.` : `${f} contains JavaScript. Ordinary documents rarely need it.`));
  }
  if (signals.has("CODE_OBFUSCATED") || escaped) evidence.push(ev("PDF_OBFUSCATED", 1.8, "malware", `${f} hides what it contains, a technique used to slip past scanners.`));
  if (signals.has("PDF_SUBMITS_DATA")) evidence.push(ev("PDF_SUBMITS_DATA", 0.9, "credential_phish", `${f} contains a form that sends what you type to a server.`));
  if (signals.has("PDF_RICH_MEDIA")) evidence.push(ev("PDF_RICH_MEDIA", 1, "malware", `${f} embeds Flash or rich media, an old route for exploits.`));
  if (budget.partial) evidence.push(ev("PDF_PARTIALLY_READ", 0.6, undefined, `${f} is too large or complex to unpack completely.`));
  return { brief: brief(filename, "pdf", signals, code, urls, budget.partial), evidence };
}

const EXPLOIT_WORDS: Record<string, string> = { CODE_SHELLCODE: "encoded machine code", CODE_HEAP_SPRAY: "memory spraying", CODE_VULNERABLE_API: "calls to reader functions with known flaws" };

function brief(filename: string, kind: FileKind, signals: Set<string>, code: string[], urls: string[], partial: boolean): FileBrief | null {
  if (!signals.size && !code.length && !urls.length) return null;
  return { filename, kind, signals: [...signals], code, urls, partial };
}

/* ---------------------------------------------------------------- Office packages */

interface ZipEntry { name: string; method: number; compressed: number; uncompressed: number; offset: number }

function zipEntries(b: Buffer, max = 3000): ZipEntry[] {
  const out: ZipEntry[] = [];
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && i < max; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    out.push({ name: b.toString("utf8", p + 46, Math.min(p + 46 + nameLen, b.length)), method: b.readUInt16LE(p + 10), compressed: b.readUInt32LE(p + 20), uncompressed: b.readUInt32LE(p + 24), offset: b.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function zipRead(b: Buffer, e: ZipEntry, max: number): string | null {
  if (e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
  const data = b.subarray(start, Math.min(b.length, start + e.compressed));
  try {
    if (e.method === 0) return data.toString("utf8", 0, Math.min(data.length, max));
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: max }).toString("utf8");
  } catch { /* a damaged entry is just unread */ }
  return null;
}

export function inspectOffice(filename: string, buf: Buffer): FileInspection {
  const entries = zipEntries(buf);
  const signals = new Set<string>();
  const urls: string[] = [];
  let partial = false;
  if (!entries.some(e => /^(\[Content_Types\]\.xml|word\/|xl\/|ppt\/)/.test(e.name))) return { brief: null, evidence: [] };
  if (entries.some(e => /vbaProject\.bin$/i.test(e.name))) signals.add("OFFICE_MACROS");
  if (entries.some(e => /\/(embeddings\/oleObject|activeX\/)/i.test(e.name))) signals.add("OFFICE_EMBEDDED_OBJECT");
  let read = 0;
  for (const e of entries) {
    const rel = /\.rels$/i.test(e.name), doc = /^(word\/document|word\/settings|xl\/externalLinks\/[^/]+|word\/webSettings)\.xml$/i.test(e.name);
    if (!rel && !doc) continue;
    if (read > MAX_TOTAL_OUT || e.uncompressed > MAX_READ) { partial = true; continue; }
    const x = zipRead(buf, e, MAX_READ);
    if (x == null) { partial = true; continue; }
    read += x.length;
    if (rel) {
      for (const m of x.matchAll(/<Relationship\b[^>]*>/gi)) {
        const r = m[0];
        const target = /Target="([^"]*)"/i.exec(r)?.[1] ?? "";
        const external = /TargetMode="External"/i.test(r);
        if (/^(ms-msdt|search-ms|ms-officecmd|mhtml|ms-word|ms-excel|ms-powerpoint):/i.test(target) || /!x-usc:|\.html?!$/i.test(target)) signals.add("OFFICE_PROTOCOL_EXPLOIT");
        if (external && /\/(attachedTemplate|oleObject|frame|subDocument|externalLinkPath)"/i.test(r)) signals.add("OFFICE_REMOTE_TEMPLATE");
        if (external && /\/hyperlink"/i.test(r)) { const u = cleanUrl(target.replace(/&amp;/g, "&")); if (u && urls.length < MAX_URLS && !urls.includes(u)) urls.push(u); }
      }
    } else if (/\bDDEAUTO\b|<w:instrText[^>]*>\s*DDE\b|\bDDE\s*"?cmd/i.test(x)) signals.add("OFFICE_DDE");
  }
  if (partial) signals.add("OFFICE_PARTIALLY_READ");
  const f = `"${filename}"`;
  const evidence: Evidence[] = [];
  if (signals.has("OFFICE_PROTOCOL_EXPLOIT")) evidence.push(ev("OFFICE_PROTOCOL_EXPLOIT", 5, "malware", `${f} tries to open a Windows component directly, the trick behind the "Follina" class of attacks.`, true));
  if (signals.has("OFFICE_REMOTE_TEMPLATE")) evidence.push(ev("OFFICE_REMOTE_TEMPLATE", 3.5, "malware", `${f} loads content from the internet when it opens, a way to fetch an exploit after the file is scanned.`, true));
  if (signals.has("OFFICE_DDE")) evidence.push(ev("OFFICE_DDE", 3, "malware", `${f} uses a field that can run a command when it's opened.`));
  if (signals.has("OFFICE_MACROS") && !MACRO_EXT.test(filename)) evidence.push(ev("OFFICE_HIDDEN_MACROS", 2.8, "malware", `${f} contains macros although its file type says it shouldn't.`));
  if (signals.has("OFFICE_EMBEDDED_OBJECT")) evidence.push(ev("OFFICE_EMBEDDED_OBJECT", 1.2, "malware", `${f} has an embedded object or control inside it.`));
  return { brief: brief(filename, "office", signals, [], urls, partial), evidence };
}

/* ---------------------------------------------------------------- RTF */

export function inspectRtf(filename: string, buf: Buffer): FileInspection {
  const s = buf.toString("latin1", 0, Math.min(buf.length, MAX_READ * 2));
  const signals = new Set<string>();
  if (/\\object\b|\\objdata\b/i.test(s)) signals.add("RTF_OBJECT");
  if (/\\objupdate\b/i.test(s)) signals.add("RTF_AUTO_OBJECT");
  // Equation Editor objects (CVE-2017-11882 and relatives) are still among the most common document exploits.
  const hexed = s.replace(/[\s\\{}]/g, "");
  if (/Equation\.3|0002ce020000000000c000000000000046/i.test(s) || /4571756174696f6e2e33/i.test(hexed)) signals.add("RTF_EQUATION_OBJECT");
  if (/\\objclass\s+(Package|htmlfile)|\\objocx/i.test(s)) signals.add("RTF_PACKAGE_OBJECT");
  const f = `"${filename}"`;
  const evidence: Evidence[] = [];
  if (signals.has("RTF_EQUATION_OBJECT")) evidence.push(ev("RTF_EXPLOIT", 5, "malware", `${f} embeds an Equation Editor object, the target of a widely used Office exploit.`, true));
  else if (signals.has("RTF_PACKAGE_OBJECT") || (signals.has("RTF_OBJECT") && signals.has("RTF_AUTO_OBJECT"))) evidence.push(ev("RTF_ACTIVE_OBJECT", 3, "malware", `${f} embeds an object set to activate on its own when opened.`));
  else if (signals.has("RTF_OBJECT")) evidence.push(ev("RTF_OBJECT", 1.2, "malware", `${f} contains an embedded object.`));
  return { brief: brief(filename, "rtf", signals, [], [], buf.length > MAX_READ * 2), evidence };
}

/* ---------------------------------------------------------------- HTML, SVG */

/** Bodies of <script> elements. indexOf, not a lazy regex, so thousands of unclosed tags stay linear. */
function scriptBodies(s: string): string[] {
  const out: string[] = [];
  const lower = s.toLowerCase();
  let i = 0;
  while (out.length < 200) {
    const open = lower.indexOf("<script", i);
    if (open < 0) break;
    const gt = lower.indexOf(">", open);
    if (gt < 0) break;
    const close = lower.indexOf("</script", gt);
    out.push(s.slice(gt + 1, close < 0 ? Math.min(s.length, gt + 1 + 400_000) : close));
    if (close < 0) break;
    i = close + 8;
  }
  return out;
}

export function inspectWeb(filename: string, buf: Buffer): FileInspection {
  const s = buf.toString("utf8", 0, Math.min(buf.length, MAX_READ));
  const svg = /\.svg$/i.test(filename) || /^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(s);
  const signals = new Set<string>();
  const code: string[] = [];
  const urls: string[] = [];
  const codeBudget = { left: MAX_CODE };
  const scripts = scriptBodies(s);
  const handlers = [...s.matchAll(/\son(load|error|click|mouseover|focus|begin|activate)\s*=\s*["']([^"']{4,4000})["']/gi)].map(m => m[2]!);
  if (scripts.length || handlers.length || /<script\b[^>]*\bsrc=/i.test(s)) signals.add(svg ? "SVG_SCRIPT" : "WEB_SCRIPT");
  for (const c of [...scripts, ...handlers]) { pushCode(code, c, codeBudget); for (const x of codeSignals(c)) signals.add(x); }
  if (/<input\b[^>]*type\s*=\s*["']?password/i.test(s) || /type\s*[:=]\s*["']password["']/i.test(scripts.join(" "))) signals.add("WEB_PASSWORD_FIELD");
  if (/<form\b[^>]*action\s*=\s*["']?https?:/i.test(s) || /fetch\s*\(\s*["']https?:|XMLHttpRequest|\$\.(post|ajax)\s*\(|navigator\.sendBeacon/i.test(scripts.join(" "))) signals.add("WEB_SENDS_DATA");
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(s) || /(window\.|document\.|top\.)?location(\.href)?\s*=|location\.(replace|assign)\s*\(/i.test(scripts.join(" ") + handlers.join(" "))) signals.add("WEB_REDIRECT");
  if (/<(iframe|embed|object)\b[^>]*src\s*=\s*["']?https?:/i.test(s)) signals.add("WEB_REMOTE_FRAME");
  if (/data:(application|text\/html)[^"']{0,40};base64,[A-Za-z0-9+/=]{2000,}/i.test(s)) signals.add("CODE_SMUGGLING");
  for (const m of s.matchAll(/\b(?:href|src|action)\s*=\s*["'](https?:\/\/[^"'\s<>]{3,2000})["']|location(?:\.href)?\s*=\s*["'](https?:\/\/[^"'\s<>]{3,2000})["']/gi)) {
    const u = cleanUrl(m[1] ?? m[2] ?? "");
    if (u && urls.length < MAX_URLS && !urls.includes(u)) urls.push(u);
  }
  const f = `"${filename}"`;
  const evidence: Evidence[] = [];
  if (signals.has("CODE_SMUGGLING")) evidence.push(ev("WEB_SMUGGLING", 4, "malware", `${f} assembles a hidden file in your browser and saves it, a way to get malware past email scanners.`, true));
  if (signals.has("WEB_PASSWORD_FIELD")) evidence.push(ev("WEB_CREDENTIAL_FORM", signals.has("WEB_SENDS_DATA") ? 3.2 : 2.4, "credential_phish", `${f} opens a sign-in form on your own computer${signals.has("WEB_SENDS_DATA") ? " and sends what you type to a server" : ""}. Real services don't send their sign-in page as an attachment.`));
  if (svg && signals.has("SVG_SCRIPT")) evidence.push(ev("SVG_SCRIPT", 2.6, "malware", `The image ${f} contains a program. Pictures don't need one.`));
  if (signals.has("CODE_OBFUSCATED") || signals.has("CODE_SHELLCODE")) evidence.push(ev("WEB_OBFUSCATED_SCRIPT", 2, "malware", `The code in ${f} is deliberately scrambled to hide what it does.`));
  if (signals.has("CODE_EXECUTES") || signals.has("CODE_DOWNLOADS")) evidence.push(ev("WEB_DROPPER", 3, "malware", `The code in ${f} tries to download or run something.`));
  if (signals.has("WEB_REDIRECT") && !signals.has("WEB_PASSWORD_FIELD")) evidence.push(ev("WEB_REDIRECT", 1, "malicious_link", `${f} sends you to a website as soon as it's opened.`));
  return { brief: brief(filename, "web", signals, code, urls, buf.length > MAX_READ), evidence };
}

/* ---------------------------------------------------------------- Scripts */

export function inspectScript(filename: string, buf: Buffer): FileInspection {
  const s = buf.toString("utf8", 0, Math.min(buf.length, MAX_READ));
  const signals = new Set(codeSignals(s));
  signals.add("SCRIPT_FILE");
  const code: string[] = [];
  pushCode(code, s, { left: MAX_CODE });
  const urls = [...new Set((s.match(/https?:\/\/[^\s"'<>`)]{3,500}/gi) ?? []).map(cleanUrl).filter((u): u is string => !!u))].slice(0, MAX_URLS);
  const f = `"${filename}"`;
  const evidence: Evidence[] = [];
  if (signals.has("CODE_DOWNLOADS") && signals.has("CODE_EXECUTES")) evidence.push(ev("SCRIPT_DOWNLOAD_AND_RUN", 3, "malware", `The script ${f} downloads something from the internet and runs it.`, true));
  else if (signals.has("CODE_DOWNLOADS")) evidence.push(ev("SCRIPT_DOWNLOADER", 2, "malware", `The script ${f} downloads files from the internet.`));
  if (signals.has("CODE_ENCODED_PAYLOAD") || signals.has("CODE_OBFUSCATED")) evidence.push(ev("SCRIPT_OBFUSCATED", 1.8, "malware", `The script ${f} hides its real instructions in encoded text.`));
  return { brief: brief(filename, "script", signals, code, urls, buf.length > MAX_READ), evidence };
}

/** Routes one attachment to the right inspector by its contents first and its name second. */
export function inspectFile(filename: string, contentType: string, buf: Buffer): FileInspection {
  const name = filename.toLowerCase().trim();
  try {
    if (buf.length >= 5 && buf.toString("latin1", 0, 1024).includes("%PDF-")) return inspectPdf(filename, buf);
    if (buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304 && (OOXML_EXT.test(name) || /officedocument|ms-(word|excel|powerpoint)/i.test(contentType))) return inspectOffice(filename, buf);
    if (buf.toString("latin1", 0, 6) === "{\\rtf1" || buf.toString("latin1", 0, 5) === "{\\rt" || /\.rtf$/.test(name) && buf.toString("latin1", 0, 2) === "{\\") return inspectRtf(filename, buf);
    if (WEB_EXT.test(name) || /^(text\/html|image\/svg\+xml|application\/xhtml)/i.test(contentType)) return inspectWeb(filename, buf);
    if (SCRIPT_EXT.test(name)) return inspectScript(filename, buf);
  } catch {
    return { brief: { filename, kind: WEB_EXT.test(name) ? "web" : SCRIPT_EXT.test(name) ? "script" : /\.rtf$/.test(name) ? "rtf" : OOXML_EXT.test(name) ? "office" : "pdf", signals: ["INSPECTION_FAILED"], code: [], urls: [], partial: true }, evidence: [ev("ATT_INSPECTION_FAILED", 0.8, undefined, `"${filename}" couldn't be opened for inspection.`)] };
  }
  return { brief: null, evidence: [] };
}
