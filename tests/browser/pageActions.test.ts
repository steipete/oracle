import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ensureModelSelection,
  waitForAssistantResponse,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensurePromptReady,
  waitForResumedConversationHydration,
  ensureNotBlocked,
  ensureLoggedIn,
} from "../../src/browser/pageActions.js";
import {
  buildLoginProbeExpressionForTest,
  buildWelcomeBackAccountPickerExpressionForTest,
} from "../../src/browser/actions/navigation.js";
import * as attachments from "../../src/browser/actions/attachments.js";
import * as attachmentDataTransfer from "../../src/browser/actions/attachmentDataTransfer.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

const logger = vi.fn();

beforeEach(() => {
  logger.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ensureModelSelection", () => {
  test("logs when model already selected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "already-selected", label: "GPT-5.2 Pro" } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "GPT-5.2 Pro", logger)).resolves.toMatchObject({
      requestedModel: "GPT-5.2 Pro",
      resolvedLabel: "GPT-5.2 Pro",
      status: "already-selected",
      strategy: "select",
      verified: true,
    });
    expect(logger).toHaveBeenCalledWith("Model picker: GPT-5.2 Pro");
  });

  test("throws when option missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "option-not-found" } } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "GPT-5 Pro", logger)).rejects.toThrow(
      /Unable to find model option matching/,
    );
  });

  test("includes temporary chat hint when requested Pro option is missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "option-not-found",
            hint: { temporaryChat: true, availableOptions: ["Auto", "Thinking"] },
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureModelSelection(runtime, "GPT-5.2 Pro", logger)).rejects.toThrow(
      /model labels may differ/i,
    );
  });

  test("throws when button missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "button-missing" } } }),
    } as unknown as ChromeClient["Runtime"];
    // buttonWaitMs: 0 skips the composer-pill wait so this exercises the give-up path directly.
    await expect(
      ensureModelSelection(runtime, "Instant", logger, "select", { buttonWaitMs: 0 }),
    ).rejects.toThrow(
      /Unable to locate the ChatGPT model selector button.*--browser-model-strategy current.*--browser-model-strategy ignore/s,
    );
  });
});

describe("navigateToChatGPT", () => {
  test("navigates and waits for ready state", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: "loading" } })
        .mockResolvedValueOnce({ result: { value: "complete" } }),
    } as unknown as ChromeClient["Runtime"];
    await navigateToChatGPT(
      { navigate } as unknown as ChromeClient["Page"],
      runtime,
      "https://chat.openai.com",
      logger,
    );
    expect(navigate).toHaveBeenCalledWith({ url: "https://chat.openai.com" });
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
  });
});

describe("navigateToPromptReadyWithFallback", () => {
  test("falls back to base URL when prompt is missing", async () => {
    const navigate = vi.fn().mockResolvedValue(undefined);
    const ensureNotBlockedMock = vi.fn().mockResolvedValue(undefined);
    const ensurePromptReadyMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Prompt textarea did not appear before timeout"))
      .mockResolvedValueOnce(undefined);
    const runtime = {} as unknown as ChromeClient["Runtime"];
    const page = {} as unknown as ChromeClient["Page"];

    await expect(
      navigateToPromptReadyWithFallback(
        page,
        runtime,
        {
          url: "https://chatgpt.com/g/missing/project",
          fallbackUrl: "https://chatgpt.com/",
          timeoutMs: 5_000,
          headless: false,
          logger,
        },
        {
          navigateToChatGPT: navigate,
          ensureNotBlocked: ensureNotBlockedMock,
          ensurePromptReady: ensurePromptReadyMock,
        },
      ),
    ).resolves.toEqual({ usedFallback: true });

    expect(navigate).toHaveBeenNthCalledWith(
      1,
      page,
      runtime,
      "https://chatgpt.com/g/missing/project",
      logger,
    );
    expect(navigate).toHaveBeenNthCalledWith(2, page, runtime, "about:blank", logger);
    expect(navigate).toHaveBeenNthCalledWith(3, page, runtime, "https://chatgpt.com/", logger);
    expect(ensureNotBlockedMock).toHaveBeenCalledTimes(2);
    expect(ensurePromptReadyMock).toHaveBeenNthCalledWith(1, runtime, 5_000, logger);
    expect(ensurePromptReadyMock).toHaveBeenNthCalledWith(2, runtime, 120_000, logger);
  });
});

