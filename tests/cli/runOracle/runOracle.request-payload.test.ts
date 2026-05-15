import { describe, expect, test, vi } from "vitest";

import { runOracle } from "@src/oracle.ts";
import { MockClient, MockStream, buildResponse } from "./helpers.ts";

describe("runOracle request payload", () => {
  test("maps gpt-5.1-pro alias to gpt-5.5-pro API model", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Alias check",
        model: "gpt-5.1-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(client.lastRequest?.model).toBe("gpt-5.5-pro");
    expect(logs.join("\n")).toContain("(API: gpt-5.5-pro)");
    expect(logs.join("\n")).toContain("gpt-5.1-pro");
    expect(logs.join("\n")).toContain("OpenAI API uses `gpt-5.5-pro`");
  });

  test("maps gpt-5.2-pro alias to gpt-5.5-pro API model", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Alias check",
        model: "gpt-5.2-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(client.lastRequest?.model).toBe("gpt-5.5-pro");
    expect(logs.join("\n")).toContain("(API: gpt-5.5-pro)");
    expect(logs.join("\n")).toContain("gpt-5.2-pro");
    expect(logs.join("\n")).toContain("OpenAI API uses `gpt-5.5-pro`");
  });

  test("search enabled by default", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: "Default search",
        model: "gpt-5.2-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.tools).toEqual([{ type: "web_search_preview" }]);
  });

  test("passes baseUrl through to clientFactory", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; baseUrl?: string }> = [];
    await runOracle(
      {
        prompt: "Custom endpoint",
        model: "gpt-5.2-pro",
        baseUrl: "https://litellm.test/v1",
        background: false,
      },
      {
        apiKey: "sk-test",
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, baseUrl: options?.baseUrl });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([{ apiKey: "sk-test", baseUrl: "https://litellm.test/v1" }]);
  });

  test("logs the first-party OpenAI route", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Route check",
        model: "gpt-5.1",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (message: string) => logs.push(message),
      },
    );
    expect(logs.join("\n")).toContain(
      "Provider: OpenAI | base: api.openai.com | key: apiKey option",
    );
  });

  test("passes gemini custom baseUrl through to clientFactory", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; baseUrl?: string; model?: string }> = [];
    await runOracle(
      {
        prompt: "Gemini custom endpoint",
        model: "gemini-3-pro",
        baseUrl: "https://litellm.test/v1",
        background: false,
      },
      {
        apiKey: "gk-test",
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, baseUrl: options?.baseUrl, model: options?.model });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([
      { apiKey: "gk-test", baseUrl: "https://litellm.test/v1", model: "gemini-3-pro" },
    ]);
  });

  test("keeps explicit claude baseUrl even when ANTHROPIC_BASE_URL is set", async () => {
    const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://env.anthropic.test/v1";

    try {
      const stream = new MockStream([], buildResponse());
      const client = new MockClient(stream);
      const captured: Array<{ apiKey: string; baseUrl?: string; model?: string }> = [];
      await runOracle(
        {
          prompt: "Claude custom endpoint",
          model: "claude-4.6-sonnet",
          baseUrl: "https://litellm.test/v1",
          background: false,
        },
        {
          apiKey: "ak-test",
          clientFactory: (apiKey, options) => {
            captured.push({ apiKey, baseUrl: options?.baseUrl, model: options?.model });
            return client;
          },
          log: () => {},
          write: () => true,
        },
      );
      expect(captured).toEqual([
        { apiKey: "ak-test", baseUrl: "https://litellm.test/v1", model: "claude-4.6-sonnet" },
      ]);
    } finally {
      if (originalAnthropicBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
      }
    }
  });

  test("does not auto-fallback to OpenRouter when provider is forced to OpenAI", async () => {
    const originalOpenai = process.env.OPENAI_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "or-test";

    try {
      await expect(
        runOracle(
          {
            prompt: "Forced OpenAI should require OpenAI key",
            model: "gpt-5.1",
            provider: "openai",
            background: false,
          },
          {
            clientFactory: () => {
              throw new Error("clientFactory should not be called");
            },
            log: () => {},
            write: () => true,
          },
        ),
      ).rejects.toThrow(/Missing OPENAI_API_KEY/);
    } finally {
      if (originalOpenai === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenai;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }
  });

  test("uses OpenAI credentials for forced OpenAI custom model ids", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const originalOpenai = process.env.OPENAI_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    const captured: Array<{ apiKey: string; baseUrl?: string }> = [];
    const logs: string[] = [];
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.OPENROUTER_API_KEY = "or-test";

    try {
      await runOracle(
        {
          prompt: "Forced OpenAI custom model",
          model: "o3-mini",
          provider: "openai",
          background: false,
        },
        {
          clientFactory: (apiKey, options) => {
            captured.push({ apiKey, baseUrl: options?.baseUrl });
            return client;
          },
          log: (message: string) => logs.push(message),
          write: () => true,
        },
      );
    } finally {
      if (originalOpenai === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenai;
      }
      if (originalOpenRouter === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      }
    }

    expect(captured).toEqual([{ apiKey: "sk-openai", baseUrl: undefined }]);
    expect(client.lastRequest?.model).toBe("o3-mini");
    expect(logs.join("\n")).toContain(
      "Provider: OpenAI | base: api.openai.com | key: OPENAI_API_KEY",
    );
  });

  test("rejects forced OpenAI provider mode for known non-OpenAI models", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Claude should not run through OpenAI",
          model: "claude-4.6-sonnet",
          provider: "openai",
          background: false,
        },
        {
          apiKey: "sk-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/OpenAI provider cannot run claude-4\.6-sonnet/);
    expect(client.lastRequest).toBeNull();
  });

  test("rejects forced OpenAI provider mode for native-looking custom model ids", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Custom Claude should not run through OpenAI",
          model: "claude-3-haiku",
          provider: "openai",
          background: false,
        },
        {
          apiKey: "sk-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/OpenAI provider cannot run claude-3-haiku/);
    expect(client.lastRequest).toBeNull();
  });

  test("rejects forced OpenAI provider mode for provider-qualified non-OpenAI ids", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Provider-qualified Claude should not run through OpenAI",
          model: "anthropic/claude-sonnet-4.5",
          provider: "openai",
          background: false,
        },
        {
          apiKey: "sk-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/OpenAI provider cannot run anthropic\/claude-sonnet-4\.5/);
    expect(client.lastRequest).toBeNull();
  });

  test("passes azure config to clientFactory, logs the route, and sends the deployment name as the Azure model", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; azure?: unknown; resolvedModelId?: string }> = [];
    const logs: string[] = [];
    const azureOptions = {
      endpoint: "https://my-azure.com/",
      deployment: "gpt-4-test",
      apiVersion: "2024-01-01",
    };

    await runOracle(
      {
        prompt: "Azure test",
        model: "gpt-5.2-pro",
        azure: azureOptions,
        background: false,
      },
      {
        apiKey: "sk-test",
        clientFactory: (apiKey, options) => {
          captured.push({
            apiKey,
            azure: options?.azure,
            resolvedModelId: options?.resolvedModelId,
          });
          return client;
        },
        log: (message: string) => logs.push(message),
        write: () => true,
      },
    );
    expect(captured).toEqual([
      { apiKey: "sk-test", azure: azureOptions, resolvedModelId: "gpt-4-test" },
    ]);
    expect(client.lastRequest?.model).toBe("gpt-4-test");
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: gpt-4-test | key: apiKey option",
    );
  });

  test("treats custom GPT model ids with an Azure endpoint as Azure OpenAI", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const originalAzureKey = process.env.AZURE_OPENAI_API_KEY;
    const captured: Array<{ apiKey: string; azure?: unknown; resolvedModelId?: string }> = [];
    const logs: string[] = [];
    const azureOptions = {
      endpoint: "https://my-azure.com/",
      deployment: "custom-gpt4o",
    };
    process.env.AZURE_OPENAI_API_KEY = "az-test";

    try {
      await runOracle(
        {
          prompt: "Azure custom GPT",
          model: "gpt-4o",
          azure: azureOptions,
          background: false,
        },
        {
          clientFactory: (apiKey, options) => {
            captured.push({
              apiKey,
              azure: options?.azure,
              resolvedModelId: options?.resolvedModelId,
            });
            return client;
          },
          log: (message: string) => logs.push(message),
          write: () => true,
        },
      );
    } finally {
      if (originalAzureKey === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = originalAzureKey;
      }
    }

    expect(captured).toEqual([
      { apiKey: "az-test", azure: azureOptions, resolvedModelId: "custom-gpt4o" },
    ]);
    expect(client.lastRequest?.model).toBe("custom-gpt4o");
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: custom-gpt4o | key: AZURE_OPENAI_API_KEY|OPENAI_API_KEY",
    );
  });

  test("treats explicit Azure provider runs with custom non-GPT model ids as Azure OpenAI", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const originalAzureKey = process.env.AZURE_OPENAI_API_KEY;
    const captured: Array<{ apiKey: string; azure?: unknown; resolvedModelId?: string }> = [];
    const logs: string[] = [];
    const azureOptions = {
      endpoint: "https://my-azure.com/",
      deployment: "my-o3",
    };
    process.env.AZURE_OPENAI_API_KEY = "az-test";

    try {
      await runOracle(
        {
          prompt: "Azure custom O-series deployment",
          model: "o3-mini",
          provider: "azure",
          azure: azureOptions,
          effectiveModelId: "o3-mini",
          background: false,
        },
        {
          clientFactory: (apiKey, options) => {
            captured.push({
              apiKey,
              azure: options?.azure,
              resolvedModelId: options?.resolvedModelId,
            });
            return client;
          },
          log: (message: string) => logs.push(message),
          write: () => true,
        },
      );
    } finally {
      if (originalAzureKey === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = originalAzureKey;
      }
    }

    expect(captured).toEqual([
      { apiKey: "az-test", azure: azureOptions, resolvedModelId: "my-o3" },
    ]);
    expect(client.lastRequest?.model).toBe("my-o3");
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: my-o3 | key: AZURE_OPENAI_API_KEY|OPENAI_API_KEY",
    );
  });

  test("rejects explicit Azure provider mode without an endpoint", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Azure provider needs endpoint",
          model: "gpt-5.1",
          provider: "azure",
          background: false,
        },
        {
          apiKey: "sk-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/--provider azure requires --azure-endpoint/);
    expect(client.lastRequest).toBeNull();
  });

  test("keeps explicit Azure provider routing ahead of OpenRouter base URLs", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const originalAzureKey = process.env.AZURE_OPENAI_API_KEY;
    const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
    const captured: Array<{
      apiKey: string;
      azure?: unknown;
      baseUrl?: string;
      resolvedModelId?: string;
    }> = [];
    const azureOptions = {
      endpoint: "https://my-azure.com/",
      deployment: "my-o3",
    };
    process.env.AZURE_OPENAI_API_KEY = "az-test";
    process.env.OPENROUTER_API_KEY = "or-test";

    try {
      await runOracle(
        {
          prompt: "Azure should win over OpenRouter",
          model: "o3-mini",
          provider: "azure",
          azure: azureOptions,
          baseUrl: "https://openrouter.ai/api/v1",
          background: false,
        },
        {
          clientFactory: (apiKey, options) => {
            captured.push({
              apiKey,
              azure: options?.azure,
              baseUrl: options?.baseUrl,
              resolvedModelId: options?.resolvedModelId,
            });
            return client;
          },
          log: () => {},
          write: () => true,
        },
      );
    } finally {
      if (originalAzureKey === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = originalAzureKey;
      }
      if (originalOpenRouterKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
      }
    }

    expect(captured).toEqual([
      { apiKey: "az-test", azure: azureOptions, baseUrl: undefined, resolvedModelId: "my-o3" },
    ]);
    expect(client.lastRequest?.model).toBe("my-o3");
  });

  test("treats auto-mode Azure deployments for custom non-GPT model ids as Azure OpenAI", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const originalAzureKey = process.env.AZURE_OPENAI_API_KEY;
    const captured: Array<{ apiKey: string; azure?: unknown; resolvedModelId?: string }> = [];
    const logs: string[] = [];
    const azureOptions = {
      endpoint: "https://my-azure.com/",
      deployment: "my-o3",
    };
    process.env.AZURE_OPENAI_API_KEY = "az-test";

    try {
      await runOracle(
        {
          prompt: "Azure custom O-series auto route",
          model: "o3-mini",
          azure: azureOptions,
          effectiveModelId: "o3-mini",
          background: false,
        },
        {
          clientFactory: (apiKey, options) => {
            captured.push({
              apiKey,
              azure: options?.azure,
              resolvedModelId: options?.resolvedModelId,
            });
            return client;
          },
          log: (message: string) => logs.push(message),
          write: () => true,
        },
      );
    } finally {
      if (originalAzureKey === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = originalAzureKey;
      }
    }

    expect(captured).toEqual([
      { apiKey: "az-test", azure: azureOptions, resolvedModelId: "my-o3" },
    ]);
    expect(client.lastRequest?.model).toBe("my-o3");
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: my-o3 | key: AZURE_OPENAI_API_KEY|OPENAI_API_KEY",
    );
  });

  test("rejects explicit Azure provider mode for known non-OpenAI models", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Claude should not run through Azure OpenAI",
          model: "claude-4.6-sonnet",
          provider: "azure",
          azure: { endpoint: "https://my-azure.com/", deployment: "my-claude" },
          background: false,
        },
        {
          apiKey: "az-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/Azure OpenAI provider cannot run claude-4\.6-sonnet/);
    expect(client.lastRequest).toBeNull();
  });

  test("rejects explicit Azure provider mode for native-looking custom model ids", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Custom Gemini should not run through Azure OpenAI",
          model: "gemini-3-pro-preview",
          provider: "azure",
          azure: { endpoint: "https://my-azure.com/", deployment: "my-gemini" },
          background: false,
        },
        {
          apiKey: "az-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/Azure OpenAI provider cannot run gemini-3-pro-preview/);
    expect(client.lastRequest).toBeNull();
  });

  test("rejects explicit Azure provider mode for provider-qualified non-OpenAI ids", async () => {
    const client = new MockClient(new MockStream([], buildResponse()));
    await expect(
      runOracle(
        {
          prompt: "Provider-qualified Gemini should not run through Azure OpenAI",
          model: "google/gemini-3-pro-preview",
          provider: "azure",
          azure: { endpoint: "https://my-azure.com/", deployment: "my-gemini" },
          background: false,
        },
        {
          apiKey: "az-test",
          clientFactory: () => client,
          log: () => {},
          write: () => true,
        },
      ),
    ).rejects.toThrow(/Azure OpenAI provider cannot run google\/gemini-3-pro-preview/);
    expect(client.lastRequest).toBeNull();
  });

  test("allows Azure without deployment when the implicit deployment is gpt-5.5-pro", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Azure implicit deployment",
        model: "gpt-5.5-pro",
        azure: { endpoint: "https://my-azure.com/" },
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (message: string) => logs.push(message),
        write: () => true,
      },
    );
    expect(client.lastRequest?.model).toBe("gpt-5.5-pro");
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: gpt-5.5-pro | key: apiKey option",
    );
  });

  test("fails early when Azure endpoint is set without a deployment", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await expect(
      runOracle(
        {
          prompt: "Azure missing deployment",
          model: "gpt-5.1",
          azure: { endpoint: "https://my-azure.com/" },
          background: false,
        },
        {
          apiKey: "sk-test",
          client,
          log: (message: string) => logs.push(message),
          write: () => true,
        },
      ),
    ).rejects.toThrow(
      /Azure mode requires --azure-deployment unless your deployment is literally gpt-5\.5-pro/,
    );
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: none | key: apiKey option",
    );
  });

  test("fails early for custom Azure model ids without a deployment", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await expect(
      runOracle(
        {
          prompt: "Azure custom missing deployment",
          model: "o3-mini",
          azure: { endpoint: "https://my-azure.com/" },
          background: false,
        },
        {
          apiKey: "sk-test",
          client,
          log: (message: string) => logs.push(message),
          write: () => true,
        },
      ),
    ).rejects.toThrow(
      /Azure mode requires --azure-deployment unless your deployment is literally gpt-5\.5-pro/,
    );
    expect(client.lastRequest).toBeNull();
    expect(logs.join("\n")).toContain(
      "Provider: Azure OpenAI | endpoint: my-azure.com | deployment: none | key: apiKey option",
    );
  });

  test("does not require an Azure deployment for non-OpenAI providers", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Claude with unrelated Azure env",
        model: "claude-4.6-sonnet",
        azure: { endpoint: "https://my-azure.com/" },
        background: false,
      },
      {
        apiKey: "ak-test",
        clientFactory: () => client,
        log: (message: string) => logs.push(message),
        write: () => true,
      },
    );
    expect(logs.join("\n")).toContain(
      "Provider: Anthropic | base: api.anthropic.com | key: ANTHROPIC_API_KEY",
    );
    expect(logs.join("\n")).not.toContain("Provider: Azure OpenAI");
  });

  test("does not pass Azure client config to non-OpenAI OpenAI-compatible routes", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; azure?: unknown; baseUrl?: string }> = [];
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Grok with unrelated Azure env",
        model: "grok-4.1",
        azure: { endpoint: "https://my-azure.com/" },
        background: false,
      },
      {
        apiKey: "xai-test",
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, azure: options?.azure, baseUrl: options?.baseUrl });
          return client;
        },
        log: (message: string) => logs.push(message),
        write: () => true,
      },
    );

    expect(captured).toEqual([
      { apiKey: "xai-test", azure: undefined, baseUrl: "https://api.x.ai/v1" },
    ]);
    expect(logs.join("\n")).toContain("Provider: xAI | base: api.x.ai/v1 | key: XAI_API_KEY");
    expect(logs.join("\n")).not.toContain("Provider: Azure OpenAI");
  });

  test("uses grok search tool shape", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: "Search capability",
        model: "grok-4.1",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.tools).toEqual([{ type: "web_search" }]);
    expect(client.lastRequest?.background).toBeUndefined();
  });

  test("forces foreground for models without background support (grok)", async () => {
    const stream = new MockStream([], buildResponse());
    const createSpy = vi.fn();
    const client = new MockClient(stream);
    // Override background create handler to fail if invoked.
    client.responses.create = createSpy.mockImplementation(() => {
      throw new Error("create should not be called for grok");
    });
    await runOracle(
      {
        prompt: "Please run in foreground",
        model: "grok-4.1",
        background: true,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(createSpy).not.toHaveBeenCalled();
  });
});
