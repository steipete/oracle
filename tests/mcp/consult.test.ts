import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { SessionModelRun } from "../../src/sessionStore.js";
import { applyConsultPreset } from "../../src/mcp/consultPresets.ts";
import { consultInputSchema } from "../../src/mcp/types.ts";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  buildConsultBrowserConfig,
  buildConsultDryRunResolved,
  formatConsultDryRunResolved,
  registerConsultTool,
  summarizeArtifactsForConsult,
  summarizeImageArtifactsForConsult,
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

  test("normalizes browser thinking-time aliases for MCP callers", () => {
    expect(
      consultInputSchema.parse({
        prompt: "review this plan",
        files: [],
        browserThinkingTime: "xhigh",
      }),
    ).toMatchObject({
      browserThinkingTime: "heavy",
    });
  });

  test("keeps the registered MCP input schema JSON-schema compatible", () => {
    let inputSchema: z.ZodRawShape | undefined;
    registerConsultTool({
      registerTool: (_name: string, def: unknown) => {
        inputSchema = (def as { inputSchema: z.ZodRawShape }).inputSchema;
      },
      server: {
        sendLoggingMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof registerConsultTool>[0]);

    expect(inputSchema).toBeDefined();
    expect(() => z.toJSONSchema(z.object(inputSchema!))).not.toThrow();
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

  test("surfaces saved image artifacts for agent callers", () => {
    const artifacts = [
      {
        kind: "image",
        path: "/tmp/mockup.png",
        label: "Generated image",
        mimeType: "image/png",
        sizeBytes: 1234,
        sourceUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_abc",
        url: "https://chatgpt.com/backend-api/estuary/content?id=file_abc",
        finalUrl: "https://files.local/mockup.png",
        alt: "generated image",
        width: 1024,
        height: 1024,
        fileId: "file_abc",
      },
      {
        kind: "transcript",
        path: "/tmp/transcript.md",
        label: "Browser transcript",
      },
    ];

    const sessionArtifacts = artifacts as Parameters<typeof summarizeArtifactsForConsult>[0];

    expect(summarizeArtifactsForConsult(sessionArtifacts)).toEqual([
      expect.objectContaining({
        kind: "image",
        path: "/tmp/mockup.png",
        mimeType: "image/png",
      }),
      expect.objectContaining({
        kind: "transcript",
        path: "/tmp/transcript.md",
      }),
    ]);
    const summarizedImages = summarizeImageArtifactsForConsult(sessionArtifacts);
    expect(summarizedImages).toEqual([
      expect.objectContaining({
        kind: "image",
        path: "/tmp/mockup.png",
        width: 1024,
        height: 1024,
        fileId: "file_abc",
      }),
    ]);
    expect(summarizeArtifactsForConsult(sessionArtifacts)?.[0]).not.toHaveProperty("sourceUrl");
    expect(summarizedImages?.[0]).not.toHaveProperty("sourceUrl");
    expect(summarizedImages?.[0]).not.toHaveProperty("url");
    expect(summarizedImages?.[0]).not.toHaveProperty("finalUrl");
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
          thinkingTime: "high" as never,
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

  test("defaults MCP browser consults to manual login on Windows", () => {
    const config = buildConsultBrowserConfig({
      userConfig: {},
      env: {},
      runModel: "gpt-5.5-pro",
      inputModel: "gpt-5.5-pro",
    });

    expect(config.manualLogin).toBe(process.platform === "win32");
    expect(config.cookieSync).toBe(process.platform !== "win32");
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
        browserBundleFormat: "zip",
        browserFollowUps: ["challenge", "final"],
        generateImage: "/tmp/oracle-image.png",
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
        bundleFormat: "zip",
        profileDir: "/tmp/oracle-profile",
        imageOutputPath: "/tmp/oracle-image.png",
      },
    });
    expect(resolved.guidance.join("\n")).toContain("signed-in ChatGPT profile");
    expect(resolved.guidance.join("\n")).toContain("private Chrome profile");
    expect(resolved.guidance.join("\n")).toContain("--browser-keep-browser");
    expect(resolved.guidance.join("\n")).toContain("image-aware wait/download");
    expect(formatConsultDryRunResolved(resolved).join("\n")).toContain(
      "browser thinking time: extended",
    );
    expect(formatConsultDryRunResolved(resolved).join("\n")).toContain(
      "browser bundle format: zip",
    );
    expect(formatConsultDryRunResolved(resolved).join("\n")).toContain(
      "image output: /tmp/oracle-image.png",
    );
  });

  test("returns resolved dry-run details from the registered MCP consult tool", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    const imagePath = path.join(home, "generated", "from-mcp.png");
    try {
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
        generateImage: imagePath,
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
            desiredModel: "Pro",
            thinkingTime: "extended",
            modelStrategy: "select",
            imageOutputPath: path.join(realpathSync(home), "generated", "from-mcp.png"),
          }),
        },
      });
      expect(result.content[0]?.text).toContain("[dry-run] MCP resolved request:");
    } finally {
      setOracleHomeDirOverrideForTest(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an MCP consult image path outside the generated output directory", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
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
        generateImage: "/tmp/from-mcp.png",
      })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/generated output directory/);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails closed for image output over a remote browser service", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    const prevHost = process.env.ORACLE_REMOTE_HOST;
    const prevToken = process.env.ORACLE_REMOTE_TOKEN;
    process.env.ORACLE_REMOTE_HOST = "remote.example:8080";
    process.env.ORACLE_REMOTE_TOKEN = "remote-token";
    try {
      const handlers: Array<(input: unknown) => Promise<unknown>> = [];
      registerConsultTool({
        registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
          handlers.push(fn);
        },
        server: { sendLoggingMessage: async () => undefined },
      } as unknown as Parameters<typeof registerConsultTool>[0]);
      const handler = handlers[0];
      if (!handler) throw new Error("handler not registered");

      const result = (await handler({
        dryRun: true,
        engine: "browser",
        model: "gpt-5.5",
        prompt: "make an image",
        files: [],
        // Path under the Oracle home so containment passes and we reach the
        // remote guard rather than the path check.
        generateImage: path.join(home, "generated", "img.png"),
      })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(
        /image output is not supported with a remote browser/i,
      );
    } finally {
      if (prevHost === undefined) delete process.env.ORACLE_REMOTE_HOST;
      else process.env.ORACLE_REMOTE_HOST = prevHost;
      if (prevToken === undefined) delete process.env.ORACLE_REMOTE_TOKEN;
      else process.env.ORACLE_REMOTE_TOKEN = prevToken;
      setOracleHomeDirOverrideForTest(null);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects image output when consult resolves to the API engine", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const handlers: Array<(input: unknown) => Promise<unknown>> = [];
      registerConsultTool({
        registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
          handlers.push(fn);
        },
        server: { sendLoggingMessage: async () => undefined },
      } as unknown as Parameters<typeof registerConsultTool>[0]);
      const handler = handlers[0];
      if (!handler) throw new Error("handler not registered");

      const result = (await handler({
        dryRun: true,
        engine: "api",
        model: "gpt-5.5",
        prompt: "make an image",
        files: [],
        generateImage: path.join(home, "generated", "img.png"),
      })) as { isError?: boolean; content: Array<{ type: "text"; text: string }> };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/requires engine:"browser"/);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      rmSync(home, { recursive: true, force: true });
    }
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
