import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { HostedProvider, ModelOutputError, ModelRefusedError, SYSTEM_PROMPT, type Effort } from "./hosted";
import type { InferenceProvider } from "./types";

/**
 * The balanced tier: it reads every incoming message, so the price per message matters as much as the ceiling.
 * AEGIS_LLM_MODEL overrides it, for instance with the flagship.
 */
export const OPENAI_DEFAULT_MODEL = "gpt-6.1-sol";

/** The slice of the SDK this provider uses, so tests can stand in for it. */
type ResponsesClient = Pick<OpenAI, "responses">;
export interface OpenAIProviderOptions { client?: ResponsesClient; apiKey?: string; baseURL?: string; model?: string; onUsage?: InferenceProvider["onUsage"] }

/** The main hosted provider. Reached only through hostedProvider, when the server has an OpenAI key. */
export class OpenAIProvider extends HostedProvider {
  readonly id = "openai";
  readonly model: string;
  private client: ResponsesClient;

  constructor(o: OpenAIProviderOptions = {}) {
    super();
    this.client = o.client ?? new OpenAI({ ...(o.apiKey ? { apiKey: o.apiKey } : {}), ...(o.baseURL ? { baseURL: o.baseURL } : {}) });
    this.model = o.model ?? OPENAI_DEFAULT_MODEL;
    this.onUsage = o.onUsage;
  }

  protected async call<T extends z.ZodType>(purpose: string, schema: T, user: string, effort: Effort): Promise<z.infer<T>> {
    const t0 = Date.now();
    // Prompts and completions are never logged. Only counts and latency leave this function.
    const res = await this.client.responses.parse({
      model: this.model,
      instructions: SYSTEM_PROMPT,
      input: user,
      // Strict structured output: the reply is JSON for this schema or it's a refusal.
      text: { format: zodTextFormat(schema, purpose) },
      reasoning: { effort },
      max_output_tokens: 8000,
      // Mail is sent for an answer, not for keeping: the provider isn't asked to retain the exchange.
      store: false,
    });
    this.onUsage?.({ purpose, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, latencyMs: Date.now() - t0 });
    const refused = (res.output ?? []).some(item => item.type === "message" && item.content.some(part => part.type === "refusal"));
    if (refused) throw new ModelRefusedError("model declined");
    if (res.status === "incomplete" || res.output_parsed == null) throw new ModelOutputError("model output unusable");
    // The SDK parses against the schema; re-validate so a misbehaving or fake client can't bypass it.
    return schema.parse(res.output_parsed);
  }
}
