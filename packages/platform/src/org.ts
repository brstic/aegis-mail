import { createHash, randomBytes } from "node:crypto";
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { DEFAULT_POLICY, PRODUCT_NAME, type TenantPolicy } from "@aegis/domain";
import { randomToken } from "@aegis/cryptography";
import { registrableDomain, FREE_MAIL } from "@aegis/security-engine";
import { audit } from "./audit";
import { AppError, badRequest, conflict, type Ctx, forbidden, notFound, type Platform } from "./context";
import { msgCtx, type MessageEnvelope } from "./ingest";
import { enqueue } from "./jobs";
import { errorCode } from "./log";
import { mailUnavailable, queueMail } from "./mail-queue";
import { rateLimit } from "./auth";
import { inviteMail } from "./identity";
import type { Tx } from "@aegis/db";

type Role = "owner" | "security_admin" | "workspace_manager" | "member";
export const CAN: Record<string, Role[]> = {
  manageMembers: ["owner", "workspace_manager"], changeRoles: ["owner"], managePolicy: ["owner", "security_admin"], viewSecurity: ["owner", "security_admin"],
  viewAudit: ["owner", "security_admin"], manageDomains: ["owner", "security_admin"],
  // Whoever controls the identity provider can sign in as anyone on the domain, including an owner. So: owners only.
  manageSso: ["owner"],
};
export async function roleOf(p: Platform, ctx: Ctx): Promise<Role> {
  const r = await p.db.withUser(ctx, t => t.one<{ role: Role }>("SELECT role FROM memberships WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, ctx.userId]));
  if (!r) throw notFound();
  return r.role;
}
export async function requireRole(p: Platform, ctx: Ctx, cap: keyof typeof CAN) {
  const role = await roleOf(p, ctx);
  if (!CAN[cap]!.includes(role)) throw forbidden();
  return role;
}

export async function listMembers(p: Platform, ctx: Ctx) {
  const role = await roleOf(p, ctx);
  const full = [...CAN.manageMembers!, ...CAN.viewSecurity!].includes(role);
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT u.id, u.name, u.email, m.role, m.created_at \"joinedAt\", u.totp_enabled \"mfaEnabled\" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 ORDER BY m.created_at", [ctx.tenantId]));
  // Colleagues' names and roles are enough to choose who to share with. Addresses and MFA status are for managers.
  return full ? rows : rows.map(r => ({ id: r.id, name: r.name, role: r.role }));
}

export async function invite(p: Platform, ctx: Ctx, input: { email: string; role: Role }) {
  const inviter = await requireRole(p, ctx, "manageMembers");
  // Only an owner can hand out a role with power over security.
  if (inviter !== "owner" && !["member", "workspace_manager"].includes(input.role)) throw forbidden("Only an owner can invite someone with that role.");
  // Honest failure: nothing is created that can't be delivered. Demo mode records instead, and still shows the link.
  if (!p.mailer) throw mailUnavailable();
  const to = input.email.trim().toLowerCase();
  if (!p.config.demoMode) {
    const self = await p.db.withSystem(t => t.one<{ email_verified_at: Date | null }>("SELECT email_verified_at FROM users WHERE id=$1", [ctx.userId]));
    // Otherwise a throwaway signup could use us to send mail to strangers.
    if (!self?.email_verified_at) throw new AppError(403, "email_unverified", "Verify your own email address before inviting people.");
    await rateLimit(p, `invite-tenant:${ctx.tenantId}`, 100, 3600);
    await rateLimit(p, `invite-to:${ctx.tenantId}:${createHash("sha256").update(to).digest("hex")}`, 5, 86_400);
  }
  const token = randomToken(24);
  const hash = createHash("sha256").update(token).digest("hex");
  const org = await p.db.withUser(ctx, async t => {
    await t.query("INSERT INTO invitations(tenant_id,email,role,token_hash,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days')", [ctx.tenantId, to, input.role, hash, ctx.userId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "member.invited", targetType: "invitation", meta: { role: input.role } });
    return t.one<{ name: string }>("SELECT name FROM organizations WHERE id=$1", [ctx.tenantId]);
  });
  const acceptUrl = `${p.config.appOrigin}/invite/${token}`;
  await queueMail(p, "invite", inviteMail(p, to, acceptUrl, org?.name ?? ""));
  // The link is a credential for the invited person. Only demo mode, which delivers nothing, shows it to the inviter.
  return { sent: true, ...(p.config.demoMode ? { acceptUrl } : {}) };
}
export async function listInvites(p: Platform, ctx: Ctx) {
  await requireRole(p, ctx, "manageMembers");
  return p.db.withUser(ctx, t => t.query<any>("SELECT id, email, role, expires_at \"expiresAt\", accepted_at \"acceptedAt\" FROM invitations WHERE accepted_at IS NULL AND expires_at>now() ORDER BY created_at DESC"));
}

