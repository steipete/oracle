import { describe, expect, test, vi } from "vitest";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import {
  continueBrowserSession,
  resumeBrowserSession,
  __test__,
} from "../../src/browser/reattach.js";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";

type FakeTarget = { targetId?: string; type?: string; url?: string };
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

describe("resumeBrowserSession", () => {
  test("selects target and captures markdown via stubs", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "Hello PATH plan",
      html: "",
      meta: { messageId: "m1", turnId: "conversation-turn-1" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "markdown response");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await resumeBrowserSession(runtime, { timeoutMs: 2000 }, logger, {
      listTargets,
      connect,
      waitForAssistantResponse,
      captureAssistantMarkdown,
    });

    expect(result.answerMarkdown).toBe("markdown response");
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 51559, target: "target-1" }),
    );
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(captureAssistantMarkdown).toHaveBeenCalled();
  });

  test("falls back to recovery when chrome port is missing", async () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/abc",
    };
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { recoverSession });

    expect(result.answerMarkdown).toBe("fallback-md");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("falls back to recovery when existing chrome attach fails", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
    };
    const listTargets = vi.fn(async () => {
      throw new Error("no targets");
    }) as unknown as () => Promise<FakeTarget[]>;
    const recoverSession = vi.fn(async () => ({
      answerText: "fallback",
      answerMarkdown: "fallback-md",
    }));
    const logger = vi.fn() as BrowserLogger;

    const result = await resumeBrowserSession(runtime, {}, logger, { listTargets, recoverSession });

    expect(result.answerText).toBe("fallback");
    expect(recoverSession).toHaveBeenCalled();
  });

  test("continues an existing chrome conversation with a new prompt", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      { prompt: "Follow up on the implementation." },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(ensurePromptReady).toHaveBeenCalled();
    expect(clearPromptComposer).toHaveBeenCalled();
    expect(submitPrompt).toHaveBeenCalled();
    expect(waitForAssistantResponse).toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
    expect(result.runtime?.conversationId).toBe("abc");
  });

  test("uploads attachments during follow-up prompts", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [
          { targetId: "target-1", type: "page", url: runtime.tabUrl },
          { targetId: "target-2", type: "page", url: "about:blank" },
        ] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi.fn(async () => 3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "supervisor response",
      html: "",
      meta: { messageId: "m2", turnId: "conversation-turn-2" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "supervisor markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Review these files.",
        attachments: [{ path: "/tmp/context.zip", displayPath: "context.zip", sizeBytes: 4 }],
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(clearComposerAttachments).toHaveBeenCalled();
    expect(uploadAttachmentFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ displayPath: "context.zip" }),
      logger,
      { expectedCount: 1 },
    );
    expect(waitForAttachmentCompletion).toHaveBeenCalled();
    expect(waitForUserTurnAttachments).toHaveBeenCalledWith(
      expect.anything(),
      ["context.zip"],
      20_000,
      logger,
    );
    expect(submitPrompt).toHaveBeenCalled();
    expect(result.answerMarkdown).toBe("supervisor markdown");
  });

  test("retries follow-up with uploaded attachments when inline prompt is too large", async () => {
    const runtime = {
      chromePort: 51559,
      chromeHost: "127.0.0.1",
      chromeTargetId: "target-1",
      tabUrl: "https://chatgpt.com/c/abc",
      conversationId: "abc",
    };
    const listTargets = vi.fn(
      async () =>
        [{ targetId: "target-1", type: "page", url: runtime.tabUrl }] satisfies FakeTarget[],
    ) as unknown as () => Promise<FakeTarget[]>;
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
      if (expression === "location.href") {
        return { result: { value: runtime.tabUrl } };
      }
      if (expression === "1+1") {
        return { result: { value: 2 } };
      }
      return { result: { value: null } };
    });
    const connect = vi.fn(
      async () =>
        ({
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Runtime: { enable: vi.fn(), evaluate },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          DOM: { enable: vi.fn() },
          // biome-ignore lint/style/useNamingConvention: mirrors DevTools protocol domain names
          Input: {},
          close: vi.fn(async () => {}),
        }) satisfies FakeClient,
    ) as unknown as (options?: unknown) => Promise<ChromeClient>;
    const ensurePromptReady = vi.fn(async () => {});
    const clearPromptComposer = vi.fn(async () => {});
    const clearComposerAttachments = vi.fn(async () => {});
    const uploadAttachmentFile = vi.fn(async () => true);
    const waitForAttachmentCompletion = vi.fn(async () => {});
    const waitForUserTurnAttachments = vi.fn(async () => true);
    const submitPrompt = vi
      .fn()
      .mockRejectedValueOnce(
        new BrowserAutomationError("too large", { code: "prompt-too-large", stage: "submit" }),
      )
      .mockResolvedValueOnce(3);
    const waitForAssistantResponse = vi.fn(async () => ({
      text: "retry response",
      html: "",
      meta: { messageId: "m3", turnId: "conversation-turn-3" },
    }));
    const captureAssistantMarkdown = vi.fn(async () => "retry markdown");
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;

    const result = await continueBrowserSession(
      runtime,
      { timeoutMs: 2_000, inputTimeoutMs: 1_000 },
      logger,
      {
        prompt: "Huge inline context",
        fallbackSubmission: {
          prompt: "Fallback with uploads",
          attachments: [{ path: "/tmp/fallback.zip", displayPath: "fallback.zip", sizeBytes: 4 }],
        },
      },
      {
        listTargets,
        connect,
        ensurePromptReady,
        clearPromptComposer,
        clearComposerAttachments,
        uploadAttachmentFile,
        waitForAttachmentCompletion,
        waitForUserTurnAttachments,
        submitPrompt,
        waitForAssistantResponse,
        captureAssistantMarkdown,
      },
    );

    expect(submitPrompt).toHaveBeenCalledTimes(2);
    expect(uploadAttachmentFile).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ displayPath: "fallback.zip" }),
      logger,
      { expectedCount: 1 },
    );
    const loggerCalls = (logger as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(loggerCalls.some((call) => String(call[0]).includes("retrying with file uploads"))).toBe(
      true,
    );
    expect(result.answerMarkdown).toBe("retry markdown");
  });
});

