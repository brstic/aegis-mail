import type { Ctx, Platform } from "./context";
import { msgCtx, type MessageEnvelope } from "./ingest";

/** The signed-in person's own mail, across their accounts. RLS scopes it. Counts only: no subject, sender or body leaves here. */
export async function personalInsights(p: Platform, ctx: Ctx, days = 30) {
  const since = new Date(p.now().getTime() - days * 864e5);
  return p.db.withUser(ctx, async t => {
    const perAccount = await t.query<any>(
      `SELECT a.id "accountId", a.display_name "displayName",
         count(*) FILTER (WHERE NOT m.from_me)::int received, count(*) FILTER (WHERE m.from_me)::int sent,
         count(*) FILTER (WHERE m.risk_label IN ('suspicious','high_risk','malicious'))::int flagged
       FROM mail_accounts a LEFT JOIN messages m ON m.account_id=a.id AND m.internal_date >= $1 AND m.tombstoned_at IS NULL
       WHERE a.owner_user_id=$2 GROUP BY a.id, a.display_name ORDER BY received DESC`, [since, ctx.userId]);
    // Time from an incoming message to the next message you sent in that thread.
    const reply = await t.one<{ h: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.internal_date - m.internal_date) / 3600) h
       FROM messages m JOIN LATERAL (SELECT internal_date FROM messages x WHERE x.thread_id=m.thread_id AND x.from_me AND x.internal_date > m.internal_date ORDER BY x.internal_date LIMIT 1) r ON true
       WHERE NOT m.from_me AND m.internal_date >= $1`, [since]);
    const busiestHours = await t.query<any>("SELECT extract(hour FROM internal_date)::int AS hour, count(*)::int AS count FROM messages WHERE NOT from_me AND internal_date >= $1 GROUP BY 1 ORDER BY 1", [since]);
    const rows = await t.query<any>("SELECT id, envelope_enc FROM messages WHERE NOT from_me AND internal_date >= $1 AND envelope_enc IS NOT NULL LIMIT 2000", [since]);
    const counts = new Map<string, number>();
    for (const r of rows) {
      const e = await p.envelope.openJson<MessageEnvelope>(msgCtx(ctx.tenantId, r.id), r.envelope_enc);
      for (const topic of e.topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    return { days, perAccount, medianReplyHours: reply?.h == null ? null : Math.round(reply.h * 10) / 10, topicCounts: [...counts].map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count), busiestHours };
  });
}

const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Open tasks as a calendar file. Only firm dates: vague timing ("soon") never becomes a calendar entry on its own. */
export function tasksToIcs(tasks: { id: string; text: string; dueAt: string | Date | null; dueUncertain: boolean }[], now: Date) {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const firm = tasks.filter(t => t.dueAt && !t.dueUncertain);
  const events = firm.map(t => {
    const d = new Date(t.dueAt!).toISOString().slice(0, 10).replace(/-/g, "");
    return ["BEGIN:VEVENT", `UID:${t.id}@aegis-mail`, `DTSTAMP:${stamp(now)}`, `DTSTART;VALUE=DATE:${d}`, `SUMMARY:${icsEscape(t.text.slice(0, 200))}`, "END:VEVENT"].join("\r\n");
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Aegis Mail//Tasks//EN", ...events, "END:VCALENDAR", ""].join("\r\n");
}
