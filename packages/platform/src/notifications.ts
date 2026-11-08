import { PRODUCT_NAME } from "@aegis/domain";
import { type Ctx, notFound, type Platform } from "./context";
import { queueMail } from "./mail-queue";
import type { Prefs } from "./prefs";

export type NotificationKind = "held_message" | "account_reconnect" | "send_failed" | "reminder_due" | "followup_due" | "rule_matched" | "send_partial";
export type Severity = "normal" | "critical";
type DeliveryPrefs = Pick<Prefs, "workingHours" | "quietHours" | "timeZone" | "criticalBypassQuiet">;

// ---------- When something may be shown ----------
const clocks = new Map<string, Intl.DateTimeFormat>();
function clockFor(tz: string) {
  let c = clocks.get(tz);
  if (!c) {
    // An unknown zone must not lose notifications, so it reads as UTC.
    try { c = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch { return clockFor("UTC"); }
    clocks.set(tz, c);
  }
  return c;
}
export function localClock(now: Date, tz: string) {
  const parts: Record<string, string> = {};
  for (const x of clockFor(tz).formatToParts(now)) parts[x.type] = x.value;
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), date: `${parts.year}-${parts.month}-${parts.day}` };
}
export const timeZoneOf = (prefs: DeliveryPrefs) => prefs.timeZone ?? prefs.workingHours?.tz ?? "UTC";

/** Half-open, and may wrap past midnight. Equal ends mean an empty window, not all day. */
export function inHourWindow(hour: number, start: number, end: number) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function deliverableNow(prefs: DeliveryPrefs, severity: Severity, now: Date) {
  const { hour } = localClock(now, timeZoneOf(prefs));
  const quiet = !!prefs.quietHours && inHourWindow(hour, prefs.quietHours.start, prefs.quietHours.end);
  if (severity === "critical") return !quiet || prefs.criticalBypassQuiet === true;
  if (quiet) return false;
  const wh = prefs.workingHours;
  return !wh || wh.start >= wh.end || inHourWindow(hour, wh.start, wh.end);
}

/** Longest anything waits. Settings can leave no hour open at all, and a notification still has to arrive eventually. */
export const MAX_DEFER_HOURS = 48;

/**
 * The first moment it may be shown. Walks local hour boundaries, not UTC ones, so half-hour zones and daylight saving
 * changes land on the real boundary.
 */
export function nextDeliveryAt(prefs: DeliveryPrefs, severity: Severity, now: Date): Date {
  if (deliverableNow(prefs, severity, now)) return now;
  const tz = timeZoneOf(prefs);
  let t = now.getTime();
  const limit = t + MAX_DEFER_HOURS * 3600_000;
  while (t < limit) {
    const c = localClock(new Date(t), tz);
    t += (60 - c.minute) * 60_000 - c.second * 1000 - (t % 1000);
    if (t >= limit) break;
    if (deliverableNow(prefs, severity, new Date(t))) return new Date(t);
  }
  return new Date(limit);
}

// ---------- Creating them, in the worker ----------
/**
 * Runs per tenant on a schedule, in the worker's tenant context. Rows hold a kind and an ID: no subject, sender or body is
 * read here, and each one goes only to the mailbox's owner, never to a grantee or an admin.
 */
