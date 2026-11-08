import { hash as argon2Hash } from "@node-rs/argon2";
import { createHash } from "node:crypto";
import type { Tx } from "@aegis/db";
import { randomToken } from "@aegis/cryptography";
import { PRODUCT_NAME } from "@aegis/domain";
import { audit } from "./audit";
import { PASSWORD_HASH_PARAMS, rateLimit, ssoEnforcedFor, ssoRequired, verifyUserTotp } from "./auth";
import { AppError, badRequest, type Ctx, type Platform } from "./context";
import { errorCode } from "./log";
import { mailUnavailable, queueMail } from "./mail-queue";
import type { TransactionalMail } from "./mailer";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (e: string) => e.trim().toLowerCase();
const VERIFY_SECONDS = 24 * 3600;
const RESET_SECONDS = 3600;

const tokenInvalid = () => badRequest("token_invalid", "That link isn't valid anymore. It may have expired or already been used.");

/** Only one link per purpose stays live, so an older email stops working when a newer one goes out. */
async function issueToken(t: Tx, userId: string, email: string, purpose: "verify_email" | "password_reset", seconds: number) {
  const token = randomToken(32);
  await t.query("DELETE FROM email_tokens WHERE user_id=$1 AND purpose=$2 AND consumed_at IS NULL", [userId, purpose]);
  await t.query("INSERT INTO email_tokens(user_id,purpose,token_hash,email,expires_at) VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 second'))", [userId, purpose, sha(token), email, seconds]);
  return token;
}

async function auditTenant(t: Tx, userId: string) {
  return (await t.one<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1", [userId]))?.tenant_id ?? null;
}

/**
 * A workspace name is whatever the inviter typed. It goes into mail sent to a stranger, so it can't carry a link or line
 * breaks: this product's own invitations must not be a phishing channel.
 */
export function sanitizeMailText(raw: string, max = 80) {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\S*:\/\/\S*/g, " ")
    .replace(/\bwww\.\S*/gi, " ")
    .replace(/\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b\S*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, max);
}

export function inviteMail(p: Platform, to: string, acceptUrl: string, workspaceName: string): TransactionalMail {
  const name = sanitizeMailText(workspaceName);
  return {
    to,
    subject: `You've been invited to a workspace on ${PRODUCT_NAME}`,
    text: `You've been invited to join ${name ? `the workspace "${name}"` : "a workspace"} on ${PRODUCT_NAME}.\n\nTo accept, open this link and sign in with this email address:\n\n${acceptUrl}\n\nThe link works for 7 days. Joining a workspace doesn't give its admins access to your mail content, and it doesn't connect a mailbox.\n\nIf you weren't expecting this, you can ignore this email.\n`,
  };
}

function verifyMail(p: Platform, to: string, token: string): TransactionalMail {
  return {
    to,
    subject: `Confirm your email address for ${PRODUCT_NAME}`,
    text: `Someone created an account at ${PRODUCT_NAME} with this address. If that was you, confirm it here:\n\n${p.config.appOrigin}/verify-email/${token}\n\nThe link works for 24 hours and can be used once. If it wasn't you, ignore this email and don't open the link.\n`,
  };
}

function resetMail(p: Platform, to: string, token: string): TransactionalMail {
  return {
    to,
    subject: `Reset your ${PRODUCT_NAME} password`,
    text: `Someone asked to reset the password for this ${PRODUCT_NAME} account. If that was you, choose a new password here:\n\n${p.config.appOrigin}/reset-password/${token}\n\nThe link works for 1 hour and can be used once. Resetting signs you out everywhere and removes your passkeys, so you'll add those again afterwards. If it wasn't you, ignore this email and your password stays the same.\n`,
  };
}

function factorAddedMail(p: Platform, to: string, what: string): TransactionalMail {
  return {
    to,
    subject: `A new way to sign in was added to your ${PRODUCT_NAME} account`,
    text: `${what[0]!.toUpperCase()}${what.slice(1)} was just added to your ${PRODUCT_NAME} account, and your other devices were signed out.\n\nIf that was you, there's nothing to do.\n\nIf it wasn't, someone else has been using your account. Reset your password now, which signs everyone out and removes every passkey:\n\n${p.config.appOrigin}/forgot-password\n\nIf an authenticator app you don't recognize is asking you for a code, contact your administrator or support.\n`,
  };
}

