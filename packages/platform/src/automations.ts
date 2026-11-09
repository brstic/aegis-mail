import { z } from "zod";
import type { SecurityResult } from "@aegis/domain";
import { emailDomain } from "@aegis/mail-parser";
import { audit } from "./audit";
import { nextDeliveryAt } from "./notifications";
import { AppError, badRequest, type AccountRow, type Ctx, notFound, type Platform } from "./context";
import { checkAutomationLimit } from "./limits";
import { enqueue } from "./jobs";
import type { MessageEnvelope } from "./ingest";

/**
 * Deterministic rule graph. The evaluator runs on structured facts and never consults a model. There's no send, forward,
 * or delete action in the schema, so no rule, however produced, can do those.
 */
export const Condition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("from_domain"), domains: z.array(z.string().max(253)).min(1).max(100) }),
  z.object({ type: z.literal("from_address"), addresses: z.array(z.string().max(254)).min(1).max(100) }),
  z.object({ type: z.literal("subject_contains"), terms: z.array(z.string().max(100)).min(1).max(20) }),
  z.object({ type: z.literal("body_contains"), terms: z.array(z.string().max(100)).min(1).max(20) }),
  z.object({ type: z.literal("is_bulk"), value: z.boolean() }),
  z.object({ type: z.literal("topic"), topic: z.string().max(40) }),
  z.object({ type: z.literal("risk_at_least"), label: z.enum(["suspicious", "high_risk", "malicious"]) }),
  z.object({ type: z.literal("section"), section: z.string().max(40) }),
]);
export const RuleAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("archive") }),
  z.object({ type: z.literal("mark_read") }),
  z.object({ type: z.literal("star") }),
  z.object({ type: z.literal("label"), name: z.string().max(64) }),
  z.object({ type: z.literal("set_section"), section: z.enum(["needs_attention", "important_people", "read_later", "low_priority"]) }),
  z.object({ type: z.literal("hold") }),
  z.object({ type: z.literal("remind"), hours: z.number().int().min(1).max(24 * 30) }),
  z.object({ type: z.literal("add_to_digest") }),
]);
export const RuleDefinition = z.object({
  trigger: z.literal("message.classified"),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(Condition).min(1).max(20),
  actions: z.array(RuleAction).min(1).max(5),
  accountIds: z.array(z.string().uuid()).optional(),
  /** Whether a match raises a notification. */
  notify: z.enum(["none", "each"]).default("none"),
});
export type RuleDefinition = z.infer<typeof RuleDefinition>;

const RISK_RANK: Record<string, number> = { safe: 0, bulk_low_priority: 0, unknown_unscannable: 1, suspicious: 2, high_risk: 3, malicious: 4 };
const ACTION_RISK: Record<string, number> = { add_to_digest: 0, set_section: 0, label: 0, star: 0, remind: 0, mark_read: 1, hold: 1, archive: 2 };
export function riskClass(def: RuleDefinition): "low" | "medium" {
  const max = Math.max(...def.actions.map(a => ACTION_RISK[a.type] ?? 2));
  return max >= 2 ? "medium" : "low";
}

export interface Facts { fromAddress: string; fromDomain: string; subject: string; text: string; isBulk: boolean; topics: string[]; risk: string; section: string }

function condMatches(c: z.infer<typeof Condition>, f: Facts): boolean {
  switch (c.type) {
    case "from_domain": return c.domains.some(d => f.fromDomain === d.toLowerCase() || f.fromDomain.endsWith(`.${d.toLowerCase()}`));
    case "from_address": return c.addresses.some(a => a.toLowerCase() === f.fromAddress);
    case "subject_contains": return c.terms.some(t => f.subject.toLowerCase().includes(t.toLowerCase()));
    case "body_contains": return c.terms.some(t => f.text.toLowerCase().includes(t.toLowerCase()));
    case "is_bulk": return f.isBulk === c.value;
    case "topic": return f.topics.includes(c.topic);
    case "risk_at_least": return (RISK_RANK[f.risk] ?? 0) >= RISK_RANK[c.label]!;
    case "section": return f.section === c.section;
  }
}
export function evaluateRule(def: Omit<RuleDefinition, "notify">, f: Facts): boolean {
  const res = def.conditions.map(c => condMatches(c, f));
  return def.match === "all" ? res.every(Boolean) : res.some(Boolean);
}

