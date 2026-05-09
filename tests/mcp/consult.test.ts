import { describe, expect, test } from "vitest";
import type { SessionModelRun } from "../../src/sessionStore.js";
import { applyConsultPreset } from "../../src/mcp/consultPresets.ts";
import {
  buildConsultBrowserConfig,
  buildConsultDryRunResolved,
  formatConsultDryRunResolved,
  registerConsultTool,
  summarizeModelRunsForConsult,
} from "../../src/mcp/tools/consult.ts";

describe("summarizeModelRunsForConsult", () => {
  test("applies the ChatGPT Pro Heavy consult preset as overridable defaults", () => {
    expect(
      applyConsultPreset({
        preset: "chatgpt-pro-heavy",
        prompt: "review this plan",
        files: [],
      }),
    ).toMatchObject({
      engine: "browser",
      model: "gpt-5.5-pro",
      browserThinkingTime: "extended",
    });

    expect(
      applyConsultPreset({
        preset: "chatgpt-pro-heavy",
        prompt: "use current picker",
        files: [],
        model: "gpt-5.2",
        browserThinkingTime: "extended",
      }),
    ).toMatchObject({
      engine: "browser",
      model: "gpt-5.2",
      browserThinkingTime: "extended",
    });
  });

  test("rejects the ChatGPT Pro Heavy preset with multi-model fan-out", () => {
    expect(() =>
      applyConsultPreset({
        preset: "chatgpt-pro-heavy",
        prompt: "review this plan",
        files: [],
        models: ["gpt-5.1", "gpt-5.2"],
      }),
    ).toThrow(/cannot be combined with models/i);
  });

  test("maps per-model metadata into consult summaries", () => {
    const runs: SessionModelRun[] = [
      {
        model: "gpt-5.2-pro",
        status: "completed",
        startedAt: "2025-11-19T00:00:00Z",
        completedAt: "2025-11-19T00:00:30Z",
        usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0, totalTokens: 1200 },
        response: { id: "resp_123", requestId: "req_456", status: "completed" },
        log: { path: "models/gpt-5.2-pro.log" },
      },
    ];
    const result = summarizeModelRunsForConsult(runs);
    expect(result).toEqual([
      expect.objectContaining({
        model: "gpt-5.2-pro",
        status: "completed",
        usage: expect.objectContaining({ totalTokens: 1200 }),
        response: expect.objectContaining({ id: "resp_123" }),
        logPath: "models/gpt-5.2-pro.log",
      }),
    ]);
  });

  test("returns undefined for empty lists", () => {
    expect(summarizeModelRunsForConsult([])).toBeUndefined();
    expect(summarizeModelRunsForConsult(undefined)).toBeUndefined();
  });

  test("merges browser defaults from config for consult runs", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
          debugPort: 9224,
          keepBrowser: true,
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
          thinkingTime: "extended",
          researchMode: "deep",
          archiveConversations: "never",
        },
      },
      env: {},
      runModel: "gpt-5.1",
      inputModel: "gpt-5.1",
    });

    expect(config).toMatchObject({
      chatgptUrl: "https://chatgpt.com/g/g-p-foo/project",
      url: "https://chatgpt.com/g/g-p-foo/project",
      debugPort: 9224,
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
      thinkingTime: "extended",
      researchMode: "deep",
      archiveConversations: "never",
      desiredModel: "GPT-5.2",
      cookieSync: false,
    });
  });

  test("lets explicit consult inputs override config defaults", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {
        browser: {
          keepBrowser: false,
          manualLogin: false,
          manualLoginProfileDir: "/tmp/config-profile",
          thinkingTime: "light",
        },
      },
      env: {
        ORACLE_BROWSER_PROFILE_DIR: "/tmp/env-profile",
      },
      runModel: "claude-3.7-sonnet",
      inputModel: "claude-3.7-sonnet",
      browserModelLabel: "Claude Sonnet",
      browserKeepBrowser: true,
      browserThinkingTime: "heavy",
      browserModelStrategy: "current",
      browserResearchMode: "deep",
      browserArchive: "always",
    });

    expect(config).toMatchObject({
      keepBrowser: true,
      manualLogin: true,
      manualLoginProfileDir: "/tmp/env-profile",
      thinkingTime: "heavy",
      modelStrategy: "current",
      researchMode: "deep",
      archiveConversations: "always",
      desiredModel: "Claude Sonnet",
      cookieSync: false,
    });
  });

  test("summarizes resolved browser dry-runs for agent callers", () => {
    const resolved = buildConsultDryRunResolved({
      resolvedEngine: "browser",
      runOptions: {
        prompt: "review this",
        model: "gpt-5.5-pro",
        file: ["README.md"],
        browserAttachments: "always",
        browserBundleFiles: true,
        browserFollowUps: ["challenge", "final"],
      },
      browserConfig: {
        desiredModel: "GPT-5.5 Pro",
        thinkingTime: "extended",
        modelStrategy: "select",
        researchMode: "off",
        keepBrowser: false,
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        chatgptUrl: "https://chatgpt.com/",
      },
    });

    expect(resolved).toMatchObject({
      resolvedEngine: "browser",
      model: "gpt-5.5-pro",
      files: ["README.md"],
      followUpCount: 2,
      browser: {
        desiredModel: "GPT-5.5 Pro",
        thinkingTime: "extended",
        attachments: "always",
        bundleFiles: true,
        profileDir: "/tmp/oracle-profile",
      },
    });
    expect(resolved.guidance.join("\n")).toContain("signed-in ChatGPT profile");
    expect(formatConsultDryRunResolved(resolved).join("\n")).toContain(
      "browser thinking time: extended",
    );
  });

  test("returns resolved dry-run details from the registered MCP consult tool", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    registerConsultTool({
      registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
        handlers.push(fn);
      },
      server: {
        sendLoggingMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof registerConsultTool>[0]);
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    const result = (await handler({
      dryRun: true,
      engine: "browser",
      model: "gpt-5.5-pro",
      prompt: "review this",
      files: [],
      browserThinkingTime: "extended",
      browserModelStrategy: "select",
    })) as {
      content: Array<{ type: "text"; text: string }>;
      structuredContent: {
        status: string;
        dryRun: boolean;
        resolved: ReturnType<typeof buildConsultDryRunResolved>;
      };
    };

    expect(result.structuredContent).toMatchObject({
      status: "dry-run",
      dryRun: true,
      resolved: {
        resolvedEngine: "browser",
        model: "gpt-5.5-pro",
        browser: expect.objectContaining({
          desiredModel: "GPT-5.5 Pro",
          thinkingTime: "extended",
          modelStrategy: "select",
        }),
      },
    });
    expect(result.content[0]?.text).toContain("[dry-run] MCP resolved request:");
  });

  test("rejects unsupported consult fields instead of silently ignoring them", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    registerConsultTool({
      registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
        handlers.push(fn);
      },
      server: {
        sendLoggingMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof registerConsultTool>[0]);
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    const result = (await handler({
      dryRun: true,
      engine: "browser",
      model: "gpt-5.5-pro",
      prompt: "review this",
      files: [],
      run_in_background: true,
    })) as {
      isError?: boolean;
      content: Array<{ type: "text"; text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("run_in_background");
  });
});
