import { browserPromptFingerprint } from "../../src/browser/promptFingerprint.js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionMetadata } from "../../src/sessionStore.js";

const getPaths = async () => ({
  dir: path.join(os.tmpdir(), `oracle-recovery-mock-${randomUUID()}`),
});

const baseMeta = {
  id: "sess-recover",
  createdAt: "2026-05-26T00:00:00.000Z",
  status: "completed",
  options: {},
  mode: "browser",
  cwd: "/tmp/recover-cwd",
  browser: {
    config: {
      manualLogin: true,
      manualLoginProfileDir: "/tmp/recover-profile",
    },
    runtime: {
      chromeHost: "127.0.0.1",
      chromePort: 9223,
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
    },
  },
} as unknown as SessionMetadata;

const completedHarvest = {
  targetId: "target-x",
  url: "https://chatgpt.com/c/saved-conversation",
  conversationId: "saved-conversation",
  state: "completed",
  authenticated: true,
  stopExists: false,
  sendExists: true,
  assistantCount: 1,
  currentModelLabel: "GPT-5.5 Pro",
  assistantFollowsLatestUser: true,
  lastAssistantTurnIndex: 1,
  lastUserTurnIndex: 0,
  lastUserMessageId: "current-message",
  lastAssistantMarkdown: "## Recovered answer\n\nFull response captured.",
  lastAssistantText: "Recovered answer. Full response captured.",
  lastAssistantSnippet: "Recovered answer.",
  lastUserText: "original prompt",
  lastUserSnippet: "original prompt",
} as const;

