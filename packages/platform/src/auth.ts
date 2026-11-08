import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { Secret, TOTP } from "otpauth";
import type { Tx } from "@aegis/db";
import { randomToken } from "@aegis/cryptography";
import { audit } from "./audit";
import { AppError, badRequest, type Ctx, type Platform } from "./context";
import { notifyFactorAdded, notifyRecoveryCodeUsed, sendVerificationEmail } from "./identity";

const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };
export const SESSION_HOURS = 24 * 7;
export const SESSION_IDLE_HOURS = 24;
/**
 * How long a new passkey stays on probation: as long as the longest session. A sign-in with a younger one doesn't stand in for a
 * password, so a session that managed to add a passkey can't use it to mint itself something better.
 */
export const PASSKEY_TRUST_HOURS = SESSION_HOURS;
const RECENT_SIGN_IN_MINUTES = 10;
export { ARGON2 as PASSWORD_HASH_PARAMS };

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
const norm = (e: string) => e.trim().toLowerCase();

let dummyHash: Promise<string> | null = null;
/** Verified against when the user doesn't exist, so response time doesn't reveal which emails are registered. */
function dummy() { return (dummyHash ??= argon2Hash(randomBytes(16).toString("hex"), ARGON2)); }

export interface SessionInfo { sessionId: string; userId: string; tenantId: string; role: string; email: string; name: string; workspaces: { id: string; name: string; kind: string; role: string }[]; mfaEnabled: boolean; expiresAt: Date; emailVerified: boolean }

/** Fixed window limiter persisted in Postgres so it holds across processes. */
export async function rateLimit(p: Platform, key: string, limit: number, windowSec: number) {
  const row = await p.db.withSystem(t => t.one<{ count: number }>(
    `INSERT INTO rate_limits(key,count,window_start) VALUES ($1,1,now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - ($2::int * interval '1 second') THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - ($2::int * interval '1 second') THEN now() ELSE rate_limits.window_start END
     RETURNING count`, [key, windowSec]));
  if (row && row.count > limit) throw new AppError(429, "rate_limited", "Too many attempts. Try again in a few minutes.");
}

export type AuthMethod = "password" | "passkey" | "passkey_recent" | "idp";
/** How a session began. mfaPassed means a second factor was actually presented to it, never that one merely exists on the account. */
export interface SessionProof { method: AuthMethod; mfaPassed: boolean }

export async function createSession(p: Platform, t: Tx, userId: string, tenantId: string | null, proof: SessionProof, ua?: string) {
  // Every way in comes through here. Someone whose only workspaces are suspended gets told why, and nothing about their data changes.
  const blocked = await t.one<{ reason: string }>("SELECT x.reason FROM memberships m JOIN tenant_suspensions x ON x.tenant_id=m.tenant_id WHERE m.user_id=$1 AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.user_id=$1 AND NOT EXISTS (SELECT 1 FROM tenant_suspensions y WHERE y.tenant_id=o.tenant_id)) LIMIT 1", [userId]);
  if (blocked) throw new AppError(403, "workspace_suspended", `This workspace has been suspended by the service operator. Nothing has been deleted. Reason given: ${blocked.reason}`);
  const token = randomToken(32);
  const s = await t.one<{ id: string; expires_at: Date }>(
    "INSERT INTO sessions(user_id, token_hash, active_tenant_id, mfa_passed, auth_method, user_agent_summary, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7::int * interval '1 hour')) RETURNING id, expires_at",
    [userId, tokenHash(token), tenantId, proof.mfaPassed, proof.method, (ua ?? "").slice(0, 80) || null, SESSION_HOURS]);
  return { token, sessionId: s!.id, expiresAt: s!.expires_at };
}

/**
 * Whether this instance takes a new account for `email`. With sign-up set to "invite", only the first account on an empty instance
 * (its administrator) and addresses with a pending invitation qualify. The lock makes two simultaneous first sign-ups take turns.
 */
