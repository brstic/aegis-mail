import { randomUUID } from "node:crypto";
import { AppError, notFound, type Platform } from "./context";
import { enqueue, PermanentJobError } from "./jobs";
import { openUnderKms, sealUnderKms, type TransactionalMail } from "./mailer";

export type MailKind = "verify_email" | "password_reset" | "invite" | "digest" | "security_notice";

export const mailUnavailable = () => new AppError(503, "mail_unavailable", "This deployment can't send email yet, so this can't be done. An administrator needs to set up a mail relay.");

const ctxOf = (id: string) => `outbound_mail:${id}`;

/**
 * Seals the rendered mail and queues it. The job carries only the row's id: a link inside the mail stays out of the jobs
 * table and out of logs. Called after the caller's transaction commits.
 */
export async function queueMail(p: Platform, kind: MailKind, mail: TransactionalMail): Promise<string> {
  if (!p.mailer) throw mailUnavailable();
  const id = randomUUID();
  const enc = await sealUnderKms(p.kms, ctxOf(id), mail);
  await p.db.withSystem(async t => {
    await t.query("INSERT INTO outbound_mail(id,kind,content_enc) VALUES ($1,$2,$3)", [id, kind, enc]);
    await enqueue(t, { tenantId: null, kind: "mail.send", payload: { mailId: id }, maxAttempts: 6 });
  });
  return id;
}

/** Worker side. Retries come from the job queue. The content goes as soon as it's been handed over. */
export async function deliverMail(p: Platform, mailId: string) {
  const row = await p.db.withSystem(t => t.one<{ content_enc: Buffer | null; state: string }>("SELECT content_enc, state FROM outbound_mail WHERE id=$1", [mailId]));
  if (!row || row.state !== "queued" || !row.content_enc) return;
  if (!p.mailer) throw new PermanentJobError("mail_unavailable");
  const mail = await openUnderKms<TransactionalMail>(p.kms, ctxOf(mailId), row.content_enc);
  await p.mailer.send(mail);
  await p.db.withSystem(t => t.query("UPDATE outbound_mail SET state='sent', content_enc=NULL, finished_at=now() WHERE id=$1", [mailId]));
}

export async function mailFailed(p: Platform, mailId: string, code: string) {
  await p.db.withSystem(t => t.query("UPDATE outbound_mail SET state='failed', content_enc=NULL, error_code=$2, finished_at=now() WHERE id=$1", [mailId, code.slice(0, 64)]));
}

/** The dev page's data. Exists only in demo mode. */
export async function listDevOutbox(p: Platform, limit = 50) {
  if (!p.config.demoMode) throw notFound();
  const rows = await p.db.withSystem(t => t.query<{ id: string; content_enc: Buffer; created_at: Date }>("SELECT id, content_enc, created_at FROM dev_outbox ORDER BY created_at DESC LIMIT $1", [limit]));
  return Promise.all(rows.map(async r => ({ id: r.id, createdAt: r.created_at, ...(await openUnderKms<TransactionalMail>(p.kms, `dev_outbox:${r.id}`, r.content_enc)) })));
}
