import type { Tx } from "@aegis/db";
import { audit } from "./audit";
import { AppError, badRequest, type Ctx, forbidden, notFound, type Platform } from "./context";
import { requireRole } from "./org";
import { enqueue } from "./jobs";
import { requireOwner } from "./send";
import { msgCtx, recordException, type MessageEnvelope } from "./ingest";

/** The owner vouching for a sender: by releasing its mail, or saying a warning was wrong. The sender comes from the message's own sealed envelope. */
async function ownerException(p: Platform, t: Tx, ctx: Ctx, m: { id: string; account_id: string; sender_hash: string | null; sender_domain_hash: string | null; envelope_enc: Buffer | null }) {
  if (!m.sender_hash || !m.envelope_enc) return;
  const from = (await p.envelope.openJson<MessageEnvelope>(msgCtx(ctx.tenantId, m.id), m.envelope_enc)).from;
  if (from) await recordException(p, t, { tenantId: ctx.tenantId, accountId: m.account_id, messageId: m.id, senderHash: m.sender_hash, domainHash: m.sender_domain_hash, from, scope: "sender", by: "user" });
}

async function bumpReport(t: Tx, day: string, kind: string) {
  await t.query("SELECT app.bump_report($1::date,$2)", [day, kind]);
}

/** Owner-driven and reversible. Malware-class holds need a security admin if tenant policy says so; the row never disappears. */
/** In an organization, blocked mail is the admins' to handle. A member doesn't see it, and can't release it. */
export async function membersSeeBlocked(p: Platform, ctx: Ctx): Promise<boolean> {
  return p.db.withUser(ctx, async t => {
    const r = await t.one<{ kind: string; admin: boolean }>("SELECT o.kind, app.has_role('owner','security_admin') admin FROM organizations o WHERE o.id=$1", [ctx.tenantId]);
    return !r || r.kind !== "organization" || r.admin;
  });
}

export async function decideQuarantine(p: Platform, ctx: Ctx, messageId: string, decision: "release" | "delete") {
  if (!(await membersSeeBlocked(p, ctx))) throw forbidden("Your workspace admin handles blocked mail.");
  // Recorded on its own, because throwing in the decision transaction would roll this back.
  const approvalNeeded = await p.db.withUser(ctx, async t => {
    const m = await t.one<any>("SELECT m.account_id, m.risk_label, q.state FROM messages m JOIN quarantine_items q ON q.message_id=m.id WHERE m.id=$1", [messageId]);
    if (!m) throw notFound();
    await requireOwner(t, m.account_id);
    if (decision !== "release" || m.risk_label !== "malicious" || (m.state !== "held" && m.state !== "pending_approval")) return false;
    const policy = await t.one<any>("SELECT policy FROM tenant_policies WHERE tenant_id=$1", [ctx.tenantId]);
    if (policy?.policy?.releaseRequiresApprovalForMalicious === false) return false;
    const role = await t.one<any>("SELECT app.has_role('owner','security_admin') ok");
    if (role?.ok) return false;
    await t.query("UPDATE quarantine_items SET state='pending_approval' WHERE message_id=$1", [messageId]);
    return true;
  });
  if (approvalNeeded) throw new AppError(403, "approval_required", "This message was rated malicious, so a security admin needs to approve its release. Your request was recorded.");
  const res = await p.db.withUser(ctx, async t => {
    const m = await t.one<any>("SELECT m.id, m.account_id, m.risk_label, m.folder_role, m.held, m.sender_hash, m.sender_domain_hash, m.envelope_enc, q.state, q.original_folder_role, q.provider_moved, a.read_only FROM messages m JOIN quarantine_items q ON q.message_id=m.id JOIN mail_accounts a ON a.id=m.account_id WHERE m.id=$1", [messageId]);
    if (!m) throw notFound();
    if (m.state !== "held" && m.state !== "pending_approval") throw badRequest("already_decided", "This message was already reviewed.");
    await t.query("UPDATE quarantine_items SET state=$2, decided_by=$3, decided_at=now() WHERE message_id=$1", [messageId, decision === "release" ? "released" : "deleted", ctx.userId]);
    if (decision === "release") await t.query("UPDATE messages SET held=false, folder_role=$2, updated_at=now() WHERE id=$1", [messageId, m.original_folder_role]);
    // Releasing mail says the detectors were wrong about this sender, so they don't hold its next message for the same reason.
    // It doesn't cover a malware match or a forged sender: the engine never lets an exception excuse those.
    if (decision === "release") await ownerException(p, t, ctx, m);
    if (decision !== "release") await t.query("UPDATE messages SET held=false, folder_role='trash', updated_at=now() WHERE id=$1", [messageId]);
    await bumpReport(t, p.now().toISOString().slice(0, 10), decision === "release" ? "quarantine_released" : "quarantine_deleted");
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: decision === "release" ? "message.released" : "message.quarantined", targetType: "message", targetId: messageId, meta: { outcome: decision, label: m.risk_label } });
    return m;
  });
  if (!res.read_only) {
    const target = decision === "release" ? res.original_folder_role : "trash";
    await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "provider.change", payload: { accountId: res.account_id, messageId, change: { moveToRole: target }, reason: decision } }));
  }
  return { ok: true, restoredTo: decision === "release" ? res.original_folder_role : "trash", providerUpdatePending: !res.read_only };
}