export async function signupAllowed(p: Platform, t: Tx, email: string): Promise<boolean> {
  if (p.config.signup !== "invite") return true;
  await t.query("SELECT pg_advisory_xact_lock(hashtextextended('signup:first', 727003))");
  if (!(await t.one("SELECT 1 FROM users LIMIT 1"))) return true;
  return !!(await t.one("SELECT 1 FROM invitations WHERE lower(email)=$1 AND accepted_at IS NULL AND expires_at>now() LIMIT 1", [norm(email)]));
}
export const signupClosed = () => new AppError(403, "signup_closed", "This server takes new accounts by invitation. Ask someone who runs a workspace here to invite your address.");

export async function signUp(p: Platform, input: { email: string; password: string; name: string; workspaceKind: "personal" | "organization"; workspaceName?: string }, ua?: string, clientKey?: string) {
  const email = norm(input.email);
  await rateLimit(p, `signup:${tokenHash(email)}`, 5, 3600);
  // Hashing is deliberately expensive, so unlimited signups would be a CPU attack.
  if (clientKey) await rateLimit(p, `signup-client:${tokenHash(clientKey)}`, 30, 3600);
  if (input.password.length < 12) throw badRequest("weak_password", "Use a password of at least 12 characters.");
  if (await p.db.withSystem(t => ssoEnforcedFor(t, email))) throw ssoRequired();
  const passwordHash = await argon2Hash(input.password, ARGON2);
  const created = await p.db.withSystem(async t => {
    const exists = await t.one("SELECT 1 FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [email]);
    // Honest about the conflict at sign-up. Sign-in itself doesn't reveal existence.
    if (exists) throw new AppError(409, "email_taken", "An account with this email already exists. Try signing in.");
    if (!(await signupAllowed(p, t, email))) throw signupClosed();
    const u = await t.one<{ id: string }>("INSERT INTO users(email,name,password_hash) VALUES ($1,$2,$3) RETURNING id", [email, input.name, passwordHash]);
    const tenantId = await createWorkspace(t, u!.id, input.workspaceKind, input.workspaceName ?? (input.workspaceKind === "personal" ? `${input.name}'s workspace` : `${input.name}'s organization`));
    const s = await createSession(p, t, u!.id, tenantId, { method: "password", mfaPassed: false }, ua);
    await audit(t, { tenantId, actor: u!.id, event: "auth.login", meta: { outcome: "signup" } });
    return { ...s, userId: u!.id, tenantId };
  });
  // After commit. The account exists either way, and the banner in the app can resend.
  const verificationQueued = await sendVerificationEmail(p, created.userId, email).then(() => true, () => false);
  return { ...created, verificationQueued };
}

/** Domain-level, not account-level: it says the same thing whether or not this address has an account. */
export async function ssoEnforcedFor(t: Tx, email: string): Promise<boolean> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  const r = await t.one<{ enforced: boolean }>("SELECT enforced FROM sso_discover($1)", [domain]);
  return r?.enforced === true;
}
export const ssoRequired = () => new AppError(403, "sso_required", "Your organization requires single sign-on for this email address.");

export async function createWorkspace(t: Tx, userId: string, kind: "personal" | "organization", name: string) {
  const o = await t.one<{ id: string }>("INSERT INTO organizations(kind,name) VALUES ($1,$2) RETURNING id", [kind, name]);
  await t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'owner')", [o!.id, userId]);
  await t.query("INSERT INTO tenant_policies(tenant_id) VALUES ($1)", [o!.id]);
  return o!.id;
}

/**
 * Two limits. Per email and client stops guessing from one place without letting a stranger lock out the real user. A much
 * higher per-email ceiling stops distributed guessing. Spraying many addresses is caught per client.
 */
