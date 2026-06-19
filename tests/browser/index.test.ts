import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import {
  __test__,
  classifyPreservedBrowserErrorForTest,
  formatBrowserTurnTranscript,
  isLocalChromeHostForTest,
  maybeArchiveCompletedConversationForTest,
  redactBrowserConfigForDebugLogForTest,
  resolveRemoteTabLeaseProfileDirForTest,
  runBrowserMode,
  runSubmissionWithRecoveryForTest,
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

describe("browser run target cleanup", () => {
  test("never retains a copied profile after a preserved browser error", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: true,
      }),
    ).toBe(false);
  });

  test("keeps existing retention semantics for ordinary profiles", () => {
    expect(
      __test__.shouldKeepLocalBrowserOpen({
        effectiveKeepBrowser: false,
        preserveBrowserOnError: true,
        usingCopiedProfile: false,
      }),
    ).toBe(true);
  });

  test("keeps the completed conversation tab when keepBrowser is enabled", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
      }),
    ).toBe(false);
  });

  test("closes owned completed tabs by default", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(true);
  });

  test("does not close attached or incomplete targets", () => {
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: false,
        keepBrowser: false,
      }),
    ).toBe(false);
    expect(
      __test__.shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(false);
  });
});

describe("manual-login profile setup gate", () => {
  test("fails fast for an uninitialized manual-login profile unless setup keeps Chrome open", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-empty-profile-"));
    try {
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).rejects.toThrow(/private Chrome profile/i);

      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: true,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts an initialized manual-login Chrome profile", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-initialized-profile-"));
    try {
      await mkdir(path.join(dir, "Default"));
      await expect(
        __test__.assertManualLoginProfileReadyForRun({
          userDataDir: dir,
          keepBrowser: false,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formats the first-time setup command with the selected profile", () => {
    expect(__test__.formatManualLoginSetupCommand("/tmp/oracle profile")).toContain(
      '--browser-manual-login-profile-dir "/tmp/oracle profile"',
    );
  });

  test("caps non-setup manual-login waits so MCP callers fail fast", () => {
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, false)).toBe(30_000);
    expect(__test__.resolveManualLoginWaitMs(5_000, false)).toBe(5_000);
    expect(__test__.resolveManualLoginWaitMs(20 * 60_000, true)).toBe(20 * 60_000);
  });
});

// NOTE: shouldSkipThinkingTimeSelection was removed — it incorrectly assumed
// that selecting "Pro" in the picker always implied Extended effort, which is
// wrong for lower-tier plans where Pro defaults to Standard. The thinking time
// step now always runs; ensureThinkingTime handles the already-selected case.

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

describe("ChatGPT UI warning detection", () => {
  test("classifies request-speed warnings as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "You are sending too many requests too quickly. Please try again later.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies visually mangled request-speed modal text as rate limits", () => {
    expect(
      __test__.classifyChatGptUiWarningText(
        "Too many reque t. You’re making reque t too quickly. We’ve temporarily limited access to your conversations. Please wait a few minutes before trying again.",
      ),
    ).toBe("rate_limit");
  });

  test("classifies bare retry-later warnings as temporary unavailability", () => {
    expect(__test__.classifyChatGptUiWarningText("Try again later.")).toBe("temporary_unavailable");
  });

  test("collects visible warning candidates from the browser DOM", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
            {
              text: "ordinary page text",
              source: "visible-warning-text",
            },
          ],
        },
      }),
    };

    await expect(__test__.collectChatGptUiWarnings(Runtime as never)).resolves.toEqual([
      {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
        source: "selector",
        role: "alert",
        ariaLive: "assertive",
        selector: '[role="alert"]',
      },
    ]);
    const expression = Runtime.evaluate.mock.calls[0]?.[0]?.expression;
    expect(expression).not.toContain("createTreeWalker");
    expect(expression).not.toContain('[class*="error" i]');
    expect(expression).not.toContain('[class*="warning" i]');
    expect(expression).toContain("current = current.parentElement");
    expect(expression).toContain("Number.parseFloat(currentStyle.opacity || '1') === 0");
  });

  test("redacts account and token-like values from warning details", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "Sign in as private@example.test with session_token=secret-session-value",
              source: "selector",
              role: "dialog",
              selector: '[role="dialog"]',
            },
          ],
        },
      }),
    };

    const warnings = await __test__.collectChatGptUiWarnings(Runtime as never);
    expect(warnings).toEqual([
      {
        type: "auth_or_challenge",
        message: "Sign in as [redacted-email] with session_token=[redacted]",
        source: "selector",
        role: "dialog",
        ariaLive: null,
        selector: '[role="dialog"]',
      },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("private@example.test");
    expect(JSON.stringify(warnings)).not.toContain("secret-session-value");
  });

  test("builds a structured timeout error when ChatGPT shows a blocking warning", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              text: "You are sending too many requests too quickly. Please try again later.",
              source: "selector",
              role: "alert",
              ariaLive: "assertive",
              selector: '[role="alert"]',
            },
          ],
        },
      }),
    };
    const logger = vi.fn<(message: string) => void>();

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: logger as never,
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      cause: new Error("timeout"),
    });

    expect(error.message).toContain("rate-limit warning");
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      code: "chatgpt-ui-warning",
      runtime: { chromePort: 9222 },
      diagnostics: { domPath: "/tmp/assistant-timeout.dom.json" },
      uiWarning: {
        type: "rate_limit",
        message: "You are sending too many requests too quickly. Please try again later.",
      },
    });
    expect(logger).toHaveBeenCalledWith(
      "[browser] ChatGPT UI warning detected (rate_limit): You are sending too many requests too quickly. Please try again later.",
    );
  });

  test("keeps the generic timeout error when no blocking warning is visible", async () => {
    const Runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: [] } }),
    };

    const error = await __test__.createAssistantTimeoutError({
      Runtime: Runtime as never,
      logger: vi.fn() as never,
      runtime: { chromePort: 9222 },
      cause: new Error("timeout"),
    });

    expect(error.message).toBe(
      "Assistant response timed out before completion; reattach later to capture the answer.",
    );
    expect(error.details).toMatchObject({
      stage: "assistant-timeout",
      runtime: { chromePort: 9222 },
    });
    expect(error.details).not.toHaveProperty("uiWarning");
  });

  test("routes plain response observer timeouts through assistant timeout handling", () => {
    expect(__test__.isAssistantResponseTimeoutError(new Error("Response timeout"))).toBe(true);
    expect(__test__.isAssistantResponseTimeoutError(new Error("Navigation timeout"))).toBe(false);
  });
});

describe("browser follow-ups", () => {
  test("rejects copy-profile with manual-login before launching Chrome", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          manualLogin: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*browser-manual-login/i);
  });

  test("rejects copy-profile with existing-browser modes before connecting", async () => {
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          attachRunning: true,
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
    await expect(
      runBrowserMode({
        prompt: "test",
        config: {
          remoteChrome: { host: "127.0.0.1", port: 9222 },
          copyProfileSource: "/tmp/source-profile",
        },
      }),
    ).rejects.toThrow(/cannot be combined.*remote Chrome/i);
  });

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

describe("isLocalChromeHostForTest", () => {
  test.each(["localhost", "LOCALHOST", "127.0.0.1", "127.12.34.56", "::1", "[::1]"])(
    "accepts loopback host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(true);
    },
  );

  test.each(["remote-host", "192.168.1.5", "10.0.0.2", "2001:db8::1"])(
    "rejects remote host %s",
    (host) => {
      expect(isLocalChromeHostForTest(host)).toBe(false);
    },
  );
});