/** After the change commits. A relay that's down must not undo a factor the owner added, so this logs rather than throws. */
export async function notifyFactorAdded(p: Platform, userId: string, what: "a passkey" | "an authenticator app") {
  if (!p.mailer) return;
  try {
    const u = await p.db.withSystem(t => t.one<{ email: string }>("SELECT email FROM users WHERE id=$1 AND deleted_at IS NULL", [userId]));
    if (u) await queueMail(p, "security_notice", factorAddedMail(p, u.email, what));
  } catch (e) { p.log.warn("auth.factor_notice_failed", { errorCode: errorCode(e) }); }
}

/** Says the code was spent and how many are left. Goes out even if this was the owner, since a stolen code looks identical. */
export async function notifyRecoveryCodeUsed(p: Platform, userId: string, left: number) {
  if (!p.mailer) return;
  try {
    const u = await p.db.withSystem(t => t.one<{ email: string }>("SELECT email FROM users WHERE id=$1 AND deleted_at IS NULL", [userId]));
    if (u) await queueMail(p, "security_notice", { to: u.email, subject: `A recovery code was used on your ${PRODUCT_NAME} account`, text: `A recovery code was just used to get into your account. ${left} ${left === 1 ? "code is" : "codes are"} left.\n\nIf this wasn't you, change your password, then replace your codes and your authenticator app in your security settings: ${p.config.appOrigin}/app/settings/security\n` });
  } catch (e) { p.log.warn("auth.factor_notice_failed", { errorCode: errorCode(e) }); }
}

export async function sendVerificationEmail(p: Platform, userId: string, email: string) {
  if (!p.mailer) throw mailUnavailable();
  const token = await p.db.withSystem(t => issueToken(t, userId, email, "verify_email", VERIFY_SECONDS));
  await queueMail(p, "verify_email", verifyMail(p, email, token));
}

/** The banner's resend button. */
export async function resendVerification(p: Platform, ctx: Ctx) {
  await rateLimit(p, `verify-resend:${ctx.userId}`, 5, 3600);
  const u = await p.db.withSystem(t => t.one<{ email: string; email_verified_at: Date | null }>("SELECT email, email_verified_at FROM users WHERE id=$1 AND deleted_at IS NULL", [ctx.userId]));
  if (!u || u.email_verified_at) return { alreadyVerified: true };
  await sendVerificationEmail(p, ctx.userId, u.email);
  return { alreadyVerified: false };
}

/** A POST from the page behind the link, so a mail scanner that fetches links can't spend or complete it. */
export async function confirmEmail(p: Platform, token: string, clientKey?: string) {
  if (clientKey) await rateLimit(p, `verify-confirm:${sha(clientKey)}`, 30, 900);
  await p.db.withSystem(async t => {
    const k = await t.one<{ user_id: string; email: string }>("UPDATE email_tokens SET consumed_at=now() WHERE token_hash=$1 AND purpose='verify_email' AND consumed_at IS NULL AND expires_at>now() RETURNING user_id, email", [sha(token)]);
    if (!k) throw tokenInvalid();
    const u = await t.one("UPDATE users SET email_verified_at=COALESCE(email_verified_at, now()) WHERE id=$1 AND lower(email)=lower($2) AND deleted_at IS NULL RETURNING id", [k.user_id, k.email]);
    if (!u) throw tokenInvalid();
    await audit(t, { tenantId: await auditTenant(t, k.user_id), actor: k.user_id, event: "auth.email_verified" });
  });
}

/**
 * The same answer for every address. All the work that depends on the address runs after the response is decided, so
 * neither the body nor the timing says whether it has an account. `done` exists for tests.
 */
export async function requestPasswordReset(p: Platform, rawEmail: string, clientKey?: string) {
  if (!p.mailer) throw mailUnavailable();
  const email = norm(rawEmail);
  if (clientKey) await rateLimit(p, `reset-client:${sha(clientKey)}`, 20, 3600);
  const done = issueReset(p, email).catch(e => p.log.warn("auth.reset_request_failed", { errorCode: errorCode(e) }));
  return { ok: true as const, done };
}

