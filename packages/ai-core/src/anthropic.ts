import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { HostedProvider, ModelOutputError, ModelRefusedError, SYSTEM_PROMPT, type Effort } from "./hosted";
import type { InferenceProvider } from "./types";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

export interface AnthropicProviderOptions { client?: Anthropic; apiKey?: string; baseURL?: string; model?: string; onUsage?: InferenceProvider["onUsage"] }

/** The alternative hosted provider. Used when an Anthropic key is the one configured; see hostedProvider. */
export class AnthropicProvider extends HostedProvider {
  readonly id = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(o: AnthropicProviderOptions = {}) {
    super();
    this.client = o.client ?? new Anthropic({ ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
    this.model = o.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.onUsage = o.onUsage;
  }

  protected async call<T extends z.ZodType>(purpose: string, schema: T, user: string, effort: Effort): Promise<z.infer<T>> {
    const t0 = Date.now();
    // Prompts and completions are never logged. Only counts and latency leave this function.
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      output_config: { effort, format: zodOutputFormat(schema) },
      messages: [{ role: "user", content: user }],
    } as never) as unknown as { stop_reason: string; parsed_output: z.infer<T> | null; usage: { input_tokens: number; output_tokens: number } };
    this.onUsage?.({ purpose, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, latencyMs: Date.now() - t0 });
    if (res.stop_reason === "refusal") throw new ModelRefusedError("model declined");
    if (res.stop_reason === "max_tokens" || res.parsed_output == null) throw new ModelOutputError("model output unusable");
    // SDK parse validates against the schema; re-validate so a misbehaving or fake client can't bypass it.
    return schema.parse(res.parsed_output);
  }
}