describe("ensurePromptReady", () => {
  test("resolves when input selector enabled", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: true } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensurePromptReady(runtime, 1000, logger)).resolves.toBeUndefined();
    expect(logger).not.toHaveBeenCalled();
  });

  test("throws when timeout reached", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: false } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensurePromptReady(runtime, 0, logger)).rejects.toThrow(/textarea did not appear/i);
  });
});

describe("waitForResumedConversationHydration", () => {
  test("waits for stable prior turns and verifies the expected conversation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 2 } })
          .mockResolvedValueOnce({ result: { value: 2 } })
          .mockResolvedValueOnce({ result: { value: 2 } })
          .mockResolvedValueOnce({ result: { value: 2 } })
          .mockResolvedValueOnce({
            result: { value: "https://chatgpt.com/c/expected-thread" },
          }),
      } as unknown as ChromeClient["Runtime"];
      const ensurePromptReadyMock = vi.fn().mockResolvedValue(undefined);

      const promise = waitForResumedConversationHydration(runtime, 5_000, logger, {
        ensurePromptReady: ensurePromptReadyMock,
        requirePriorTurns: true,
        expectedConversationUrl: "https://chatgpt.com/g/project/c/expected-thread",
      });
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe(2);
      expect(ensurePromptReadyMock).toHaveBeenCalledWith(runtime, 5_000, logger);
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails closed when no prior turns hydrate", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({ result: { value: 0 } }),
      } as unknown as ChromeClient["Runtime"];
      const promise = waitForResumedConversationHydration(runtime, 1_000, logger, {
        ensurePromptReady: vi.fn().mockResolvedValue(undefined),
        requirePriorTurns: true,
      });
      const assertion = expect(promise).rejects.toMatchObject({
        details: {
          stage: "resume-conversation",
          priorTurns: 0,
          settled: false,
        },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("fails closed when navigation lands on a different conversation", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: 1 } })
          .mockResolvedValueOnce({ result: { value: 1 } })
          .mockResolvedValueOnce({ result: { value: 1 } })
          .mockResolvedValueOnce({ result: { value: 1 } })
          .mockResolvedValueOnce({ result: { value: "https://chatgpt.com/c/other-thread" } }),
      } as unknown as ChromeClient["Runtime"];
      const promise = waitForResumedConversationHydration(runtime, 5_000, logger, {
        ensurePromptReady: vi.fn().mockResolvedValue(undefined),
        requirePriorTurns: true,
        expectedConversationUrl: "https://chatgpt.com/c/expected-thread",
      });
      const assertion = expect(promise).rejects.toMatchObject({
        details: {
          stage: "resume-conversation",
          expectedConversationId: "expected-thread",
          actualConversationId: "other-thread",
        },
      });
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ensureNotBlocked", () => {
  test("throws descriptive error when cloudflare detected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "Just a moment..." } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureNotBlocked(runtime, true, logger)).rejects.toThrow(/headless mode/i);
    expect(logger).toHaveBeenCalledWith("Cloudflare anti-bot page detected");
  });

  test("passes through when title clean", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: "ChatGPT" } })
        .mockResolvedValueOnce({ result: { value: false } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureNotBlocked(runtime, false, logger)).resolves.toBeUndefined();
  });

  test("throws structured browser error when headful cloudflare is detected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: "Just a moment..." } }),
    } as unknown as ChromeClient["Runtime"];
    try {
      await ensureNotBlocked(runtime, false, logger);
      throw new Error("expected ensureNotBlocked to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserAutomationError);
      expect((error as BrowserAutomationError).details).toMatchObject({
        stage: "cloudflare-challenge",
        headless: false,
      });
    }
  });

  test("throws structured browser error when ChatGPT account security block appears", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: "ChatGPT" } })
        .mockResolvedValueOnce({ result: { value: false } })
        .mockResolvedValueOnce({ result: { value: true } }),
    } as unknown as ChromeClient["Runtime"];

    await expect(ensureNotBlocked(runtime, false, logger)).rejects.toMatchObject({
      details: { stage: "chatgpt-account-blocked" },
    });
    expect(logger).toHaveBeenCalledWith("ChatGPT account security block detected");
  });
});

