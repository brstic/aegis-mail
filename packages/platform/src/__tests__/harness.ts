import { randomBytes } from "node:crypto";
import { createTestDb } from "@aegis/db";
import { LocalDevKms } from "@aegis/cryptography";
import { createPlatform, type Platform, makeLogger, connectAccount, drainJobs, signUp, type Ctx, enqueue } from "../index";
import { mime, type MimeInput } from "@aegis/test-fixtures";

export async function testPlatform(overrides: Parameters<typeof createPlatform>[0] = {}) {
  const { db, drop } = await createTestDb("p");
  const logs: string[] = [];
  const p = createPlatform({ db, kms: new LocalDevKms(randomBytes(32)), config: { demoMode: true, appOrigin: "http://localhost:3000", webauthnRpId: "localhost" }, log: makeLogger(l => logs.push(l)), env: {}, ...overrides });
  return { p, drop, logs };
}

export async function user(p: Platform, email: string, opts: { kind?: "personal" | "organization" } = {}): Promise<Ctx & { token: string }> {
  const s = await signUp(p, { email, password: "correct-horse-battery", name: email.split("@")[0]!, workspaceKind: opts.kind ?? "personal" });
  // Sign-up queues the verification mail. Suites that claim jobs by hand expect to start from an empty queue.
  await drainJobs(p);
  return { tenantId: s.tenantId, userId: s.userId, sessionId: s.sessionId, token: s.token };
}

/**
 * Stands in for clicking the emailed link, for suites whose subject is something else. The link itself is tested through
 * real tokens in identity.test.ts.
 */
export async function markVerified(p: Platform, userId: string) {
  await p.db.withSystem(t => t.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [userId]));
}

/**
 * A code works once in its 30 seconds, which suites using several in a row would otherwise trip over. Stands in for waiting. The rule itself
 * is tested in review-regressions-2.test.ts.
 */
export async function nextTotpStep(p: Platform, userId: string) {
  await p.db.withSystem(t => t.query("UPDATE users SET totp_last_step=NULL WHERE id=$1", [userId]));
}

export async function demoAccount(p: Platform, ctx: Ctx, email = "me@fernhill.example") {
  return connectAccount(p, ctx, { kind: "demo", email, displayName: "Test", credential: { kind: "demo" } });
}

let n = 0;
export async function deliver(p: Platform, ctx: Ctx, accountId: string, input: MimeInput, opts: { folder?: string; hoursAgo?: number; remoteId?: string; thread?: string } = {}) {
  const when = new Date(p.now().getTime() - (opts.hoursAgo ?? 1) * 36e5);
  const remoteId = opts.remoteId ?? `r${++n}-${Date.now()}`;
  await p.db.withWorker(ctx.tenantId, t => t.query("INSERT INTO demo_mailbox(account_id,tenant_id,remote_id,remote_thread_id,internal_date,raw,folder_role) VALUES ($1,$2,$3,$4,$5,$6,$7)", [accountId, ctx.tenantId, remoteId, opts.thread ?? null, when, Buffer.from(mime({ ...input, date: when.toUTCString() })), opts.folder ?? "inbox"]));
  await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "sync.account", payload: { accountId } }));
  await drainJobs(p);
  const row = await p.db.withWorker(ctx.tenantId, t => t.one<any>("SELECT id, thread_id, risk_label, policy_action, held, priority_section, priority_score, folder_role FROM messages WHERE account_id=$1 AND provider_message_id=$2", [accountId, remoteId]));
  return { ...row!, remoteId };
}