const SECTION_ORDER = ["needs_attention", "important_people", "read_later", "low_priority"];

/**
 * When several rules match one message. Fixed and inspectable: holding beats anything that would hide the message, and
 * among section changes the most prominent wins, since a rule shouldn't be able to bury what another raised.
 */
export function resolveConflicts(actions: z.infer<typeof RuleAction>[]): Set<z.infer<typeof RuleAction>> {
  const dropped = new Set<z.infer<typeof RuleAction>>();
  if (actions.some(a => a.type === "hold")) {
    // A held message stays in security review, where it can be found.
    for (const a of actions) if (a.type === "archive" || a.type === "mark_read" || a.type === "set_section" || a.type === "add_to_digest") dropped.add(a);
    return dropped;
  }
  const sections = actions.filter((a): a is Extract<z.infer<typeof RuleAction>, { type: "set_section" }> => a.type === "set_section");
  const best = [...sections].sort((x, y) => SECTION_ORDER.indexOf(x.section) - SECTION_ORDER.indexOf(y.section))[0];
  for (const a of sections) if (a !== best) dropped.add(a);
  // Raising a message and hiding it disagree, so raising wins.
  if (best && (best.section === "needs_attention" || best.section === "important_people")) for (const a of actions) if (a.type === "add_to_digest" || a.type === "archive" || a.type === "mark_read") dropped.add(a);
  return dropped;
}