describe("ensureLoggedIn", () => {
  function runWelcomeBackPickerForLabels(labels: string[], preferredEmail: string | null = null) {
    const clicked: string[] = [];
    const nodes = labels.map((label) => ({
      textContent: label,
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : "")),
      click: vi.fn(() => clicked.push(label)),
    }));
    const document = { querySelectorAll: vi.fn(() => nodes) };
    const setTimeout = vi.fn((callback: () => void) => {
      callback();
      return 0;
    });
    const expression = buildWelcomeBackAccountPickerExpressionForTest(preferredEmail);
    const evaluate = new Function("document", "setTimeout", `return ${expression};`) as (
      document: unknown,
      setTimeout: unknown,
    ) => {
      clicked?: boolean;
      selection?: "preferred" | "only-account";
      reason?: string;
      accountCount?: number;
    };

    return { result: evaluate(document, setTimeout), clicked };
  }

  async function runLoginProbeForLabels(
    labels: string[],
    options: {
      backendStatus?: number;
      backendStatuses?: number[];
      backendBody?: string;
      backendBodies?: string[];
      sessionStatus?: number;
      sessionStatuses?: number[];
      sessionBody?: unknown;
      sessionBodies?: unknown[];
      pathname?: string;
      composerVisible?: boolean;
      appSignal?: "profile" | "history" | "model" | null;
      probeTimeoutMs?: number;
    } = {},
  ) {
    const {
      backendStatus = 200,
      backendStatuses,
      backendBody = "",
      backendBodies,
      sessionStatus = 200,
      sessionStatuses,
      sessionBody = { user: { id: "test-user" }, accessToken: "do-not-expose" },
      sessionBodies,
      pathname = "/",
      composerVisible = false,
      appSignal = null,
      probeTimeoutMs = 0,
    } = options;
    class FakeHTMLElement {
      constructor(
        public textContent: string,
        private readonly visible = true,
      ) {}

      getAttribute() {
        return "";
      }

      getBoundingClientRect() {
        return { width: this.visible ? 120 : 0, height: this.visible ? 32 : 0 };
      }
    }

    const nodes = labels.map((label) => new FakeHTMLElement(label));
    const composer = composerVisible ? new FakeHTMLElement("") : null;
    const loggedInSignal = appSignal ? new FakeHTMLElement("") : null;
    const document = {
      querySelectorAll: vi.fn(() => nodes),
      querySelector: vi.fn((selector: string) => {
        if (
          composer &&
          [
            "#prompt-textarea",
            ".ProseMirror",
            'textarea[data-id="prompt-textarea"]',
            'textarea[name="prompt-textarea"]',
            '[contenteditable="true"][role="textbox"]',
          ].includes(selector)
        ) {
          return composer;
        }
        if (appSignal === "profile" && selector === '[data-testid="accounts-profile-button"]') {
          return loggedInSignal;
        }
        if (appSignal === "history" && selector === '[data-testid^="history-item-"]') {
          return loggedInSignal;
        }
        if (
          appSignal === "model" &&
          selector ===
            '[data-testid="model-switcher-dropdown-button"], button.__composer-pill[aria-haspopup="menu"], button.__composer-pill'
        ) {
          return loggedInSignal;
        }
        return null;
      }),
    };
    const window = {
      getComputedStyle: vi.fn(() => ({ display: "block", visibility: "visible" })),
    };
    const backendStatusQueue = [...(backendStatuses ?? [backendStatus])];
    const backendBodyQueue = [...(backendBodies ?? [backendBody])];
    const sessionStatusQueue = [...(sessionStatuses ?? [sessionStatus])];
    const sessionBodyQueue = [...(sessionBodies ?? [sessionBody])];
    const next = <T>(queue: T[]): T | undefined => (queue.length > 1 ? queue.shift() : queue[0]);
    const fetch = vi.fn().mockImplementation((url: string) => {
      const sessionRequest = url === "/api/auth/session";
      const status = next(sessionRequest ? sessionStatusQueue : backendStatusQueue);
      const body = next(sessionRequest ? sessionBodyQueue : backendBodyQueue);
      return Promise.resolve({
        status,
        json: vi.fn().mockImplementation(async () => {
          if (body instanceof Error) throw body;
          return body;
        }),
        clone: () => ({ text: vi.fn().mockResolvedValue(body) }),
      });
    });
    const location = { href: `https://chatgpt.com${pathname}`, pathname };
    const expression = buildLoginProbeExpressionForTest(probeTimeoutMs);
    const evaluate = new Function(
      "document",
      "window",
      "HTMLElement",
      "fetch",
      "location",
      `return ${expression};`,
    ) as (
      document: unknown,
      window: unknown,
      HTMLElement: typeof FakeHTMLElement,
      fetch: unknown,
      location: unknown,
    ) => Promise<{
      ok: boolean;
      domLoginCta: boolean;
      status: number;
      backendStatus: number | null;
      sessionAuthenticated: boolean;
      sessionResolved: boolean;
    }>;

    return evaluate(document, window, FakeHTMLElement, fetch, location);
  }

  test("logs success when session is present", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { ok: true, status: 200, url: "/backend-api/me" } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 2 })).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Login check passed"));
  });

  test("does not treat history items starting with login as login CTAs", async () => {
    await expect(runLoginProbeForLabels(["Login setup instruction"])).resolves.toMatchObject({
      ok: true,
      domLoginCta: false,
      status: 200,
    });
  });

  test("still detects exact and provider login CTAs", async () => {
    await expect(runLoginProbeForLabels(["Log in"])).resolves.toMatchObject({
      ok: false,
      domLoginCta: true,
    });
    await expect(runLoginProbeForLabels(["Continue with Google"])).resolves.toMatchObject({
      ok: false,
      domLoginCta: true,
    });
  });

  test("accepts a valid cookie-authenticated session without consulting the legacy probe", async () => {
    await expect(
      runLoginProbeForLabels([], {
        backendStatus: 401,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      backendStatus: null,
      sessionAuthenticated: true,
      sessionResolved: true,
      domLoginCta: false,
    });
  });

  test("falls back to authenticated app DOM when the session and legacy probes are unavailable", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionStatus: 503,
        backendStatus: 401,
        composerVisible: true,
        appSignal: "profile",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 503,
      backendStatus: 401,
      sessionAuthenticated: false,
      sessionResolved: false,
      appAuthenticated: true,
    });
  });

  test("retries a transient session failure and accepts the resolved user", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionStatuses: [503, 200],
        sessionBodies: [{}, { user: { id: "test-user" }, accessToken: "do-not-expose" }],
        backendStatus: 401,
        probeTimeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      backendStatus: null,
      sessionAuthenticated: true,
      sessionResolved: true,
    });
  });

  test("does not accept unavailable probes with only a model pill", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionStatus: 503,
        backendStatus: 401,
        composerVisible: true,
        appSignal: "model",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      backendStatus: 401,
      appAuthenticated: false,
    });
  });

  test("does not accept unavailable probes with only a composer", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionStatus: 503,
        backendStatus: 401,
        composerVisible: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      backendStatus: 401,
      appAuthenticated: false,
    });
  });

  test("treats a resolved session without a user as logged out despite stale app DOM", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionBody: {},
        backendStatus: 200,
        composerVisible: true,
        appSignal: "profile",
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 200,
      backendStatus: null,
      cfBlocked: false,
      sessionAuthenticated: false,
      sessionResolved: true,
      appAuthenticated: true,
    });
  });

  test("keeps plain session 401/403 responses authoritative", async () => {
    for (const sessionStatus of [401, 403]) {
      await expect(
        runLoginProbeForLabels([], {
          sessionStatus,
          backendStatus: 200,
          composerVisible: true,
          appSignal: "profile",
        }),
      ).resolves.toMatchObject({
        ok: false,
        status: sessionStatus,
        backendStatus: null,
        sessionAuthenticated: false,
        sessionResolved: false,
        appAuthenticated: true,
      });
    }
  });

  test("keeps auth pages and visible login CTAs authoritative", async () => {
    await expect(
      runLoginProbeForLabels([], {
        pathname: "/auth/login",
        composerVisible: true,
        appSignal: "profile",
      }),
    ).resolves.toMatchObject({
      ok: false,
      onAuthPage: true,
      appAuthenticated: true,
    });

    await expect(
      runLoginProbeForLabels(["Log in"], {
        composerVisible: true,
        appSignal: "history",
      }),
    ).resolves.toMatchObject({
      ok: false,
      domLoginCta: true,
      appAuthenticated: true,
    });
  });

  test("detects Cloudflare-blocked backend probes and falls back to app DOM", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionStatus: 503,
        backendStatus: 403,
        backendBody: "<html><body>cf-mitigated challenge from Cloudflare</body></html>",
        composerVisible: true,
        appSignal: "profile",
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 503,
      backendStatus: 403,
      cfBlocked: true,
      appAuthenticated: true,
    });
  });

  test("does not expose session response fields in the probe result", async () => {
    const result = await runLoginProbeForLabels([], {
      sessionBody: {
        user: { id: "test-user", email: "private@example.test" },
        accessToken: "secret-access-token",
        sessionToken: "secret-session-token",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      sessionAuthenticated: true,
      sessionResolved: true,
    });
    expect(JSON.stringify(result)).not.toContain("private@example.test");
    expect(JSON.stringify(result)).not.toContain("secret-access-token");
    expect(JSON.stringify(result)).not.toContain("secret-session-token");
  });

  test("does not keep stale Cloudflare state after the session resolves logged out", async () => {
    await expect(
      runLoginProbeForLabels([], {
        sessionStatuses: [503, 200],
        sessionBodies: [{}, {}],
        backendStatus: 403,
        backendBody: "<html><body>cf-mitigated challenge from Cloudflare</body></html>",
        composerVisible: true,
        probeTimeoutMs: 500,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 200,
      backendStatus: null,
      cfBlocked: false,
      sessionAuthenticated: false,
      sessionResolved: true,
    });
  });

  test("selects the configured welcome-back account by exact email", () => {
    const { result, clicked } = runWelcomeBackPickerForLabels(
      ["Continue as steipete@example.test", "Continue as pete@example.test"],
      "pete@example.test",
    );

    expect(result).toEqual({ clicked: true, selection: "preferred", accountCount: 2 });
    expect(clicked).toEqual(["Continue as pete@example.test"]);
  });

  test("does not click a fallback welcome-back account when configured account is missing", () => {
    const { result, clicked } = runWelcomeBackPickerForLabels(
      ["old@example.test"],
      "missing@example.test",
    );

    expect(result).toMatchObject({
      clicked: false,
      reason: "preferred-not-found",
      accountCount: 1,
    });
    expect(clicked).toEqual([]);
  });

  test("normalizes the configured account without exposing it in errors or logs", async () => {
    vi.stubEnv("ORACLE_CHATGPT_ACCOUNT_EMAIL", " PETE@EXAMPLE.TEST ");
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { ok: false, status: 401, url: "/backend-api/me" } },
        })
        .mockImplementationOnce(async ({ expression }: { expression: string }) => {
          expect(expression).toContain('const preferredEmail = "pete@example.test"');
          return {
            result: {
              value: { clicked: false, reason: "preferred-not-found", accountCount: 2 },
            },
          };
        }),
    } as unknown as ChromeClient["Runtime"];

    const error = await ensureLoggedIn(runtime, logger, { appliedCookies: 2 }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ORACLE_CHATGPT_ACCOUNT_EMAIL did not match");
    expect((error as Error).message).not.toContain("pete@example.test");
    expect(logger.mock.calls.flat().join(" ")).not.toContain("pete@example.test");
  });

  test("does not guess when several saved accounts exist without configuration", () => {
    const { result, clicked } = runWelcomeBackPickerForLabels([
      "one@example.test",
      "two@example.test",
    ]);

    expect(result).toEqual({
      clicked: false,
      reason: "multiple-accounts",
      accountCount: 2,
    });
    expect(clicked).toEqual([]);
  });

  test("selects the only saved account without configuration", () => {
    const { result, clicked } = runWelcomeBackPickerForLabels(["only@example.test"]);

    expect(result).toEqual({ clicked: true, selection: "only-account", accountCount: 1 });
    expect(clicked).toEqual(["only@example.test"]);
  });

  test("throws with cookie guidance when cookies missing", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            status: 401,
            url: "/backend-api/me",
            domLoginCta: true,
            onAuthPage: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 0 })).rejects.toThrow(
      /inline cookies/i,
    );
  });

  test("uses remote hint for remote sessions", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { ok: false, status: 401, url: "/backend-api/me" } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { remoteSession: true })).rejects.toThrow(
      /remote Chrome session/i,
    );
  });

  test("rejects unknown backend status instead of assuming login", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            status: 0,
            url: "/backend-api/me",
            domLoginCta: false,
            onAuthPage: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 2 })).rejects.toThrow(
      /ChatGPT session not detected/i,
    );
  });

  test("treats welcome-back navigation during account click as login progress", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: { value: { ok: false, status: 401, url: "/backend-api/me" } },
        })
        .mockRejectedValueOnce(new Error("Inspected target navigated or closed"))
        .mockResolvedValueOnce({
          result: { value: { ok: true, status: 200, url: "/backend-api/me" } },
        }),
    } as unknown as ChromeClient["Runtime"];

    await expect(ensureLoggedIn(runtime, logger, { appliedCookies: 2 })).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith("Welcome back account click triggered navigation.");
    expect(logger).toHaveBeenCalledWith("Login restored via Welcome back account picker");
  });
});

