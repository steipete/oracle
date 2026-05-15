import { describe, expect, test } from "vitest";

import {
  classifyProviderFailure,
  sanitizeProviderMessage,
} from "../../src/oracle/providerFailures.js";

describe("provider failure classification", () => {
  test("redacts provider messages before surfacing them", () => {
    expect(
      sanitizeProviderMessage(
        "invalid x-api-key: sk-ant-secret123456789 and Bearer token-abc123456789",
      ),
    ).toBe("invalid x-api-key: [redacted] and Bearer [redacted]");
    expect(sanitizeProviderMessage("401 Incorrect API key provided: xai-secret123456789")).toBe(
      "401 Incorrect API key provided: [redacted]",
    );
    expect(sanitizeProviderMessage("API key is invalid: xai-secret123456789")).toBe(
      "API key is invalid: xai-...[redacted]",
    );
  });

  test("does not classify local permission errors as provider auth failures", () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/tmp/input.md'"), {
      code: "EACCES",
    });

    expect(classifyProviderFailure(error, "gpt-5.1")).toBeNull();
  });

  test("does not classify embedded status-code digits as provider failures", () => {
    expect(
      classifyProviderFailure(new Error("ECONNREFUSED 127.0.0.1:4010"), {
        model: "gpt-5.1",
        env: {},
      }),
    ).toBeNull();
    expect(
      classifyProviderFailure(new Error("proxy failed at /v1/routes/4290"), {
        model: "gpt-5.1",
        env: {},
      }),
    ).toBeNull();
  });

  test("uses Azure route context for OpenAI model auth hints", () => {
    expect(
      classifyProviderFailure(new Error("401 invalid api key"), {
        model: "gpt-5.1",
        providerMode: "auto",
        azure: { endpoint: "https://example.openai.azure.com" },
        env: { AZURE_OPENAI_API_KEY: "az-secret123456789" },
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "azure",
      keyEnv: "AZURE_OPENAI_API_KEY",
      fix: expect.stringContaining("oracle doctor --providers --models gpt-5.1"),
    });
  });

  test("classifies incorrect API key messages without a 401 prefix", () => {
    expect(
      classifyProviderFailure(new Error("Incorrect API key provided: sk-proj-secret123456789"), {
        model: "gpt-5.1",
        env: {},
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "openai",
      keyEnv: "OPENAI_API_KEY",
      providerMessage: "Incorrect API key provided: [redacted]",
    });
  });

  test("classifies auth messages before display redaction", () => {
    expect(
      classifyProviderFailure(new Error("API key is expired"), {
        model: "gemini-3-pro",
        env: { GEMINI_API_KEY: "gm-secret123456789" },
      }),
    ).toMatchObject({
      category: "auth-expired",
      provider: "gemini",
      keyEnv: "GEMINI_API_KEY",
      providerMessage: "API key is expired",
    });

    expect(
      classifyProviderFailure(new Error("API key is invalid: xai-secret123456789"), {
        model: "grok-4.1",
        env: { XAI_API_KEY: "xai-secret123456789" },
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "xai",
      keyEnv: "XAI_API_KEY",
      providerMessage: "API key is invalid: xai-...[redacted]",
    });
  });

  test("uses OpenRouter key hints for provider-qualified model routes", () => {
    expect(
      classifyProviderFailure(new Error("invalid api key"), {
        model: "anthropic/claude-3.5-sonnet",
        env: {},
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "openrouter",
      keyEnv: "OPENROUTER_API_KEY",
    });
  });

  test("uses OpenRouter key hints when fallback routes a plain model through OpenRouter", () => {
    expect(
      classifyProviderFailure(new Error("401 invalid api key"), {
        model: "gpt-5.1",
        env: { OPENROUTER_API_KEY: "sk-or-secret123456789" },
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "openrouter",
      keyEnv: "OPENROUTER_API_KEY",
    });
  });

  test("uses actual key source in recovery hints", () => {
    expect(
      classifyProviderFailure(new Error("401 invalid api key"), {
        model: "gpt-5.1",
        apiKey: "sk-explicit-secret123456789",
        env: {},
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "openai",
      keyEnv: "apiKey option",
      fix: expect.stringContaining("check --api-key value"),
    });

    expect(
      classifyProviderFailure(new Error("401 invalid api key"), {
        model: "gpt-5.1",
        azure: { endpoint: "https://example.openai.azure.com" },
        env: { OPENAI_API_KEY: "sk-fallback-secret123456789" },
      }),
    ).toMatchObject({
      category: "auth-failed",
      provider: "azure",
      keyEnv: "OPENAI_API_KEY",
      fix: expect.stringContaining("refresh OPENAI_API_KEY"),
    });
  });
});
