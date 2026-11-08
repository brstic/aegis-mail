export interface MimeInput {
  from: string; to?: string; cc?: string; subject: string; text?: string; html?: string; replyTo?: string; date?: string;
  messageId?: string; inReplyTo?: string; references?: string; headers?: Record<string, string>;
  auth?: "pass" | "fail" | "none" | "softfail" | "forwarded";
  attachments?: { filename: string; contentType: string; content: Buffer | string }[];
}
let seq = 0;

/** Builds a synthetic RFC 5322 message. All addresses in fixtures use reserved or fictional domains. */
export function mime(m: MimeInput): string {
  const domain = m.from.match(/@([^>\s]+)/)?.[1] ?? "example.test";
  const h: string[] = [
    `From: ${m.from}`, `To: ${m.to ?? "Morgan Lee <morgan@fernhill.example>"}`, `Subject: ${m.subject}`,
    `Date: ${m.date ?? new Date("2026-11-06T09:00:00Z").toUTCString()}`,
    `Message-ID: ${m.messageId ?? `<fx-${++seq}@${domain}>`}`, "MIME-Version: 1.0",
  ];
  if (m.cc) h.push(`Cc: ${m.cc}`);
  if (m.replyTo) h.push(`Reply-To: ${m.replyTo}`);
  if (m.inReplyTo) h.push(`In-Reply-To: ${m.inReplyTo}`);
  if (m.references) h.push(`References: ${m.references}`);
  const a = m.auth ?? "pass";
  if (a === "pass") h.push(`Authentication-Results: mx.fixture.test; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`);
  if (a === "fail") h.push(`Authentication-Results: mx.fixture.test; spf=fail smtp.mailfrom=${domain}; dkim=none; dmarc=fail header.from=${domain}`);
  if (a === "softfail") h.push(`Authentication-Results: mx.fixture.test; spf=softfail smtp.mailfrom=${domain}; dkim=none; dmarc=none`);
  if (a === "forwarded") h.push(`Authentication-Results: mx.fixture.test; spf=fail smtp.mailfrom=${domain}; dkim=fail; dmarc=fail header.from=${domain}; arc=pass`, `X-Forwarded-To: morgan@fernhill.example`);
  for (const [k, v] of Object.entries(m.headers ?? {})) h.push(`${k}: ${v}`);

  const textPart = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${m.text ?? ""}`;
  const htmlPart = m.html ? `Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${m.html}` : null;
  let body = textPart;
  if (htmlPart && m.text !== undefined) {
    body = `Content-Type: multipart/alternative; boundary=alt\r\n\r\n--alt\r\n${textPart}\r\n--alt\r\n${htmlPart}\r\n--alt--`;
  } else if (htmlPart) body = htmlPart;
  if (m.attachments?.length) {
    const parts = m.attachments.map(x => {
      const b64 = Buffer.from(x.content).toString("base64").replace(/(.{76})/g, "$1\r\n");
      return `--mix\r\nContent-Type: ${x.contentType}\r\nContent-Disposition: attachment; filename="${x.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}`;
    }).join("\r\n");
    body = `Content-Type: multipart/mixed; boundary=mix\r\n\r\n--mix\r\n${body}\r\n${parts}\r\n--mix--`;
  }
  return `${h.join("\r\n")}\r\n${body}\r\n`;
}

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Minimal valid ZIP with a stored entry, for archive inspection. No inflation is needed. */
export function zipOf(entries: { name: string; content?: string; encrypted?: boolean; fakeUncompressed?: number }[]): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.content ?? "x"), name = Buffer.from(e.name);
    const flags = e.encrypted ? 1 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(e.fakeUncompressed ?? data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(e.fakeUncompressed ?? data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
