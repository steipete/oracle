import { describe, expect, test, vi } from "vitest";
import { DRY_RUN_TIMESTAMP, runDryRunSummary } from "../../src/cli/dryRun.js";
import type { RunOracleOptions } from "../../src/oracle.js";

const baseRunOptions: RunOracleOptions = {
  prompt: "Explain the issue",
  model: "gpt-5.2-pro",
  file: [],
};

describe("runDryRunSummary", () => {
  test("prints API token summary and file stats", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "api",
        runOptions: { ...baseRunOptions, file: ["notes.md"] },
        cwd: "/repo",
        version: "1.2.3",
        log,
      },
      {
        readFilesImpl: async () => [{ path: "/repo/notes.md", content: 'console.log("dry run")' }],
      },
    );
    const header = log.mock.calls.find(([entry]) =>
      String(entry).includes("would call gpt-5.2-pro"),
    );
    expect(header?.[0]).toContain("[dry-run]");
    expect(log.mock.calls.some(([entry]) => String(entry).includes("File Token Usage"))).toBe(true);
  });

  test("prints deterministic API safety plan and stable equal-token file order", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "api",
        runOptions: { ...baseRunOptions, file: ["b.md", "a.md"] },
        cwd: "/repo",
        version: "1.2.3",
        log,
      },
      {
        readFilesImpl: async () => [
          { path: "/repo/b.md", content: "same content" },
          { path: "/repo/a.md", content: "same content" },
        ],
      },
    );

    const joined = log.mock.calls.flat().join("\n");
    expect(joined).toContain(`[dry-run] Generated at: ${DRY_RUN_TIMESTAMP}.`);
    expect(joined).toContain("[dry-run] Route: api/local; model=gpt-5.2-pro.");
    expect(joined).toContain("Live provider/browser action: disabled");
    expect(joined).toContain("Provider/browser locks: not acquired");
    expect(joined).toMatch(/Prompt hash plan: prompt_sha256=sha256:[a-f0-9]{64}/);
    expect(joined).toContain('Recovery command plan: no session is created; live runs print "oracle session <id>"');
    expect(joined.indexOf("a.md")).toBeLessThan(joined.indexOf("b.md"));
  });

  test("prints browser attachment summary", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "browser",
        runOptions: { ...baseRunOptions, file: ["report.txt"] },
        cwd: "/repo",
        version: "2.0.0",
        log,
        browserConfig: {
          cookieSync: true,
          cookieNames: ["__Secure-next-auth.session-token"],
          inlineCookies: null,
          inlineCookiesSource: null,
          chromeProfile: "Default",
          chromePath: null,
          url: "https://chatgpt.com/",
          timeoutMs: 1_200_000,
          inputTimeoutMs: 30_000,
          headless: false,
          keepBrowser: false,
          hideWindow: false,
          desiredModel: null,
          debug: false,
          allowCookieErrors: false,
        },
      },
      {
        assembleBrowserPromptImpl: async () => ({
          markdown: "bundle",
          composerText: "prompt",
          estimatedInputTokens: 77,
          attachments: [{ path: "/repo/report.txt", displayPath: "report.txt", sizeBytes: 2048 }],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "upload",
          fallback: null,
        }),
      },
    );
    const header = log.mock.calls.find(([entry]) =>
      String(entry).includes("would launch browser mode"),
    );
    expect(header?.[0]).toContain("browser mode");
    expect(
      log.mock.calls.some(([entry]) =>
        String(entry).includes("Browser control: launch visible Chrome"),
      ),
    ).toBe(true);
    expect(log.mock.calls.some(([entry]) => String(entry).includes("Attachments to upload"))).toBe(
      true,
    );
    expect(log.mock.calls.some(([entry]) => String(entry).includes("report.txt"))).toBe(true);
    expect(
      log.mock.calls.some(([entry]) => String(entry).includes("Cookies: copy from Chrome")),
    ).toBe(true);
    expect(
      log.mock.calls.some(([entry]) => String(entry).includes("ChatGPT archive policy: auto")),
    ).toBe(true);
  });

  test("sorts browser dry-run attachments and cookie allowlists", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "browser",
        runOptions: { ...baseRunOptions, model: "gpt-5.1" },
        cwd: "/repo",
        version: "3.0.0",
        log,
        browserConfig: {
          cookieSync: true,
          cookieNames: ["z_cookie", "a_cookie"],
          remoteChrome: { host: "chrome.internal", port: 9222 },
        },
      },
      {
        assembleBrowserPromptImpl: async () => ({
          markdown: "bundle",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [
            { path: "/repo/z.txt", displayPath: "z.txt", sizeBytes: 1 },
            { path: "/repo/a.txt", displayPath: "a.txt", sizeBytes: 1 },
          ],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "upload",
          fallback: null,
        }),
      },
    );

    const joined = log.mock.calls.flat().join("\n");
    expect(joined).toContain("Route: browser/remote-chrome chrome.internal:9222");
    expect(joined).toContain("Cookies: copy from Chrome (a_cookie, z_cookie).");
    expect(joined.indexOf("a.txt")).toBeLessThan(joined.indexOf("z.txt"));
  });

  test("emits no ANSI color when NO_COLOR is set", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      const log = vi.fn();
      await runDryRunSummary(
        {
          engine: "api",
          runOptions: baseRunOptions,
          cwd: "/repo",
          version: "1.2.3",
          log,
        },
        { readFilesImpl: async () => [] },
      );
      const joined = log.mock.calls.flat().join("\n");
      expect(joined).not.toMatch(/\x1B\[[0-?]*[ -/]*[@-~]/u);
    } finally {
      if (originalNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = originalNoColor;
      }
    }
  });

  test("prints browser follow-up summary", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "browser",
        runOptions: { ...baseRunOptions, browserFollowUps: ["challenge it", "summarize it"] },
        cwd: "/repo",
        version: "2.0.0",
        log,
        browserConfig: {},
      },
      {
        assembleBrowserPromptImpl: async () => ({
          markdown: "bundle",
          composerText: "prompt",
          estimatedInputTokens: 77,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
      },
    );

    expect(log.mock.calls.some(([entry]) => String(entry).includes("Browser follow-ups: 2"))).toBe(
      true,
    );
    expect(
      log.mock.calls.some(([entry]) => String(entry).includes("Multi-turn is explicit only")),
    ).toBe(true);
  });

  test("rejects browser follow-ups with Deep Research during dry-run", async () => {
    await expect(
      runDryRunSummary(
        {
          engine: "browser",
          runOptions: { ...baseRunOptions, browserFollowUps: ["challenge it"] },
          cwd: "/repo",
          version: "2.0.0",
          log: vi.fn(),
          browserConfig: { researchMode: "deep" },
        },
        {
          assembleBrowserPromptImpl: async () => {
            throw new Error("should not assemble invalid browser follow-up run");
          },
        },
      ),
    ).rejects.toThrow(/follow-ups are not supported with Deep Research/i);
  });

  test("logs inline cookie strategy", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "browser",
        runOptions: { ...baseRunOptions, model: "gpt-5.1" },
        cwd: "/repo",
        version: "3.0.0",
        log,
        browserConfig: {
          cookieSync: true,
          cookieNames: null,
          inlineCookies: [
            { name: "__Secure-next-auth.session-token", value: "token", domain: "chatgpt.com" },
            { name: "_account", value: "personal", domain: "chatgpt.com" },
          ],
          inlineCookiesSource: "inline-file",
          chromeProfile: "Default",
          chromePath: null,
          url: "https://chatgpt.com/",
          timeoutMs: 1_200_000,
          inputTimeoutMs: 30_000,
          headless: false,
          keepBrowser: false,
          hideWindow: false,
          desiredModel: null,
          debug: false,
          allowCookieErrors: false,
        },
      },
      {
        assembleBrowserPromptImpl: async () => ({
          markdown: "bundle",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
      },
    );
    expect(
      log.mock.calls.some(([entry]) => String(entry).includes("Cookies: inline payload")),
    ).toBe(true);
  });

  test("prints calmer browser control guidance for attach-running dry-runs", async () => {
    const log = vi.fn();
    await runDryRunSummary(
      {
        engine: "browser",
        runOptions: { ...baseRunOptions, model: "gpt-5.2" },
        cwd: "/repo",
        version: "3.0.0",
        log,
        browserConfig: {
          attachRunning: true,
        },
      },
      {
        assembleBrowserPromptImpl: async () => ({
          markdown: "bundle",
          composerText: "prompt",
          estimatedInputTokens: 10,
          attachments: [],
          inlineFileCount: 0,
          tokenEstimateIncludesInlineFiles: false,
          attachmentsPolicy: "auto",
          attachmentMode: "inline",
          fallback: null,
        }),
      },
    );

    expect(
      log.mock.calls.some(([entry]) =>
        String(entry).includes(
          "Browser control: attach to an already-running local Chrome session",
        ),
      ),
    ).toBe(true);
    expect(
      log.mock.calls.some(([entry]) =>
        String(entry).includes("leaves the existing browser process alone"),
      ),
    ).toBe(true);
  });
});
