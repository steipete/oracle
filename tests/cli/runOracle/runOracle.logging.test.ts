import { describe, expect, test } from "vitest";

import { runOracle, type ClientLike, type OracleResponse } from "@src/oracle.ts";
import { MockClient, MockStream, buildResponse, type MockResponse } from "./helpers.ts";

describe("runOracle no-file tip", () => {
  test("logs guidance when no files are attached", async () => {
    const logs: string[] = [];
    const mockStream = new MockStream([], {
      id: "resp-1",
      status: "completed",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 0,
        total_tokens: 15,
      },
      output: [
        {
          type: "message",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    });
    const client = new MockClient(mockStream);
    await runOracle(
      {
        prompt: "hello",
        model: "gpt-5.2-pro",
        search: false,
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join("\n").toLowerCase();
    expect(combined).toContain("no files attached");
    expect(combined).toContain("--file");
  });
});

describe("api key logging", () => {
  test("prints API model suffix + alias note for gpt-5.1-pro", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];

    await runOracle(
      {
        prompt: "Alias header test",
        model: "gpt-5.1-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join("\n");
    expect(combined).toContain("Calling gpt-5.1-pro (API: gpt-5.5-pro)");
    expect(combined).toContain("Resolved model: gpt-5.1-pro → gpt-5.5-pro");
    expect(combined).toContain(
      "Note: `gpt-5.1-pro` is a stable CLI alias; OpenAI API uses `gpt-5.5-pro`",
    );

    const headerIndex = logs.findIndex((line) => line.includes("Calling gpt-5.1-pro"));
    const noteIndex = logs.findIndex((line) => line.includes("stable CLI alias"));
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    expect(noteIndex).toBeGreaterThan(headerIndex);
  });

  test("suppresses alias note when suppressHeader is enabled", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];

    await runOracle(
      {
        prompt: "Alias header test (suppressed)",
        model: "gpt-5.1-pro",
        background: false,
        suppressHeader: true,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join("\n");
    expect(combined).not.toContain("Calling gpt-5.1-pro");
    expect(combined).not.toContain("stable CLI alias");
  });

  test("logs masked OPENAI_API_KEY in verbose mode", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Key log test",
        model: "gpt-5.2-pro",
        background: false,
        verbose: true,
      },
      {
        apiKey: "sk-supersecret-key-1234",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join("\n");
    expect(combined).toContain("Using apiKey option=sk-s****1234");
    expect(combined).not.toContain("supersecret");
  });

  test("adds API suffix to verbose key log when model is an alias", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];

    await runOracle(
      {
        prompt: "Alias verbose key log test",
        model: "gpt-5.1-pro",
        background: false,
        verbose: true,
      },
      {
        apiKey: "sk-supersecret-key-1234",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join("\n");
    expect(combined).toContain(
      "Using apiKey option=sk-s****1234 for model gpt-5.1-pro (API: gpt-5.5-pro)",
    );
    expect(combined).not.toContain("supersecret");
  });

  test("logs masked GEMINI_API_KEY when using gemini model in verbose mode", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Key log test Gemini",
        model: "gemini-3-pro",
        background: false,
        verbose: true,
      },
      {
        apiKey: "sk-gemini-secret-9999",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const combined = logs.join("\n");
    expect(combined).toContain("Using GEMINI_API_KEY=sk-g****9999 for model gemini-3-pro");
    expect(combined).not.toContain("gemini-secret");
  });

  test("throws when OPENAI_API_KEY is missing for API engine", async () => {
    const originalOpenai = process.env.OPENAI_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(
        runOracle(
          {
            prompt: "Needs key",
            model: "gpt-5.2-pro",
            background: false,
          },
          {
            log: () => {},
            write: () => true,
          },
        ),
      ).rejects.toThrow(
        /Missing OPENAI_API_KEY.*retry with --engine browser.*preset:"chatgpt-pro-heavy"|Missing OPENROUTER_API_KEY|valid model ID/s,
      );
    } finally {
      if (originalOpenai !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenai;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (originalOpenRouter !== undefined) {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    }
  });

  test("throws when GEMINI_API_KEY is missing for gemini API engine", async () => {
    const originalGemini = process.env.GEMINI_API_KEY;
    const originalOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(
        runOracle(
          {
            prompt: "Needs gemini key",
            model: "gemini-3-pro",
            background: false,
          },
          {
            log: () => {},
            write: () => true,
          },
        ),
      ).rejects.toThrow(/Missing GEMINI_API_KEY|API key not valid/);
    } finally {
      if (originalGemini !== undefined) {
        process.env.GEMINI_API_KEY = originalGemini;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
      if (originalOpenRouter !== undefined) {
        process.env.OPENROUTER_API_KEY = originalOpenRouter;
      } else {
        delete process.env.OPENROUTER_API_KEY;
      }
    }
  });

  test("single-line summary includes session id when provided", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      { prompt: "Summarize", model: "gpt-5.2-pro", sessionId: "abc123", background: false },
      {
        apiKey: "sk-test",
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    const finished = logs.find((line) => line.includes("sid=abc123"));
    expect(finished).toBeDefined();
    expect(finished).toContain("abc123");
    expect(logs.filter((line) => line.includes("sid=abc123")).length).toBe(1);
  });

  test("verbose logs insert separation before answer stream", async () => {
    const stream = new MockStream(
      [
        { type: "response.output_text.delta", delta: "Yo" },
        { type: "response.output_text.delta", delta: " bro." },
      ],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const logs: string[] = [];
    const writes: string[] = [];
    await runOracle(
      { prompt: "hi", model: "gpt-5.2-pro", verbose: true, background: false },
      {
        apiKey: "sk-test-1234",
        client,
        log: (msg) => logs.push(msg),
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
    );
    const answerLineIndex = logs.findIndex((line) => line.trim() === "Answer:");
    expect(answerLineIndex).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes("[verbose] Dispatching request to API..."))).toBe(
      true,
    );
    expect(logs[answerLineIndex - 1]).toBe("");
    expect(writes.join("")).toContain("Yo bro.");
  });

  test("shows cancel hint only for verbose or pro models", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      { prompt: "hi", model: "gpt-5.1", background: false },
      {
        apiKey: "sk-test",
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    expect(logs.some((line) => line.includes("Press Ctrl+C"))).toBe(false);

    logs.length = 0;
    await runOracle(
      { prompt: "hi", model: "gpt-5.2-pro", background: false },
      {
        apiKey: "sk-test",
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    expect(logs.some((line) => line.includes("Press Ctrl+C"))).toBe(true);

    logs.length = 0;
    await runOracle(
      { prompt: "hi", model: "gpt-5.1", verbose: true, background: false },
      {
        apiKey: "sk-test",
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    expect(logs.some((line) => line.includes("Press Ctrl+C"))).toBe(true);
  });

  test("suppresses the answer label when requested", async () => {
    const stream = new MockStream(
      [{ type: "response.output_text.delta", delta: "Hello world" }],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const logs: string[] = [];
    const writes: string[] = [];
    await runOracle(
      { prompt: "hi", model: "gpt-5.2-pro", suppressAnswerHeader: true, background: false },
      {
        apiKey: "sk-test-1234",
        client,
        log: (msg) => logs.push(msg),
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
    );

    expect(logs.some((line) => line.trim() === "Answer:")).toBe(false);
    expect(writes.join("")).toContain("Hello world");
  });

  test("non-streamed answers keep their first character", async () => {
    const stream = new MockStream(
      [],
      buildResponse({
        output: [
          {
            type: "message",
            content: [{ type: "text", text: "Happy to help" }],
          },
        ],
      }),
    );
    const client = new MockClient(stream);
    const writes: string[] = [];

    await runOracle(
      { prompt: "hi", model: "gpt-5.2-pro", background: false },
      {
        apiKey: "sk-test-1234",
        client,
        log: () => {},
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
    );

    const combined = writes.join("");
    expect(combined.startsWith("Happy to help")).toBe(true);
  });

  test("streamed answers get a newline before verbose footer", async () => {
    const stream = new MockStream(
      [{ type: "response.output_text.delta", delta: "Yo bro." }],
      buildResponse(),
    );
    const client = new MockClient(stream);
    const logs: string[] = [];
    const writes: string[] = [];
    await runOracle(
      { prompt: "Greeting", model: "gpt-5.2-pro", verbose: true, background: false },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: (chunk) => {
          writes.push(chunk);
          return true;
        },
      },
    );

    const verboseIndex = logs.findIndex((line) => line.includes("Response status:"));
    expect(verboseIndex).toBeGreaterThan(0);
    expect(logs[verboseIndex - 1]).toBe("");
    expect(writes.join("")).toContain("Yo bro.");
  });

  test("verbose run spells out token labels", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Verbose tokens",
        model: "gpt-5.2-pro",
        background: false,
        verbose: true,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const finished = logs.find(
      (line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"),
    );
    expect(finished).toBeDefined();
    expect(finished).not.toContain("tok(");
    expect(finished).not.toContain("tokens (");
    expect(logs.some((line) => line.includes("est→actual="))).toBe(true);
  });

  test("non-verbose run keeps short token label", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Short tokens",
        model: "gpt-5.2-pro",
        background: false,
        verbose: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const finished = logs.find(
      (line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"),
    );
    expect(finished).toBeDefined();
    expect(finished).not.toContain("tok(");
    expect(finished).not.toContain("tokens (");
    expect(logs.some((line) => line.includes("est→actual="))).toBe(false);
  });

  test("verbose footer separation still clean for non-streamed output", async () => {
    const client: ClientLike = {
      responses: {
        stream: async () =>
          new MockStream([], {
            id: "resp-id",
            status: "completed",
            usage: { input_tokens: 5, output_tokens: 0, reasoning_tokens: 0, total_tokens: 5 },
            output: [
              {
                type: "message",
                content: [{ type: "text", text: "Hello world" }],
              },
            ],
          }),
        async create() {
          return {
            id: "resp-id",
            status: "completed",
            output: [{ type: "message", content: [{ type: "text", text: "Hello world" }] }],
          } as OracleResponse;
        },
        async retrieve() {
          return {
            id: "resp-id",
            status: "completed",
            output: [{ type: "message", content: [{ type: "text", text: "Hello world" }] }],
          } as OracleResponse;
        },
      },
    } as ClientLike;
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Greeting",
        model: "gpt-5.2-pro",
        background: false,
        verbose: true,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    const statusIndex = logs.findIndex((line) => line.includes("Response status:"));
    expect(statusIndex).toBeGreaterThan(0);
    expect(logs[statusIndex - 1]).toBe("");
  });
});

describe("runOracle usage summary", () => {
  test("reads Responses API reasoning tokens from output_tokens_details", async () => {
    const response: OracleResponse = {
      id: "resp-reasoning",
      status: "completed",
      usage: {
        input_tokens: 12000,
        output_tokens: 800,
        output_tokens_details: { reasoning_tokens: 700 },
        total_tokens: 12800,
      },
      output: [{ type: "message", content: [{ type: "text", text: "ok" }] }],
    };
    const client = new MockClient(new MockStream([], response as MockResponse));
    const logs: string[] = [];

    const result = await runOracle(
      { prompt: "usage check", model: "gpt-5.1", background: false },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
        write: () => true,
      },
    );

    expect(result).toMatchObject({
      mode: "live",
      usage: { inputTokens: 12000, outputTokens: 800, reasoningTokens: 700, totalTokens: 12800 },
    });
    // output_tokens already includes reasoning: 12000 * 1.25e-6 + 800 * 10e-6
    expect(logs.join("\n")).toContain("$0.0230");
  });

  test("bills xAI reasoning tokens as output", async () => {
    // Usage example from the xAI Responses API reference: 32 + 9 + 110 = 151.
    const response: OracleResponse = {
      id: "resp-xai",
      status: "completed",
      usage: {
        input_tokens: 32,
        output_tokens: 9,
        output_tokens_details: { reasoning_tokens: 110 },
        total_tokens: 151,
      },
      output: [{ type: "message", content: [{ type: "text", text: "ok" }] }],
    };
    const client = new MockClient(new MockStream([], response as MockResponse));

    const result = await runOracle(
      { prompt: "usage check", model: "grok-4.1", background: false },
      { apiKey: "xai-test", client, log: () => {}, write: () => true },
    );

    // 32 * 0.2e-6 + (9 + 110) * 0.5e-6
    expect(result).toMatchObject({
      mode: "live",
      usage: {
        inputTokens: 32,
        outputTokens: 119,
        reasoningTokens: 110,
        totalTokens: 151,
        cost: expect.closeTo(0.0000659, 10),
      },
    });
  });

  test("bills xAI reasoning tokens as output when a gateway forwards xAI usage unchanged", async () => {
    // 32 + 9 + 94 = 135: reasoning sits outside output_tokens, as on the native API.
    const response: OracleResponse = {
      id: "resp-xai-gateway",
      status: "completed",
      usage: { input_tokens: 32, output_tokens: 9, reasoning_tokens: 94, total_tokens: 135 },
      output: [{ type: "message", content: [{ type: "text", text: "ok" }] }],
    };
    const client = new MockClient(new MockStream([], response as MockResponse));

    const result = await runOracle(
      {
        prompt: "usage check",
        model: "grok-4.1",
        baseUrl: "https://litellm.test/v1",
        background: false,
      },
      { apiKey: "xai-test", client, log: () => {}, write: () => true },
    );

    // 32 * 0.2e-6 + (9 + 94) * 0.5e-6
    expect(result).toMatchObject({
      mode: "live",
      usage: {
        inputTokens: 32,
        outputTokens: 103,
        reasoningTokens: 94,
        totalTokens: 135,
        cost: expect.closeTo(0.0000579, 10),
      },
    });
  });

  test("does not add xAI reasoning again when a gateway already counts it as output", async () => {
    // 32 + 119 = 151: the gateway already folded the 110 reasoning tokens into output_tokens.
    const response: OracleResponse = {
      id: "resp-xai-normalized",
      status: "completed",
      usage: { input_tokens: 32, output_tokens: 119, reasoning_tokens: 110, total_tokens: 151 },
      output: [{ type: "message", content: [{ type: "text", text: "ok" }] }],
    };
    const client = new MockClient(new MockStream([], response as MockResponse));

    const result = await runOracle(
      {
        prompt: "usage check",
        model: "grok-4.1",
        baseUrl: "https://litellm.test/v1",
        background: false,
      },
      { apiKey: "xai-test", client, log: () => {}, write: () => true },
    );

    expect(result).toMatchObject({
      mode: "live",
      usage: { inputTokens: 32, outputTokens: 119, reasoningTokens: 110, totalTokens: 151 },
    });
  });

  test("adds reasoning to output only for xAI models", async () => {
    // The xAI usage shape on an OpenAI model: OpenAI already counts reasoning in output_tokens.
    const response: OracleResponse = {
      id: "resp-openai-xai-shape",
      status: "completed",
      usage: {
        input_tokens: 32,
        output_tokens: 9,
        output_tokens_details: { reasoning_tokens: 110 },
        total_tokens: 151,
      },
      output: [{ type: "message", content: [{ type: "text", text: "ok" }] }],
    };
    const client = new MockClient(new MockStream([], response as MockResponse));

    const result = await runOracle(
      { prompt: "usage check", model: "gpt-5.1", background: false },
      { apiKey: "sk-test", client, log: () => {}, write: () => true },
    );

    expect(result).toMatchObject({
      mode: "live",
      usage: { inputTokens: 32, outputTokens: 9, reasoningTokens: 110, totalTokens: 151 },
    });
  });

  test("falls back to input plus output when total_tokens is missing", async () => {
    const response: OracleResponse = {
      id: "resp-no-total",
      status: "completed",
      usage: {
        input_tokens: 12000,
        output_tokens: 800,
        output_tokens_details: { reasoning_tokens: 700 },
      },
      output: [{ type: "message", content: [{ type: "text", text: "ok" }] }],
    };
    const client = new MockClient(new MockStream([], response as MockResponse));

    const result = await runOracle(
      { prompt: "usage check", model: "gpt-5.1", background: false },
      { apiKey: "sk-test", client, log: () => {}, write: () => true },
    );

    expect(result).toMatchObject({
      mode: "live",
      usage: { inputTokens: 12000, outputTokens: 800, reasoningTokens: 700, totalTokens: 12800 },
    });
  });
});