export async function scanNotifications(p: Platform, tenantId: string) {
  const now = p.now();
  const stale = new Date(now.getTime() - 7 * 86_400_000);
  await p.db.withWorker(tenantId, async t => {
    const prefsCache = new Map<string, Prefs>();
    const prefsOf = async (userId: string) => {
      let v = prefsCache.get(userId);
      if (!v) { v = (await t.one<{ prefs: Prefs }>("SELECT prefs FROM user_preferences WHERE user_id=$1", [userId]))?.prefs ?? {}; prefsCache.set(userId, v); }
      return v;
    };
    const add = async (userId: string, kind: NotificationKind, severity: Severity, refId: string, dedupeKey: string) => {
      const deliverAt = nextDeliveryAt(await prefsOf(userId), severity, now);
      await t.query("INSERT INTO notifications(tenant_id,user_id,kind,severity,ref_id,dedupe_key,deliver_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,user_id,dedupe_key) DO NOTHING", [tenantId, userId, kind, severity, refId, dedupeKey, deliverAt, now]);
    };

    const held = await t.query<{ message_id: string; owner_user_id: string; risk_label: string | null }>(
      `SELECT q.message_id, a.owner_user_id, m.risk_label FROM quarantine_items q JOIN messages m ON m.id=q.message_id JOIN mail_accounts a ON a.id=q.account_id
       WHERE q.state='held' AND a.status<>'disconnected' AND q.created_at > $1 ORDER BY q.created_at DESC LIMIT 200`, [stale]);
    // Blocking is quiet: a personal mailbox isn't told, and in an organization only the admins who handle blocked mail are.
    const org = await t.one<{ kind: string }>("SELECT kind FROM organizations WHERE id=$1", [tenantId]);
    if (org?.kind === "organization" && held.length) {
      const admins = await t.query<{ user_id: string }>("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role IN ('owner','security_admin')", [tenantId]);
      for (const h of held) for (const a of admins) await add(a.user_id, "held_message", h.risk_label === "malicious" ? "critical" : "normal", h.message_id, `held:${h.message_id}`);
    }

    const broken = await t.query<{ id: string; owner_user_id: string }>("SELECT id, owner_user_id FROM mail_accounts WHERE status='reconnect_required'");
    for (const a of broken) await add(a.owner_user_id, "account_reconnect", "normal", a.id, `reconnect:${a.id}`);

    const failed = await t.query<{ id: string; approved_by: string; draft_id: string }>("SELECT id, approved_by, draft_id FROM send_approvals WHERE state IN ('failed','unknown') AND created_at > $1 ORDER BY created_at DESC LIMIT 100", [stale]);
    for (const s of failed) await add(s.approved_by, "send_failed", "normal", s.draft_id, `send:${s.id}`);

    const due = await t.query<{ id: string; owner_user_id: string; remind_at: Date }>("SELECT id, owner_user_id, remind_at FROM tasks WHERE status='open' AND remind_at IS NOT NULL AND remind_at <= $1 AND remind_at > $2 ORDER BY remind_at LIMIT 100", [now, stale]);
    for (const r of due) await add(r.owner_user_id, "reminder_due", "normal", r.id, `remind:${r.id}:${new Date(r.remind_at).getTime()}`);

    // Three days matches the follow-up suggestion in Focus. Anything older than two weeks has been dealt with, or won't be.
    const waiting = await t.query<{ id: string; owner_user_id: string; last_message_at: Date }>(
      `SELECT th.id, a.owner_user_id, th.last_message_at FROM threads th JOIN mail_accounts a ON a.id=th.account_id
       WHERE th.last_from_me AND a.status='active' AND th.last_message_at < $1 AND th.last_message_at > $2 ORDER BY th.last_message_at DESC LIMIT 50`,
      [new Date(now.getTime() - 3 * 86_400_000), new Date(now.getTime() - 14 * 86_400_000)]);
    for (const w of waiting) await add(w.owner_user_id, "followup_due", "normal", w.id, `followup:${w.id}:${new Date(w.last_message_at).getTime()}`);

    // Whatever has resolved itself shouldn't still be asking for attention.
    await t.query("DELETE FROM notifications n WHERE n.kind='held_message' AND n.read_at IS NULL AND NOT EXISTS (SELECT 1 FROM quarantine_items q WHERE q.message_id=n.ref_id AND q.state='held')");
    await t.query("DELETE FROM notifications n WHERE n.kind='account_reconnect' AND NOT EXISTS (SELECT 1 FROM mail_accounts a WHERE a.id=n.ref_id AND a.status='reconnect_required')");
    await t.query("DELETE FROM notifications n WHERE n.kind='reminder_due' AND n.read_at IS NULL AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.id=n.ref_id AND k.status='open')");
    await t.query("DELETE FROM notifications n WHERE n.kind='followup_due' AND n.read_at IS NULL AND NOT EXISTS (SELECT 1 FROM threads th WHERE th.id=n.ref_id AND th.last_from_me)");
    await t.query("DELETE FROM notifications WHERE created_at < $1", [new Date(now.getTime() - 90 * 86_400_000)]);

    // Settings can change while something waits, so waiting rows follow the current settings.
    const waitingRows = await t.query<{ id: string; user_id: string; severity: Severity; deliver_at: Date }>("SELECT id, user_id, severity, deliver_at FROM notifications WHERE read_at IS NULL AND deliver_at > $1 LIMIT 500", [now]);
    for (const w of waitingRows) {
      const next = nextDeliveryAt(await prefsOf(w.user_id), w.severity, now);
      if (next.getTime() !== new Date(w.deliver_at).getTime()) await t.query("UPDATE notifications SET deliver_at=$2 WHERE id=$1", [w.id, next]);
    }
  });
  await sendDigests(p, tenantId, now);
}

