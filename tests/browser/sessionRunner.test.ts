import { describe, expect, test, vi } from "vitest";
import type { RunOracleOptions } from "../../src/oracle.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";
import {
  buildBrowserRunWarningsForTest,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.js";

const baseRunOptions: RunOracleOptions = {
  prompt: "Hello world",
  model: "gpt-5.2-pro",
  file: [],
  silent: false,
};

const baseConfig: BrowserSessionConfig = {};

describe("runBrowserSessionExecution", () => {
  test("logs stats and returns usage/runtime", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.({
        chromePort: 9999,
        chromeHost: "127.0.0.1",
        chromeTargetId: "t-1",
        tabUrl: "https://chatgpt.com/c/foo",
        conversationId: "foo",
      });
      return {
        answerText: "ok",
        answerMarkdown: "ok",
        artifacts: [{ kind: "transcript" as const, path: "/tmp/transcript.md" }],
        tookMs: 1000,
        answerTokens: 12,
        answerChars: 20,
        conversationId: "foo",
      };
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );
    expect(result.usage).toEqual({
      inputTokens: 42,
      outputTokens: 12,
      reasoningTokens: 0,
      totalTokens: 54,
    });
    expect(result.runtime).toMatchObject({ chromePid: undefined, conversationId: "foo" });
    expect(result.artifacts).toEqual([{ kind: "transcript", path: "/tmp/transcript.md" }]);
    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({ chromePort: 9999, chromeHost: "127.0.0.1", chromeTargetId: "t-1" }),
    );
    expect(log).toHaveBeenCalled();
  });

  test("logs and returns browser model selection evidence", async () => {
    const log = vi.fn();
    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: { desiredModel: "GPT-5.5 Pro", modelStrategy: "select" },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 42,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: vi.fn(async () => ({
          answerText: "ok",
          answerMarkdown: "ok",
          tookMs: 1000,
          answerTokens: 12,
          answerChars: 20,
          modelSelection: {
            requestedModel: "GPT-5.5 Pro",
            resolvedLabel: "Pro",
            strategy: "select" as const,
            status: "already-selected" as const,
            verified: true,
            source: "chatgpt-model-picker" as const,
            capturedAt: "2026-05-13T00:00:00.000Z",
          },
        })),
      },
    );

    expect(result.modelSelection).toMatchObject({
      requestedModel: "GPT-5.5 Pro",
      resolvedLabel: "Pro",
      verified: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("[browser] Model selection evidence: requested=GPT-5.5 Pro"),
    );
  });

  test("warns when a large browser Pro run finishes suspiciously quickly", () => {
    const warnings = buildBrowserRunWarningsForTest({
      runOptions: { ...baseRunOptions, model: "gpt-5.5-pro" },
      browserConfig: { desiredModel: "GPT-5.5 Pro" },
      inputTokens: 42_641,
      elapsedMs: 53_000,
      modelSelection: {
        requestedModel: "GPT-5.5 Pro",
        resolvedLabel: null,
        strategy: "select",
        status: "unavailable",
        verified: false,
        source: "config",
        capturedAt: "2026-05-13T00:00:00.000Z",
      },
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        code: "browser-pro-fast-large-run",
        message: expect.stringContaining("Large browser Pro run completed quickly"),
      }),
    ]);
  });

  test("passes ChatGPT image output paths into the browser runner", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "ok",
      answerMarkdown: "ok",
      artifacts: [{ kind: "transcript" as const, path: "/tmp/transcript.md" }],
      tookMs: 1000,
      answerTokens: 1,
      answerChars: 2,
    }));

    await runBrowserSessionExecution(
      {
        runOptions: {
          ...baseRunOptions,
          sessionId: "image-session",
          generateImage: "/tmp/generated.png",
          outputPath: "/tmp/output.png",
        },
        browserConfig: baseConfig,
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "image-session",
        generateImagePath: "/tmp/generated.png",
        outputPath: "/tmp/output.png",
      }),
    );
  });

  test("passes browser follow-up prompts into the browser runner", async () => {
    const executeBrowser = vi.fn(async () => ({
      answerText: "ok",
      answerMarkdown: "ok",
      tookMs: 1000,
      answerTokens: 1,
      answerChars: 2,
    }));

    await runBrowserSessionExecution(
      {
        runOptions: {
          ...baseRunOptions,
          browserFollowUps: ["challenge the recommendation", "summarize the final decision"],
        },
        browserConfig: baseConfig,
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );

    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        followUpPrompts: ["challenge the recommendation", "summarize the final decision"],
      }),
    );
  });

  test("persists attach-mode runtime metadata from the browser runner", async () => {
    const log = vi.fn();
    const persistRuntimeHint = vi.fn();
    const executeBrowser = vi.fn(async (options) => {
      await options.runtimeHintCb?.({
        browserTransport: "cdp" as const,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      });
      return {
        answerText: "ok",
        answerMarkdown: "ok",
        tookMs: 100,
        answerTokens: 2,
        answerChars: 2,
        browserTransport: "cdp" as const,
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      };
    });

    const result = await runBrowserSessionExecution(
      {
        runOptions: baseRunOptions,
        browserConfig: { attachRunning: true },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
        persistRuntimeHint,
      },
    );

    expect(persistRuntimeHint).toHaveBeenCalledWith(
      expect.objectContaining({
        browserTransport: "cdp",
        chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
        chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
        chromeTargetId: "target-2",
        tabUrl: "https://chatgpt.com/c/attached",
      }),
    );
    expect(result.runtime).toMatchObject({
      browserTransport: "cdp",
      chromeBrowserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      chromeProfileRoot: "/Users/peter/Library/Application Support/Google/Chrome",
      chromeTargetId: "target-2",
      tabUrl: "https://chatgpt.com/c/attached",
    });
  });

  test("suppresses automation noise when not verbose", async () => {
    const log = vi.fn();
    const noisyLogger = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("Prompt textarea ready");
          noisyLogger();
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => /Launching browser mode/.test(String(call[0])))).toBe(
      true,
    );
    expect(log.mock.calls.some((call) => /Prompt textarea ready/.test(String(call[0])))).toBe(
      false,
    );
    expect(noisyLogger).toHaveBeenCalled(); // ensure executeBrowser ran
  });

  test("prints fallback retry logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] Inline prompt too large; retrying with file uploads.");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(
      log.mock.calls.some((call) => String(call[0]).includes("Inline prompt too large; retrying")),
    ).toBe(true);
  });

  test("prints browser thinking heartbeat logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] ChatGPT thinking - 30s elapsed; status=planning");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("ChatGPT thinking"))).toBe(true);
  });

  test("prints browser follow-up progress logs even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] Sending follow-up 1/1");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("Sending follow-up"))).toBe(true);
  });

  test("prints browser archive logs and returns archive metadata", async () => {
    const log = vi.fn();
    const result = await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.("[browser] Archived ChatGPT conversation after saving local artifacts.");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
            archive: {
              mode: "auto" as const,
              attempted: true,
              archived: true,
              conversationUrl: "https://chatgpt.com/c/abc",
            },
          };
        },
      },
    );

    expect(log.mock.calls.some((call) => String(call[0]).includes("Archived ChatGPT"))).toBe(true);
    expect(result.archive).toMatchObject({
      archived: true,
      conversationUrl: "https://chatgpt.com/c/abc",
    });
  });

  test("prints browser control guidance even when not verbose", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async ({ log: automationLog }) => {
          automationLog?.(
            "[browser] Browser control: launch visible Chrome; may focus/control the browser UI.",
          );
          automationLog?.(
            "[browser] Browser guidance: Use --browser-attach-running to reduce desktop disruption.",
          );
          automationLog?.("[browser] Prompt textarea ready");
          return {
            answerText: "text",
            answerMarkdown: "markdown",
            tookMs: 1,
            answerTokens: 1,
            answerChars: 4,
          };
        },
      },
    );

    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser control"))).toBe(true);
    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser guidance"))).toBe(true);
    expect(log.mock.calls.some((call) => String(call[0]).includes("Prompt textarea ready"))).toBe(
      false,
    );
  });

  test("passes fallback submission through to browser runner", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 1,
      answerTokens: 1,
      answerChars: 4,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: {
            composerText: "fallback prompt",
            attachments: [{ path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1 }],
            bundled: null,
          },
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [expect.objectContaining({ path: "/repo/a.txt", displayPath: "a.txt" })],
        },
      }),
    );
  });

  test("respects verbose logging", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: { keepBrowser: true },
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 1,
          attachments: [{ path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1024 }],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "upload",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 10,
          answerTokens: 1,
          answerChars: 5,
        }),
      },
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes("Browser attachments"))).toBe(
      true,
    );
  });

  test("verbose output spells out token labels", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: true },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain("[browser]");
    expect(finishedLine).not.toContain("tok(");
    expect(finishedLine).not.toContain("tokens (");
  });

  test("non-verbose output keeps short token label", async () => {
    const log = vi.fn();
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, verbose: false },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser: async () => ({
          answerText: "text",
          answerMarkdown: "markdown",
          tookMs: 100,
          answerTokens: 5,
          answerChars: 10,
        }),
      },
    );

    const finishedLine = log.mock.calls
      .map((c) => String(c[0]))
      .find((line) => line.includes("↑") && line.includes("↓") && line.includes("Δ"));
    expect(finishedLine).toBeDefined();
    expect(finishedLine).toContain("[browser]");
    expect(finishedLine).not.toContain("tok(");
    expect(finishedLine).not.toContain("tokens (");
  });

  test("passes heartbeat interval through to browser runner", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn(async () => ({
      answerText: "text",
      answerMarkdown: "markdown",
      tookMs: 10,
      answerTokens: 1,
      answerChars: 5,
    }));
    await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, heartbeatIntervalMs: 15_000 },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 5,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(executeBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ heartbeatIntervalMs: 15_000 }),
    );
  });

  test("allows Gemini in browser mode with custom executor", async () => {
    const log = vi.fn();
    const executeBrowser = vi.fn().mockResolvedValue({
      answerText: "gemini response",
      answerMarkdown: "gemini response",
      tookMs: 100,
      answerTokens: 5,
      answerChars: 15,
    });
    const result = await runBrowserSessionExecution(
      {
        runOptions: { ...baseRunOptions, model: "gemini-3-pro" },
        browserConfig: baseConfig,
        cwd: "/repo",
        log,
      },
      {
        assemblePrompt: async () => ({
          markdown: "prompt",
          composerText: "prompt",
          estimatedInputTokens: 1,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
        executeBrowser,
      },
    );
    expect(result.answerText).toBe("gemini response");
    expect(executeBrowser).toHaveBeenCalled();
  });
});
