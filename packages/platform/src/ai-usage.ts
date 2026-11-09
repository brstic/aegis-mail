import { ANTHROPIC_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, type HostedConfig } from "@aegis/ai-core";
import type { Ctx, Platform } from "./context";

/** The model a deployment's hosted provider runs when it wasn't told which. */
export const hostedModelName = (cfg: HostedConfig) => cfg.model ?? (cfg.provider === "anthropic" ? ANTHROPIC_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL);

/**
 * Token counts for one hosted call, for the usage page and workspace limits. Counts only: no content and no prompt.
 * `as` is the database role doing the work: a person's request, or the worker scanning their mail.
 */
export async function recordAiUsage(p: Platform, as: "user" | "worker", who: { tenantId: string; userId: string }, u: { purpose: string; inputTokens: number; outputTokens: number; latencyMs: number }) {
  const cfg = p.config.ai;
  if (!cfg) return;
  const insert = (t: { query(sql: string, params: unknown[]): Promise<unknown> }) => t.query(
    "INSERT INTO ai_usage(tenant_id,user_id,provider,model,purpose,input_tokens,output_tokens,latency_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [who.tenantId, who.userId, cfg.provider, hostedModelName(cfg), u.purpose, u.inputTokens, u.outputTokens, u.latencyMs]);
  await (as === "user" ? p.db.withUser(who as Ctx, insert) : p.db.withWorker(who.tenantId, insert));
}
