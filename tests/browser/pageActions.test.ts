import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ensureModelSelection,
  waitForAssistantResponse,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensurePromptReady,
  ensureChatMode,
  waitForResumedConversationHydration,
  ensureNotBlocked,
  ensureLoggedIn,
} from "../../src/browser/pageActions.js";
import { createContext, Script } from "node:vm";
import {
  buildCloudflareInterstitialExpressionForTest,
  isCloudflareInterstitialForTest,
  buildLoginProbeExpressionForTest,
  buildWelcomeBackAccountPickerExpressionForTest,
  buildChatModeProbeExpressionForTest,
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

describe("ensureChatMode", () => {
  class FakeChatModeElement {
    readonly classList: { contains: (value: string) => boolean };

    constructor(
      readonly tagName: string,
      readonly textContent: string,
      classes: string[] = [],
      readonly childElementCount = 0,
      private readonly attributes: Record<string, string> = {},
      readonly parentElement: FakeChatModeElement | null = null,
    ) {
      const tokens = new Set(classes);
      this.classList = { contains: (value: string) => tokens.has(value) };
    }

    hasAttribute(name: string) {
      return Object.hasOwn(this.attributes, name);
    }

    matches(selector: string) {
      return (
        selector === "span.flex.items-center" &&
        this.tagName === "SPAN" &&
        this.classList.contains("flex") &&
        this.classList.contains("items-center")
      );
    }
  }

  const structuredWorkBadge = (
    overrides: {
      tagName?: string;
      textContent?: string;
      classes?: string[];
      childElementCount?: number;
      attributes?: Record<string, string>;
      parentClasses?: string[];
    } = {},
  ) => {
    const parent = new FakeChatModeElement(
      "SPAN",
      "",
      overrides.parentClasses ?? ["flex", "items-center"],
    );
    return new FakeChatModeElement(
      overrides.tagName ?? "SPAN",
      overrides.textContent ?? "Work",
      overrides.classes ?? ["shrink-0"],
      overrides.childElementCount ?? 0,
      overrides.attributes ?? {},
      parent,
    );
  };

  const runConversationModeProbe = (
    pathname: string,
    links: Array<{
      href: string;
      ariaLabel?: string;
      descendants?: FakeChatModeElement[];
      trustedHistory?: boolean;
    }>,
  ) => {
    const expression = buildChatModeProbeExpressionForTest();
    const historyLinks = links.map(
      ({ href, ariaLabel = "", descendants = [], trustedHistory = true }) => ({
        trustedHistory,
        getAttribute: (name: string) => {
          if (name === "href") return href;
          if (name === "aria-label") return ariaLabel;
          return null;
        },
        querySelectorAll: (selector: string) => (selector === "span" ? descendants : []),
      }),
    );
    const document = {
      querySelectorAll: (selector: string) =>
        selector === 'a.__menu-item[href*="/c/"]'
          ? historyLinks.filter((link) => link.trustedHistory)
          : [],
    };
    const evaluate = new Function(
      "document",
      "location",
      "URL",
      "HTMLElement",
      `return ${expression};`,
    ) as (
      document: unknown,
      location: unknown,
      url: typeof URL,
      htmlElement: typeof FakeChatModeElement,
    ) => { status: string };

    return evaluate(
      document,
      { origin: "https://chatgpt.com", pathname },
      URL,
      FakeChatModeElement,
    );
  };

  test("uses a trusted click to switch Work to Chat and verifies the result", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce({
        result: { value: { status: "work-selected", chatPoint: { x: 120, y: 48 } } },
      })
      .mockResolvedValueOnce({ result: { value: { status: "chat-selected" } } });
    const dispatchMouseEvent = vi.fn().mockResolvedValue(undefined);
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const input = { dispatchMouseEvent } as unknown as ChromeClient["Input"];

    await expect(ensureChatMode(runtime, input, 1_000, logger, { pollMs: 0 })).resolves.toBe(
      "switched",
    );

    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(1, {
      type: "mouseMoved",
      x: 120,
      y: 48,
    });
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(2, {
      type: "mousePressed",
      x: 120,
      y: 48,
      button: "left",
      clickCount: 1,
    });
    expect(dispatchMouseEvent).toHaveBeenNthCalledWith(3, {
      type: "mouseReleased",
      x: 120,
      y: 48,
      button: "left",
      clickCount: 1,
    });
    expect(logger).toHaveBeenCalledWith("ChatGPT mode: Work; switching to Chat");
    expect(logger).toHaveBeenCalledWith("ChatGPT mode: Chat (switched from Work)");
    expect(String(evaluate.mock.calls[0]?.[0]?.expression)).toContain('button[role="radio"]');
  });

  test("does not click when Chat is already selected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "chat-selected" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchMouseEvent: vi.fn(),
    } as unknown as ChromeClient["Input"];

    await expect(ensureChatMode(runtime, input, 0, logger)).resolves.toBe("chat");
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("keeps compatibility when the Chat/Work selector is absent", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "controls-absent" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchMouseEvent: vi.fn(),
    } as unknown as ChromeClient["Input"];

    await expect(ensureChatMode(runtime, input, 0, logger)).resolves.toBe("unavailable");
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("fails closed for an existing Work conversation", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "work-conversation" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchMouseEvent: vi.fn(),
    } as unknown as ChromeClient["Input"];

    await expect(ensureChatMode(runtime, input, 0, logger)).rejects.toThrow(
      /existing Work conversation/i,
    );
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("recognizes a hydrated ordinary Chat conversation", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { status: "chat-conversation" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchMouseEvent: vi.fn(),
    } as unknown as ChromeClient["Input"];

    await expect(ensureChatMode(runtime, input, 0, logger)).resolves.toBe("chat");
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("waits for conversation metadata to hydrate before classifying Work", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "conversation-unresolved" } } })
        .mockResolvedValueOnce({ result: { value: { status: "work-conversation" } } })
        .mockResolvedValueOnce({ result: { value: { status: "chat-selected" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchMouseEvent: vi.fn(),
    } as unknown as ChromeClient["Input"];
    const resetWorkConversation = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureChatMode(runtime, input, 1_000, logger, {
        pollMs: 0,
        resetWorkConversation,
      }),
    ).resolves.toBe("switched");

    expect(resetWorkConversation).toHaveBeenCalledOnce();
    expect(runtime.evaluate).toHaveBeenCalledTimes(3);
  });

  test("opens a new Chat when a non-resume run attaches to a Work conversation", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "work-conversation" } } })
        .mockResolvedValueOnce({ result: { value: { status: "chat-selected" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchMouseEvent: vi.fn(),
    } as unknown as ChromeClient["Input"];
    const resetWorkConversation = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureChatMode(runtime, input, 1_000, logger, {
        pollMs: 0,
        resetWorkConversation,
      }),
    ).resolves.toBe("switched");

    expect(resetWorkConversation).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith("ChatGPT mode: Work conversation; opening a new Chat");
    expect(logger).toHaveBeenCalledWith("ChatGPT mode: Chat (switched from Work)");
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test.each([
    ["root", "/c/root-work-thread", "/c/root-work-thread", "Root task, Work"],
    [
      "project",
      "/g/example/project/c/project-work-thread",
      "/c/project-work-thread",
      "Project task, chat in project Example, Work",
    ],
  ])(
    "classifies a structured Work badge on a %s conversation URL",
    (_kind, pathname, href, ariaLabel) => {
      expect(
        runConversationModeProbe(pathname, [
          {
            href,
            ariaLabel,
            descendants: [structuredWorkBadge()],
          },
        ]),
      ).toEqual({ status: "work-conversation" });
    },
  );

  test.each([
    ["comma-containing title", "Plan, Work, and travel", []],
    ["title exactly Work", "Work", [structuredWorkBadge({ attributes: { dir: "auto" } })]],
    ["arbitrary exact-text descendant", "Work notes", [structuredWorkBadge({ classes: [] })]],
    [
      "near-miss badge with nested content",
      "Work notes",
      [structuredWorkBadge({ childElementCount: 1 })],
    ],
    [
      "near-miss badge under an ordinary parent",
      "Work notes",
      [structuredWorkBadge({ parentClasses: ["flex"] })],
    ],
  ])("keeps an ordinary Chat conversation for a %s", (_caseName, ariaLabel, descendants) => {
    expect(
      runConversationModeProbe("/c/chat-thread", [
        { href: "/c/chat-thread", ariaLabel, descendants },
      ]),
    ).toEqual({ status: "chat-conversation" });
  });

  test("treats a terminal aria Work suffix as hydration evidence rather than authority", () => {
    expect(
      runConversationModeProbe("/c/pending-thread", [
        {
          href: "/c/pending-thread",
          ariaLabel: "Ordinary title ending, Work",
        },
      ]),
    ).toEqual({ status: "conversation-unresolved" });
  });

  test("opens a new Chat after persistent ambiguity on a non-resume attachment", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "conversation-unresolved" } } })
        .mockResolvedValueOnce({ result: { value: { status: "chat-selected" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = { dispatchMouseEvent: vi.fn() } as unknown as ChromeClient["Input"];
    const resetWorkConversation = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureChatMode(runtime, input, 0, logger, { pollMs: 0, resetWorkConversation }),
    ).resolves.toBe("switched");
    expect(resetWorkConversation).toHaveBeenCalledOnce();
    expect(logger).toHaveBeenCalledWith("ChatGPT conversation mode unresolved; opening a new Chat");
  });

  test("fails closed after persistent ambiguity on an explicit resume", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValue({ result: { value: { status: "conversation-unresolved" } } }),
    } as unknown as ChromeClient["Runtime"];
    const input = { dispatchMouseEvent: vi.fn() } as unknown as ChromeClient["Input"];

    await expect(ensureChatMode(runtime, input, 0, logger, { pollMs: 0 })).rejects.toThrow(
      /cannot safely resume/i,
    );
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
  });

  test("aggregates responsive duplicates for the exact conversation id", () => {
    expect(
      runConversationModeProbe("/c/duplicate-thread", [
        { href: "/c/duplicate-thread", ariaLabel: "Hydrated title" },
        {
          href: "/c/duplicate-thread",
          ariaLabel: "Hydrated title, Work",
          descendants: [structuredWorkBadge()],
        },
      ]),
    ).toEqual({ status: "work-conversation" });
  });

  test("ignores a matching conversation path from another origin", () => {
    expect(
      runConversationModeProbe("/c/same-thread", [
        {
          href: "https://example.test/c/same-thread",
          ariaLabel: "External, Work",
          descendants: [structuredWorkBadge()],
        },
        { href: "/c/same-thread", ariaLabel: "Local chat" },
      ]),
    ).toEqual({ status: "chat-conversation" });
  });

  test("ignores an exact-id link rendered outside trusted sidebar history", () => {
    expect(
      runConversationModeProbe("/c/same-thread", [
        {
          href: "/c/same-thread",
          ariaLabel: "User-authored link",
          descendants: [structuredWorkBadge()],
          trustedHistory: false,
        },
      ]),
    ).toEqual({ status: "conversation-unresolved" });
  });

  test("fails closed when post-reset Chat verification remains unavailable", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "work-conversation" } } })
        .mockResolvedValueOnce({ result: { value: { status: "controls-absent" } } })
        .mockResolvedValue({ result: { value: false } }),
    } as unknown as ChromeClient["Runtime"];
    const input = { dispatchMouseEvent: vi.fn() } as unknown as ChromeClient["Input"];
    const resetWorkConversation = vi.fn().mockResolvedValue(undefined);

    await expect(
      ensureChatMode(runtime, input, 0, logger, { pollMs: 0, resetWorkConversation }),
    ).rejects.toThrow(/could not verify Chat mode after leaving Work/i);
    expect(resetWorkConversation).toHaveBeenCalledOnce();
  });

  test("allocates a fresh verification window after resetting a Work conversation", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const runtime = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ result: { value: { status: "work-conversation" } } })
          .mockResolvedValueOnce({ result: { value: { status: "conversation-unresolved" } } })
          .mockResolvedValueOnce({ result: { value: { status: "chat-selected" } } }),
      } as unknown as ChromeClient["Runtime"];
      const input = { dispatchMouseEvent: vi.fn() } as unknown as ChromeClient["Input"];
      const resetWorkConversation = vi.fn().mockImplementation(async () => {
        vi.setSystemTime(1_000);
      });

      const result = ensureChatMode(runtime, input, 1_000, logger, {
        pollMs: 1,
        resetWorkConversation,
      });
      await vi.runAllTimersAsync();

      await expect(result).resolves.toBe("switched");
      expect(runtime.evaluate).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("scopes detection to exact mode radios and the active conversation metadata", () => {
    const expression = buildChatModeProbeExpressionForTest();
    expect(expression).toContain('button[role="radio"]');
    expect(expression).toContain("normalize(node.textContent) === 'chat'");
    expect(expression).toContain("normalize(node.textContent) === 'work'");
    expect(expression).toContain('a.__menu-item[href*="/c/"]');
    expect(expression).toContain("candidateUrl.origin === location.origin");
    expect(expression).toContain(
      "conversationIdFromPath(candidateUrl.pathname) === conversationId",
    );
    expect(expression).toContain("node.classList.contains('shrink-0')");
    expect(expression).not.toContain("document.body.innerText");
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

  test("does not wait for an enabled composer when hydrating an active recovery", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({ result: { value: 2 } }),
      } as unknown as ChromeClient["Runtime"];
      const ensurePromptReadyMock = vi.fn().mockRejectedValue(new Error("composer disabled"));

      const promise = waitForResumedConversationHydration(runtime, 5_000, logger, {
        ensurePromptReady: ensurePromptReadyMock,
        requirePriorTurns: true,
        requirePromptReady: false,
      });
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toBe(2);
      expect(ensurePromptReadyMock).not.toHaveBeenCalled();
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

describe("isCloudflareInterstitial hydration grace", () => {
  const verdicts = (...values: unknown[]) => {
    const fn = vi.fn();
    for (const value of values) fn.mockResolvedValueOnce({ result: { value } });
    fn.mockResolvedValue({ result: { value: values[values.length - 1] } });
    return { evaluate: fn } as unknown as ChromeClient["Runtime"];
  };

  test("weak-only evidence that resolves into the app shell is NOT a challenge", async () => {
    // The post-navigation race: bot-management script present, React shell not yet hydrated,
    // short body. The shell appearing during the grace window must clear the classification.
    const runtime = verdicts({ weak: true }, { weak: true }, { shell: true });
    await expect(isCloudflareInterstitialForTest(runtime, 5_000)).resolves.toBe(false);
  });

  test("weak-only evidence that persists through the grace window IS a challenge", async () => {
    const runtime = verdicts({ weak: true });
    await expect(isCloudflareInterstitialForTest(runtime, 1_200)).resolves.toBe(true);
  });

  test("strong evidence classifies immediately without waiting", async () => {
    const runtime = verdicts({ strong: true });
    const started = Date.now();
    await expect(isCloudflareInterstitialForTest(runtime, 60_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("no evidence at all returns false immediately", async () => {
    const runtime = verdicts({});
    await expect(isCloudflareInterstitialForTest(runtime, 60_000)).resolves.toBe(false);
  });
});

describe("ensureNotBlocked", () => {
  test("throws descriptive error when cloudflare detected", async () => {
    // The detector evaluates a verdict object; strong evidence classifies immediately.
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { strong: true } } }),
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureNotBlocked(runtime, true, logger)).rejects.toThrow(/headless mode/i);
    expect(logger).toHaveBeenCalledWith("Cloudflare anti-bot page detected");
  });

  test("passes through when not a challenge (e.g. a normal page carrying the CF script)", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { shell: true } } }) // challenge verdict: app shell
        .mockResolvedValue({ result: { value: false } }), // account security block probe
    } as unknown as ChromeClient["Runtime"];
    await expect(ensureNotBlocked(runtime, false, logger)).resolves.toBeUndefined();
  });

  test("throws structured browser error when headful cloudflare is detected", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: { strong: true } } }),
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
        .mockResolvedValueOnce({ result: { value: { shell: true } } }) // not a Cloudflare interstitial
        .mockResolvedValueOnce({ result: { value: true } }), // account security block
    } as unknown as ChromeClient["Runtime"];

    await expect(ensureNotBlocked(runtime, false, logger)).rejects.toMatchObject({
      details: { stage: "chatgpt-account-blocked" },
    });
    expect(logger).toHaveBeenCalledWith("ChatGPT account security block detected");
  });
});