export async function withdrawInvite(p: Platform, ctx: Ctx, id: string) {
  await requireRole(p, ctx, "manageMembers");
  const r = await p.db.withUser(ctx, t => t.query("DELETE FROM invitations WHERE id=$1 AND accepted_at IS NULL RETURNING id", [id]));
  if (!r.length) throw notFound();
}

/** Signed-in user accepts. Email must match, so a leaked link can't add someone else to the tenant. */
export async function acceptInvite(p: Platform, userId: string, email: string, token: string) {
  const hash = createHash("sha256").update(token).digest("hex");
  return p.db.withSystem(async t => {
    const inv = await t.one<any>("SELECT * FROM invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now()", [hash]);
    if (!inv) throw notFound();
    if (inv.email !== email.toLowerCase()) throw forbidden("This invitation was sent to a different email address.");
    // The database's address, not the caller's, and it has to be proven: a signup alone doesn't show someone owns it.
    const u = await t.one<{ email: string; email_verified_at: Date | null }>("SELECT lower(email) email, email_verified_at FROM users WHERE id=$1 AND deleted_at IS NULL", [userId]);
    if (!u || u.email !== inv.email) throw forbidden("This invitation was sent to a different email address.");
    if (!u.email_verified_at) throw new AppError(403, "email_unverified", "Verify your email address before accepting this invitation.");
    await t.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [inv.tenant_id, userId, inv.role]);
    await t.query("UPDATE invitations SET accepted_at=now() WHERE id=$1", [inv.id]);
    await audit(t, { tenantId: inv.tenant_id, actor: userId, event: "member.joined", meta: { role: inv.role, outcome: "invitation" } });
    return { tenantId: inv.tenant_id as string };
  });
}

export async function changeRole(p: Platform, ctx: Ctx, userId: string, role: Role) {
  await requireRole(p, ctx, "changeRoles");
  await p.db.withUser(ctx, async t => {
    const owners = await t.one<{ c: number }>("SELECT count(*)::int c FROM memberships WHERE role='owner'");
    const target = await t.one<{ role: Role }>("SELECT role FROM memberships WHERE user_id=$1", [userId]);
    if (!target) throw notFound();
    if (target.role === "owner" && role !== "owner" && (owners?.c ?? 0) <= 1) throw conflict("last_owner", "A workspace needs at least one owner.");
    await t.query("UPDATE memberships SET role=$2 WHERE user_id=$1", [userId, role]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "member.role_changed", targetType: "user", targetId: userId, meta: { role } });
  });
}
export async function removeMember(p: Platform, ctx: Ctx, userId: string) {
  await requireRole(p, ctx, "changeRoles");
  if (userId === ctx.userId) throw badRequest("self_remove", "You can't remove yourself.");
  await p.db.withUser(ctx, t => removeMemberTx(t, ctx.tenantId, ctx.userId, userId));
}

