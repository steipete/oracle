import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  __test__,
  classifyPreservedBrowserErrorForTest,
  formatBrowserTurnTranscript,
  maybeArchiveCompletedConversationForTest,
  redactBrowserConfigForDebugLogForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runBrowserMode,
  runSubmissionWithRecoveryForTest,
  shouldSkipThinkingTimeSelectionForTest,
  shouldPreferSystemTmpDirForTest,
  shouldPreserveBrowserOnErrorForTest,
} from "../../src/browser/index.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("shouldPreserveBrowserOnErrorForTest", () => {
  test("preserves the browser for headful cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(true);
  });

  test("does not preserve the browser for headless cloudflare challenge errors", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
  });

  test("preserves the browser for headful assistant capture errors", () => {
    const timeout = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });
    const recheck = new BrowserAutomationError("assistant recheck failed", {
      stage: "assistant-recheck",
    });

    expect(shouldPreserveBrowserOnErrorForTest(timeout, false)).toBe(true);
    expect(shouldPreserveBrowserOnErrorForTest(recheck, false)).toBe(true);
    expect(classifyPreservedBrowserErrorForTest(timeout, false)).toBe("reattachable-capture");
    expect(classifyPreservedBrowserErrorForTest(recheck, false)).toBe("reattachable-capture");
  });

  test("does not preserve assistant capture errors in headless mode", () => {
    const error = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
    });

    expect(shouldPreserveBrowserOnErrorForTest(error, true)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, true)).toBeNull();
  });

  test("does not preserve the browser for unrelated browser errors", () => {
    const error = new BrowserAutomationError("other browser error", {
      stage: "execute-browser",
    });
    expect(shouldPreserveBrowserOnErrorForTest(error, false)).toBe(false);
    expect(classifyPreservedBrowserErrorForTest(error, false)).toBeNull();
  });

  test("classifies Cloudflare preservation separately from assistant capture preservation", () => {
    const error = new BrowserAutomationError("Cloudflare challenge detected.", {
      stage: "cloudflare-challenge",
    });

    expect(classifyPreservedBrowserErrorForTest(error, false)).toBe("cloudflare-challenge");
  });
});

describe("shouldSkipThinkingTimeSelectionForTest", () => {
  test("treats GPT-5.5 Pro Extended as resolved by model selection", () => {
    expect(shouldSkipThinkingTimeSelectionForTest("GPT-5.5 Pro", "extended")).toBe(true);
    expect(shouldSkipThinkingTimeSelectionForTest("gpt-5.5-pro", "extended")).toBe(true);
  });

  test("keeps explicit effort selection for non-Pro or non-extended requests", () => {
    expect(shouldSkipThinkingTimeSelectionForTest("gpt-5.5", "heavy")).toBe(false);
    expect(shouldSkipThinkingTimeSelectionForTest("GPT-5.5 Pro", "heavy")).toBe(false);
    expect(shouldSkipThinkingTimeSelectionForTest("GPT-5.2", "extended")).toBe(false);
  });
});

describe("formatBrowserTurnTranscript", () => {
  test("keeps single-turn browser output unchanged", () => {
    expect(
      formatBrowserTurnTranscript([
        {
          label: "Initial response",
          answerText: "plain answer",
          answerMarkdown: "**plain answer**",
        },
      ]),
    ).toEqual({
      answerText: "plain answer",
      answerMarkdown: "**plain answer**",
    });
  });

  test("formats multi-turn consult output with follow-up prompts", () => {
    const result = formatBrowserTurnTranscript([
      {
        label: "Initial response",
        answerText: "initial answer",
        answerMarkdown: "initial answer",
      },
      {
        label: "Follow-up 1",
        prompt: "Challenge your previous recommendation.",
        answerText: "revised answer",
        answerMarkdown: "revised answer",
      },
    ]);

    expect(result.answerMarkdown).toContain("## Initial response");
    expect(result.answerMarkdown).toContain("## Follow-up 1");
    expect(result.answerMarkdown).toContain(
      "### Prompt\n\nChallenge your previous recommendation.",
    );
    expect(result.answerMarkdown).toContain("### Answer\n\nrevised answer");
    expect(result.answerText).toBe(result.answerMarkdown);
  });
});

describe("browser follow-ups", () => {
  test("rejects Deep Research follow-ups before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "research this",
        followUpPrompts: ["now challenge the report"],
        config: { researchMode: "deep" },
      }),
    ).rejects.toThrow(/follow-ups are not supported with Deep Research/i);
  });
});

describe("browser conversation archiving", () => {
  test("does not attempt archive when required local artifacts were not saved", async () => {
    const runtime = {
      evaluate: vi.fn(),
    };
    const log = vi.fn();

    await expect(
      maybeArchiveCompletedConversationForTest({
        Runtime: runtime as never,
        logger: log as never,
        config: resolveBrowserConfig({ archiveConversations: "always" }),
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 0,
        requiredArtifactsSaved: false,
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });
});

describe("remote Chrome option warnings", () => {
  test("does not mark browser-chrome-path as ignored for attach-running", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: true,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).not.toContain("--browser-chrome-path");
  });

  test("marks browser-chrome-path as ignored for classic remote-chrome", () => {
    expect(
      __test__.listIgnoredRemoteChromeFlags({
        attachRunning: false,
        chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }),
    ).toContain("--browser-chrome-path");
  });
});

describe("remote Chrome cleanup", () => {
  test("unrefs a kept browser so the CLI can exit after preserving Chrome", () => {
    const unref = vi.fn();

    __test__.detachKeptChromeProcess({
      process: { unref } as never,
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("closes the dedicated target after a completed run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeConnection).toHaveBeenCalledTimes(1);
    expect(closeClient).not.toHaveBeenCalled();
  });

  test("only detaches from the target after an incomplete run", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("detaches raw target clients when a run attaches to an existing remote tab", async () => {
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: null,
      client: { close: closeClient },
      runStatus: "complete",
    });

    expect(closeClient).toHaveBeenCalledTimes(1);
  });

  test("does not close an already-lost connection", async () => {
    const closeConnection = vi.fn().mockResolvedValue(undefined);
    const closeClient = vi.fn().mockResolvedValue(undefined);

    await __test__.closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: true,
      connection: { close: closeConnection },
      client: { close: closeClient },
      runStatus: "attempted",
    });

    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeClient).not.toHaveBeenCalled();
  });
});