describe("harvestSessionBrowserOutput recovery fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
  });

  test("retries via recoverConversationTab when initial harvest finds no live tab", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('No ChatGPT tab matched "https://chatgpt.com/c/saved-conversation".'),
      )
      .mockResolvedValueOnce(completedHarvest);

    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    const recoverConversationTab = vi.fn(async (meta: SessionMetadata) => ({
      host: "127.0.0.1",
      port: 53999,
      url: meta.browser?.runtime?.tabUrl ?? "",
      ref: "saved-conversation",
      chrome: fakeChrome,
    }));

    const updateSession = vi.fn(async () => {});
    const readSession = vi.fn(async () => baseMeta);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) =>
        url.includes("/c/") ? url.split("/c/")[1] : null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession, updateSession, getPaths },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(recoverConversationTab).toHaveBeenCalledWith(baseMeta, expect.any(Function), {
      existingEndpoint: { host: "127.0.0.1", port: 9223 },
    });
    // After recovery, harvest is retried against the recovered endpoint/url.
    expect(harvestChatGptTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        port: 53999,
        ref: "saved-conversation",
      }),
    );
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
    expect(updateSession).toHaveBeenCalled();
    // Default closeAfterRecover is false — Chrome stays alive for the user.
    expect(fakeChrome.kill).not.toHaveBeenCalled();
    expect(fakeChrome.process.unref).toHaveBeenCalledTimes(1);
  });

  test("does not recover when recoverIfMissing is false; surfaces the original error", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched stuff"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {}, getPaths },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { recoverIfMissing: false, quietOutput: true }),
    ).rejects.toThrow(/No ChatGPT tab matched/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test("recovers when the endpoint has no live ChatGPT tabs", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("No live ChatGPT tabs found on the configured Chrome DevTools endpoint."),
      )
      .mockResolvedValueOnce(completedHarvest);

    const recoverConversationTab = vi.fn(async () => ({
      host: "127.0.0.1",
      port: 53998,
      url: "https://chatgpt.com/c/saved-conversation",
      ref: "saved-conversation",
      chrome: { kill: vi.fn() },
    }));

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {}, getPaths },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(recoverConversationTab).toHaveBeenCalledTimes(1);
    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
  });

  test("closes the recovered Chrome when closeAfterRecover is true", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched"))
      .mockResolvedValueOnce(completedHarvest);
    const fakeChrome = { kill: vi.fn(), process: { unref: vi.fn() } };
    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 53777,
        url: "https://chatgpt.com/c/saved-conversation",
        ref: "saved-conversation",
        chrome: fakeChrome,
      })),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {}, getPaths },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await harvestSessionBrowserOutput("sess-recover", {
      closeAfterRecover: true,
      quietOutput: true,
    });
    expect(fakeChrome.kill).toHaveBeenCalledTimes(1);
    expect(fakeChrome.process.unref).not.toHaveBeenCalled();
  });

  test("does not recover an explicit browser tab override", async () => {
    const harvestChatGptTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("No ChatGPT tab matched explicit-ref"));
    const recoverConversationTab = vi.fn();

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab,
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: { readSession: async () => baseMeta, updateSession: async () => {}, getPaths },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", {
        browserTabRef: "explicit-ref",
        quietOutput: true,
      }),
    ).rejects.toThrow(/explicit-ref/);
    expect(recoverConversationTab).not.toHaveBeenCalled();
  });

  test.each([
    { reason: "unpaired answer", paired: false, currentIndex: 0 },
    { reason: "earlier identical prompt", paired: true, currentIndex: 2 },
  ])("waits instead of harvesting a stale turn ($reason)", async ({ paired, currentIndex }) => {
    const staleHarvest = {
      ...completedHarvest,
      lastUserText: "Current neutral request with the latest constraints",
      lastUserSnippet: "Current neutral request",
      lastAssistantText: "Older answer",
      lastAssistantMarkdown: "Older answer",
      assistantFollowsLatestUser: paired,
      lastUserMessageId: "old-message",
    };
    const freshHarvest = {
      ...completedHarvest,
      lastUserTurnIndex: currentIndex,
      lastAssistantTurnIndex: currentIndex + 1,
      lastUserText: "Current neutral request with the latest constraints",
      lastUserSnippet: "Current neutral request",
    };
    const harvestChatGptTab = vi
      .fn()
      .mockResolvedValueOnce(staleHarvest)
      .mockResolvedValueOnce(freshHarvest);

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => "saved-conversation",
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => ({
          ...baseMeta,
          options: { prompt: "Current neutral request with the latest constraints" },
          browser: {
            ...baseMeta.browser,
            runtime: {
              ...baseMeta.browser?.runtime,
              submittedPromptHash: browserPromptFingerprint(
                "Current neutral request with the latest constraints",
                "current-message",
              ),
            },
          },
        }),
        updateSession: async () => {},
        getPaths,
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
  });

  test("allows hydration beyond five seconds within the configured input timeout", async () => {
    vi.useFakeTimers();
    try {
      const staleHarvest = {
        ...completedHarvest,
        lastUserText: "An older neutral request",
        lastUserSnippet: "An older neutral request",
      };
      const freshHarvest = {
        ...completedHarvest,
        lastUserText: "Current neutral request",
        lastUserSnippet: "Current neutral request",
      };
      let calls = 0;
      const harvestChatGptTab = vi.fn(async () => {
        calls += 1;
        return calls < 26 ? staleHarvest : freshHarvest;
      });

      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: () => "saved-conversation",
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        recoverConversationTab: vi.fn(),
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: async () => ({
            ...baseMeta,
            options: { prompt: "Current neutral request" },
            browser: {
              ...baseMeta.browser,
              config: { ...baseMeta.browser?.config, inputTimeoutMs: 10_000 },
              runtime: {
                ...baseMeta.browser?.runtime,
                submittedPromptHash: browserPromptFingerprint(
                  "Current neutral request",
                  "current-message",
                ),
              },
            },
          }),
          updateSession: async () => {},
          getPaths,
        },
      }));

      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      const promise = harvestSessionBrowserOutput("sess-recover", { quietOutput: true });
      const assertion = expect(promise).resolves.toMatchObject({
        lastAssistantMarkdown: completedHarvest.lastAssistantMarkdown,
      });
      await vi.advanceTimersByTimeAsync(6_500);
      await assertion;
      expect(harvestChatGptTab).toHaveBeenCalledTimes(26);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    [undefined, "Yes"],
    [0, "Initial neutral request"],
    [1, "Challenge the recommendation"],
    [2, "Yes"],
  ])(
    "matches recovery to submitted follow-up progress %s",
    async (submittedCount, finalFollowUp) => {
      const harvestChatGptTab = vi
        .fn()
        .mockResolvedValueOnce({
          ...completedHarvest,
          lastUserText: String(finalFollowUp).toLowerCase(),
          lastUserSnippet: "Yesterday's unrelated neutral request",
          lastAssistantText: "Unrelated answer",
          lastAssistantMarkdown: "Unrelated answer",
        })
        .mockResolvedValueOnce({
          ...completedHarvest,
          lastUserText: finalFollowUp,
          lastUserSnippet: finalFollowUp,
        });

      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: () => "saved-conversation",
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        recoverConversationTab: vi.fn(),
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: async () => ({
            ...baseMeta,
            options: {
              prompt: "Initial neutral request",
              browserFollowUps: ["Challenge the recommendation", "Yes", "  "],
            },
            browser: {
              ...baseMeta.browser,
              runtime: {
                ...baseMeta.browser?.runtime,
                submittedPromptHash:
                  submittedCount === undefined
                    ? undefined
                    : browserPromptFingerprint(finalFollowUp, "current-message"),
              },
            },
          }),
          updateSession: async () => {},
          getPaths,
        },
      }));

      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

      expect(harvestChatGptTab).toHaveBeenCalledTimes(submittedCount === undefined ? 1 : 2);
      expect(result.lastAssistantMarkdown).toBe(
        submittedCount === undefined ? "Unrelated answer" : completedHarvest.lastAssistantMarkdown,
      );
      if (submittedCount === undefined)
        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining("Legacy browser session"),
        );
    },
  );

  test.each([
    "### File 1: example.ts\n```typescript\nconst example = 1;\n```",
    "File 1: example.ts\nconst example = 1;",
    "The attached `attachments-bundle.zip` contains 2 selected files with relative paths preserved. Extract it into a temporary directory, then inspect the resulting file tree with filesystem and search tools before answering.",
    "The attached attachments-bundle-1.zip contains 1 selected file with relative paths preserved. Extract it into a temporary directory, then inspect the resulting file tree with filesystem and search tools before answering.",
  ])("preserves unverified legacy file context: %s", async (contextSuffix) => {
    const harvestChatGptTab = vi.fn().mockResolvedValue({
      ...completedHarvest,
      lastUserText: `Use the public context only\n\nInitial neutral request\n\n${contextSuffix}`,
      lastUserSnippet: "Use the public context only",
    });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => "saved-conversation",
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => ({
          ...baseMeta,
          options: {
            prompt: "Initial neutral request",
            file: ["example.ts"],
            system: "Use the public context only",
          },
        }),
        updateSession: async () => {},
        getPaths,
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    const result = await harvestSessionBrowserOutput("sess-recover", { quietOutput: true });

    expect(harvestChatGptTab).toHaveBeenCalledTimes(1);
    expect(result.lastAssistantMarkdown).toBe(completedHarvest.lastAssistantMarkdown);
  });

  test.each([
    ["Explain\n```python\nprint(1)\n```", "Explain python print(1)"],
    ["# Heading\n\n**Important** [spec](https://example.com)", "Heading\nImportant spec"],
    ["- Alpha\n- Beta", "Alpha\nBeta"],
    ["1. Alpha\n2. Beta", "Alpha\nBeta"],
    ["> Quote\n\n*Emphasis*", "Quote\nEmphasis"],
  ])("preserves unverified legacy Markdown recovery: %s", async (sourcePrompt, renderedPrompt) => {
    const harvestChatGptTab = vi.fn().mockResolvedValue({
      ...completedHarvest,
      lastUserText: renderedPrompt.replace(/\n/g, ""),
      lastUserSnippet: renderedPrompt,
    });

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: () => "saved-conversation",
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => ({
          ...baseMeta,
          options: { prompt: sourcePrompt },
        }),
        updateSession: async () => {},
        getPaths,
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", { quietOutput: true }),
    ).resolves.toMatchObject({ lastUserText: renderedPrompt.replace(/\n/g, "") });
    expect(harvestChatGptTab).toHaveBeenCalledTimes(1);
  });

  test("preserves explicit alternate-tab inspection while requiring a paired answer", async () => {
    const explicitHarvest = {
      ...completedHarvest,
      targetId: "explicit-target",
      url: "https://chatgpt.com/c/alternate-conversation",
      conversationId: "alternate-conversation",
      lastUserText: "A different explicit prompt",
      lastUserSnippet: "A different explicit prompt",
    };
    const harvestChatGptTab = vi.fn().mockResolvedValue(explicitHarvest);
    const updateSession = vi.fn(async () => {});

    vi.doMock("../../src/browser/liveTabs.js", () => ({
      collectChatGptTabs: vi.fn(),
      DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
      DEFAULT_REMOTE_CHROME_PORT: 9222,
      extractConversationIdFromUrl: (url: string) => url.split("/c/")[1] ?? null,
      formatBrowserTabState: () => "completed",
      harvestChatGptTab,
      sessionMatchesTab: () => false,
    }));
    vi.doMock("../../src/browser/recoverConversation.js", () => ({
      recoverConversationTab: vi.fn(),
    }));
    vi.doMock("../../src/sessionStore.js", () => ({
      sessionStore: {
        readSession: async () => ({
          ...baseMeta,
          options: { prompt: "The original session prompt" },
        }),
        updateSession,
        getPaths,
      },
    }));

    const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
    await expect(
      harvestSessionBrowserOutput("sess-recover", {
        browserTabRef: "explicit-target",
        quietOutput: true,
      }),
    ).resolves.toMatchObject({ conversationId: "alternate-conversation" });
    expect(harvestChatGptTab).toHaveBeenCalledTimes(1);
    expect(updateSession).toHaveBeenCalled();
  });

  test("waits for a paired answer on an explicit alternate tab without matching the old prompt", async () => {
    vi.useFakeTimers();
    try {
      const explicitHarvest = {
        ...completedHarvest,
        targetId: "explicit-target",
        url: "https://chatgpt.com/c/alternate-conversation",
        conversationId: "alternate-conversation",
        lastUserText: "A different explicit prompt",
        lastUserSnippet: "A different explicit prompt",
      };
      const harvestChatGptTab = vi
        .fn()
        .mockResolvedValueOnce({ ...explicitHarvest, assistantFollowsLatestUser: false })
        .mockResolvedValueOnce(explicitHarvest);

      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: (url: string) => url.split("/c/")[1] ?? null,
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        recoverConversationTab: vi.fn(),
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: async () => ({
            ...baseMeta,
            options: { prompt: "The original session prompt" },
          }),
          updateSession: async () => {},
          getPaths,
        },
      }));

      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      const result = harvestSessionBrowserOutput("sess-recover", {
        browserTabRef: "explicit-target",
        quietOutput: true,
      });
      const assertion = expect(result).resolves.toMatchObject({
        conversationId: "alternate-conversation",
        assistantFollowsLatestUser: true,
      });
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
      expect(harvestChatGptTab).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    "An older neutral request",
    "Current neutral requester",
    "Current neutral request about something else",
  ])("fails closed without persisting a mismatched prompt: %s", async (observedPrompt) => {
    vi.useFakeTimers();
    try {
      const harvestChatGptTab = vi.fn().mockResolvedValue({
        ...completedHarvest,
        lastUserText: observedPrompt,
        lastUserSnippet: observedPrompt,
        lastAssistantText: "Older answer",
        lastAssistantMarkdown: "Older answer",
      });
      const updateSession = vi.fn(async () => {});

      vi.doMock("../../src/browser/liveTabs.js", () => ({
        collectChatGptTabs: vi.fn(),
        DEFAULT_REMOTE_CHROME_HOST: "127.0.0.1",
        DEFAULT_REMOTE_CHROME_PORT: 9222,
        extractConversationIdFromUrl: () => "saved-conversation",
        formatBrowserTabState: () => "completed",
        harvestChatGptTab,
        sessionMatchesTab: () => false,
      }));
      vi.doMock("../../src/browser/recoverConversation.js", () => ({
        recoverConversationTab: vi.fn(),
      }));
      vi.doMock("../../src/sessionStore.js", () => ({
        sessionStore: {
          readSession: async () => ({
            ...baseMeta,
            options: { prompt: "Current neutral request" },
            browser: {
              ...baseMeta.browser,
              config: { ...baseMeta.browser?.config, inputTimeoutMs: 750 },
              runtime: {
                ...baseMeta.browser?.runtime,
                submittedPromptHash: browserPromptFingerprint(
                  "Current neutral request",
                  "current-message",
                ),
              },
            },
          }),
          updateSession,
          getPaths,
        },
      }));

      const { harvestSessionBrowserOutput } = await import("../../src/cli/browserTabs.js");
      const promise = harvestSessionBrowserOutput("sess-recover", { quietOutput: true });
      const assertion = expect(promise).rejects.toThrow(/refusing to harvest stale output/i);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(harvestChatGptTab).toHaveBeenCalledTimes(4);
      expect(updateSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