/** The removal itself, shared with SCIM deprovisioning. The tenant filters matter there: that path has no RLS context. */
export async function removeMemberTx(t: Tx, tenantId: string, actor: string | null, userId: string) {
  await t.query("DELETE FROM memberships WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  await t.query("DELETE FROM invitations WHERE tenant_id=$1 AND invited_by=$2 AND accepted_at IS NULL", [tenantId, userId]);
  await audit(t, { tenantId, actor, event: "member.role_changed", targetType: "user", targetId: userId, meta: { outcome: "removed" } });
  // In the worker: their mailboxes in this workspace disconnect and their cached mail goes, and any grants and pending sends end.
  await enqueue(t, { tenantId, kind: "member.removed", payload: { userId } });
}

export async function getPolicy(p: Platform, ctx: Ctx) {
  const r = await p.db.withUser(ctx, t => t.one<any>("SELECT policy, retention_days, updated_at FROM tenant_policies WHERE tenant_id=$1", [ctx.tenantId]));
  return { policy: { ...DEFAULT_POLICY, ...(r?.policy ?? {}) } as TenantPolicy & { hostedModelsDisabled?: boolean }, retentionDays: r?.retention_days ?? null, updatedAt: r?.updated_at ?? null };
}

/** Guardrails: a policy can't allowlist a domain so broad it switches off protection. */
export async function updatePolicy(p: Platform, ctx: Ctx, patch: Partial<TenantPolicy> & { retentionDays?: number | null; hostedModelsDisabled?: boolean }) {
  await requireRole(p, ctx, "managePolicy");
  const { retentionDays, ...rest } = patch;
  const bad = (rest.allowDomains ?? []).filter(d => FREE_MAIL.has(registrableDomain(d)));
  if (bad.length) throw badRequest("allowlist_too_broad", `Can't allowlist ${bad.join(", ")}: anyone can get an address there.`);
  if (retentionDays !== undefined && retentionDays !== null && retentionDays < 1) throw badRequest("retention_invalid", "Retention must be at least a day.");
  const current = await getPolicy(p, ctx);
  await p.db.withUser(ctx, async t => {
    await t.query(`INSERT INTO tenant_policies(tenant_id,policy,retention_days,updated_by,updated_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (tenant_id) DO UPDATE SET policy=$2, retention_days=$3, updated_by=$4, updated_at=now()`,
      [ctx.tenantId, JSON.stringify({ ...current.policy, ...rest }), retentionDays === undefined ? current.retentionDays : retentionDays, ctx.userId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "policy.changed", meta: { fields: Object.keys(patch) } });
  });
}

/**
 * Security Center. Aggregates only. The admin role has no row access to mail, so even a bug here can't join to content.
 */
export async function securityOverview(p: Platform, ctx: Ctx, days = 30) {
  await requireRole(p, ctx, "viewSecurity");
  return p.db.withUser(ctx, async t => {
    const byLabel = await t.query<any>("SELECT label, sum(count)::int count FROM security_telemetry_daily WHERE day > now() - ($1::int * interval '1 day') GROUP BY label", [days]);
    const byCategory = await t.query<any>("SELECT category, sum(count)::int count FROM security_telemetry_daily WHERE day > now() - ($1::int * interval '1 day') AND category <> '-' AND label IN ('suspicious','high_risk','malicious') GROUP BY category ORDER BY count DESC", [days]);
    const trend = await t.query<any>("SELECT day::text, sum(count) FILTER (WHERE label IN ('suspicious','high_risk','malicious'))::int flagged, sum(count)::int total FROM security_telemetry_daily WHERE day > now() - ($1::int * interval '1 day') GROUP BY day ORDER BY day", [days]);
    const reports = await t.query<any>("SELECT kind, sum(count)::int count FROM security_reports_daily WHERE day > now() - ($1::int * interval '1 day') GROUP BY kind", [days]);
    const actions = await t.query<any>("SELECT action, sum(count)::int count FROM security_telemetry_daily WHERE day > now() - ($1::int * interval '1 day') GROUP BY action", [days]);
    const members = await t.one<{ c: number }>("SELECT count(*)::int c FROM memberships");
    const coverage = await t.query<{ status: string; count: number }>("SELECT * FROM app.mailbox_coverage()");
    const campaigns = await t.one<{ count: number; messages: number }>("SELECT count(*)::int count, COALESCE(sum(message_count),0)::int messages FROM security_campaigns WHERE message_count >= 3 AND last_seen > now() - ($1::int * interval '1 day')", [days]);
    return { days, byLabel, byCategory, trend, reports, actions, members: members?.c ?? 0, coverage, campaigns };
  });
}

export async function auditLog(p: Platform, ctx: Ctx, limit = 100, before?: number) {
  const role = await roleOf(p, ctx);
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT a.id, a.event, a.target_type \"targetType\", a.meta, a.created_at \"at\", u.name actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT $1", [limit, before ?? null]));
  return { rows, scope: CAN.viewAudit!.includes(role) ? "workspace" : "own" };
}