describe("waitForAssistantResponse", () => {
  test("returns captured assistant payload", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          type: "object",
          value: { text: "Answer", html: "<p>Answer</p>", messageId: "mid", turnId: "tid" },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const result = await waitForAssistantResponse(runtime, 1000, logger);
    expect(result.text).toBe("Answer");
    expect(result.meta).toEqual({ messageId: "mid", turnId: "tid" });
  });

  test("aborts poller when evaluation wins (no background polling)", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      const payload = { text: "Answer", html: "<p>Answer</p>", messageId: "mid", turnId: "tid" };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params?.awaitPromise) {
            return { result: { type: "object", value: payload } };
          }
          const expression = String(params?.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            // First snapshot call is the watchdog poller; keep it slow so the evaluation wins the race.
            if (snapshotCalls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return { result: { value: payload } };
          }
          return { result: { value: false } };
        });

      const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
      const promise = waitForAssistantResponse(runtime, 30_000, logger);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await promise;
      expect(result.text).toBe("Answer");

      const callsAtReturn = evaluate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(evaluate.mock.calls.length).toBe(callsAtReturn);
    } finally {
      vi.useRealTimers();
    }
  });

  test("response observer watches character data mutations", async () => {
    let capturedExpression = "";
    const runtime = {
      evaluate: vi.fn().mockImplementation((params) => {
        if (params?.awaitPromise) {
          capturedExpression = String(params?.expression ?? "");
          throw new Error("stop");
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForAssistantResponse(runtime, 100, logger)).rejects.toThrow("stop");
    expect(capturedExpression).toContain("characterData: true");
    expect(capturedExpression).toContain("copy-turn-action-button");
    expect(capturedExpression).toContain("isLastAssistantTurnFinished");
    expect(capturedExpression).toContain("lastAssistantTurn.querySelector(FINISHED_SELECTOR)");
    expect(capturedExpression).not.toContain("document.querySelector(FINISHED_SELECTOR)");
    expect(capturedExpression).toContain("lastAssistantTurn.querySelectorAll('.markdown')");
    expect(capturedExpression).not.toContain("document.querySelectorAll('.markdown')");
    expect(capturedExpression).toContain("data-message-author-role");
    expect(capturedExpression).toContain("role === 'assistant'");
  });

  test("falls back to snapshot when observer fails", async () => {
    const evaluate = vi
      .fn()
      .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
        if (params?.awaitPromise) {
          throw new Error("observer failed");
        }
        if (
          typeof params?.expression === "string" &&
          params.expression.includes("extractAssistantTurn")
        ) {
          return {
            result: {
              value: {
                text: "Recovered",
                html: "<p>Recovered</p>",
                messageId: "mid",
                turnId: "tid",
              },
            },
          };
        }
        return { result: { value: null } };
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const result = await waitForAssistantResponse(runtime, 200, logger);
    expect(result.text).toBe("Recovered");
    expect(evaluate).toHaveBeenCalled();
  });
});

describe("uploadAttachmentFile", () => {
  let transferSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    transferSpy = vi
      .spyOn(attachmentDataTransfer, "transferAttachmentViaDataTransfer")
      .mockResolvedValue({ fileName: "oracle-browser-smoke.txt", size: 1 });
  });

  afterEach(() => {
    transferSpy.mockRestore();
  });

  test.skip("selects DOM input and uploads file", async () => {
    logger.mockClear();
    vi.spyOn(attachments, "waitForAttachmentVisible").mockResolvedValue(undefined);
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { matched: true, found: true } } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/foo.md", displayPath: "foo.md" },
        logger,
      ),
    ).resolves.toBe(true);
    expect(dom.querySelector).toHaveBeenCalled();
    expect(dom.setFileInputFiles).toHaveBeenCalledWith({ nodeId: 2, files: ["/tmp/foo.md"] });
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("Attachment queued"));
  }, 15_000);

  test("throws when file input missing", async () => {
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 0 }),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn(),
    } as unknown as ChromeClient["Runtime"];
    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/foo.md", displayPath: "foo.md" },
        logger,
      ),
    ).rejects.toThrow(/unable to locate.*attachment input/i);
  });

  test("skips upload when attachment already present (ellipsis-aware detection)", async () => {
    logger.mockClear();
    let capturedPresenceExpression = "";
    const dom = {
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("text.includes('…')")) {
          capturedPresenceExpression = expr;
          return { result: { value: { ui: true, input: false } } };
        }
        return { result: { value: { ui: false, input: false } } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/SettingsStore.swift", displayPath: "SettingsStore.swift" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(capturedPresenceExpression).toContain("text.includes('…')");
    expect(capturedPresenceExpression).toContain("text.includes('...')");
    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/Attachment already present/i));
  });

  test("skips reupload when file already queued in input", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return { result: { value: { ui: false, input: true } } };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                order: [0],
              },
            },
          };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/already queued/i));
  });

  test("skips upload when file count already satisfies expected count", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: false,
                chipSignature: "",
                fileCount: 1,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
        { expectedCount: 1 },
      ),
    ).resolves.toBe(true);

    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/composer shows 1 file/i));
  });

  test("skips upload when input count already satisfies expected count", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn(),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 1,
                uploading: false,
                chipSignature: "",
                fileCount: 0,
              },
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
        { expectedCount: 1 },
      ),
    ).resolves.toBe(true);

    expect(dom.getDocument).not.toHaveBeenCalled();
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/composer shows 1 file/i));
  });

  test("avoids retrying other inputs once upload shows progress", async () => {
    logger.mockClear();
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: readSignalCalls >= 3,
                chipSignature: "",
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 1,
                chips: [],
                inputNames: ["oracle-browser-smoke.txt"],
                composerText: "",
                uploading: true,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("found")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(dom.querySelector).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
  });

  test("checks for late attachment signals before trying alternate inputs", async () => {
    logger.mockClear();
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          if (readSignalCalls < 3) {
            return {
              result: {
                value: {
                  ui: false,
                  input: false,
                  chipCount: 0,
                  inputCount: 0,
                  uploading: false,
                  chipSignature: "",
                },
              },
            };
          }
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 1,
                inputCount: 0,
                uploading: false,
                chipSignature: "late-chip",
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 0,
                chips: [],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: false } } };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    const uploadPromise = uploadAttachmentFile(
      { runtime, dom },
      { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
      logger,
    );
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await expect(uploadPromise).resolves.toBe(true);
    vi.useRealTimers();

    expect(dom.querySelector).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
  });

  test("defers data transfer fallback when attachment signals appear after setFileInputFiles", async () => {
    logger.mockClear();
    vi.spyOn(attachments, "waitForAttachmentVisible").mockResolvedValue(undefined);
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          if (readSignalCalls === 1) {
            return {
              result: {
                value: {
                  ui: false,
                  input: false,
                  chipCount: 0,
                  inputCount: 0,
                  uploading: false,
                  chipSignature: "",
                  fileCount: 0,
                },
              },
            };
          }
          return {
            result: {
              value: {
                ui: true,
                input: false,
                chipCount: 1,
                inputCount: 1,
                uploading: false,
                chipSignature: "chip",
                fileCount: 1,
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                baselineFileCount: 0,
                order: [0],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 1,
                chips: [],
                inputNames: ["oracle-browser-smoke.txt"],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
        logger,
      ),
    ).resolves.toBe(true);

    expect(transferSpy).not.toHaveBeenCalled();
  });

  test("clears stale file inputs before trying alternate candidates", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: false,
                chipSignature: "",
                fileCount: 0,
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                baselineFileCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (expr.includes('input[type="file"][data-oracle-upload-idx') && expr.includes("names")) {
          return { result: { value: { names: [], value: "", count: 0 } } };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 0,
                chips: [],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: false } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: false } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    const uploadPromise = uploadAttachmentFile(
      { runtime, dom },
      { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
      logger,
    );
    const handledPromise = uploadPromise.catch((error) => error as Error);
    await Promise.resolve();
    await vi.runAllTimersAsync();
    const error = await handledPromise;
    vi.useRealTimers();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Attachment did not register/i);
    expect(dom.setFileInputFiles).toHaveBeenCalledWith({ nodeId: 2, files: [] });
  });

  test("uses file-count signal to avoid retrying alternate inputs", async () => {
    logger.mockClear();
    vi.spyOn(attachments, "waitForAttachmentVisible").mockResolvedValue(undefined);
    let readSignalCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("matchesExpected")) {
          readSignalCalls += 1;
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: 0,
                inputCount: 0,
                uploading: false,
                chipSignature: "",
                fileCount: readSignalCalls >= 3 ? 1 : 0,
              },
            },
          };
        }
        if (expr.includes("baselineChipCount") && expr.includes("baselineChips")) {
          return {
            result: {
              value: {
                ok: true,
                baselineChipCount: 0,
                baselineChips: [],
                baselineUploading: false,
                baselineInputCount: 0,
                baselineFileCount: 0,
                order: [0, 1],
              },
            },
          };
        }
        if (
          expr.includes("chipCount") &&
          expr.includes("composerText") &&
          expr.includes("uploading")
        ) {
          return {
            result: {
              value: {
                chipCount: 0,
                chips: [],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          return { result: { value: { found: true } } };
        }
        if (expr.includes("normalizedNoExt") && expr.includes("selectors")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    const uploadPromise = uploadAttachmentFile(
      { runtime, dom },
      { path: "/tmp/oracle-browser-smoke.txt", displayPath: "oracle-browser-smoke.txt" },
      logger,
    );
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await expect(uploadPromise).resolves.toBe(true);
    vi.useRealTimers();

    expect(dom.querySelector).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
  });
});

