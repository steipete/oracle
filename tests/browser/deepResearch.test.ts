import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock delay to resolve instantly in tests
vi.mock("../../src/browser/utils.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    delay: vi.fn(() => Promise.resolve()),
  };
});

import {
  activateDeepResearch,
  buildActivateDeepResearchExpressionForTest,
  buildDeepResearchFrameStatusExpressionForTest,
  findDeepResearchFrameIdForTest,
  isDeepResearchPlaceholderTextForTest,
  waitForResearchPlanAutoConfirm,
  waitForDeepResearchCompletion,
  checkDeepResearchStatus,
} from "../../src/browser/actions/deepResearch.js";
import type { BrowserLogger } from "../../src/browser/types.js";

function createMockRuntime() {
  return {
    evaluate: vi.fn(),
  };
}

function createMockLogger(): BrowserLogger {
  const fn = vi.fn() as BrowserLogger;
  fn.verbose = false;
  fn.sessionLog = vi.fn();
  return fn;
}

describe("activateDeepResearch", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockInput: Record<string, unknown>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockInput = {};
    mockLogger = createMockLogger();
  });

  it("activates Deep Research when all steps succeed", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "activated" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith("Deep Research mode activated");
  });

  it("returns early when already active", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "already-active" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith("Deep Research mode already active");
  });

  it("throws when plus button is missing", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "plus-button-missing" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/composer plus button/);
  });

  it("throws with available options when Deep Research item missing", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          status: "dropdown-item-missing",
          available: ["Create image", "Web search"],
        },
      },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/not found.*Create image/);
  });

  it("throws when pill does not confirm", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "pill-not-confirmed" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/pill did not appear/);
  });

  it("throws on unexpected result", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { status: "unknown-status" } },
    });
    await expect(
      activateDeepResearch(mockRuntime as never, mockInput as never, mockLogger),
    ).rejects.toThrow(/Unexpected result/);
  });
});

describe("Deep Research activation expression", () => {
  it("prefers the slash command and keeps the plus-menu fallback", () => {
    const expression = buildActivateDeepResearchExpressionForTest();

    expect(expression).toContain("/Deepresearch");
    expect(expression).toContain("findDeepResearchItem");
    expect(expression).toContain("composer-plus-btn");
    expect(expression).toContain('role="menuitemradio"');
    expect(expression).toContain('[class*="composer-pill"]');
    expect(expression).toContain("deep research");
    expect(expression).toContain("already-active");
  });
});

describe("isDeepResearchPlaceholderTextForTest", () => {
  it("rejects tool-call stubs as final reports", () => {
    expect(isDeepResearchPlaceholderTextForTest("Called tool")).toBe(true);
    expect(isDeepResearchPlaceholderTextForTest("Użyto narzędzia")).toBe(true);
    expect(isDeepResearchPlaceholderTextForTest("CHECK_DEEP_OK https://example.com")).toBe(false);
  });
});

describe("Deep Research iframe helpers", () => {
  it("finds nested Deep Research frames", () => {
    expect(
      findDeepResearchFrameIdForTest({
        frame: { id: "root", url: "https://chatgpt.com/" },
        childFrames: [
          { frame: { id: "other", url: "https://example.com/" } },
          {
            frame: {
              id: "deep",
              url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
            },
          },
        ],
      }),
    ).toBe("deep");
  });

  it("normalizes completed iframe report text", () => {
    const expression = buildDeepResearchFrameStatusExpressionForTest();
    expect(expression).toContain("deep research report");
    expect(expression).toContain("research completed");
    expect(expression).toContain("reportText");
  });
});

describe("waitForResearchPlanAutoConfirm", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockLogger = createMockLogger();
  });

  it("detects research plan via iframe and waits for auto-confirm", async () => {
    // Phase A: plan detected via iframe
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { hasResearchIframe: true, hasResearchText: false } },
    });
    // Phase B: research started
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasLargeIframe: false, isResearching: true } },
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as never, mockLogger, 1_000),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining("Research plan detected"));
  });

  it("detects research plan via text content", async () => {
    // Phase A: plan detected via text
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: { hasResearchIframe: false, hasResearchText: true } },
    });
    // Phase B: research started
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasLargeIframe: false, isResearching: true } },
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as never, mockLogger, 1_000),
    ).resolves.toBeUndefined();
  });

  it("handles plan not detected gracefully", async () => {
    // All polls: nothing detected — use short timeout to avoid slow test
    mockRuntime.evaluate.mockResolvedValue({
      result: { value: { hasResearchIframe: false, hasResearchText: false } },
    });

    // Override planDeadline by passing very short auto-confirm wait
    // The function internally waits up to 60s for plan detection;
    // we can't easily shorten that, so we rely on the implementation
    // returning gracefully when plan isn't found.
    // Since the plan detection polls every 2s for up to 60s, this test
    // would be slow. Instead, test that the function handles the timeout path.
    // We'll use a trick: mock Date.now to advance time quickly.
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    vi.spyOn(Date, "now").mockImplementation(() => {
      fakeNow += 30_000; // Jump 30s each call
      return fakeNow;
    });

    await expect(
      waitForResearchPlanAutoConfirm(mockRuntime as never, mockLogger, 100),
    ).resolves.toBeUndefined();
    expect(mockLogger).toHaveBeenCalledWith(expect.stringContaining("not detected"));

    vi.spyOn(Date, "now").mockRestore();
  });
});