describe("cloudflare interstitial detection (DOM logic)", () => {
  function evalCloudflare(opts: {
    title?: string;
    bodyText?: string;
    appShell?: boolean;
    widget?: boolean;
    script?: boolean;
  }): boolean {
    const expr = buildCloudflareInterstitialExpressionForTest();
    const context = createContext({
      String,
      Boolean,
      document: {
        title: opts.title ?? "",
        body: { innerText: opts.bodyText ?? "" },
        querySelector: (selector: string) => {
          const s = String(selector);
          if (
            s.includes("prompt-textarea") ||
            s.includes("conversation-turn") ||
            s.includes("profile-button") ||
            s.includes("form[data-type]") ||
            s.includes('href*="/c/"')
          ) {
            return opts.appShell ? {} : null;
          }
          if (
            s.includes("challenge-form") ||
            s.includes("cf-challenge") ||
            s.includes("challenges.cloudflare.com") ||
            s.includes("cdn-cgi/challenge-platform")
          ) {
            return opts.widget ? {} : null;
          }
          if (s.includes("challenge-platform")) {
            return opts.script ? {} : null; // the bot-management script
          }
          return null;
        },
      },
    });
    return new Script(expr).runInContext(context) as boolean;
  }

  test("does NOT flag a normal app page that merely carries the CF bot-management script", () => {
    // The regression: the new GPT-5.6 "Work" UI (app shell present) + the challenge-platform
    // script was wrongly detected as a Cloudflare challenge.
    expect(evalCloudflare({ title: "ChatGPT", appShell: true, script: true })).toBe(false);
  });

  test("does NOT flag a content-rich page even without a recognized app shell", () => {
    expect(
      evalCloudflare({ title: "", appShell: false, script: true, bodyText: "x".repeat(1200) }),
    ).toBe(false);
  });

  test("does NOT treat generic challenge copy as strong evidence on a content-rich page", () => {
    expect(
      evalCloudflare({
        title: "ChatGPT",
        appShell: false,
        script: true,
        bodyText: `A normal long-form answer says just a moment in passing. ${"x".repeat(1200)}`,
      }),
    ).toBe(false);
  });

  test("flags the real interstitial by title", () => {
    expect(evalCloudflare({ title: "Just a moment..." })).toBe(true);
  });

  test("flags a real challenge widget with no app shell", () => {
    expect(evalCloudflare({ title: "", appShell: false, widget: true })).toBe(true);
  });

  test("flags a short interstitial page carrying the script", () => {
    expect(
      evalCloudflare({ title: "", appShell: false, script: true, bodyText: "just a moment" }),
    ).toBe(true);
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
    vi.useFakeTimers();
    try {
      const payload = {
        text: "Answer to the question.",
        html: "<p>Answer to the question.</p>",
        messageId: "mid",
        turnId: "tid",
      };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params?.awaitPromise) {
            return { result: { type: "object", value: payload } };
          }
          const expression = String(params?.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            return { result: { value: payload } };
          }
          // A finished turn's action bar is present -> the terminal gate proves completion (proofA).
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: true } };
          }
          return { result: { value: false } };
        });
      const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
      const promise = waitForAssistantResponse(runtime, 30_000, logger);
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await promise;
      expect(result.text).toBe("Answer to the question.");
      expect(result.meta).toEqual({ messageId: "mid", turnId: "tid" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts poller when evaluation wins (no background polling)", async () => {
    vi.useFakeTimers();
    try {
      let snapshotCalls = 0;
      // Use a confident-length answer so the fast path returns directly; a
      // sub-16-char capture would (intentionally) trigger the short-response
      // confirmation watchdog, which this test is not exercising.
      const answerText = "Answer to the question.";
      const payload = {
        text: answerText,
        html: `<p>${answerText}</p>`,
        messageId: "mid",
        turnId: "tid",
      };
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
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: true } }; // action bar present -> proofA
          }
          return { result: { value: false } };
        });

      const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
      const promise = waitForAssistantResponse(runtime, 30_000, logger);
      await vi.advanceTimersByTimeAsync(4_000);
      const result = await promise;
      expect(result.text).toBe(answerText);

      // The confirm re-poll is FOREGROUND; once the promise resolves there must be no further
      // (background) polling — the poller is aborted when the evaluation path wins.
      const callsAtReturn = evaluate.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(evaluate.mock.calls.length).toBe(callsAtReturn);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconfirms a short no-control capture and returns the grown answer", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const partial = { text: "I", messageId: "mid", turnId: "tid" };
      const complete = {
        text: "I finished the answer after the thinking transition.",
        messageId: "mid",
        turnId: "tid",
      };
      let snapshotCalls = 0;
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params.awaitPromise) {
            return { result: { type: "object", value: partial } };
          }
          const expression = String(params.expression ?? "");
          // The stub "I" is captured mid-stream; the full answer and its action bar arrive at 3.5s.
          const done = Date.now() - startedAt >= 3_500;
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            if (snapshotCalls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return { result: { value: done ? complete : partial } };
          }
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: done } }; // action bar only once the turn finishes
          }
          return { result: { value: false } };
        });

      const promise = waitForAssistantResponse(
        { evaluate } as unknown as ChromeClient["Runtime"],
        30_000,
        logger,
      );
      await vi.advanceTimersByTimeAsync(12_000);

      // The short stub must NOT be finalized; the grown, bar-proven answer is returned.
      await expect(promise).resolves.toMatchObject({ text: complete.text });
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a stable short capture without a completion signal", async () => {
    vi.useFakeTimers();
    try {
      const partial = { text: "I", messageId: "mid", turnId: "tid" };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params.awaitPromise) {
            return { result: { type: "object", value: partial } };
          }
          const expression = String(params.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            return { result: { value: partial } };
          }
          return { result: { value: false } };
        });

      const promise = waitForAssistantResponse(
        { evaluate } as unknown as ChromeClient["Runtime"],
        15_000,
        logger,
      );
      const assertion = expect(promise).rejects.toThrow(/refusing to finalize/i);
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a stable short watchdog capture when the observer hangs", async () => {
    vi.useFakeTimers();
    try {
      const partial = { text: "I", messageId: "mid", turnId: "tid" };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params.awaitPromise) {
            return new Promise(() => undefined);
          }
          const expression = String(params.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            return { result: { value: partial } };
          }
          return { result: { value: false } };
        });
      const terminateExecution = vi.fn().mockResolvedValue(undefined);

      const promise = waitForAssistantResponse(
        { evaluate, terminateExecution } as unknown as ChromeClient["Runtime"],
        15_000,
        logger,
      );
      const assertion = expect(promise).rejects.toThrow(/watchdog-timeout/i);
      await vi.advanceTimersByTimeAsync(16_000);
      await assertion;
      expect(terminateExecution).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("re-polls a completion capture longer than 80 characters until the full answer is stable", async () => {
    vi.useFakeTimers();
    try {
      const partialText =
        "The first paragraph already exceeds eighty characters, but the answer is still rendering during the transition.";
      const partial = { text: partialText, messageId: "mid", turnId: "tid" };
      const complete = {
        text: `${partialText} This is the rest of the answer after the thinking transition finished.`,
        messageId: "mid",
        turnId: "tid",
      };
      let snapshotCalls = 0;
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params.awaitPromise) {
            return { result: { type: "object", value: partial } };
          }
          const expression = String(params.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            snapshotCalls += 1;
            if (snapshotCalls === 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return { result: { value: snapshotCalls <= 5 ? partial : complete } };
          }
          // Still rendering while the first paragraph shows: no action bar until the turn finishes.
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: snapshotCalls > 5 } };
          }
          return { result: { value: false } };
        });

      const promise = waitForAssistantResponse(
        { evaluate } as unknown as ChromeClient["Runtime"],
        30_000,
        logger,
      );
      await vi.advanceTimersByTimeAsync(12_000);

      // The long-but-partial first paragraph must not be finalized; the full answer is returned.
      await expect(promise).resolves.toMatchObject({ text: complete.text });
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps a legitimate short completion after watchdog confirmation", async () => {
    vi.useFakeTimers();
    try {
      const answer = { text: "Yes.", messageId: "mid", turnId: "tid" };
      const evaluate = vi
        .fn()
        .mockImplementation(async (params: { expression?: string; awaitPromise?: boolean }) => {
          if (params.awaitPromise) {
            return { result: { type: "object", value: answer } };
          }
          const expression = String(params.expression ?? "");
          if (expression.includes("extractAssistantTurn")) {
            return { result: { value: answer } };
          }
          if (expression.includes("Find the LAST assistant turn")) {
            return { result: { value: true } };
          }
          return { result: { value: false } };
        });

      const promise = waitForAssistantResponse(
        { evaluate } as unknown as ChromeClient["Runtime"],
        30_000,
        logger,
      );
      await vi.advanceTimersByTimeAsync(6_000);

      // A legitimately short answer is kept once its action bar proves completion (proofA).
      await expect(promise).resolves.toMatchObject({ text: "Yes." });
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
        const expression = typeof params?.expression === "string" ? params.expression : "";
        if (expression.includes("extractAssistantTurn")) {
          return {
            result: {
              value: {
                text: "Recovered assistant response.",
                html: "<p>Recovered assistant response.</p>",
                messageId: "mid",
                turnId: "tid",
              },
            },
          };
        }
        // Recovered turn is finished (action bar present) -> the terminal gate confirms it.
        if (expression.includes("Find the LAST assistant turn")) {
          return { result: { value: true } };
        }
        return { result: { value: null } };
      });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const result = await waitForAssistantResponse(runtime, 10_000, logger);
    expect(result.text).toBe("Recovered assistant response.");
    expect(evaluate).toHaveBeenCalled();
  });
});

