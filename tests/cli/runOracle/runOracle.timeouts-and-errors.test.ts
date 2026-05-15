import { describe, expect, test } from "vitest";

import {
  OracleTransportError,
  PromptValidationError,
  runOracle,
  type ClientLike,
  type OracleResponse,
} from "@src/oracle.ts";
import { MockBackgroundClient, MockClient, MockStream, buildResponse } from "./helpers.ts";

describe("timeouts", () => {
  test("non-pro run respects short timeout override", async () => {
    const nowRef = { t: 0 };
    const wait = async (ms: number) => {
      nowRef.t += ms;
    };
    const client: ClientLike = {
      responses: {
        async stream() {
          return new MockStream([], buildResponse());
        },
        async create() {
          return { id: "bg-1", status: "in_progress", output: [] } as OracleResponse;
        },
        async retrieve() {
          return { id: "bg-1", status: "in_progress", output: [] } as OracleResponse;
        },
      },
    };

    await expect(
      runOracle(
        { prompt: "hi", model: "gpt-5.1", background: true, timeoutSeconds: 1 },
        { client, log: () => {}, write: () => true, wait, now: () => nowRef.t },
      ),
    ).rejects.toBeInstanceOf(OracleTransportError);
  });

  test("gpt-5.2-pro auto timeout allows long background runs", async () => {
    const finalResponse = buildResponse({ status: "completed" });
    const initialResponse = { ...finalResponse, status: "in_progress", output: [] };
    const client = new MockBackgroundClient([initialResponse, finalResponse]);
    const nowRef = { t: 0 };
    const wait = async (ms: number) => {
      nowRef.t += ms;
    };

    await runOracle(
      { prompt: "hi", model: "gpt-5.2-pro", background: true },
      { client, log: () => {}, write: () => true, wait, now: () => nowRef.t },
    );
  });

  test("derives HTTP timeout from explicit overall timeout", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ httpTimeoutMs?: number }> = [];

    await runOracle(
      {
        prompt: "Timeout route check",
        model: "gpt-5.1",
        background: false,
        timeoutSeconds: 600,
      },
      {
        apiKey: "sk-test",
        clientFactory: (_apiKey, options) => {
          captured.push({ httpTimeoutMs: options?.httpTimeoutMs });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );

    expect(captured).toEqual([{ httpTimeoutMs: 600_000 }]);
  });

  test("keeps explicit shorter HTTP timeout and logs the precedence", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ httpTimeoutMs?: number }> = [];
    const logs: string[] = [];

    await runOracle(
      {
        prompt: "Timeout route check",
        model: "gpt-5.1",
        background: false,
        timeoutSeconds: 600,
        httpTimeoutMs: 30_000,
      },
      {
        apiKey: "sk-test",
        clientFactory: (_apiKey, options) => {
          captured.push({ httpTimeoutMs: options?.httpTimeoutMs });
          return client;
        },
        log: (line) => logs.push(line),
        write: () => true,
      },
    );

    expect(captured).toEqual([{ httpTimeoutMs: 30_000 }]);
    expect(logs.join("\n")).toContain("transport can fail before overall timeout");
  });
});

describe("runOracle preview mode", () => {
  test("returns preview metadata instead of executing", async () => {
    const result = await runOracle(
      {
        prompt: "Preview only prompt that is definitely long enough.",
        model: "gpt-5.1",
        previewMode: "summary",
      },
      {
        apiKey: "sk-test",
        log: () => {},
        write: () => true,
      },
    );
    expect(result.mode).toBe("preview");
    if (result.mode === "preview") {
      expect(result.estimatedInputTokens).toBeGreaterThan(0);
      expect(result.requestBody.model).toContain("gpt-5.1");
    }
  });
});

describe("runOracle error handling", () => {
  test("surfaces prompt validation errors for short pro prompts", async () => {
    const original = process.env.ORACLE_MIN_PROMPT_CHARS;
    process.env.ORACLE_MIN_PROMPT_CHARS = "20";
    try {
      await expect(
        runOracle(
          { prompt: "too short", model: "gpt-5.2-pro" },
          { apiKey: "sk-test", log: () => {}, write: () => true },
        ),
      ).rejects.toBeInstanceOf(PromptValidationError);
    } finally {
      if (original === undefined) {
        delete process.env.ORACLE_MIN_PROMPT_CHARS;
      } else {
        process.env.ORACLE_MIN_PROMPT_CHARS = original;
      }
    }
  });

  test("propagates background session polling errors", async () => {
    const responses = [
      buildResponse({ status: "in_progress" }),
      buildResponse({ status: "in_progress" }),
      buildResponse({ status: "completed" }),
    ];
    const client = new MockBackgroundClient(responses);
    const logLines: string[] = [];

    client.triggerConnectionDrop();

    const result = await runOracle(
      { prompt: "background", model: "gpt-5-pro", background: true },
      {
        apiKey: "sk-test",
        client,
        log: (line) => logLines.push(line),
        write: () => true,
        wait: async () => {},
      },
    );
    expect(result.mode).toBe("live");
    expect(
      logLines.some(
        (line) =>
          line.includes("Retrying") ||
          line.includes("background response status") ||
          line.includes("Reconnected"),
      ),
    ).toBe(true);
  }, 2000);

  test("logs short-prompt guidance when prompt is brief", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "short",
        model: "gpt-5.2-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg) => logs.push(msg),
        write: () => true,
      },
    );
    expect(logs.some((line) => line.includes("brief prompts often yield generic answers"))).toBe(
      true,
    );
  });
});