export async function signIn(p: Platform, input: { email: string; password: string; totp?: string }, ua?: string, clientKey?: string) {
  const email = norm(input.email);
  await rateLimit(p, `signin:${tokenHash(email)}:${clientKey ? tokenHash(clientKey) : "none"}`, 10, 900);
  if (clientKey) {
    await rateLimit(p, `signin-ceiling:${tokenHash(email)}`, 100, 900);
    await rateLimit(p, `signin-client:${tokenHash(clientKey)}`, 200, 900);
  }
  if (await p.db.withSystem(t => ssoEnforcedFor(t, email))) throw ssoRequired();
  const user = await p.db.withSystem(t => t.one<any>("SELECT id, password_hash, totp_enabled, totp_secret_enc FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [email]));
  const ok = await argon2Verify(user?.password_hash ?? (await dummy()), input.password).catch(() => false);
  const invalid = new AppError(401, "invalid_credentials", "That email and password don't match.");
  if (!user || !user.password_hash || !ok) {
    if (user) await p.db.withSystem(async t => { const m = await t.one<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1 LIMIT 1", [user.id]); await audit(t, { tenantId: m?.tenant_id ?? null, actor: user.id, event: "auth.login_failed" }); });
    throw invalid;
  }
  if (user.totp_enabled) {
    if (!input.totp) throw new AppError(401, "mfa_required", "Enter the code from your authenticator app.");
    if (!(await verifyUserTotp(p, user.id, user.totp_secret_enc, input.totp))) throw new AppError(401, "invalid_mfa", "That code isn't right. Check the time on your device and try again.");
  }
  return p.db.withSystem(async t => {
    const m = await t.one<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1", [user.id]);
    // Someone removed from their only organization still has an account, so give them somewhere to land.
    const tenantId = m?.tenant_id ?? await createWorkspace(t, user.id, "personal", "Personal workspace");
    const s = await createSession(p, t, user.id, tenantId, { method: "password", mfaPassed: user.totp_enabled === true }, ua);
    await audit(t, { tenantId, actor: user.id, event: "auth.login", meta: { outcome: user.totp_enabled ? "mfa" : "password" } });
    return { ...s, userId: user.id, tenantId: m?.tenant_id ?? null };
  });
}

/**
 * Demo only: a session for a seeded synthetic user, with no password check and no per-email limit, since every demo
 * visitor shares one identity. Refuses outside demo mode. Limited per client by the caller instead.
 */
export async function demoSession(p: Platform, email: string, ua?: string) {
  if (!p.config.demoMode) throw new AppError(404, "not_found", "Not found");
  return p.db.withSystem(async t => {
    const u = await t.one<{ id: string }>("SELECT id FROM users WHERE lower(email)=$1 AND deleted_at IS NULL", [norm(email)]);
    if (!u) throw new AppError(409, "demo_not_seeded", "The demo workspace isn't set up yet. Run: pnpm db:seed");
    const m = await t.one<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1", [u.id]);
    return createSession(p, t, u.id, m?.tenant_id ?? null, { method: "password", mfaPassed: false }, ua);
  });
}

export async function resolveSession(p: Platform, token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  return p.db.withSystem(async t => {
    const s = await t.one<any>(
      `SELECT s.id, s.user_id, s.active_tenant_id, s.expires_at, u.email, u.name, u.totp_enabled, u.email_verified_at FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.last_seen_at > now() - ($2::int * interval '1 hour') AND u.deleted_at IS NULL`,
      [tokenHash(token), SESSION_IDLE_HOURS]);
    if (!s) return null;
    await t.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1 AND last_seen_at < now() - interval '1 minute'", [s.id]);
    const ws = await t.query<any>("SELECT o.id, o.name, o.kind, m.role FROM memberships m JOIN organizations o ON o.id=m.tenant_id WHERE m.user_id=$1 AND NOT EXISTS (SELECT 1 FROM tenant_suspensions x WHERE x.tenant_id=o.id) ORDER BY m.created_at", [s.user_id]);
    const active = ws.find(w => w.id === s.active_tenant_id) ?? ws[0];
    if (!active) return null;
    return { sessionId: s.id, userId: s.user_id, tenantId: active.id, role: active.role, email: s.email, name: s.name, workspaces: ws, mfaEnabled: s.totp_enabled, expiresAt: s.expires_at, emailVerified: !!s.email_verified_at };
  });
}

/** Someone in another, working workspace still signs in. This is how they learn why one of theirs has gone from the list. */
export async function suspendedWorkspaces(p: Platform, userId: string) {
  return p.db.withSystem(t => t.query<{ name: string; reason: string }>("SELECT o.name, x.reason FROM memberships m JOIN organizations o ON o.id=m.tenant_id JOIN tenant_suspensions x ON x.tenant_id=m.tenant_id WHERE m.user_id=$1 ORDER BY x.suspended_at DESC LIMIT 5", [userId]));
}

export async function switchWorkspace(p: Platform, session: SessionInfo, tenantId: string) {
  if (!session.workspaces.some(w => w.id === tenantId)) throw new AppError(404, "not_found", "Not found");
  await p.db.withSystem(t => t.query("UPDATE sessions SET active_tenant_id=$2 WHERE id=$1", [session.sessionId, tenantId]));
}

/** New token, same session identity. Called after privilege changes such as enabling MFA. */
export async function rotateSession(p: Platform, sessionId: string) {
  const token = randomToken(32);
  await p.db.withSystem(t => t.query("UPDATE sessions SET token_hash=$2 WHERE id=$1 AND revoked_at IS NULL", [sessionId, tokenHash(token)]));
  return token;
}

export async function signOut(p: Platform, sessionId: string) {
  await p.db.withSystem(t => t.query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [sessionId]));
}

export async function listSessions(p: Platform, userId: string, currentId: string) {
  const rows = await p.db.withSystem(t => t.query<any>("SELECT id, user_agent_summary, created_at, last_seen_at, expires_at FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY last_seen_at DESC LIMIT 50", [userId]));
  return rows.map(r => ({ id: r.id, device: r.user_agent_summary ?? "Unknown device", createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentId }));
}

export async function revokeSession(p: Platform, ctx: Ctx, sessionId: string) {
  await p.db.withSystem(async t => {
    const r = await t.query("UPDATE sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id", [sessionId, ctx.userId]);
    if (r.length) await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "session.revoked" });
  });
}

// ---------- TOTP ----------
const totpCtx = (userId: string) => ({ tenantId: "00000000-0000-0000-0000-000000000000", keyClass: "credential" as const, table: "users", recordId: userId });

const TOTP_PERIOD = 30;
function totpFor(secretBase32: string, email: string) {
  return new TOTP({ issuer: "Aegis Mail", label: email, algorithm: "SHA1", digits: 6, period: TOTP_PERIOD, secret: Secret.fromBase32(secretBase32) });
}

async function sealTotp(p: Platform, ctx: Ctx, secret: string) {
  return p.envelope.seal({ tenantId: ctx.tenantId, keyClass: "credential", table: "users", recordId: ctx.userId }, secret);
}

/**
 * Accepts a code once. The step is claimed in one statement, so two requests racing with the same code can't both win. A pending secret
 * records nothing: it isn't a factor yet, and proving it spends nothing on the secret it will replace.
 */
export async function verifyUserTotp(p: Platform, userId: string, enc: Buffer | null, code: string, opts: { pending?: boolean } = {}) {
  if (!enc) return false;
  // A recovery code stands in wherever a current code is asked for, except when setting up a new app: that proves the new secret works.
  if (!opts.pending && RECOVERY_CODE.test(code.toLowerCase())) return useRecoveryCode(p, userId, code.toLowerCase());
  // TOTP secrets are sealed under the tenant the user enrolled in; the header stores it.
  const tenantId = enc.subarray(0, 36).toString("ascii");
  const secret = (await p.envelope.open({ ...totpCtx(userId), tenantId }, enc.subarray(36))).toString("utf8");
  const at = Date.now();
  const delta = totpFor(secret, "x").validate({ token: code, window: 1, timestamp: at });
  if (delta === null) return false;
  if (opts.pending) return true;
  const step = Math.floor(at / (TOTP_PERIOD * 1000)) + delta;
  return !!(await p.db.withSystem(t => t.one("UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step<$2) RETURNING id", [userId, step])));
}

/** What's asked for before an action a stolen session must not be able to take alone. */
// ---------- Recovery codes ----------
const RECOVERY_CODE = /^[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}$/;
const RECOVERY_CODE_COUNT = 10;
const recoveryHash = (code: string) => createHash("sha256").update(code).digest("hex");
function newRecoveryCodes() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = Array.from(randomBytes(15), b => alphabet[b & 31]!).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10)}`;
  });
}
/** Spent in one statement, so two requests racing with the same code can't both win. */
async function useRecoveryCode(p: Platform, userId: string, code: string) {
  const r = await p.db.withSystem(t => t.one<{ left: number; tenant: string | null }>(
    `UPDATE users SET totp_recovery_hashes=array_remove(totp_recovery_hashes,$2) WHERE id=$1 AND $2=ANY(totp_recovery_hashes)
     RETURNING cardinality(totp_recovery_hashes) AS left, (SELECT tenant_id::text FROM memberships WHERE user_id=$1 LIMIT 1) AS tenant`, [userId, recoveryHash(code)]));
  if (!r) return false;
  await p.db.withSystem(t => audit(t, { tenantId: r.tenant, actor: userId, event: "auth.recovery_code_used", meta: { count: r.left } }));
  await notifyRecoveryCodeUsed(p, userId, r.left);
  return true;
}
export async function recoveryCodeStatus(p: Platform, ctx: Ctx) {
  const u = await p.db.withSystem(t => t.one<{ remaining: number }>("SELECT cardinality(totp_recovery_hashes) AS remaining FROM users WHERE id=$1", [ctx.userId]));
  return { remaining: u?.remaining ?? 0 };
}
/** Replaces every code. Shown once, so anyone who could read the hashes still can't use them. */
export async function regenerateRecoveryCodes(p: Platform, ctx: Ctx, code: string) {
  const u = await p.db.withSystem(t => t.one<{ totp_enabled: boolean }>("SELECT totp_enabled FROM users WHERE id=$1", [ctx.userId]));
  if (!u?.totp_enabled) throw badRequest("mfa_not_enabled", "Your authenticator app isn't turned on.");
  await requireCurrentTotp(p, ctx, code);
  const codes = newRecoveryCodes();
  await p.db.withSystem(async t => {
    await t.query("UPDATE users SET totp_recovery_hashes=$2 WHERE id=$1", [ctx.userId, codes.map(recoveryHash)]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "auth.recovery_codes_replaced" });
  });
  return { recoveryCodes: codes };
}

export interface FactorProof { password?: string; totp?: string }

/** Sign-in refuses a password on a domain that requires SSO, so such a hash proves nothing and the account can't reset it either. */
async function usablePasswordHash(p: Platform, userId: string): Promise<string | null> {
  return p.db.withSystem(async t => {
    const u = await t.one<{ password_hash: string | null; email: string }>("SELECT password_hash, email FROM users WHERE id=$1", [userId]);
    return u?.password_hash && !(await ssoEnforcedFor(t, u.email)) ? u.password_hash : null;
  });
}

/** For the settings pages, to know whether to ask for a password or send someone back through their identity provider. */
export async function canReauthWithPassword(p: Platform, userId: string) {
  return !!(await usablePasswordHash(p, userId));
}

/**
 * A sign-in in the last few minutes stands in for a password only if it proved something the session itself can't. An identity provider
 * always counts. A passkey counts past its probation, and only on an account with no password to ask for instead.
 */
async function recentlySignedIn(p: Platform, ctx: Ctx, hasPassword: boolean) {
  if (!ctx.sessionId) return false;
  const methods: AuthMethod[] = hasPassword ? ["idp"] : ["idp", "passkey", "password"];
  return !!(await p.db.withSystem(t => t.one("SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND auth_method = ANY($3) AND created_at > now() - ($4::int * interval '1 minute')", [ctx.sessionId, ctx.userId, methods, RECENT_SIGN_IN_MINUTES])));
}

/**
 * For the most destructive actions and for adding a way in: a stolen session alone isn't enough. Says whether a password was actually
 * typed, because some callers trust that further than they trust a recent sign-in.
 */
export async function reauthenticate(p: Platform, ctx: Ctx, password: string, totp?: string): Promise<{ passwordPresented: boolean }> {
  await rateLimit(p, `reauth:${ctx.userId}`, 10, 900);
  const hash = await usablePasswordHash(p, ctx.userId);
  let passwordPresented = false;
  if (hash && password) {
    if (!(await argon2Verify(hash, password).catch(() => false))) throw new AppError(401, "invalid_credentials", "That password isn't right.");
    passwordPresented = true;
  } else if (!(await recentlySignedIn(p, ctx, !!hash))) {
    if (hash) throw new AppError(401, "invalid_credentials", "That password isn't right.");
    // Federated accounts have no password.
    throw new AppError(401, "reauth_required", `For safety, sign out and sign in again, then try this within ${RECENT_SIGN_IN_MINUTES} minutes.`);
  }
  await requireCurrentTotp(p, ctx, totp);
  return { passwordPresented };
}

/**
 * Changing how someone signs in needs a code from the active factor, so a hijacked session can't strip MFA or add a login
 * that skips it. Attempts are limited, since a session could otherwise guess a six-digit code at leisure.
 */
export async function requireCurrentTotp(p: Platform, ctx: Ctx, code: string | undefined) {
  const u = await p.db.withSystem(t => t.one<any>("SELECT totp_enabled, totp_secret_enc FROM users WHERE id=$1", [ctx.userId]));
  if (!u?.totp_enabled) return;
  await rateLimit(p, `totp-verify:${ctx.userId}`, 10, 900);
  if (!code || !(await verifyUserTotp(p, ctx.userId, u.totp_secret_enc, code))) throw badRequest("invalid_mfa", "Enter a current code from your authenticator app.");
}

/** Done in the transaction that adds a factor: whoever else is signed in shouldn't keep going without the owner hearing about it. */
async function revokeOtherSessions(t: Tx, userId: string, keep: string | undefined) {
  await t.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2", [userId, keep ?? null]);
}

/**
 * The new secret stays pending, and the active factor keeps working, until a code proves the new one. Starting needs proof of who this is:
 * without it, a stolen session could add a code the owner has never seen and lock them out of both sign-in and password reset.
 */
export async function beginTotpEnrollment(p: Platform, ctx: Ctx, email: string, proof: FactorProof = {}) {
  const { passwordPresented } = await reauthenticate(p, ctx, proof.password ?? "", proof.totp);
  if (!ctx.sessionId) throw new AppError(401, "reauth_required", "For safety, sign out and sign in again, then try this.");
  const secret = new Secret({ size: 20 }).base32;
  const sealed = Buffer.concat([Buffer.from(ctx.tenantId, "ascii"), await sealTotp(p, ctx, secret)]);
  await p.db.withSystem(t => t.query("UPDATE users SET totp_pending_enc=$2, totp_pending_session=$3, totp_pending_password_proven=$4 WHERE id=$1", [ctx.userId, sealed, ctx.sessionId, passwordPresented]));
  return { secret, uri: totpFor(secret, email).toString() };
}

/**
 * The session gets credit for a second factor only if it typed the password to start this and has now shown the new code. A session that
 * got here on a recent sign-in signs in again with the code, which someone holding only that session can't do.
 */
export async function confirmTotp(p: Platform, ctx: Ctx, code: string) {
  const u = await p.db.withSystem(t => t.one<{ totp_pending_enc: Buffer | null; totp_pending_session: string | null; totp_pending_password_proven: boolean }>("SELECT totp_pending_enc, totp_pending_session, totp_pending_password_proven FROM users WHERE id=$1", [ctx.userId]));
  if (!ctx.sessionId || u?.totp_pending_session !== ctx.sessionId) throw badRequest("invalid_mfa", "That setup has ended. Start again.");
  await rateLimit(p, `totp-verify:${ctx.userId}`, 10, 900);
  if (!(await verifyUserTotp(p, ctx.userId, u?.totp_pending_enc ?? null, code, { pending: true }))) throw badRequest("invalid_mfa", "That code isn't right.");
  const recoveryCodes = newRecoveryCodes();
  await p.db.withSystem(async t => {
    await t.query("UPDATE users SET totp_secret_enc=totp_pending_enc, totp_pending_enc=NULL, totp_pending_session=NULL, totp_pending_password_proven=false, totp_last_step=NULL, totp_enabled=true, totp_recovery_hashes=$2 WHERE id=$1", [ctx.userId, recoveryCodes.map(recoveryHash)]);
    await revokeOtherSessions(t, ctx.userId, ctx.sessionId);
    if (u.totp_pending_password_proven) await t.query("UPDATE sessions SET mfa_passed=true WHERE id=$1", [ctx.sessionId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "auth.mfa_enabled" });
  });
  await notifyFactorAdded(p, ctx.userId, "an authenticator app");
  return { rotatedToken: await rotateSession(p, ctx.sessionId), recoveryCodes };
}

export async function disableTotp(p: Platform, ctx: Ctx, code: string) {
  const u = await p.db.withSystem(t => t.one<any>("SELECT totp_enabled FROM users WHERE id=$1", [ctx.userId]));
  if (!u?.totp_enabled) throw badRequest("mfa_not_enabled", "Your authenticator app isn't turned on.");
  await requireCurrentTotp(p, ctx, code);
  await p.db.withSystem(async t => {
    await t.query("UPDATE users SET totp_enabled=false, totp_secret_enc=NULL, totp_pending_enc=NULL, totp_pending_session=NULL, totp_pending_password_proven=false, totp_last_step=NULL, totp_recovery_hashes='{}' WHERE id=$1", [ctx.userId]);
    // The factor these sessions showed is gone, so they haven't shown one anymore.
    await t.query("UPDATE sessions SET mfa_passed=false WHERE user_id=$1 AND auth_method NOT LIKE 'passkey%'", [ctx.userId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "auth.mfa_disabled" });
  });
  return { rotatedToken: ctx.sessionId ? await rotateSession(p, ctx.sessionId) : undefined };
}

// ---------- Passkeys ----------
const rp = (p: Platform) => ({ rpName: "Aegis Mail", rpID: p.config.webauthnRpId, origin: p.config.appOrigin });

async function saveChallenge(t: Tx, userId: string | null, purpose: string, challenge: string) {
  const r = await t.one<{ id: string }>("INSERT INTO auth_challenges(user_id,purpose,challenge,expires_at) VALUES ($1,$2,$3, now() + interval '5 minutes') RETURNING id", [userId, purpose, challenge]);
  return r!.id;
}
async function takeChallenge(t: Tx, id: string, purposePattern: string) {
  const r = await t.one<{ challenge: string; user_id: string | null; purpose: string }>("DELETE FROM auth_challenges WHERE id=$1 AND purpose LIKE $2 AND expires_at>now() RETURNING challenge, user_id, purpose", [id, purposePattern]);
  if (!r) throw badRequest("challenge_expired", "That sign-in attempt expired. Try again.");
  return r;
}

/** Registration is held to one session, and it remembers what that session proved to start it. */
const registerPurpose = (sessionId: string | undefined, passwordPresented: boolean | "%") => `register:${sessionId ?? "none"}:${passwordPresented === "%" ? "%" : passwordPresented ? "password" : "recent"}`;

export async function beginPasskeyRegistration(p: Platform, ctx: Ctx, email: string, proof: FactorProof = {}) {
  const { passwordPresented } = await reauthenticate(p, ctx, proof.password ?? "", proof.totp);
  const existing = await p.db.withSystem(t => t.query<any>("SELECT credential_id, transports FROM passkeys WHERE user_id=$1", [ctx.userId]));
  const options = await generateRegistrationOptions({
    rpName: rp(p).rpName, rpID: rp(p).rpID, userName: email, attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports })),
  });
  const challengeId = await p.db.withSystem(t => saveChallenge(t, ctx.userId, registerPurpose(ctx.sessionId, passwordPresented), options.challenge));
  return { options, challengeId };
}

export async function finishPasskeyRegistration(p: Platform, ctx: Ctx, challengeId: string, response: any, name?: string) {
  const c = await p.db.withSystem(t => takeChallenge(t, challengeId, registerPurpose(ctx.sessionId, "%")));
  if (c.user_id !== ctx.userId) throw badRequest("challenge_mismatch", "That request doesn't match this session.");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: rp(p).origin, expectedRPID: rp(p).rpID });
  if (!v.verified || !v.registrationInfo) throw badRequest("passkey_failed", "We couldn't verify that passkey.");
  const { credential } = v.registrationInfo;
  await p.db.withSystem(async t => {
    await t.query("INSERT INTO passkeys(user_id,credential_id,public_key,counter,transports,name,added_with_password) VALUES ($1,$2,$3,$4,$5,$6,$7)", [ctx.userId, credential.id, Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], (name ?? "Passkey").slice(0, 60), c.purpose.endsWith(":password")]);
    await revokeOtherSessions(t, ctx.userId, ctx.sessionId);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "auth.passkey_added" });
  });
  await notifyFactorAdded(p, ctx.userId, "a passkey");
}

export async function beginPasskeySignIn(p: Platform) {
  const options = await generateAuthenticationOptions({ rpID: rp(p).rpID, userVerification: "preferred" });
  const challengeId = await p.db.withSystem(t => saveChallenge(t, null, "signin", options.challenge));
  return { options, challengeId };
}

export async function finishPasskeySignIn(p: Platform, challengeId: string, response: any, ua?: string) {
  // Consumed in its own transaction: a failed verification must not roll this back and leave it reusable.
  const c = await p.db.withSystem(t => takeChallenge(t, challengeId, "signin"));
  return p.db.withSystem(async t => {
    const key = await t.one<any>("SELECT * FROM passkeys WHERE credential_id=$1", [response.id]);
    if (!key) throw new AppError(401, "invalid_credentials", "We couldn't verify that passkey.");
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: c.challenge, expectedOrigin: rp(p).origin, expectedRPID: rp(p).rpID,
      credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: key.transports },
    });
    if (!v.verified) throw new AppError(401, "invalid_credentials", "We couldn't verify that passkey.");
    const who = await t.one<{ email: string }>("SELECT email FROM users WHERE id=$1 AND deleted_at IS NULL", [key.user_id]);
    if (who && await ssoEnforcedFor(t, who.email)) throw ssoRequired();
    await t.query("UPDATE passkeys SET counter=$2, last_used_at=now() WHERE id=$1", [key.id, v.authenticationInfo.newCounter]);
    const m = await t.one<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1 ORDER BY created_at LIMIT 1", [key.user_id]);
    // A verified passkey is two factors in one, unless it's new and nobody typed a password to add it. See PASSKEY_TRUST_HOURS.
    const settled = Date.now() - new Date(key.created_at).getTime() >= PASSKEY_TRUST_HOURS * 3_600_000;
    const s = await createSession(p, t, key.user_id, m?.tenant_id ?? null, { method: settled ? "passkey" : "passkey_recent", mfaPassed: v.authenticationInfo.userVerified && (settled || key.added_with_password === true) }, ua);
    await audit(t, { tenantId: m?.tenant_id ?? null, actor: key.user_id, event: "auth.login", meta: { outcome: "passkey" } });
    return s;
  });
}

export async function removePasskey(p: Platform, ctx: Ctx, id: string, totp?: string) {
  await requireCurrentTotp(p, ctx, totp);
  await p.db.withSystem(async t => {
    const r = await t.query("DELETE FROM passkeys WHERE id=$1 AND user_id=$2 RETURNING id", [id, ctx.userId]);
    if (!r.length) throw new AppError(404, "not_found", "Not found");
    // Sessions don't record which passkey began them, so all of them lose the credit rather than the one that's gone keeping it.
    await t.query("UPDATE sessions SET mfa_passed=false WHERE user_id=$1 AND auth_method LIKE 'passkey%'", [ctx.userId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "auth.passkey_removed" });
  });
}

export async function listPasskeys(p: Platform, userId: string) {
  const rows = await p.db.withSystem(t => t.query<any>("SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id=$1 ORDER BY created_at", [userId]));
  return rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}