// ---------- Delegation: explicit, owner-granted, revocable ----------
export async function grantMailbox(p: Platform, ctx: Ctx, accountId: string, granteeUserId: string, opts: { canSend?: boolean } = {}) {
  await p.db.withUser(ctx, async t => {
    const a = await t.one<any>("SELECT owner_user_id FROM mail_accounts WHERE id=$1", [accountId]);
    if (!a) throw notFound();
    if (a.owner_user_id !== ctx.userId) throw forbidden("Only the mailbox owner can share it.");
    const member = await t.one("SELECT 1 FROM memberships WHERE user_id=$1", [granteeUserId]);
    if (!member) throw notFound();
    await t.query("INSERT INTO mailbox_grants(account_id,tenant_id,grantee_user_id,granted_by,can_send) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id,grantee_user_id) DO UPDATE SET can_send=EXCLUDED.can_send", [accountId, ctx.tenantId, granteeUserId, ctx.userId, opts.canSend === true]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "member.role_changed", targetType: "mailbox_grant", targetId: accountId, meta: { outcome: "granted" } });
  });
}
export async function revokeMailboxGrant(p: Platform, ctx: Ctx, accountId: string, granteeUserId: string) {
  await p.db.withUser(ctx, async t => {
    await t.query("DELETE FROM mailbox_grants WHERE account_id=$1 AND grantee_user_id=$2", [accountId, granteeUserId]);
    // Sends they approved but that haven't gone yet end with their access.
    await t.query("UPDATE send_approvals SET state='failed', error_code='access_revoked' WHERE account_id=$1 AND approved_by=$2 AND state='authorized'", [accountId, granteeUserId]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "member.role_changed", targetType: "mailbox_grant", targetId: accountId, meta: { outcome: "revoked" } });
  });
}
export async function listGrants(p: Platform, ctx: Ctx) {
  return p.db.withUser(ctx, t => t.query<any>("SELECT g.can_send \"canSend\", g.account_id \"accountId\", a.email account, g.grantee_user_id \"granteeUserId\", u.name grantee, g.granted_by=$1 mine, g.created_at \"at\" FROM mailbox_grants g JOIN users u ON u.id=g.grantee_user_id LEFT JOIN mail_accounts a ON a.id=g.account_id", [ctx.userId]));
}