const DIGEST_LINE: Record<NotificationKind, (n: number) => string> = {
  held_message: n => `${n} ${n === 1 ? "message" : "messages"} blocked`,
  account_reconnect: n => `${n} ${n === 1 ? "mailbox needs" : "mailboxes need"} reconnecting`,
  send_failed: n => `${n} ${n === 1 ? "message" : "messages"} that may not have been sent`,
  reminder_due: n => `${n} task ${n === 1 ? "reminder" : "reminders"} due`,
  followup_due: n => `${n} ${n === 1 ? "conversation" : "conversations"} you may want to follow up on`,
  rule_matched: n => `${n} ${n === 1 ? "message" : "messages"} matched a rule you asked to hear about`,
  send_partial: n => `${n} sent ${n === 1 ? "message" : "messages"} that didn't reach everyone`,
};

/** Counts only, on purpose: no subject, sender, account name or snippet. Goes only to a verified address. */
export function renderDigest(p: Platform, to: string, counts: { kind: NotificationKind; count: number }[]) {
  return {
    to,
    subject: `Your ${PRODUCT_NAME} digest`,
    text: `Here's what's waiting for you in ${PRODUCT_NAME}:\n\n${counts.map(c => `- ${DIGEST_LINE[c.kind](c.count)}`).join("\n")}\n\nOpen the app to see them: ${p.config.appOrigin}/app\n\nThis digest never includes message content. You can turn it off under Settings, Personalization.\n`,
  };
}

async function sendDigests(p: Platform, tenantId: string, now: Date) {
  if (!p.mailer) return;
  const people = await p.db.withWorker(tenantId, t => t.query<{ user_id: string; prefs: Prefs; email: string; email_verified_at: Date | null; last_sent_on: string | null }>(
    `SELECT m.user_id, u_p.prefs, u.email, u.email_verified_at, d.last_sent_on::text last_sent_on FROM memberships m
     JOIN user_preferences u_p ON u_p.user_id=m.user_id JOIN users u ON u.id=m.user_id
     LEFT JOIN notification_digests d ON d.tenant_id=m.tenant_id AND d.user_id=m.user_id
     WHERE m.tenant_id=$1 AND u_p.prefs->>'emailDigest'='true' AND u.email_verified_at IS NOT NULL`, [tenantId]));
  for (const u of people) {
    const c = localClock(now, timeZoneOf(u.prefs));
    if (u.last_sent_on === c.date || c.hour < (u.prefs.workingHours?.start ?? 8) || !deliverableNow(u.prefs, "normal", now)) continue;
    const counts = await p.db.withWorker(tenantId, t => t.query<{ kind: NotificationKind; count: number }>("SELECT kind, count(*)::int count FROM notifications WHERE user_id=$1 AND read_at IS NULL AND digested_at IS NULL AND deliver_at <= $2 GROUP BY kind ORDER BY kind", [u.user_id, now]));
    const known = counts.filter(c => c.kind in DIGEST_LINE);
    if (!known.length) continue;
    await queueMail(p, "digest", renderDigest(p, u.email, known));
    await p.db.withWorker(tenantId, async t => {
      await t.query("UPDATE notifications SET digested_at=$2 WHERE user_id=$1 AND digested_at IS NULL AND deliver_at <= $2", [u.user_id, now]);
      await t.query("INSERT INTO notification_digests(tenant_id,user_id,last_sent_on) VALUES ($1,$2,$3) ON CONFLICT (tenant_id,user_id) DO UPDATE SET last_sent_on=EXCLUDED.last_sent_on", [tenantId, u.user_id, c.date]);
    });
  }
}

