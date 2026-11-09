import { AnthropicProvider } from "./anthropic";
import { LocalHeuristicProvider } from "./heuristic";
import type { HostedProvider } from "./hosted";
import { OpenAIProvider } from "./openai";
import type { InferenceProvider } from "./types";

export * from "./types";
export * from "./dates";
export * from "./text";
export * from "./guard";
export * from "./heuristic";
export * from "./hosted";
export * from "./openai";
export * from "./anthropic";
export * from "./assistant";

export type HostedProviderName = "openai" | "anthropic";
/** What a deployment configured: which hosted provider, its key, and optionally another endpoint or model. */
export interface HostedConfig { provider: HostedProviderName; apiKey: string; baseURL?: string; model?: string }

/** The hosted provider a deployment configured. The only place a hosted client is constructed. */
export function hostedProvider(cfg: HostedConfig, onUsage?: InferenceProvider["onUsage"]): HostedProvider {
  const o = { apiKey: cfg.apiKey, baseURL: cfg.baseURL, model: cfg.model, onUsage };
  return cfg.provider === "anthropic" ? new AnthropicProvider(o) : new OpenAIProvider(o);
}

export interface ProviderSelection { provider: InferenceProvider; reason: string }

/**
 * For what a person asks the AI to write: summaries, drafts and the assistant. A hosted model is used only with ALL of
 * a configured key, AI enabled, and this user's explicit consent. Absent any of them, that content stays local.
 * Security review of incoming mail doesn't come through here: it uses the hosted model whenever the server has one.
 */
export function selectProvider(opts: { hosted?: HostedConfig; aiEnabled: boolean; hostedConsent: boolean; onUsage?: InferenceProvider["onUsage"]; factory?: () => InferenceProvider }): ProviderSelection {
  if (!opts.aiEnabled) return { provider: new LocalHeuristicProvider(), reason: "AI features are off for this user" };
  if (!opts.hostedConsent) return { provider: new LocalHeuristicProvider(), reason: "User hasn't consented to hosted models" };
  if (opts.factory) return { provider: opts.factory(), reason: "Injected provider" };
  if (!opts.hosted) return { provider: new LocalHeuristicProvider(), reason: "No hosted model configured" };
  return { provider: hostedProvider(opts.hosted, opts.onUsage), reason: "User consented and a hosted model is configured" };
}