// ---------- Incident sharing: the only way an analyst sees message content, and only because the user chose to ----------
/** Worker side of member removal. */
export async function finishMemberRemoval(p: Platform, tenantId: string, userId: string) {
  await p.db.withWorker(tenantId, async t => {
    const accounts = await t.query<{ id: string }>("SELECT id FROM mail_accounts WHERE owner_user_id=$1", [userId]);
    await t.query("DELETE FROM mailbox_grants WHERE grantee_user_id=$1", [userId]);
    await t.query("DELETE FROM automations WHERE user_id=$1", [userId]);
    await t.query("DELETE FROM incident_shares WHERE analyst_user_id=$1", [userId]);
    await t.query("DELETE FROM notifications WHERE user_id=$1", [userId]);
    await t.query("UPDATE send_approvals SET state='failed', error_code='approver_removed' WHERE approved_by=$1 AND state='authorized'", [userId]);
    for (const a of accounts) {
      await t.query("UPDATE mail_accounts SET status='disconnected' WHERE id=$1", [a.id]);
      await enqueue(t, { tenantId, kind: "account.disconnect", payload: { accountId: a.id, reason: "delete" }, maxAttempts: 3 });
    }
  });
}

export async function shareIncident(p: Platform, ctx: Ctx, input: { messageId: string; analystUserId: string; redact: boolean; hours: number; note?: string }) {
  const id = crypto.randomUUID();
  const m = await p.db.withUser(ctx, async t => {
    const r = await t.one<any>("SELECT m.id, m.account_id, m.envelope_enc, m.risk_label, c.blob_enc, s.reason_codes FROM messages m LEFT JOIN message_contents c ON c.message_id=m.id LEFT JOIN security_analyses s ON s.message_id=m.id WHERE m.id=$1", [input.messageId]);
    if (!r) throw notFound();
    const owner = await t.one<any>("SELECT owner_user_id FROM mail_accounts WHERE id=$1", [r.account_id]);
    if (owner?.owner_user_id !== ctx.userId) throw forbidden("Only the mailbox owner can share a message.");
    const analyst = await t.one<{ role: Role }>("SELECT role FROM memberships WHERE user_id=$1", [input.analystUserId]);
    if (!analyst || !CAN.viewSecurity!.includes(analyst.role)) throw badRequest("not_analyst", "Choose someone with a security role in this workspace.");
    return r;
  });
  const e = m.envelope_enc ? await p.envelope.openJson<MessageEnvelope>(msgCtx(ctx.tenantId, m.id), m.envelope_enc) : null;
  const c = m.blob_enc ? await p.envelope.openJson<{ text: string }>(msgCtx(ctx.tenantId, m.id, "message_contents"), m.blob_enc) : { text: "" };
  const snapshot = input.redact
    ? { riskLabel: m.risk_label, reasonCodes: m.reason_codes ?? [], senderDomain: e?.from?.address?.split("@")[1] ?? null, redacted: true }
    : { riskLabel: m.risk_label, reasonCodes: m.reason_codes ?? [], subject: e?.subject, from: e?.from, text: c.text.slice(0, 50_000), redacted: false };
  const enc = await p.envelope.sealJson(msgCtx(ctx.tenantId, id, "incident_shares"), snapshot);
  await p.db.withUser(ctx, async t => {
    await t.query("INSERT INTO incident_shares(id,tenant_id,account_id,message_id,shared_by,analyst_user_id,redacted,snapshot_enc,note,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10::int * interval '1 hour'))",
      [id, ctx.tenantId, m.account_id, m.id, ctx.userId, input.analystUserId, input.redact, enc, input.note?.slice(0, 500) ?? null, input.hours]);
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "incident.shared", targetType: "incident", targetId: id, meta: { hours: input.hours, redacted: input.redact } });
  });
  return { id };
}
export async function revokeIncident(p: Platform, ctx: Ctx, id: string) {
  const r = await p.db.withUser(ctx, t => t.query("UPDATE incident_shares SET revoked_at=now() WHERE id=$1 AND shared_by=$2 RETURNING id", [id, ctx.userId]));
  if (!r.length) throw notFound();
  await p.db.withUser(ctx, t => audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: "incident.revoked", targetType: "incident", targetId: id }));
}
export async function listIncidents(p: Platform, ctx: Ctx) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT i.*, u.name shared_by_name, a.name analyst_name FROM incident_shares i JOIN users u ON u.id=i.shared_by JOIN users a ON a.id=i.analyst_user_id ORDER BY i.created_at DESC LIMIT 50"));
  return Promise.all(rows.map(async r => ({ id: r.id, sharedBy: r.shared_by_name, analyst: r.analyst_name, mine: r.shared_by === ctx.userId, redacted: r.redacted, note: r.note, expiresAt: r.expires_at, revokedAt: r.revoked_at, snapshot: await p.envelope.openJson<any>(msgCtx(ctx.tenantId, r.id, "incident_shares"), r.snapshot_enc) })));
}