async function issueReset(p: Platform, email: string) {
  // Per address and silent: it stops a stranger mail-bombing someone, and answering 429 here would let them lock resets out.
  try { await rateLimit(p, `reset-email:${sha(email)}`, 5, 3600); } catch (e) { if (e instanceof AppError && e.status === 429) return; throw e; }
  const token = await p.db.withSystem(async t => {
    const u = await t.one<{ id: string; email: string }>("SELECT id, email FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [email]);
    if (!u) return null;
    // These accounts sign in through their organization, so a password wouldn't work anyway.
    if (await ssoEnforcedFor(t, email)) return null;
    return { value: await issueToken(t, u.id, u.email, "password_reset", RESET_SECONDS), to: u.email };
  });
  if (token) await queueMail(p, "password_reset", resetMail(p, token.to, token.value));
}

export async function resetPassword(p: Platform, input: { token: string; password: string; totp?: string }, clientKey?: string) {
  if (clientKey) await rateLimit(p, `reset-finish:${sha(clientKey)}`, 30, 900);
  if (input.password.length < 12) throw badRequest("weak_password", "Use a password of at least 12 characters.");
  const row = await p.db.withSystem(t => t.one<{ id: string; user_id: string; token_email: string; email: string; totp_enabled: boolean; totp_secret_enc: Buffer | null; email_verified_at: Date | null }>(
    `SELECT k.id, k.user_id, k.email token_email, u.email, u.totp_enabled, u.totp_secret_enc, u.email_verified_at FROM email_tokens k JOIN users u ON u.id=k.user_id
     WHERE k.token_hash=$1 AND k.purpose='password_reset' AND k.consumed_at IS NULL AND k.expires_at>now() AND u.deleted_at IS NULL`, [sha(input.token)]));
  if (!row || norm(row.token_email) !== norm(row.email)) throw tokenInvalid();
  if (await p.db.withSystem(t => ssoEnforcedFor(t, row.email))) throw ssoRequired();
  // Mailbox access alone doesn't get past the authenticator app. The link stays usable, so a mistyped code costs nothing.
  if (row.totp_enabled) {
    if (!input.totp) throw new AppError(401, "mfa_required", "This account uses an authenticator app. Enter a current code to reset the password.");
    await rateLimit(p, `totp-verify:${row.user_id}`, 10, 900);
    if (!(await verifyUserTotp(p, row.user_id, row.totp_secret_enc, input.totp))) throw new AppError(401, "invalid_mfa", "That code isn't right. Check the time on your device and try again.");
  }
  const hash = await argon2Hash(input.password, PASSWORD_HASH_PARAMS);
  await p.db.withSystem(async t => {
    const spent = await t.one("UPDATE email_tokens SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL RETURNING id", [row.id]);
    if (!spent) throw tokenInvalid();
    await t.query("UPDATE users SET password_hash=$2, email_verified_at=COALESCE(email_verified_at, now()), totp_pending_enc=NULL, totp_pending_session=NULL, totp_pending_password_proven=false WHERE id=$1", [row.user_id, hash]);
    await t.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [row.user_id]);
    await t.query("DELETE FROM email_tokens WHERE user_id=$1 AND consumed_at IS NULL", [row.user_id]);
    // Someone resetting a password may be recovering from a takeover, and a passkey signs in without the password: it would outlive this.
    // The owner adds their own back, which now takes the new password.
    await t.query("DELETE FROM passkeys WHERE user_id=$1", [row.user_id]);
    // Using this link is the first proof of who owns the address. Anything added before that could be a squatter's.
    if (!row.email_verified_at) {
      await t.query("DELETE FROM identities WHERE user_id=$1", [row.user_id]);
    }
    await audit(t, { tenantId: await auditTenant(t, row.user_id), actor: row.user_id, event: "auth.password_reset" });
  });
}

/**
 * Someone signed up with this address and never proved they own it, and the address's real owner has now arrived through a
 * source that does prove it. Anything already on the account could be a squatter's, waiting to share it: this is the
 * pre-hijacking attack. So every way in goes, and the account continues for the proven owner.
 */
export async function neutralizeUnverifiedAccount(t: Tx, userId: string) {
  await t.query("UPDATE users SET password_hash=NULL, totp_enabled=false, totp_secret_enc=NULL, totp_pending_enc=NULL, totp_pending_session=NULL, totp_pending_password_proven=false, totp_last_step=NULL, totp_recovery_hashes='{}', email_verified_at=now() WHERE id=$1", [userId]);
  await t.query("DELETE FROM passkeys WHERE user_id=$1", [userId]);
  await t.query("DELETE FROM identities WHERE user_id=$1", [userId]);
  await t.query("DELETE FROM email_tokens WHERE user_id=$1", [userId]);
  await t.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
}