export async function recordFeedback(p: Platform, ctx: Ctx, messageId: string, kind: "important" | "not_important" | "not_a_threat" | "report_phishing") {
  const day = p.now().toISOString().slice(0, 10);
  const m = await p.db.withUser(ctx, async t => {
    const m = await t.one<any>("SELECT id, account_id, sender_hash, sender_domain_hash, envelope_enc, held, folder_role, risk_label FROM messages WHERE id=$1", [messageId]);
    if (!m) throw notFound();
    await requireOwner(t, m.account_id);
    await t.query("INSERT INTO user_feedback(tenant_id,account_id,message_id,user_id,kind) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [ctx.tenantId, m.account_id, messageId, ctx.userId, kind]);
    // Personal signals only; never shared across users or tenants, so one sender can't poison others.
    if (m.sender_hash) {
      if (kind === "important") await t.query("UPDATE contacts SET is_vip=true, is_ignored=false WHERE account_id=$1 AND sender_hash=$2", [m.account_id, m.sender_hash]);
      if (kind === "not_important") await t.query("UPDATE contacts SET dismissed_count=dismissed_count+1, is_vip=false WHERE account_id=$1 AND sender_hash=$2", [m.account_id, m.sender_hash]);
    }
    if (kind === "important") await t.query("UPDATE messages SET priority_section='needs_attention', priority_score=GREATEST(COALESCE(priority_score,0),0.8) WHERE id=$1 AND risk_label IN ('safe','bulk_low_priority')", [messageId]);
    if (kind === "not_important") await t.query("UPDATE messages SET priority_section='low_priority', priority_score=LEAST(COALESCE(priority_score,0),0.1) WHERE id=$1 AND risk_label IN ('safe','bulk_low_priority')", [messageId]);
    if (kind === "not_a_threat" && !m.held) await t.query("UPDATE messages SET risk_label='safe', policy_action='allow', priority_section='read_later' WHERE id=$1 AND risk_label <> 'malicious'", [messageId]);
    if (kind === "not_a_threat" && !m.held && m.risk_label !== "malicious") await ownerException(p, t, ctx, m);
    if (kind === "report_phishing") await t.query("UPDATE messages SET risk_label=CASE WHEN risk_label='malicious' THEN risk_label ELSE 'high_risk' END, priority_section='security_review', priority_score=0, held=true WHERE id=$1", [messageId]);
    if (kind === "report_phishing") await t.query("INSERT INTO quarantine_items(message_id,tenant_id,account_id,state,original_folder_role) VALUES ($1,$2,$3,'held',$4) ON CONFLICT (message_id) DO UPDATE SET state='held'", [messageId, ctx.tenantId, m.account_id, m.folder_role]);
    // Reporting a sender takes back any exception it had.
    if (kind === "report_phishing" && m.sender_hash) await t.query("UPDATE contacts SET trusted_at=NULL, trusted_scope=NULL, trusted_by=NULL WHERE account_id=$1 AND (sender_hash=$2 OR (trusted_scope='domain' AND domain_hash=$3))", [m.account_id, m.sender_hash, m.sender_domain_hash]);
    if (kind === "report_phishing" || kind === "not_a_threat") await bumpReport(t, day, kind);
    return m;
  });
  if (kind === "report_phishing") await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "provider.change", payload: { accountId: m.account_id, messageId, change: { moveToRole: "spam" }, reason: "report" } }));
  return { ok: true };
}

