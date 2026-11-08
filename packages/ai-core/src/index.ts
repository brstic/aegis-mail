import { AnthropicProvider } from "./anthropic";
import { LocalHeuristicProvider } from "./heuristic";
import type { InferenceProvider } from "./types";

export * from "./types";
export * from "./dates";
export * from "./text";
export * from "./guard";
export * from "./heuristic";
export * from "./anthropic";
export * from "./assistant";

export interface ProviderSelection { provider: InferenceProvider; reason: string }

/**
 * Hosted inference requires ALL of: a configured key, AI enabled, and this user's explicit consent.
 * Absent any of them, content stays local. This is the single choke point; nothing else constructs a hosted client.
 */
export function selectProvider(opts: { apiKey?: string; baseURL?: string; model?: string; aiEnabled: boolean; hostedConsent: boolean; onUsage?: InferenceProvider["onUsage"]; factory?: () => InferenceProvider }): ProviderSelection {
  if (!opts.aiEnabled) return { provider: new LocalHeuristicProvider(), reason: "AI features are off for this user" };
  if (!opts.hostedConsent) return { provider: new LocalHeuristicProvider(), reason: "User hasn't consented to hosted models" };
  if (opts.factory) return { provider: opts.factory(), reason: "Injected provider" };
  if (!opts.apiKey) return { provider: new LocalHeuristicProvider(), reason: "No hosted model configured" };
  const { apiKey, baseURL, model, onUsage } = opts;
  return { provider: new AnthropicProvider({ apiKey, baseURL, model, onUsage }), reason: "User consented and a hosted model is configured" };
}
