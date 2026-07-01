import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OracleRequestBody } from "../../src/oracle/types.js";

describe("createDefaultClientFactory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ORACLE_CLIENT_FACTORY;
    vi.restoreAllMocks();
  });

  test("falls back to default factory and warns when custom factory export is invalid", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "/nonexistent/path.js";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    expect(typeof factory).toBe("function");
    expect(warn).toHaveBeenCalledOnce();
  });

  test("uses inline test factory hook when requested", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "INLINE_TEST_FACTORY";
    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("key");
    const request: OracleRequestBody = {
      model: "gpt-5.1",
      instructions: "test",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    };
    const response = await client.responses.create(request);
    const streamed = client.responses.stream(request);
    const retrieved = await client.responses.retrieve("inline-test");

    expect(response).toMatchObject({ id: "inline-test", status: "completed" });
    expect(retrieved).toMatchObject({ id: "inline-test" });
    // stream exposes an async iterator and a finalResponse promise.
    expect(typeof (await streamed).finalResponse).toBe("function");
  });

  test("routes gemini models through the Gemini client", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const createGeminiClient = vi.fn((key, model, resolvedModelId) => ({
      client: "gemini",
      key,
      model,
      resolvedModelId,
    }));
    vi.doMock("../../src/oracle/gemini.js", () => ({ createGeminiClient }));

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("abc", { model: "gemini-3-pro", resolvedModelId: "gem-3-pro" });

    expect(createGeminiClient).toHaveBeenCalledWith("abc", "gemini-3-pro", "gem-3-pro");
    expect(client).toMatchObject({ client: "gemini", model: "gemini-3-pro" });
  });

  test("routes gemini custom base URLs through the chat/completions adapter", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const createGeminiClient = vi.fn();
    vi.doMock("../../src/oracle/gemini.js", () => ({ createGeminiClient }));

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("abc", {
      model: "gemini-3-pro",
      resolvedModelId: "gem-3-pro",
      baseUrl: "https://litellm.test/v1",
    });

    expect(createGeminiClient).not.toHaveBeenCalled();
    expect(client.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
  });

  test("routes claude models through the Claude client", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const createClaudeClient = vi.fn((key, model, resolvedModelId, baseUrl) => ({
      client: "claude",
      key,
      model,
      resolvedModelId,
      baseUrl,
    }));
    vi.doMock("../../src/oracle/claude.js", () => ({ createClaudeClient }));

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("xyz", {
      model: "claude-4.6-sonnet",
      resolvedModelId: "claude-sonnet",
      baseUrl: "https://api.anthropic.com/v1/messages",
    });

    expect(createClaudeClient).toHaveBeenCalledWith(
      "xyz",
      "claude-4.6-sonnet",
      "claude-sonnet",
      "https://api.anthropic.com/v1/messages",
    );
    expect(client).toMatchObject({ client: "claude", model: "claude-4.6-sonnet" });
  });

  test("routes claude custom base URLs through the chat/completions adapter", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const createClaudeClient = vi.fn();
    vi.doMock("../../src/oracle/claude.js", () => ({ createClaudeClient }));

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("xyz", {
      model: "claude-4.6-sonnet",
      resolvedModelId: "claude-sonnet",
      baseUrl: "https://litellm.test/v1",
    });

    expect(createClaudeClient).not.toHaveBeenCalled();
    expect(client.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
  });

  test("forwards reasoning effort through the custom-gateway chat/completions adapter", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const captured: Array<Record<string, unknown>> = [];

    class MockOpenAI {
      responses = {
        create: async () => ({ id: "unused", status: "completed" }),
        stream: async () => ({
          [Symbol.asyncIterator]: () => ({
            async next() {
              return { done: true, value: undefined };
            },
          }),
          finalResponse: async () => ({ id: "unused", status: "completed" }),
        }),
        retrieve: async (id: string) => ({ id, status: "completed" }),
      };
      chat = {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params);
            return {
              id: "cmpl-test",
              choices: [{ message: { role: "assistant", content: "42" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              created: 0,
              model: "gateway-model",
              object: "chat.completion",
            };
          },
        },
      };
    }

    vi.doMock("openai", () => ({ __esModule: true, default: MockOpenAI }));

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("key", { model: "gpt-5.5", baseUrl: "https://litellm.test/v1" });

    await client.responses.create({
      model: "gateway-model",
      instructions: "sys",
      input: [{ role: "user", content: [{ type: "input_text", text: "2+2?" }] }],
      reasoning: { effort: "xhigh" },
      max_output_tokens: 64,
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      model: "gateway-model",
      reasoning_effort: "xhigh",
      max_tokens: 64,
      stream: false,
    });
  });

  test("omits reasoning_effort when the request has no reasoning", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const captured: Array<Record<string, unknown>> = [];

    class MockOpenAI {
      responses = {
        create: async () => ({ id: "unused", status: "completed" }),
        stream: async () => ({
          [Symbol.asyncIterator]: () => ({
            async next() {
              return { done: true, value: undefined };
            },
          }),
          finalResponse: async () => ({ id: "unused", status: "completed" }),
        }),
        retrieve: async (id: string) => ({ id, status: "completed" }),
      };
      chat = {
        completions: {
          create: async (params: Record<string, unknown>) => {
            captured.push(params);
            return {
              id: "cmpl-test",
              choices: [{ message: { role: "assistant", content: "ok" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              created: 0,
              model: "m",
              object: "chat.completion",
            };
          },
        },
      };
    }

    vi.doMock("openai", () => ({ __esModule: true, default: MockOpenAI }));

    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();
    const client = factory("key", { model: "gpt-5.1", baseUrl: "https://litellm.test/v1" });

    await client.responses.create({
      model: "gpt-5.1",
      instructions: "sys",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty("reasoning_effort");
  });

  test("creates OpenAI clients for default and Azure paths", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const { createDefaultClientFactory } = await import("../../src/oracle/client.js");
    const factory = createDefaultClientFactory();

    const defaultClient = factory("sk-test", { model: "gpt-5.1" });
    const azureClient = factory("sk-azure", {
      model: "gpt-5.1",
      azure: {
        endpoint: "https://example.azure.com",
        apiVersion: "2025-04-01-preview",
        deployment: "gpt5",
      },
    });

    expect(defaultClient.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
    expect(azureClient.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
  });

  test("uses the OpenAI client with Azure v1 base URLs for responses", async () => {
    process.env.ORACLE_CLIENT_FACTORY = "";
    const openAIArgs: unknown[] = [];
    const azureArgs: unknown[] = [];

    class MockOpenAI {
      responses = {
        create: async () => ({ id: "ok", status: "completed" }),
        stream: async () => ({
          [Symbol.asyncIterator]: () => ({
            async next() {
              return { done: true, value: undefined };
            },
          }),
          finalResponse: async () => ({ id: "ok", status: "completed" }),
        }),
        retrieve: async (id: string) => ({ id, status: "completed" }),
      };

      constructor(options: unknown) {
        openAIArgs.push(options);
      }
    }

    class MockAzureOpenAI {
      constructor(options: unknown) {
        azureArgs.push(options);
      }
    }

    vi.doMock("openai", () => ({
      __esModule: true,
      default: MockOpenAI,
      AzureOpenAI: MockAzureOpenAI,
    }));

    const { buildAzureResponsesBaseUrl, createDefaultClientFactory } =
      await import("../../src/oracle/client.js");
    expect(buildAzureResponsesBaseUrl("https://example.azure.com/")).toBe(
      "https://example.azure.com/openai/v1",
    );

    const factory = createDefaultClientFactory();
    const client = factory("sk-azure", {
      model: "gpt-5.1",
      azure: { endpoint: "https://example.azure.com/", deployment: "gpt5" },
    });

    expect(openAIArgs).toEqual([
      expect.objectContaining({
        apiKey: "sk-azure",
        baseURL: "https://example.azure.com/openai/v1",
      }),
    ]);
    expect(azureArgs).toEqual([]);
    expect(client.responses).toMatchObject({
      create: expect.any(Function),
      stream: expect.any(Function),
      retrieve: expect.any(Function),
    });
  });
});
