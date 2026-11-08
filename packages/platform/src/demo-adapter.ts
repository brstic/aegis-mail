import { randomUUID } from "node:crypto";
import { CAPABILITIES, CursorExpiredError, type ConnectionTestResult, type FolderRole, type MailAdapter, type MailChange, type MessageChange, type OutboundMessage, type RemoteFolder, type SyncPage } from "@aegis/domain";
import type { AccountRow, Platform } from "./context";

/**
 * Real MailAdapter over a synthetic store. Everything downstream (parser, detectors, encryption, RLS) is the
 * production code path. Sending appends to a synthetic Sent folder; nothing leaves the machine.
 */
export class DemoAdapter implements MailAdapter {
  readonly kind = "demo" as const;
  readonly capabilities = CAPABILITIES.demo;
  constructor(private p: Platform, private account: AccountRow) {}
  private w<T>(fn: Parameters<Platform["db"]["withWorker"]>[1] extends (t: infer X) => any ? (t: X) => Promise<T> : never) { return this.p.db.withWorker(this.account.tenant_id, fn as never) as Promise<T>; }

  async testConnection(): Promise<ConnectionTestResult> { return { ok: true, folders: 6 }; }
  async listFolders(): Promise<RemoteFolder[]> { return (["inbox", "sent", "drafts", "archive", "spam", "trash"] as FolderRole[]).map(r => ({ remoteId: r, name: r, role: r })); }

  private toChange(r: any): MailChange {
    if (r.deleted) return { type: "delete", remoteId: r.remote_id };
    return { type: "upsert", remoteId: r.remote_id, remoteThreadId: r.remote_thread_id ?? undefined, internalDate: new Date(r.internal_date).toISOString(), raw: r.raw, state: { folderRole: r.folder_role, labels: r.labels, isRead: r.is_read, isStarred: r.is_starred } };
  }
  private async page(after: number, limit: number): Promise<SyncPage> {
    const rows = await this.w<any[]>(t => t.query("SELECT *, seq FROM demo_mailbox WHERE account_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [this.account.id, after, limit]) as never);
    const last = rows.length ? Number(rows[rows.length - 1].seq) : after;
    return { changes: rows.map(r => this.toChange(r)), cursor: String(last), hasMore: rows.length === limit };
  }
  async fullSync(o: { windowDays: number; pageSize: number; cursor?: string }) { return this.page(Number(o.cursor ?? 0), o.pageSize); }
  async incrementalSync(cursor: string, o: { pageSize: number }) {
    if (!/^\d+$/.test(cursor)) throw new CursorExpiredError("bad demo cursor");
    return this.page(Number(cursor), o.pageSize);
  }
  async fetchRaw(remoteId: string) {
    const r = await this.w<any>(t => t.one("SELECT raw FROM demo_mailbox WHERE account_id=$1 AND remote_id=$2", [this.account.id, remoteId]) as never);
    if (!r) throw new Error("not found");
    return r.raw as Uint8Array;
  }
  async applyChange(remoteId: string, c: MessageChange) {
    await this.w(t => t.query(
      `UPDATE demo_mailbox SET folder_role=COALESCE($3,folder_role), is_read=COALESCE($4,is_read), is_starred=COALESCE($5,is_starred)
       WHERE account_id=$1 AND remote_id=$2`, [this.account.id, remoteId, c.moveToRole ?? null, c.isRead ?? null, c.isStarred ?? null]) as never);
  }
  async send(m: OutboundMessage) {
    const remoteId = `sent-${randomUUID()}`;
    const head = [`From: "${m.from.name ?? ""}" <${m.from.address}>`, `To: ${m.to.map(a => a.address).join(", ")}`, m.cc?.length ? `Cc: ${m.cc.map(a => a.address).join(", ")}` : null, `Subject: ${m.subject}`, `Date: ${this.p.now().toUTCString()}`, `Message-ID: ${m.messageId}`, m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : null, m.references?.length ? `References: ${m.references.join(" ")}` : null, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"].filter(Boolean).join("\r\n");
    const raw = m.attachments?.length ? (await (await import("@aegis/mail-adapters")).composeMime(m, { keepBcc: false })).raw : Buffer.from(`${head}\r\n\r\n${m.text}\r\n`);
    await this.w(t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,internal_date,raw,folder_role,is_read) VALUES ($1,$2,$3,$4,$5,'sent',true)", [this.account.id, this.account.tenant_id, remoteId, this.p.now(), raw]) as never);
    return { remoteId, acceptedAt: this.p.now().toISOString() };
  }
  async findSentByMessageId(messageId: string) {
    const rows = await this.w<any[]>(t => t.query("SELECT remote_id FROM demo_mailbox WHERE account_id=$1 AND folder_role='sent' AND position($2::bytea in raw) > 0 LIMIT 1", [this.account.id, Buffer.from(messageId)]) as never);
    return rows[0] ? { remoteId: rows[0].remote_id } : null;
  }
  async revoke() { return true; }
}
