import type { Ctx, Platform } from "./context";
import { recordErasure } from "./deletion-log";
import { eraseSearchWords } from "./erasure";
import { enqueue } from "./jobs";
import { deleteOwnedEmbeddings } from "./semantic-search";
export interface Prefs { defaultView?: "focus" | "inbox"; density?: string; layout?: string; theme?: string; aiEnabled?: boolean; personalizationEnabled?: boolean; hostedModelConsent?: boolean; serverSearchEnabled?: boolean; semanticSearchEnabled?: boolean; automationLevel?: string; workingHours?: { start: number; end: number; tz: string } | null; timeZone?: string; emailDigest?: boolean; browserNotifications?: boolean; criticalBypassQuiet?: boolean; hiddenSections?: string[]; pinnedSections?: string[]; quietHours?: { start: number; end: number } | null; tone?: "neutral" | "warm" | "brief" | "formal"; summariesEnabled?: boolean; topicsEnabled?: boolean; storeAttachments?: boolean; customTopics?: { name: string; terms: string[] }[]; accountRanking?: Record<string, number>; priorityWeights?: Record<string, number>; signatures?: { id: string; accountId: string; name: string; text: string; isDefault: boolean }[]; savedSearches?: { name: string; q: string; concepts: boolean; semantic?: boolean }[]; digestHours?: number }
export async function getPrefs(p: Platform, ctx: Ctx): Promise<Prefs> {
  const r = await p.db.withUser(ctx, t => t.one<{ prefs: Prefs }>("SELECT prefs FROM user_preferences WHERE user_id=$1", [ctx.userId]));
  return r?.prefs ?? {};
}
export async function updatePrefs(p: Platform, ctx: Ctx, patch: Partial<Prefs>) {
  const current = await getPrefs(p, ctx);
  const next = { ...current, ...patch };
  await p.db.withUser(ctx, async t => {
    await t.query("INSERT INTO user_preferences(user_id,prefs) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET prefs=user_preferences.prefs || $3::jsonb, updated_at=now()", [ctx.userId, JSON.stringify(next), JSON.stringify(patch)]);
    if (patch.hostedModelConsent !== undefined && patch.hostedModelConsent !== current.hostedModelConsent) await t.query("INSERT INTO consent_records(user_id,tenant_id,purpose,granted) VALUES ($1,$2,'hosted_model',$3)", [ctx.userId, ctx.tenantId, patch.hostedModelConsent]);
  });
  // Opting out removes the lexemes now, in every workspace: preferences are per person, RLS is per tenant.
  const searchOff = patch.serverSearchEnabled === false, vectorsOff = searchOff || patch.semanticSearchEnabled === false;
  const vectorsBack = !vectorsOff && !!p.embeddings && (patch.serverSearchEnabled === true || patch.semanticSearchEnabled === true) && next.serverSearchEnabled !== false && next.semanticSearchEnabled !== false;
  if (vectorsOff || vectorsBack) {
    const tenants = await p.db.withSystem(t => t.query<{ tenant_id: string }>("SELECT tenant_id FROM memberships WHERE user_id=$1", [ctx.userId]));
    for (const { tenant_id } of tenants) {
      const c = { tenantId: tenant_id, userId: ctx.userId };
      if (searchOff) await p.db.withUser(c, async t => {
        await eraseSearchWords(t, ctx.userId);
        await recordErasure(t, { kind: "search_off", tenantId: tenant_id, userId: ctx.userId });
      });
      if (vectorsOff) await p.db.withUser(c, async t => {
        await deleteOwnedEmbeddings(t, ctx.userId);
        // Replaying search_off takes the vectors too.
        if (!searchOff) await recordErasure(t, { kind: "vectors_off", tenantId: tenant_id, userId: ctx.userId });
      });
      // Word search doesn't rebuild when turned back on, but vectors come from the stored body, so they can.
      if (vectorsBack) await p.db.withUser(c, async t => {
        for (const a of await t.query<{ id: string }>("SELECT id FROM mail_accounts WHERE owner_user_id=$1 AND status<>'disconnected'", [ctx.userId])) await enqueue(t, { tenantId: tenant_id, kind: "embed.backfill", payload: { accountId: a.id }, dedupeKey: `embed-backfill:${a.id}:on` });
      });
    }
  }
  return next;
}