describe("waitForDeepResearchCompletion", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockLogger = createMockLogger();
  });

  it("detects completion via finished actions", async () => {
    // First poll: still in progress
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: true, textLength: 100, hasIframe: true },
      },
    });
    // Second poll: completed
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false },
      },
    });
    // extractDeepResearchResult → readAssistantSnapshot
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          text: "Research report content",
          html: "<p>Research report content</p>",
          turnId: "t1",
          messageId: "m1",
        },
      },
    });
    // extractDeepResearchResult → captureAssistantMarkdown (copy button click)
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: null },
    });

    const result = await waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000);
    expect(result.text).toBe("Research report content");
  });

  it("detects completion via the Deep Research iframe", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          completed: true,
          inProgress: false,
          textLength: 80,
          text: "CHECK_DEEP_OK https://example.com/report",
          html: "<p>CHECK_DEEP_OK https://example.com/report</p>",
        },
      },
    });
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [
            {
              frame: {
                id: "deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
            },
          ],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 42 }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      0,
      mockPage as never,
    );

    expect(result.text).toBe("CHECK_DEEP_OK https://example.com/report");
    expect(mockPage.createIsolatedWorld).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: "deep-frame" }),
    );
    expect(mockRuntime.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextId: 42 }),
    );
  });

  it("detects completion via a Deep Research target session", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
      },
    });
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach") {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "deep-session",
            targetInfo: {
              type: "iframe",
              url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
            },
          });
          return {};
        }
        if (method === "Target.getTargets") {
          return { targetInfos: [] };
        }
        if (method === "Page.getFrameTree" && sessionId === "deep-session") {
          return {
            frameTree: {
              frame: {
                id: "sandbox",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
              childFrames: [
                {
                  frame: {
                    id: "root-frame",
                    name: "root",
                    url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
                  },
                },
              ],
            },
          };
        }
        if (method === "Page.createIsolatedWorld" && sessionId === "deep-session") {
          return {
            executionContextId: (params as { frameId?: string }).frameId === "root-frame" ? 12 : 11,
          };
        }
        if (
          method === "Runtime.evaluate" &&
          sessionId === "deep-session" &&
          (params as { contextId?: number }).contextId === 12
        ) {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "CHECK_DEEP_OK https://example.com/report",
              },
            },
          };
        }
        return {};
      }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      0,
      undefined,
      mockClient as never,
    );

    expect(result.text).toBe("CHECK_DEEP_OK https://example.com/report");
    expect(mockClient.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ contextId: 12, returnByValue: true }),
      "deep-session",
    );
  });

  it("throws on timeout with metadata", async () => {
    // All polls: never completed
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: { finished: false, stopVisible: true, textLength: 500, hasIframe: true },
      },
    });

    // Use very short timeout
    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 100),
    ).rejects.toThrow(/did not complete/);
  });
});

describe("checkDeepResearchStatus", () => {
  let mockRuntime: ReturnType<typeof createMockRuntime>;
  let mockLogger: BrowserLogger;

  beforeEach(() => {
    mockRuntime = createMockRuntime();
    mockLogger = createMockLogger();
  });

  it("reports completed when finished actions visible", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { completed: true, inProgress: false, hasIframe: false, textLength: 5000 },
      },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(true);
    expect(status.inProgress).toBe(false);
    expect(status.textLength).toBe(5000);
  });

  it("reports in-progress when iframe present", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { completed: false, inProgress: true, hasIframe: true, textLength: 0 },
      },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(false);
    expect(status.inProgress).toBe(true);
    expect(status.hasIframe).toBe(true);
  });

  it("handles undefined result gracefully", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: { value: undefined },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(false);
    expect(status.inProgress).toBe(false);
    expect(status.textLength).toBe(0);
  });
});