// ---------- Domains ----------
export async function addDomain(p: Platform, ctx: Ctx, domain: string) {
  await requireRole(p, ctx, "manageDomains");
  const d = domain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) || FREE_MAIL.has(registrableDomain(d))) throw badRequest("domain_invalid", "Enter a domain you control.");
  const token = `aegis-verify=${randomBytes(16).toString("hex")}`;
  await p.db.withUser(ctx, t => t.query("INSERT INTO verified_domains(tenant_id,domain,verification_token) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,domain) DO NOTHING", [ctx.tenantId, d, token]));
  return p.db.withUser(ctx, t => t.one<any>("SELECT domain, verification_token \"token\", verified_at \"verifiedAt\" FROM verified_domains WHERE domain=$1", [d]));
}
export async function listDomains(p: Platform, ctx: Ctx) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT domain, verification_token \"token\", verified_at \"verifiedAt\", txt_missing_since \"txtMissingSince\", lapsed_at \"lapsedAt\" FROM verified_domains ORDER BY domain"));
  return rows.map(r => ({ ...r, lapsesAt: r.verifiedAt && r.txtMissingSince ? new Date(new Date(r.txtMissingSince).getTime() + DOMAIN_GRACE_DAYS * 86_400_000) : null }));
}
export async function verifyDomain(p: Platform, ctx: Ctx, domain: string, resolveTxt: (d: string) => Promise<string[][]>) {
  await requireRole(p, ctx, "manageDomains");
  const row = await p.db.withUser(ctx, t => t.one<any>("SELECT verification_token FROM verified_domains WHERE domain=$1", [domain]));
  if (!row) throw notFound();
  const recs = await resolveTxt(domain).catch(() => [] as string[][]);
  if (!recs.flat().includes(row.verification_token)) throw new AppError(409, "domain_unverified", "We couldn't find that TXT record yet. DNS changes can take a while to appear.");
  await p.db.withUser(ctx, t => t.query("UPDATE verified_domains SET verified_at=now(), last_checked_at=now(), txt_missing_since=NULL, lapsed_at=NULL WHERE domain=$1", [domain]));
}

export const DOMAIN_GRACE_DAYS = 7;
export type TxtResolver = (domain: string) => Promise<string[][]>;

/** Only an answer that says the record isn't there counts. A resolver that timed out knows nothing about who owns the domain. */
async function txtPresent(resolve: TxtResolver, domain: string, token: string): Promise<boolean | null> {
  try { return (await resolve(domain)).flat().includes(token); }
  catch (e) {
    const code = (e as { code?: string })?.code;
    return code === "ENODATA" || code === "ENOTFOUND" ? false : null;
  }
}

function domainWarningMail(to: string, domain: string, token: string, by: Date) {
  return { to, subject: `Your ${PRODUCT_NAME} domain verification record is missing`, text: `We can no longer find the TXT record that shows your organization controls ${domain}.\n\nIf it comes back by ${by.toUTCString()}, nothing changes. After that the domain stops counting as verified: single sign-on and provisioning for it stop.\n\nIf you still own this domain, add this TXT record again:\n\n${token}\n\nIf you no longer own it, there's nothing to do.\n` };
}
function domainLapsedMail(to: string, domain: string) {
  return { to, subject: `${domain} is no longer verified on ${PRODUCT_NAME}`, text: `The TXT record for ${domain} has been missing for ${DOMAIN_GRACE_DAYS} days, so it no longer counts as verified. Single sign-on and provisioning for it have stopped. People on that domain who have a password can still use it, and anyone else can set one through the sign-in page's reset link.\n\nIf you still own this domain, add the TXT record again and check it on the Domains page. Everything resumes, unless another organization has proven the domain and set up single sign-on for it in the meantime.\n` };
}