describe("reattach helpers", () => {
  const {
    pickTarget,
    extractConversationIdFromUrl,
    buildConversationUrl,
    mergeRuntimeMetadata,
    openConversationFromSidebar,
  } = __test__;
  type EvaluateParams = { expression: string };
  type EvaluateResult<T> = { result: { value: T } };

  test("extracts conversation id from a chat URL", () => {
    expect(extractConversationIdFromUrl("https://chatgpt.com/c/abc-123")).toBe("abc-123");
    expect(extractConversationIdFromUrl("")).toBeUndefined();
  });

  test("builds conversation URL from tabUrl or conversationId", () => {
    expect(
      buildConversationUrl(
        { tabUrl: "https://chatgpt.com/c/live", conversationId: "ignored" },
        "https://chatgpt.com/",
      ),
    ).toBe("https://chatgpt.com/c/live");
    expect(buildConversationUrl({ conversationId: "abc" }, "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc",
    );
  });

  test("mergeRuntimeMetadata refreshes runtime hints after relaunch", () => {
    expect(
      mergeRuntimeMetadata(
        {
          chromePid: 11,
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/tmp/old",
          tabUrl: "https://chatgpt.com/c/old",
        },
        {
          chromePid: 22,
          chromePort: 9333,
          userDataDir: "/tmp/new",
          tabUrl: "https://chatgpt.com/c/new",
          controllerPid: 44,
        },
      ),
    ).toMatchObject({
      chromePid: 22,
      chromePort: 9333,
      userDataDir: "/tmp/new",
      conversationId: "new",
      controllerPid: 44,
    });
  });

  test("pickTarget prefers chromeTargetId, then tabUrl, then first page", () => {
    const targets = [
      { targetId: "t-1", type: "page", url: "https://chatgpt.com/c/first" },
      { targetId: "t-2", type: "page", url: "https://chatgpt.com/c/second" },
      { targetId: "t-3", type: "page", url: "about:blank" },
    ];
    expect(pickTarget(targets, { chromeTargetId: "t-2" })).toEqual(targets[1]);
    expect(pickTarget(targets, { tabUrl: "https://chatgpt.com/c/first" })).toEqual(targets[0]);
    expect(pickTarget(targets, {})).toEqual(targets[0]);
  });

  test("openConversationFromSidebar passes conversationId and projects preference", async () => {
    const evaluate = vi.fn<
      (
        params: EvaluateParams,
      ) => Promise<EvaluateResult<{ ok: boolean; href?: string; count: number }>>
    >(async () => ({
      result: { value: { ok: true, href: "https://chatgpt.com/c/abc", count: 3 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, {
      conversationId: "abc",
      preferProjects: true,
    });

    expect(ok).toBe(true);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain('const conversationId = "abc"');
    expect(call?.expression).toContain("const preferProjects = true");
  });

  test("openConversationFromSidebar handles missing conversationId", async () => {
    const evaluate = vi.fn<
      (params: EvaluateParams) => Promise<EvaluateResult<{ ok: boolean; count: number }>>
    >(async () => ({
      result: { value: { ok: false, count: 0 } },
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];

    const ok = await openConversationFromSidebar(runtime, { preferProjects: false });

    expect(ok).toBe(false);
    const call = evaluate.mock.calls[0]?.[0] as EvaluateParams | undefined;
    expect(call?.expression).toContain("const conversationId = null");
    expect(call?.expression).toContain("const preferProjects = false");
  });
});