// ---------- Reading them ----------
const COPY: Record<NotificationKind, { title: string; href: string }> = {
  held_message: { title: "A message was blocked", href: "/app/org/blocked" },
  account_reconnect: { title: "A mailbox needs reconnecting", href: "/app/settings/accounts" },
  send_failed: { title: "A message may not have been sent", href: "/app/drafts" },
  reminder_due: { title: "A task reminder is due", href: "/app/tasks" },
  followup_due: { title: "A conversation may need a follow-up", href: "/app/awaiting" },
  rule_matched: { title: "A message matched one of your rules", href: "/app/inbox" },
  send_partial: { title: "A message you sent didn't reach everyone", href: "/app/sent" },
};

export async function listNotifications(p: Platform, ctx: Ctx, limit = 30) {
  const now = p.now();
  return p.db.withUser(ctx, async t => {
    const rows = await t.query<{ id: string; kind: NotificationKind; severity: Severity; ref_id: string | null; deliver_at: Date; read_at: Date | null }>(
      "SELECT id, kind, severity, ref_id, deliver_at, read_at FROM notifications WHERE user_id=$1 AND tenant_id=$2 AND deliver_at <= $3 ORDER BY deliver_at DESC, id LIMIT $4", [ctx.userId, ctx.tenantId, now, limit]);
    const counts = await t.one<{ unread: number; waiting: number }>("SELECT count(*) FILTER (WHERE deliver_at <= $3 AND read_at IS NULL)::int unread, count(*) FILTER (WHERE deliver_at > $3 AND read_at IS NULL)::int waiting FROM notifications WHERE user_id=$1 AND tenant_id=$2", [ctx.userId, ctx.tenantId, now]);
    // The owner can already see their mailbox's name. RLS keeps this to their own accounts.
    const accountIds = rows.filter(r => r.kind === "account_reconnect" && r.ref_id).map(r => r.ref_id);
    const names = new Map((accountIds.length ? await t.query<{ id: string; display_name: string }>("SELECT id, display_name FROM mail_accounts WHERE id = ANY($1::uuid[])", [accountIds]) : []).map(a => [a.id, a.display_name]));
    return {
      unread: counts?.unread ?? 0,
      waiting: counts?.waiting ?? 0,
      // A kind this code no longer knows (gateway_downstream_changed, from the dropped gateway mode) is skipped rather than crashing the list.
      items: rows.filter(r => r.kind in COPY).map(r => {
        const name = r.kind === "account_reconnect" && r.ref_id ? names.get(r.ref_id) : undefined;
        return { id: r.id, kind: r.kind, severity: r.severity, title: name ? `${name} needs reconnecting` : COPY[r.kind].title, href: COPY[r.kind].href, at: r.deliver_at, read: !!r.read_at };
      }),
    };
  });
}

export async function markNotificationRead(p: Platform, ctx: Ctx, id: string) {
  await p.db.withUser(ctx, t => t.query("UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL", [id, ctx.userId]));
}
export async function markAllNotificationsRead(p: Platform, ctx: Ctx) {
  await p.db.withUser(ctx, t => t.query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND tenant_id=$2 AND deliver_at <= $3 AND read_at IS NULL", [ctx.userId, ctx.tenantId, p.now()]));
}

/** The task's owner sets when to be reminded. A null clears it. */
export async function setTaskReminder(p: Platform, ctx: Ctx, taskId: string, remindAt: Date | null) {
  const r = await p.db.withUser(ctx, t => t.query("UPDATE tasks SET remind_at=$2 WHERE id=$1 AND owner_user_id=$3 RETURNING id", [taskId, remindAt, ctx.userId]));
  if (!r.length) throw notFound();
}