export async function setContactPreference(p: Platform, ctx: Ctx, messageId: string, pref: "vip" | "ignore" | "clear") {
  await p.db.withUser(ctx, async t => {
    const m = await t.one<any>("SELECT account_id, sender_hash FROM messages WHERE id=$1", [messageId]);
    if (!m) throw notFound();
    await requireOwner(t, m.account_id);
    await t.query("UPDATE contacts SET is_vip=$3, is_ignored=$4 WHERE account_id=$1 AND sender_hash=$2", [m.account_id, m.sender_hash, pref === "vip", pref === "ignore"]);
  });
}


export interface OrgBlockedItem { messageId: string; accountId: string; mailbox: string; ownerName: string | null; received: string; risk: string | null; categories: string[]; state: string; heldSince: string }

/** Every held message in the workspace, for an owner or security admin. Content-blind: which mailbox, when, the rating and why. */
export async function orgQuarantine(p: Platform, ctx: Ctx): Promise<{ items: OrgBlockedItem[] }> {
  await requireRole(p, ctx, "viewSecurity");
  const items = await p.db.withUser(ctx, t => t.query<OrgBlockedItem>(
    `SELECT message_id "messageId", account_id "accountId", mailbox, owner_name "ownerName", received, risk_label risk, categories, state, held_since "heldSince" FROM app.org_quarantine()`));
  return { items };
}

/** An admin's decision on someone else's held message. Recorded in the audit log like the owner's own would be. */
export async function orgQuarantineDecide(p: Platform, ctx: Ctx, messageId: string, decision: "release" | "delete") {
  await requireRole(p, ctx, "managePolicy");
  const res = await p.db.withUser(ctx, async t => {
    let r: { account_id: string; restored_to: string; read_only: boolean; risk_label: string | null } | null;
    try { r = await t.one("SELECT * FROM app.org_quarantine_decide($1,$2)", [messageId, decision]); }
    catch (e: any) {
      if (e?.code === "P0002") throw notFound();
      if (e?.code === "55000") throw badRequest("already_decided", "This message was already reviewed.");
      if (e?.code === "42501") throw forbidden();
      throw e;
    }
    if (!r) throw notFound();
    await bumpReport(t, p.now().toISOString().slice(0, 10), decision === "release" ? "quarantine_released" : "quarantine_deleted");
    await audit(t, { tenantId: ctx.tenantId, actor: ctx.userId, event: decision === "release" ? "message.released" : "message.quarantined", targetType: "message", targetId: messageId, meta: { outcome: decision, label: r.risk_label, by: "admin" } });
    return r;
  });
  if (!res.read_only) await p.db.withSystem(t => enqueue(t, { tenantId: ctx.tenantId, kind: "provider.change", payload: { accountId: res.account_id, messageId, change: { moveToRole: res.restored_to }, reason: decision } }));
  return { ok: true, restoredTo: res.restored_to, providerUpdatePending: !res.read_only };
}