describe("waitForAttachmentVisible", () => {
  test("treats file input name match as a valid visibility signal", async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    const evaluate = vi
      .fn()
      .mockResolvedValue({ result: { value: { found: true, source: "file-input" } } });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    await expect(
      attachments.waitForAttachmentVisible(runtime, "oracle-browser-smoke.txt", 100, logger),
    ).resolves.toBeUndefined();

    const call = (evaluate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as
      | { expression?: string }
      | undefined;
    const capturedExpression = String(call?.expression ?? "");
    expect(capturedExpression).toContain("source: 'file-input'");
    expect(capturedExpression).toContain('input[type="file"]');
    expect(capturedExpression).toContain("attachments?");
  });
});

describe("waitForAttachmentCompletion", () => {
  test("resolves when composer ready", async () => {
    const evaluate = vi.fn();
    evaluate.mockImplementation(async () => {
      const call = evaluate.mock.calls.length;
      if (call <= 1) {
        return { result: { value: { state: "disabled", uploading: true, filesAttached: true } } };
      }
      return { result: { value: { state: "ready", uploading: false, filesAttached: true } } };
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    vi.useFakeTimers();
    const promise = waitForAttachmentCompletion(runtime, 5_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
    expect(runtime.evaluate).toHaveBeenCalled();
  });

  test("resolves when send button missing but files present", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValueOnce({
        result: { value: { state: "missing", uploading: false, filesAttached: true } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForAttachmentCompletion(runtime, 200)).resolves.toBeUndefined();
  });

  test("rejects when timeout reached", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { state: "disabled", uploading: true, filesAttached: false } },
      }),
    } as unknown as ChromeClient["Runtime"];
    await expect(waitForAttachmentCompletion(runtime, 200)).rejects.toThrow(
      /Attachments did not finish/,
    );
  });
});
