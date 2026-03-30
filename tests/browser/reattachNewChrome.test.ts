import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeClient = {
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Runtime: {
    enable: () => void;
    evaluate: (params: {
      expression: string;
      returnByValue?: boolean;
    }) => Promise<{ result: { value: unknown } }>;
  };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  DOM: { enable: () => void };
  // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
  Input: Record<string, never>;
  close: () => Promise<void> | void;
};

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("continueBrowserSession via reopened Chrome", () => {
  test("resumes without resending when observation fails after send", async () => {
    const launchedChrome = {
      pid: 4321,
      port: 9222,
      kill: vi.fn(async () => {}),
    };
    const initialEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/abc" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const initialClient = {
      Runtime: { enable: vi.fn(), evaluate: initialEvaluate },
      DOM: { enable: vi.fn() },
      Input: {},
      close: vi.fn(async () => {}),
    } satisfies FakeClient;
    const launchChrome = vi.fn(async () => launchedChrome);
    const connectToChrome = vi.fn(async () => initialClient) as unknown as (
      port: number,
      logger: BrowserLogger,
      host?: string,
    ) => Promise<ChromeClient>;
    const hideChromeWindow = vi.fn(async () => {});
    const navigateToChatGPT = vi.fn(async () => {});
    const ensureNotBlocked = vi.fn(async () => {});
    const ensureLoggedIn = vi.fn(async () => {});
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);

    vi.doMock("../../src/browser/chromeLifecycle.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
        "../../src/browser/chromeLifecycle.js",
      );
      return { ...original, launchChrome, connectToChrome, hideChromeWindow };
    });
    vi.doMock("../../src/browser/pageActions.js", async () => {
      const original = await vi.importActual<typeof import("../../src/browser/pageActions.js")>(
        "../../src/browser/pageActions.js",
      );
      return {
        ...original,
        navigateToChatGPT,
        ensureNotBlocked,
        ensureLoggedIn,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      };
    });

    const { continueBrowserSession } = await import("../../src/browser/reattach.js");
    const resumeEvaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: "https://chatgpt.com/c/abc" } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const resumeConnect = vi.fn(
      async () =>
        ({
          Runtime: { enable: vi.fn(), evaluate: resumeEvaluate },
          DOM: { enable: vi.fn() },
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({
        text: "supervisor response",
        html: "",
        meta: { messageId: "m2", turnId: "conversation-turn-2" },
      });
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const listTargets = vi.fn(async () => [
      { targetId: "target-1", type: "page", url: "https://chatgpt.com/c/abc" },
    ]);
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      {
        tabUrl: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      },
      { timeoutMs: 2_000, inputTimeoutMs: 1_000, modelStrategy: "ignore" },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect: resumeConnect,
        waitForAssistantResponse,
        captureAssistantMarkdown,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(waitForAssistantResponse).toHaveBeenCalledTimes(2);
    expect(launchChrome).toHaveBeenCalledTimes(1);
    expect(connectToChrome).toHaveBeenCalledTimes(1);
    expect(resumeConnect).toHaveBeenCalledTimes(1);
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });
});
