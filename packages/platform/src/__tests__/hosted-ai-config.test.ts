import { describe, expect, it } from "vitest";
import { hostedAiFromEnv } from "../index";

describe("which hosted model a server uses", () => {
  it("none without a key", () => expect(hostedAiFromEnv({})).toBeUndefined());
  it("OpenAI when its key is set, and when both are", () => {
    expect(hostedAiFromEnv({ OPENAI_API_KEY: "o" })).toEqual({ provider: "openai", apiKey: "o" });
    expect(hostedAiFromEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" })).toEqual({ provider: "openai", apiKey: "o" });
  });
  it("Anthropic when it's the only key, or when asked for by name", () => {
    expect(hostedAiFromEnv({ ANTHROPIC_API_KEY: "a" })).toEqual({ provider: "anthropic", apiKey: "a" });
    expect(hostedAiFromEnv({ OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a", AEGIS_LLM_PROVIDER: "anthropic" })).toEqual({ provider: "anthropic", apiKey: "a" });
  });
  it("naming a provider that has no key configures nothing", () => expect(hostedAiFromEnv({ ANTHROPIC_API_KEY: "a", AEGIS_LLM_PROVIDER: "openai" })).toBeUndefined());
  it("an unknown provider name is refused at boot rather than guessed", () => expect(() => hostedAiFromEnv({ OPENAI_API_KEY: "o", AEGIS_LLM_PROVIDER: "gemini" })).toThrow(/AEGIS_LLM_PROVIDER/));
  it("the model and endpoint settings go to the chosen provider", () => {
    expect(hostedAiFromEnv({ OPENAI_API_KEY: "o", AEGIS_LLM_MODEL: "gpt-6-astra", AEGIS_LLM_BASE_URL: "https://llm.internal/v1" })).toEqual({ provider: "openai", apiKey: "o", model: "gpt-6-astra", baseURL: "https://llm.internal/v1" });
  });
  it("a model name left over from the other provider is ignored", () => {
    // Earlier .env files shipped with AEGIS_LLM_MODEL=claude-opus-5-5.
    expect(hostedAiFromEnv({ OPENAI_API_KEY: "o", AEGIS_LLM_MODEL: "claude-opus-5-5" })).toEqual({ provider: "openai", apiKey: "o" });
    expect(hostedAiFromEnv({ ANTHROPIC_API_KEY: "a", AEGIS_LLM_MODEL: "gpt-6.1-sol" })).toEqual({ provider: "anthropic", apiKey: "a" });
  });
});