/** Natural language to a rule. Returns an inspectable rule the user must approve; it never activates anything. */
export function ruleFromText(text: string): { definition: RuleDefinition; notes: string[] } | { error: string } {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (/\b(auto-?reply|send|forward|delete|wire|pay)\b/.test(lower) && !/\bdon'?t (auto-?reply|send|forward)\b/.test(lower) && !/\bbank details\b/.test(lower)) return { error: "Automations can't send, forward, delete or pay. You can have matching mail held, labelled or surfaced instead." };
  const conditions: z.infer<typeof Condition>[] = [];
  const actions: z.infer<typeof RuleAction>[] = [];
  const notes: string[] = [];
  const domains = [...lower.matchAll(/\b(?:from|sender)\s+([a-z0-9.-]+\.[a-z]{2,})\b/g)].map(m => m[1]!);
  if (domains.length) conditions.push({ type: "from_domain", domains });
  if (/\bnewsletters?\b|\bbulk\b/.test(lower)) conditions.push({ type: "is_bulk", value: true });
  if (/\b(appointment|confirmation)s?\b/.test(lower)) conditions.push({ type: "subject_contains", terms: ["appointment", "confirmation"] });
  if (/\bnotifications?\b/.test(lower)) conditions.push({ type: "topic", topic: "alerts" });
  if (/\binvoices?\b/.test(lower)) conditions.push({ type: "topic", topic: "invoices" });
  if (/\b(bank details|payment details)\b/.test(lower)) conditions.push({ type: "body_contains", terms: ["bank details", "banking details", "payment details"] });
  if (/\bsuspicious\b/.test(lower)) conditions.push({ type: "risk_at_least", label: "suspicious" });
  const quoted = [...t.matchAll(/["“]([^"”]{2,100})["”]/g)].map(m => m[1]!);
  if (quoted.length) conditions.push({ type: "subject_contains", terms: quoted });
  if (/\bdigest\b|\bone daily summary\b|\bdaily summary\b/.test(lower)) actions.push({ type: "add_to_digest" });
  if (/\bhold\b|\bquarantine\b/.test(lower)) actions.push({ type: "hold" });
  if (/\barchive\b|\bmove\b.*\bout of\b/.test(lower)) actions.push({ type: "archive" });
  if (/\bmark\b.*\bimportant\b/.test(lower)) actions.push({ type: "set_section", section: "needs_attention" });
  if (/\b(low priority|demote)\b/.test(lower)) actions.push({ type: "set_section", section: "low_priority" });
  if (/\bmark\b.*\bread\b/.test(lower)) actions.push({ type: "mark_read" });
  if (/\bstar\b/.test(lower)) actions.push({ type: "star" });
  const remind = lower.match(/\bremind me\b.*?(\d+)\s*(business\s+)?(hour|day)/) ?? lower.match(/(\d+)\s*(business\s+)?(hour|day)s?\b.*\bremind me\b/);
  if (remind) { actions.push({ type: "remind", hours: Number(remind[1]) * (remind[3] === "day" ? 24 : 1) }); if (remind[2]) notes.push("Reminders use calendar time; business hours aren't calculated yet."); }
  else if (/\bremind me\b/.test(lower)) actions.push({ type: "remind", hours: 24 });
  const label = lower.match(/\blabel(?: them| it)?(?: as)?\s+["“]?([a-z0-9 _-]{2,40})["”]?/);
  if (label) actions.push({ type: "label", name: label[1]!.trim() });
  if (!conditions.length) return { error: "I couldn't tell which emails this applies to. Try naming a sender domain, a topic, or a word in the subject." };
  if (!actions.length) return { error: "I couldn't tell what should happen. Try archive, label, hold, mark important, or remind me." };
  // What was typed can be understood and still be out of range: a reminder a year out, or dozens of quoted phrases.
  const built = RuleDefinition.safeParse({ trigger: "message.classified", match: "all", conditions, actions });
  if (!built.success) return { error: "That rule is outside what's supported. Reminders can be up to 30 days out, and a rule can match up to 20 words or phrases." };
  return { definition: built.data, notes };
}

export async function listAutomations(p: Platform, ctx: Ctx) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT a.*, (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id=a.id AND NOT r.dry_run) runs FROM automations a WHERE a.user_id=$1 ORDER BY a.created_at DESC", [ctx.userId]));
  return rows.map(r => ({ id: r.id, name: r.name, definition: r.definition, riskClass: r.risk_class, enabled: r.enabled, hourlyBudget: r.hourly_budget, runs: r.runs, createdAt: r.created_at }));
}
export async function createAutomation(p: Platform, ctx: Ctx, input: { name: string; definition: unknown; enabled: boolean }) {
  const parsed = RuleDefinition.safeParse(input.definition);
  if (!parsed.success) throw badRequest("invalid_rule", "That rule isn't valid.");
  await checkAutomationLimit(p, ctx);
  return p.db.withUser(ctx, t => t.one<any>("INSERT INTO automations(tenant_id,user_id,name,definition,risk_class,enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [ctx.tenantId, ctx.userId, input.name, JSON.stringify(parsed.data), riskClass(parsed.data), input.enabled]));
}
export async function setAutomationEnabled(p: Platform, ctx: Ctx, id: string, enabled: boolean) {
  const r = await p.db.withUser(ctx, t => t.query("UPDATE automations SET enabled=$2, updated_at=now() WHERE id=$1 RETURNING id", [id, enabled]));
  if (!r.length) throw notFound();
}
/** A changed rule starts counting its hourly budget from what's already run. Risk class is recomputed, never taken from the caller. */
export async function updateAutomation(p: Platform, ctx: Ctx, id: string, patch: { name?: string; definition?: unknown }) {
  const parsed = patch.definition === undefined ? null : RuleDefinition.safeParse(patch.definition);
  if (parsed && !parsed.success) throw badRequest("invalid_rule", "That rule isn't valid.");
  const r = await p.db.withUser(ctx, t => t.query("UPDATE automations SET name=COALESCE($2,name), definition=COALESCE($3,definition), risk_class=COALESCE($4,risk_class), updated_at=now() WHERE id=$1 RETURNING id", [id, patch.name ?? null, parsed?.success ? JSON.stringify(parsed.data) : null, parsed?.success ? riskClass(parsed.data) : null]));
  if (!r.length) throw notFound();
}
/** What a rule did and when. Content-free: outcome and action names, no subjects or senders. */
export async function automationRuns(p: Platform, ctx: Ctx, id: string) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT outcome, actions, created_at FROM automation_runs WHERE automation_id=$1 AND NOT dry_run ORDER BY created_at DESC LIMIT 25", [id]));
  return rows.map(r => ({ outcome: r.outcome, actions: r.actions, at: r.created_at }));
}
export async function deleteAutomation(p: Platform, ctx: Ctx, id: string) { await p.db.withUser(ctx, t => t.query("DELETE FROM automations WHERE id=$1", [id])); }

/** Dry run over recent mail: what would match, with no side effects. */
export async function dryRun(p: Platform, ctx: Ctx, definition: unknown, limit = 50) {
  const parsed = RuleDefinition.safeParse(definition);
  if (!parsed.success) throw badRequest("invalid_rule", "That rule isn't valid.");
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT m.id, m.envelope_enc, m.risk_label, m.priority_section, c.blob_enc FROM messages m LEFT JOIN message_contents c ON c.message_id=m.id WHERE m.envelope_enc IS NOT NULL AND NOT m.from_me AND m.tombstoned_at IS NULL ORDER BY m.internal_date DESC LIMIT $1", [limit]));
  const matches = [];
  for (const r of rows) {
    const e = await p.envelope.openJson<MessageEnvelope>({ tenantId: ctx.tenantId, keyClass: "body", table: "messages", recordId: r.id }, r.envelope_enc);
    const body = r.blob_enc ? await p.envelope.openJson<{ text: string }>({ tenantId: ctx.tenantId, keyClass: "body", table: "message_contents", recordId: r.id }, r.blob_enc) : { text: "" };
    const facts: Facts = { fromAddress: e.from?.address ?? "", fromDomain: emailDomain(e.from?.address), subject: e.subject, text: body.text, isBulk: e.isBulk, topics: e.topics, risk: r.risk_label ?? "safe", section: r.priority_section ?? "" };
    if (evaluateRule(parsed.data, facts)) matches.push({ messageId: r.id, subject: e.subject, from: e.from?.address });
  }
  return { scanned: rows.length, matches, riskClass: riskClass(parsed.data), actions: parsed.data.actions };
}

export interface EvalInput { envelope: MessageEnvelope; security: SecurityResult; text: string; section: string }

/**
 * Runs once per message, on classification only. Rule actions don't re-trigger classification, so rules can't cycle.
 * Automation level gates what may act; policy is enforced here, not by anything a model produced.
 */
export async function evaluateAutomations(p: Platform, account: AccountRow, messageId: string, input: EvalInput) {
  const tenantId = account.tenant_id;
  const { rules, prefs } = await p.db.withWorker(tenantId, async t => ({
    rules: await t.query<any>("SELECT * FROM automations WHERE enabled AND user_id=$1 ORDER BY created_at", [account.owner_user_id]),
    prefs: (await t.one<any>("SELECT prefs FROM user_preferences WHERE user_id=$1", [account.owner_user_id]))?.prefs ?? {},
  }));
  if (!rules.length) return;
  const level: string = prefs.automationLevel ?? "assist";
  const facts: Facts = { fromAddress: input.envelope.from?.address ?? "", fromDomain: emailDomain(input.envelope.from?.address), subject: input.envelope.subject, text: input.text, isBulk: input.envelope.isBulk, topics: input.envelope.topics, risk: input.security.label, section: input.section };
  const matched = rules.map(rule => ({ rule, def: RuleDefinition.parse(rule.definition) })).filter(({ def }) => (!def.accountIds || def.accountIds.includes(account.id)) && evaluateRule(def, facts));
  const conflicts = resolveConflicts(matched.flatMap(m => m.def.actions));
  for (const { rule, def } of matched) {
    await p.db.withWorker(tenantId, async t => {
      const recent = await t.one<{ c: number }>("SELECT count(*)::int c FROM automation_runs WHERE automation_id=$1 AND created_at > now() - interval '1 hour' AND NOT dry_run", [rule.id]);
      const overBudget = (recent?.c ?? 0) >= rule.hourly_budget;
      const taken: string[] = [];
      // Holding is protective, so it isn't budgeted: otherwise flooding a rule would switch it off before the real attack.
      for (const a of overBudget ? def.actions.filter(x => x.type === "hold") : def.actions) {
        if (conflicts.has(a)) { taken.push(`conflict:${a.type}`); continue; }
        const medium = (ACTION_RISK[a.type] ?? 2) >= 2;
        // Observe: recommend only. Approve: everything queues. Assist: low-risk runs, medium queues. Limited: both run.
        const mustPropose = level === "observe" || level === "approve" || (level === "assist" && medium);
        // A flagged message is never archived or marked read by a rule, whatever the rule says.
        const blocked = input.security.label !== "safe" && input.security.label !== "bulk_low_priority" && (a.type === "archive" || a.type === "mark_read");
        if (blocked) { taken.push(`blocked:${a.type}`); continue; }
        if (mustPropose) {
          await t.query("INSERT INTO proposed_actions(tenant_id,account_id,user_id,message_id,automation_id,action) VALUES ($1,$2,$3,$4,$5,$6)", [tenantId, account.id, account.owner_user_id, messageId, rule.id, JSON.stringify(a)]);
          taken.push(`proposed:${a.type}`);
          continue;
        }
        await applyRuleAction(p, t, account, messageId, a);
        taken.push(a.type);
      }
      await t.query("INSERT INTO automation_runs(tenant_id,account_id,automation_id,message_id,outcome,actions,dry_run) VALUES ($1,$2,$3,$4,$6,$5,false) ON CONFLICT DO NOTHING", [tenantId, account.id, rule.id, messageId, taken, overBudget ? "budget_exceeded" : "executed"]);
      await audit(t, { tenantId, event: "automation.executed", targetType: "message", targetId: messageId, meta: { automation_id: rule.id, count: taken.length } });
      if (def.notify === "each") await t.query("INSERT INTO notifications(tenant_id,user_id,kind,severity,ref_id,dedupe_key,deliver_at) VALUES ($1,$2,'rule_matched','normal',$3,$4,$5) ON CONFLICT (tenant_id,user_id,dedupe_key) DO NOTHING", [tenantId, account.owner_user_id, messageId, `rule:${rule.id}:${messageId}`, nextDeliveryAt(prefs, "normal", p.now())]);
    });
  }
}

async function applyRuleAction(p: Platform, t: any, account: AccountRow, messageId: string, a: z.infer<typeof RuleAction>) {
  const tenantId = account.tenant_id;
  switch (a.type) {
    case "archive":
      await t.query("UPDATE messages SET folder_role='archive' WHERE id=$1", [messageId]);
      await enqueue(t, { tenantId, kind: "provider.change", payload: { accountId: account.id, messageId, change: { moveToRole: "archive" }, rollback: { folder_role: "inbox" } } });
      break;
    case "mark_read":
      await t.query("UPDATE messages SET is_read=true WHERE id=$1", [messageId]);
      await enqueue(t, { tenantId, kind: "provider.change", payload: { accountId: account.id, messageId, change: { isRead: true } } });
      break;
    case "star": await t.query("UPDATE messages SET is_starred=true WHERE id=$1", [messageId]); break;
    case "label": {
      const l = await t.one("INSERT INTO mail_labels(tenant_id,account_id,name) VALUES ($1,$2,$3) ON CONFLICT (account_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id", [tenantId, account.id, a.name]);
      await t.query("INSERT INTO message_labels(message_id,label_id,tenant_id,account_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [messageId, l.id, tenantId, account.id]);
      break;
    }
    case "set_section": await t.query("UPDATE messages SET priority_section=$2 WHERE id=$1 AND risk_label IN ('safe','bulk_low_priority')", [messageId, a.section]); break;
    case "hold": {
      const m = await t.one("SELECT folder_role FROM messages WHERE id=$1", [messageId]);
      await t.query("UPDATE messages SET held=true, priority_section='security_review' WHERE id=$1", [messageId]);
      await t.query("INSERT INTO quarantine_items(message_id,tenant_id,account_id,state,original_folder_role) VALUES ($1,$2,$3,'held',$4) ON CONFLICT DO NOTHING", [messageId, tenantId, account.id, m.folder_role]);
      break;
    }
    case "remind": {
      const m = await t.one("SELECT thread_id FROM messages WHERE id=$1", [messageId]);
      const tid = crypto.randomUUID();
      const enc = await p.envelope.sealJson({ tenantId, keyClass: "body", table: "tasks", recordId: tid }, { text: "Reminder from your automation: check this conversation", kind: "request", owner: "you" });
      await t.query("INSERT INTO tasks(id,tenant_id,account_id,owner_user_id,thread_id,message_id,blob_enc,source,dedupe_key,remind_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'automation',$8, now() + ($9::int * interval '1 hour')) ON CONFLICT DO NOTHING", [tid, tenantId, account.id, account.owner_user_id, m.thread_id, messageId, enc, `auto:${messageId}:remind`, a.hours]);
      break;
    }
    case "add_to_digest": await t.query("UPDATE messages SET priority_section='low_priority' WHERE id=$1 AND risk_label IN ('safe','bulk_low_priority')", [messageId]); break;
  }
}

export async function listProposals(p: Platform, ctx: Ctx) {
  const rows = await p.db.withUser(ctx, t => t.query<any>("SELECT pa.*, m.envelope_enc, a.name rule_name FROM proposed_actions pa JOIN messages m ON m.id=pa.message_id JOIN automations a ON a.id=pa.automation_id WHERE pa.state='pending' AND pa.user_id=$1 ORDER BY pa.created_at DESC LIMIT 100", [ctx.userId]));
  return Promise.all(rows.map(async r => {
    const e = r.envelope_enc ? await p.envelope.openJson<MessageEnvelope>({ tenantId: ctx.tenantId, keyClass: "body", table: "messages", recordId: r.message_id }, r.envelope_enc) : null;
    return { id: r.id, ruleName: r.rule_name, action: JSON.parse(r.action), messageId: r.message_id, subject: e?.subject ?? "", from: e?.from?.address ?? "" };
  }));
}

export async function decideProposal(p: Platform, ctx: Ctx, id: string, approve: boolean) {
  const r = await p.db.withUser(ctx, async t => {
    const pa = await t.one<any>("UPDATE proposed_actions SET state=$2 WHERE id=$1 AND state='pending' AND user_id=$3 RETURNING *", [id, approve ? "approved" : "rejected", ctx.userId]);
    if (!pa) throw notFound();
    return pa;
  });
  if (!approve) return;
  const action = RuleAction.parse(JSON.parse(r.action));
  await p.db.withUser(ctx, async t => {
    const account = await t.one<AccountRow>("SELECT * FROM mail_accounts WHERE id=$1", [r.account_id]);
    if (account) await applyRuleAction(p, t, account, r.message_id, action);
  });
}