describe("image-only assistant turn detection", () => {
  test("treats ChatGPT image-only chrome text as non-answer UI", () => {
    expect(__test__.isImageOnlyUiChromeText("Stopped thinking\nEdit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("Edit")).toBe(true);
    expect(__test__.isImageOnlyUiChromeText("PR169_IMAGE_OK")).toBe(false);
  });
});

describe("redactBrowserConfigForDebugLogForTest", () => {
  test("redacts inline cookie values while preserving count context", () => {
    const redacted = redactBrowserConfigForDebugLogForTest({
      inlineCookies: [
        { name: "__Secure-next-auth.session-token", value: "secret-token" },
        { name: "_account", value: "secret-account" },
      ],
      inlineCookiesSource: "inline-file",
      debug: true,
    });

    expect(redacted).toMatchObject({
      inlineCookies: "[redacted:2 cookies]",
      inlineCookieCount: 2,
      inlineCookiesSource: "inline-file",
      debug: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("secret-account");
  });

  test("leaves missing inline cookies unchanged", () => {
    expect(redactBrowserConfigForDebugLogForTest({ debug: true })).toEqual({ debug: true });
  });
});

describe("shouldPreferSystemTmpDirForTest", () => {
  test("prefers /tmp for Linux tmpdirs under a hidden home segment", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.tmp", "/home/openclaw")).toBe(
      true,
    );
    expect(
      shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/.cache/tmp", "/home/openclaw"),
    ).toBe(true);
  });

  test("keeps normal Linux tmpdirs and non-Linux platforms unchanged", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/tmp", "/home/openclaw")).toBe(false);
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw/tmp", "/home/openclaw")).toBe(
      false,
    );
    expect(shouldPreferSystemTmpDirForTest("darwin", "/Users/me/.tmp", "/Users/me")).toBe(false);
  });

  test("does not treat sibling home paths as inside the home directory", () => {
    expect(shouldPreferSystemTmpDirForTest("linux", "/home/openclaw2/.tmp", "/home/openclaw")).toBe(
      false,
    );
  });
});

describe("runSubmissionWithRecoveryForTest", () => {
  test("preserves prompt-too-large fallback after a dead-composer retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new BrowserAutomationError("dead composer", { code: "dead-composer" }))
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockResolvedValueOnce({
        baselineTurns: 7,
        baselineAssistantText: "done",
      });
    const reloadPromptComposer = vi.fn().mockResolvedValue(undefined);
    const prepareFallbackSubmission = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn<(message: string) => void>();

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [{ path: "/tmp/fallback.txt", displayPath: "fallback.txt", sizeBytes: 12 }],
        },
        submit,
        reloadPromptComposer,
        prepareFallbackSubmission,
        logger,
      }),
    ).resolves.toEqual({
      baselineTurns: 7,
      baselineAssistantText: "done",
    });

    expect(reloadPromptComposer).toHaveBeenCalledTimes(1);
    expect(prepareFallbackSubmission).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      "[browser] Inline prompt too large; retrying with file uploads.",
    );
    expect(submit).toHaveBeenNthCalledWith(1, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(2, "inline prompt", []);
    expect(submit).toHaveBeenNthCalledWith(3, "fallback prompt", [
      expect.objectContaining({ displayPath: "fallback.txt" }),
    ]);
  });

  test("throws when prompt-too-large happens again after fallback", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large", { code: "prompt-too-large" }),
      )
      .mockRejectedValueOnce(
        new BrowserAutomationError("prompt too large again", { code: "prompt-too-large" }),
      );

    await expect(
      runSubmissionWithRecoveryForTest({
        prompt: "inline prompt",
        attachments: [],
        fallbackSubmission: {
          prompt: "fallback prompt",
          attachments: [],
        },
        submit,
        reloadPromptComposer: vi.fn().mockResolvedValue(undefined),
        prepareFallbackSubmission: vi.fn().mockResolvedValue(undefined),
        logger: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(/prompt too large again/i);
  });
});

describe("resolveRemoteTabLeaseProfileDirForTest", () => {
  test("coordinates remote Chrome only when a manual-login profile is configured", () => {
    const coordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: true,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(coordinated)).toBe(
      path.resolve("/tmp/oracle-profile"),
    );

    const uncoordinated = resolveBrowserConfig({
      remoteChrome: { host: "127.0.0.1", port: 9222 },
      manualLogin: false,
      manualLoginProfileDir: "/tmp/oracle-profile",
    });
    expect(resolveRemoteTabLeaseProfileDirForTest(uncoordinated)).toBeNull();
  });
});