/**
 * Worker job. Verification used to be forever, so after a domain changed hands the old tenant's identity provider could still link to
 * accounts on it, and the new owner was told the domain was taken. A missing record starts a grace period, since DNS gets broken by
 * accident. After that verified_at is cleared, and every check that trusts the domain stops by itself. `resolve` is a seam for tests:
 * demo deployments have made-up domains and no resolver, so they skip this.
 */
export async function recheckDomains(p: Platform, tenantId: string, resolve: TxtResolver | undefined = p.resolveTxt ?? (p.config.demoMode ? undefined : dnsResolveTxt)) {
  if (!resolve) return;
  const rows = await p.db.withWorker(tenantId, t => t.query<{ id: string; domain: string; verification_token: string; txt_missing_since: Date | null }>("SELECT id, domain, verification_token, txt_missing_since FROM verified_domains WHERE tenant_id=$1 AND verified_at IS NOT NULL", [tenantId]));
  const now = p.now();
  for (const d of rows) {
    const present = await txtPresent(resolve, d.domain, d.verification_token);
    if (present === null) { p.log.info("domain.recheck_unknown", { tenantId }); continue; }
    if (present) {
      await p.db.withWorker(tenantId, async t => {
        await t.query("UPDATE verified_domains SET last_checked_at=$2, txt_missing_since=NULL WHERE id=$1", [d.id, now]);
        if (d.txt_missing_since) await audit(t, { tenantId, event: "domain.record_restored", targetType: "domain", targetId: d.id });
      });
      continue;
    }
    const since = d.txt_missing_since ? new Date(d.txt_missing_since) : null;
    if (since && now.getTime() - since.getTime() < DOMAIN_GRACE_DAYS * 86_400_000) {
      await p.db.withWorker(tenantId, t => t.query("UPDATE verified_domains SET last_checked_at=$2 WHERE id=$1", [d.id, now]));
      continue;
    }
    await p.db.withWorker(tenantId, async t => {
      if (since) await t.query("UPDATE verified_domains SET last_checked_at=$2, verified_at=NULL, lapsed_at=$2 WHERE id=$1", [d.id, now]);
      else await t.query("UPDATE verified_domains SET last_checked_at=$2, txt_missing_since=$2 WHERE id=$1", [d.id, now]);
      await audit(t, { tenantId, event: since ? "domain.lapsed" : "domain.record_missing", targetType: "domain", targetId: d.id });
    });
    await tellDomainOwners(p, tenantId, to => since ? domainLapsedMail(to, d.domain) : domainWarningMail(to, d.domain, d.verification_token, new Date(now.getTime() + DOMAIN_GRACE_DAYS * 86_400_000)));
  }
}

/** After the state has changed, and never the reason it doesn't: the state is what protects people, and the Domains page shows it too. */
async function tellDomainOwners(p: Platform, tenantId: string, render: (to: string) => { to: string; subject: string; text: string }) {
  if (!p.mailer) return;
  try {
    const owners = await p.db.withWorker(tenantId, t => t.query<{ email: string }>("SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role='owner' AND u.email_verified_at IS NOT NULL", [tenantId]));
    for (const o of owners) await queueMail(p, "security_notice", render(o.email));
  } catch (e) { p.log.warn("domain.notice_failed", { errorCode: errorCode(e) }); }
}

// Reference only, to document that an admin path to content doesn't exist.
export const ADMIN_CONTENT_ENDPOINTS: string[] = [];
