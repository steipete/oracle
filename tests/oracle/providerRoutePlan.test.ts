import { describe, expect, test } from "vitest";
import { buildProviderRoutePlan } from "../../src/oracle/providerRoutePlan.js";

describe("provider route plan", () => {
  test("forced OpenAI ignores configured Azure for GPT models", () => {
    const plan = buildProviderRoutePlan({
      model: "gpt-5.4",
      providerMode: "openai",
      azure: {
        endpoint: "https://example-resource.openai.azure.com/",
        deployment: "gpt-prod",
      },
      env: {
        OPENAI_API_KEY: "sk-openai-test-key",
        AZURE_OPENAI_API_KEY: "az-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenAI");
    expect(plan.base).toBe("api.openai.com");
    expect(plan.keySource).toBe("OPENAI_API_KEY");
    expect(plan.keyPreview).toContain("OPENAI_API_KEY=sk-o");
    expect(plan.azureNote).toContain("ignored");
  });

  test("auto Azure route reports missing deployment before request dispatch", () => {
    const plan = buildProviderRoutePlan({
      model: "gpt-5.4",
      providerMode: "auto",
      azure: {
        endpoint: "https://example-resource.openai.azure.com/",
      },
      env: {
        AZURE_OPENAI_API_KEY: "az-test-key",
      },
    });

    expect(plan.ok).toBe(false);
    expect(plan.providerLabel).toBe("Azure OpenAI");
    expect(plan.base).toBe("example-resource.openai.azure.com");
    expect(plan.error).toMatch(/Azure mode requires --azure-deployment/);
  });

  test("native provider route reports missing Gemini key", () => {
    const plan = buildProviderRoutePlan({
      model: "gemini-3-pro",
      providerMode: "auto",
      env: {},
    });

    expect(plan.ok).toBe(false);
    expect(plan.providerLabel).toBe("Google Gemini");
    expect(plan.keySource).toBe("GEMINI_API_KEY");
    expect(plan.error).toBe("Missing GEMINI_API_KEY.");
  });

  test("forced OpenAI invalid model reports the attempted OpenAI route", () => {
    const plan = buildProviderRoutePlan({
      model: "claude-4.6-sonnet",
      providerMode: "openai",
      env: {
        OPENAI_API_KEY: "sk-openai-test-key",
        ANTHROPIC_API_KEY: "ak-native-test-key",
      },
    });

    expect(plan.ok).toBe(false);
    expect(plan.providerLabel).toBe("OpenAI");
    expect(plan.keySource).toBe("OPENAI_API_KEY");
    expect(plan.error).toMatch(/OpenAI provider cannot run claude-4\.6-sonnet/);
  });

  test("provider-qualified custom ids report OpenRouter readiness in auto mode", () => {
    const plan = buildProviderRoutePlan({
      model: "openai/o3",
      providerMode: "auto",
      env: {
        OPENAI_API_KEY: "sk-openai-test-key",
      },
    });

    expect(plan.ok).toBe(false);
    expect(plan.providerLabel).toBe("OpenRouter");
    expect(plan.base).toBe("openrouter.ai/api/...");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
    expect(plan.error).toBe("Missing OPENROUTER_API_KEY.");
  });

  test("provider-qualified ids prefer OpenRouter over native provider keys", () => {
    const plan = buildProviderRoutePlan({
      model: "anthropic/claude-sonnet-4.5",
      providerMode: "auto",
      env: {
        ANTHROPIC_API_KEY: "ak-native-test-key",
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenRouter");
    expect(plan.base).toBe("openrouter.ai/api/...");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
  });

  test("provider-qualified ids preserve explicit proxy base URLs", () => {
    const plan = buildProviderRoutePlan({
      model: "anthropic/claude-sonnet-4.5",
      providerMode: "auto",
      baseUrl: "https://litellm.test/v1",
      env: {
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenAI-compatible");
    expect(plan.base).toBe("litellm.test/v1");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
  });

  test("explicit proxy base URLs do not fallback to OpenRouter for first-party models", () => {
    const plan = buildProviderRoutePlan({
      model: "gpt-5.4",
      providerMode: "auto",
      baseUrl: "https://litellm.test/v1",
      env: {
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(false);
    expect(plan.providerLabel).toBe("OpenAI-compatible");
    expect(plan.base).toBe("litellm.test/v1");
    expect(plan.keySource).toBe("OPENAI_API_KEY");
    expect(plan.error).toBe("Missing OPENAI_API_KEY.");
  });

  test("provider-qualified ids ignore native base URL overrides in auto mode", () => {
    const plan = buildProviderRoutePlan({
      model: "openai/gpt-4o-mini",
      providerMode: "auto",
      baseUrl: "https://api.openai.com/v1",
      env: {
        OPENAI_API_KEY: "sk-openai-test-key",
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenRouter");
    expect(plan.base).toBe("openrouter.ai/api/...");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
  });

  test("provider-qualified ids preserve configured proxy base URLs", () => {
    const plan = buildProviderRoutePlan({
      model: "openai/gpt-4o-mini",
      providerMode: "auto",
      env: {
        OPENAI_BASE_URL: "https://litellm.test/v1",
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenAI-compatible");
    expect(plan.base).toBe("litellm.test/v1");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
  });

  test("provider-qualified ids ignore native provider base URLs", () => {
    const plan = buildProviderRoutePlan({
      model: "anthropic/claude-sonnet-4.5",
      providerMode: "auto",
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_API_KEY: "ak-native-test-key",
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenRouter");
    expect(plan.base).toBe("openrouter.ai/api/...");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
  });

  test("custom model ids report OpenRouter route when its key is missing", () => {
    const plan = buildProviderRoutePlan({
      model: "llama-3",
      providerMode: "auto",
      env: {},
    });

    expect(plan.ok).toBe(false);
    expect(plan.providerLabel).toBe("OpenRouter");
    expect(plan.base).toBe("openrouter.ai/api/...");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
    expect(plan.error).toBe("Missing OPENROUTER_API_KEY.");
  });

  test("provider-qualified ids are not captured by auto Azure routing", () => {
    const plan = buildProviderRoutePlan({
      model: "openai/gpt-4o-mini",
      providerMode: "auto",
      azure: {
        endpoint: "https://example-resource.openai.azure.com/",
        deployment: "gpt-prod",
      },
      env: {
        AZURE_OPENAI_API_KEY: "az-test-key",
        OPENROUTER_API_KEY: "or-openrouter-test-key",
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.providerLabel).toBe("OpenRouter");
    expect(plan.base).toBe("openrouter.ai/api/...");
    expect(plan.keySource).toBe("OPENROUTER_API_KEY");
    expect(plan.azureNote).toContain("configured, not used");
  });

  test("forced Azure route errors still report Azure readiness", () => {
    const plan = buildProviderRoutePlan({
      model: "gpt-5.4",
      providerMode: "azure",
      env: {},
    });

    expect(plan.ok).toBe(false);
    expect(plan.provider).toBe("azure");
    expect(plan.providerLabel).toBe("Azure OpenAI");
    expect(plan.keySource).toBe("AZURE_OPENAI_API_KEY|OPENAI_API_KEY");
    expect(plan.error).toMatch(/--provider azure requires --azure-endpoint/);
  });
});