describe("composer attachment menu safety", () => {
  test("captures the pre-attachment page identity", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: "https://chatgpt.com/g/project-example" },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(attachments.captureComposerNavigationUrl(runtime)).resolves.toBe(
      "https://chatgpt.com/g/project-example",
    );
  });

  test("fails closed when the pre-attachment page identity cannot be captured", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({ result: { value: null } }),
    } as unknown as ChromeClient["Runtime"];

    await expect(attachments.captureComposerNavigationUrl(runtime)).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: expect.objectContaining({
        code: "attachment-navigation-identity-unavailable",
        stage: "upload-attachment",
      }),
    });
  });

  test("activates only the exact plus control with a trusted keyboard event", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        value: {
          status: "focused",
          startUrl: "https://chatgpt.com/",
          focused: true,
        },
      },
    });
    const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
    const dispatchMouseEvent = vi.fn().mockResolvedValue(undefined);
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const input = {
      dispatchKeyEvent,
      dispatchMouseEvent,
    } as unknown as ChromeClient["Input"];

    await expect(attachments.activateComposerPlus(runtime, input)).resolves.toEqual({
      method: "trusted-keyboard",
      startUrl: "https://chatgpt.com/",
    });

    expect(dispatchKeyEvent).toHaveBeenCalledTimes(2);
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "keyDown", key: "Enter", code: "Enter" }),
    );
    expect(dispatchKeyEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "keyUp", key: "Enter", code: "Enter" }),
    );
    expect(dispatchMouseEvent).not.toHaveBeenCalled();

    const expression = String(evaluate.mock.calls[0]?.[0]?.expression ?? "");
    expect(expression).toContain("#composer-plus-btn");
    expect(expression).toContain('button[data-testid="composer-plus-btn"]');
    expect(expression).not.toContain('[data-testid*="plus"]');
    expect(expression).not.toContain('button[aria-label^="add" i]');
    expect(expression).not.toContain("getBoundingClientRect().left");
  });

  test("fails closed before activation when Work is selected", async () => {
    const dispatchKeyEvent = vi.fn();
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "work-selected",
            startUrl: "https://chatgpt.com/",
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const input = { dispatchKeyEvent } as unknown as ChromeClient["Input"];

    const error = await attachments.activateComposerPlus(runtime, input).catch((cause) => cause);

    expect(error).toBeInstanceOf(BrowserAutomationError);
    expect((error as BrowserAutomationError).details).toMatchObject({
      code: "attachment-control-work-mode",
      stage: "upload-attachment",
    });
    expect(dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test.each([
    ["root to a new conversation", "https://chatgpt.com/", "https://chatgpt.com/c/WEB:new-work"],
    [
      "root to a project landing",
      "https://chatgpt.com/",
      "https://chatgpt.com/g/g-project-b/project",
    ],
    [
      "one project landing to another",
      "https://chatgpt.com/g/g-project-a/project",
      "https://chatgpt.com/g/g-project-b/project",
    ],
    [
      "project conversation to another conversation",
      "https://chatgpt.com/g/g-example/project/c/chat-a",
      "https://chatgpt.com/g/g-example/project/c/chat-b",
    ],
  ])("rejects unexpected navigation from %s", async (_caseName, startUrl, currentUrl) => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { currentUrl, workSelected: false } },
      }),
    } as unknown as ChromeClient["Runtime"];

    const error = await attachments
      .assertComposerPlusStayedInPlace(runtime, startUrl)
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(BrowserAutomationError);
    expect((error as BrowserAutomationError).details).toMatchObject({
      code: "attachment-control-unexpected-navigation",
      stage: "upload-attachment",
      startUrl,
      currentUrl,
    });
  });

  test.each([
    [
      "root URL query/hash rewrite",
      "https://chatgpt.com/?model=gpt-5.6-sol",
      "https://chatgpt.com/#temporary-chat",
    ],
    [
      "same project landing with trailing slash and query rewrite",
      "https://chatgpt.com/g/g-example/project/?model=gpt-5.6-sol",
      "https://chatgpt.com/g/g-example/project#composer",
    ],
  ])(
    "accepts a stable non-conversation context after %s",
    async (_caseName, startUrl, currentUrl) => {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: { value: { currentUrl, workSelected: false } },
        }),
      } as unknown as ChromeClient["Runtime"];

      await expect(
        attachments.assertComposerPlusStayedInPlace(runtime, startUrl),
      ).resolves.toBeUndefined();
    },
  );

  test("accepts a project-scoped URL rewrite that preserves the conversation id", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            currentUrl: "https://chatgpt.com/g/g-example/project/c/chat-same",
            workSelected: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      attachments.assertComposerPlusStayedInPlace(runtime, "https://chatgpt.com/c/chat-same"),
    ).resolves.toBeUndefined();
  });

  test("rejects Work state even when the conversation URL is unchanged", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            currentUrl: "https://chatgpt.com/c/chat-same",
            workSelected: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      attachments.assertComposerPlusStayedInPlace(runtime, "https://chatgpt.com/c/chat-same"),
    ).rejects.toThrow(/navigated to Work/i);
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
    expect(capturedPresenceExpression).toContain("namePattern");
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
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
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

  test("does not skip upload for an unrelated file-count label", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn().mockRejectedValue(new Error("UPLOAD_PATH_REACHED")),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
    ).rejects.toThrow("UPLOAD_PATH_REACHED");

    expect(dom.getDocument).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
  });

  test("does not skip upload for an unnamed file-input count", async () => {
    logger.mockClear();
    const dom = {
      getDocument: vi.fn().mockRejectedValue(new Error("UPLOAD_PATH_REACHED")),
      querySelector: vi.fn(),
      setFileInputFiles: vi.fn(),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
    ).rejects.toThrow("UPLOAD_PATH_REACHED");

    expect(dom.getDocument).toHaveBeenCalledTimes(1);
    expect(dom.setFileInputFiles).not.toHaveBeenCalled();
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
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
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
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
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

  test("retains confirmed per-file upload evidence for a filename-less image", async () => {
    logger.mockClear();
    let inputSet = false;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockImplementation(async ({ files }: { files: string[] }) => {
        inputSet = files.length > 0;
      }),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes('const action = "confirm"')) return { result: { value: inputSet } };
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: inputSet ? 3 : 2,
                inputCount: 0,
                uploading: false,
                chipSignature: inputSet ? "chip-a|chip-b|image-preview" : "chip-a|chip-b",
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
                baselineChipCount: 2,
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
                local: true,
                chipCount: inputSet ? 3 : 2,
                chips: inputSet
                  ? [{ text: "chip-a" }, { text: "chip-b" }, { testid: "image-preview" }]
                  : [{ text: "chip-a" }, { text: "chip-b" }],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("return { names: [], value: '', count: 0 }")) {
          return { result: { value: { names: [], value: "", count: 0 } } };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          throw new Error("literal filename visibility probe should be redundant");
        }
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
          throw new Error("global attachment anchoring should be redundant");
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    try {
      const uploadPromise = uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/case412.jpg", displayPath: "case412.jpg" },
        logger,
      );
      const assertion = expect(uploadPromise).resolves.toBe(true);
      await vi.runAllTimersAsync();
      await assertion;

      expect(dom.setFileInputFiles).toHaveBeenCalledWith({
        nodeId: 2,
        files: ["/tmp/case412.jpg"],
      });
      expect(transferSpy).not.toHaveBeenCalled();
      expect(logger).toHaveBeenCalledWith(
        "Attachment queued (per-file composer evidence confirmed)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("rejects a filename-less image when the extra chip predates the file assignment", async () => {
    logger.mockClear();
    let inputSet = false;
    let literalProbeCalls = 0;
    const dom = {
      getDocument: vi.fn().mockResolvedValue({ root: { nodeId: 1 } }),
      querySelector: vi.fn().mockResolvedValue({ nodeId: 2 }),
      setFileInputFiles: vi.fn().mockImplementation(async ({ files }: { files: string[] }) => {
        inputSet = files.length > 0;
      }),
    } as unknown as ChromeClient["DOM"];
    const runtime = {
      evaluate: vi.fn().mockImplementation(async (params: { expression?: string }) => {
        const expr = String(params?.expression ?? "");
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
          return {
            result: {
              value: {
                ui: false,
                input: false,
                chipCount: inputSet ? 3 : 2,
                inputCount: 0,
                uploading: false,
                chipSignature: inputSet ? "chip-a|chip-b|unrelated" : "chip-a|chip-b",
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
                baselineChipCount: 2,
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
                local: true,
                chipCount: 3,
                chips: [{ text: "chip-a" }, { text: "chip-b" }, { testid: "unrelated" }],
                inputNames: [],
                composerText: "",
                uploading: false,
              },
            },
          };
        }
        if (expr.includes("return { names: [], value: '', count: 0 }")) {
          return { result: { value: { names: [], value: "", count: 0 } } };
        }
        if (expr.includes("attachmentSelectors") && expr.includes("attachment-cards")) {
          literalProbeCalls += 1;
          return { result: { value: { found: false } } };
        }
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
          throw new Error("global attachment anchoring should not confirm this attempt");
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];

    vi.useFakeTimers();
    try {
      const uploadPromise = uploadAttachmentFile(
        { runtime, dom },
        { path: "/tmp/case412.jpg", displayPath: "case412.jpg" },
        logger,
      );
      const assertion = expect(uploadPromise).rejects.toThrow(
        /Attachment did not appear in ChatGPT composer/i,
      );
      await vi.runAllTimersAsync();
      await assertion;

      expect(dom.setFileInputFiles).toHaveBeenCalledTimes(1);
      expect(literalProbeCalls).toBeGreaterThan(0);
      expect(transferSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
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

  test("does not use a file-count-only signal as upload confirmation", async () => {
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
        if (expr.includes("const normalizedExpected") && expr.includes("chipSignature")) {
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
          return { result: { value: { found: false } } };
        }
        if (expr.includes("const matchesExpected =") && expr.includes("const selectors =")) {
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
    const assertion = expect(uploadPromise).rejects.toThrow(/Attachment did not register/i);
    await Promise.resolve();
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();

    expect(dom.querySelector).toHaveBeenCalledTimes(2);
    expect(dom.setFileInputFiles).toHaveBeenCalled();

    const fileCountExpressions = (
      runtime.evaluate as unknown as { mock: { calls: Array<Array<{ expression?: string }>> } }
    ).mock.calls
      .map(([params]) => String(params?.expression ?? ""))
      .filter((expression) => expression.includes("fileCountSelectors"));
    expect(fileCountExpressions.length).toBeGreaterThan(1);
    expect(
      fileCountExpressions.some((expression) => expression.includes("baselineFileCount")),
    ).toBe(true);
    expect(
      fileCountExpressions.every(
        (expression) =>
          expression.includes("scope && scope !== document.body") &&
          expression.includes("root && root !== document.body"),
      ),
    ).toBe(true);
    for (const expression of fileCountExpressions) {
      expect(expression).not.toContain("document.querySelectorAll(fileCountSelectors)");
    }
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
    expect(capturedExpression).not.toContain("source: 'file-count'");
    expect(capturedExpression).not.toContain("visibleRemove");
  });
});

describe("waitForAttachmentCompletion", () => {
  test("keeps sidebar file-count labels outside the active composer scan", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      result: {
        value: {
          state: "missing",
          uploading: false,
          filesAttached: true,
          attachedNames: [],
          inputNames: [],
          fileCount: 0,
        },
      },
    });
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    await expect(waitForAttachmentCompletion(runtime, 200)).resolves.toBeUndefined();

    const call = evaluate.mock.calls[0]?.[0] as { expression?: string } | undefined;
    const expression = String(call?.expression ?? "");
    expect(expression).toContain("composerScope !== document");
    expect(expression).toContain("composerScope !== document.body");
    expect(expression).not.toContain("document.querySelectorAll(fileCountSelectors)");
  });

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
