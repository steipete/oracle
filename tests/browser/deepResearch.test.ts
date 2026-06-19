import { describe, expect, it, vi, beforeEach } from "vitest";
import vm from "node:vm";

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
  buildDeepResearchCompletionPollExpressionForTest,
  buildDeepResearchFrameStatusExpressionForTest,
  buildDeepResearchStatusExpressionForTest,
  captureDeepResearchTargetKeys,
  filterIncompleteDeepResearchReadForTest,
  findDeepResearchFrameIdForTest,
  isConfirmedDeepResearchTargetForTest,
  isDeepResearchPlaceholderTextForTest,
  pickPreferredDeepResearchReadForTest,
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

function createFrameOwnerClient(
  ownerTurnIndex: number | null | ((frameId: string) => number | null),
) {
  let currentFrameId = "";
  return {
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getFrameOwner") {
        currentFrameId = String(params?.frameId ?? "");
        return { backendNodeId: 7 };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "frame-owner" } };
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value:
              typeof ownerTurnIndex === "function"
                ? ownerTurnIndex(currentFrameId)
                : ownerTurnIndex,
          },
        };
      }
      return {};
    }),
  };
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

  it("rejects Deep Research planning and status captures", () => {
    expect(
      isDeepResearchPlaceholderTextForTest(
        "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      ),
    ).toBe(true);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "<system-reminder>\n# Plan Mode - System Reminder\nDo not make edits.\n</system-reminder>",
      ),
    ).toBe(true);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "The final report explains why the Stop research control can remain visible.",
      ),
    ).toBe(false);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "# UI findings\n\nThe control can remain visible after completion:\n\nStop research\n\nThis is the defect.",
      ),
    ).toBe(false);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "# Evidence\n\nThe captured panel ended with:\n\nDetermining steps for creating a report...\nStop research\n\nThat was not a final report.",
      ),
    ).toBe(false);
    expect(
      isDeepResearchPlaceholderTextForTest(
        "# Evidence\n\nThis completed report quotes the two final UI lines.\n\nDetermining steps for creating a report...\nStop research",
      ),
    ).toBe(false);
  });
});

describe("Deep Research iframe helpers", () => {
  it("downgrades incomplete iframe content from completed to in-progress", () => {
    expect(
      filterIncompleteDeepResearchReadForTest({
        completed: true,
        inProgress: false,
        textLength: 120,
        text: "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      }),
    ).toMatchObject({ completed: false, inProgress: true });
  });

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

  it("does not treat an unrelated root iframe as Deep Research", () => {
    expect(
      findDeepResearchFrameIdForTest({
        frame: { id: "other", name: "root", url: "https://example.com/" },
      }),
    ).toBeNull();
  });

  it("confirms target sessions from target metadata or frame-tree evidence", () => {
    expect(
      isConfirmedDeepResearchTargetForTest(
        "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
        { frame: { id: "root", name: "root", url: "about:blank" } },
      ),
    ).toBe(true);
    expect(
      isConfirmedDeepResearchTargetForTest("", {
        frame: {
          id: "deep",
          url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
        },
      }),
    ).toBe(true);
    expect(
      isConfirmedDeepResearchTargetForTest("", {
        frame: { id: "other", name: "root", url: "https://example.com/" },
      }),
    ).toBe(false);
  });

  it("normalizes completed iframe report text", () => {
    const expression = buildDeepResearchFrameStatusExpressionForTest();
    expect(expression).toContain("deep research report");
    expect(expression).toContain("research completed");
    expect(expression).toContain("reportText");
  });

  it("captures completed localized reports without the English report heading", () => {
    const expression = buildDeepResearchFrameStatusExpressionForTest();
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: {
          innerText:
            "Research completed in 44m ·\n" +
            "19\n" +
            "citations ·\n" +
            "328\n" +
            "searches\n" +
            "Audyt możliwości eksportu danych z profilu Steam\n" +
            "Audyt możliwości eksportu danych z profilu Steam\n" +
            "Data audytu: 2026-05-02\n" +
            "Ten raport opisuje dostępne ścieżki eksportu danych profilu Steam.",
          innerHTML: "<article>Audyt możliwości eksportu danych z profilu Steam</article>",
        },
      },
    }) as { completed?: boolean; text?: string; textLength?: number };

    expect(result.completed).toBe(true);
    expect(result.text).toContain("Audyt możliwości eksportu danych z profilu Steam");
    expect(result.text?.match(/Audyt możliwości eksportu danych/g)).toHaveLength(1);
    expect(result.text).not.toContain("Research completed");
    expect(result.text).not.toContain("citations");
    expect(result.text).not.toContain("searches");
    expect(result.textLength).toBeGreaterThan(40);
  });
});

describe("pickPreferredDeepResearchReadForTest", () => {
  const completed = (text: string, len = 80) => ({
    completed: true,
    inProgress: false,
    textLength: len,
    text,
  });
  const inProgress = (len: number) => ({ completed: false, inProgress: true, textLength: len });

  it("returns null when neither read exists", () => {
    expect(pickPreferredDeepResearchReadForTest(null, null)).toBeNull();
  });

  it("prefers a completed target read over an in-progress in-page read", () => {
    expect(pickPreferredDeepResearchReadForTest(completed("TARGET"), inProgress(10))?.text).toBe(
      "TARGET",
    );
  });

  it("prefers the target read when both are completed", () => {
    expect(
      pickPreferredDeepResearchReadForTest(completed("TARGET"), completed("FRAME"))?.text,
    ).toBe("TARGET");
  });

  it("uses a completed in-page read when the target read is missing (legacy inline)", () => {
    expect(pickPreferredDeepResearchReadForTest(null, completed("FRAME"))?.text).toBe("FRAME");
  });

  it("uses a completed in-page read when the target read is only in-progress", () => {
    expect(pickPreferredDeepResearchReadForTest(inProgress(12), completed("FRAME"))?.text).toBe(
      "FRAME",
    );
  });

  it("keeps the best in-progress read for progress when none completed", () => {
    expect(pickPreferredDeepResearchReadForTest(inProgress(12), inProgress(5))?.textLength).toBe(
      12,
    );
    expect(pickPreferredDeepResearchReadForTest(null, inProgress(7))?.textLength).toBe(7);
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

  it("captures only existing targets attached to the current page session", async () => {
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "foreign-session",
              targetInfo: { targetId: "foreign-target", type: "iframe", url: deepResearchUrl },
            },
            "foreign-page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "existing-session",
              targetInfo: { targetId: "existing-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "unrelated-session",
              targetInfo: { targetId: "unrelated-target", type: "iframe", url: "about:blank" },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: {
                id: `${sessionId}-frame`,
                name: "root",
                url: sessionId === "unrelated-session" ? "about:blank" : deepResearchUrl,
              },
            },
          };
        }
        return {};
      }),
    };

    await expect(captureDeepResearchTargetKeys(mockClient as never)).resolves.toEqual([
      "existing-target",
    ]);
  });

  it("rejects an unavailable target baseline instead of trusting an empty scan", async () => {
    const mockClient = {
      on: vi.fn(),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string) => {
        if (method === "Target.setAutoAttach") {
          throw new Error("auto-attach unavailable");
        }
        return {};
      }),
    };

    await expect(captureDeepResearchTargetKeys(mockClient as never)).rejects.toThrow(
      "baseline capture unavailable",
    );
  });

  it("detects completion via finished actions", async () => {
    // First poll: still in progress
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 100,
          hasIframe: true,
          incompleteResult: true,
          researchActivity: true,
        },
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

  it("fails clearly when ChatGPT silently returns a normal response", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 100, hasIframe: false },
      },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000),
    ).rejects.toThrow(/without starting Deep Research/);
  });

  it("does not treat an unscoped page iframe as evidence for a normal response", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: false, stopVisible: true, textLength: 10, hasIframe: true },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 100, hasIframe: true },
      },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000),
    ).rejects.toThrow(/without starting Deep Research/);
  });

  it("does not treat a system reminder as evidence for a normal response", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 100,
          hasIframe: false,
          incompleteResult: true,
          researchActivity: false,
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 100, hasIframe: false },
      },
    });

    await expect(
      waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000),
    ).rejects.toThrow(/without starting Deep Research/);
  });

  it("accepts a finished DOM report after observing a planning panel", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 100,
          hasIframe: false,
          incompleteResult: true,
          researchActivity: true,
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false },
      },
    });
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
    mockRuntime.evaluate.mockResolvedValueOnce({ result: { value: null } });

    const result = await waitForDeepResearchCompletion(mockRuntime as never, mockLogger, 60_000);
    expect(result.text).toBe("Research report content");
  });

  it("accepts a finished DOM report after scoped tool activity", async () => {
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 11,
          hasIframe: true,
          incompleteResult: true,
          researchActivity: true,
          hasActiveScopedResearch: true,
          hasVerifiedScopedResearchActivity: true,
        },
      },
    });
    mockRuntime.evaluate.mockResolvedValueOnce({
      result: {
        value: { finished: true, stopVisible: false, textLength: 5000, hasIframe: false },
      },
    });
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
    mockRuntime.evaluate.mockResolvedValueOnce({ result: { value: null } });

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
      undefined,
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
              frame: { id: "sandbox", name: "root", url: "about:blank" },
            },
          };
        }
        if (
          method === "Runtime.evaluate" &&
          sessionId === "deep-session" &&
          typeof (params as { contextId?: number }).contextId !== "number"
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
      undefined,
      undefined,
      mockClient as never,
    );

    expect(result.text).toBe("CHECK_DEEP_OK https://example.com/report");
    expect(mockClient.send).toHaveBeenCalledWith(
      "Runtime.evaluate",
      expect.objectContaining({ returnByValue: true }),
      "deep-session",
    );
  });

  it("does not return a foreign completed Deep Research report from another tab", async () => {
    // Cross-tab isolation: a shared/persistent Chrome profile can hold another
    // tab's COMPLETED Deep Research report. Target discovery must be scoped to the
    // current Oracle-controlled page (via page-session auto-attach), so the
    // foreign report is never read into this session — even though a browser-wide
    // Target.getTargets scan would surface it.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    let getTargetsCalled = false;
    let foreignAttachCalled = false;
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // Page-scoped auto-attach surfaces only THIS page's OOPIF — still in progress.
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "current-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Target.getTargets") {
          // A foreign tab's COMPLETED report is visible browser-wide; it must be ignored.
          getTargetsCalled = true;
          return {
            targetInfos: [{ targetId: "foreign-target", type: "iframe", url: deepResearchUrl }],
          };
        }
        if (method === "Target.attachToTarget") {
          foreignAttachCalled = true;
          return { sessionId: "foreign-session" };
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "foreign-session" ? 99 : 50 };
        }
        if (method === "Runtime.evaluate" && sessionId === "foreign-session") {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "FOREIGN_REPORT https://example.com/foreign",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "current-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 10, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
        ),
      ).rejects.toThrow(/did not complete/);
      // The foreign target must never be reached, regardless of the browser-wide scan.
      expect(foreignAttachCalled).toBe(false);
      expect(getTargetsCalled).toBe(false);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("binds Target.setAutoAttach to the page session on a session-bound wrapper client", async () => {
    // On the browser-WSEndpoint path, `client` is a session-bound wrapper whose
    // raw `send` is browser-level (only domain methods are session-bound). If
    // auto-attach is issued without the page session id, it attaches browser-wide
    // and a foreign completed Deep Research tab leaks into this session. The fix
    // passes `oraclePageSessionId`; this test asserts every setAutoAttach call is
    // bound to that page session.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    const setAutoAttachSessions: Array<string | undefined> = [];
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      // Marks the session-bound wrapper (createSessionBoundChromeClient).
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          setAutoAttachSessions.push(sessionId);
          // Page-session-scoped: only this page's OOPIF (in progress). If the call
          // were browser-wide (sessionId !== page-session), a foreign completed
          // report would also attach — which the assertions below forbid.
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "current-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          if (sessionId !== "page-session") {
            listeners.get("Target.attachedToTarget")?.({
              sessionId: "foreign-session",
              targetInfo: { type: "iframe", url: deepResearchUrl },
            });
          }
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "foreign-session" ? 99 : 50 };
        }
        if (method === "Runtime.evaluate" && sessionId === "foreign-session") {
          return {
            result: {
              value: { completed: true, inProgress: false, textLength: 80, text: "FOREIGN_REPORT" },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "current-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 10, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
        ),
      ).rejects.toThrow(/did not complete/);
      // Every auto-attach was bound to the page session — never browser-wide.
      expect(setAutoAttachSessions.length).toBeGreaterThan(0);
      expect(setAutoAttachSessions.every((s) => s === "page-session")).toBe(true);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("ignores target events from another page session on the shared browser client", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    const evaluatedSessions: string[] = [];
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // chrome-remote-interface emits every flattened session event to the
          // base listener. Its second callback argument identifies the parent
          // page session that produced the child target event.
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "foreign-child-session",
              targetInfo: { type: "iframe", url: deepResearchUrl },
            },
            "foreign-page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "current-child-session",
              targetInfo: { type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "foreign-child-session" ? 99 : 50 };
        }
        if (method === "Runtime.evaluate" && sessionId) {
          evaluatedSessions.push(sessionId);
          if (sessionId === "foreign-child-session") {
            return {
              result: {
                value: {
                  completed: true,
                  inProgress: false,
                  textLength: 80,
                  text: "FOREIGN_REPORT https://example.com/foreign",
                },
              },
            };
          }
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 10, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 8 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          undefined,
          mockClient as never,
        ),
      ).rejects.toThrow(/did not complete/);
      expect(evaluatedSessions).not.toContain("foreign-child-session");
      expect(evaluatedSessions).toContain("current-child-session");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("accepts a fresh OOPIF report when its frame owner is unavailable", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: true,
          textLength: 11,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    const evaluatedSessions: string[] = [];
    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "old-session",
              targetInfo: { targetId: "old-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "current-session",
              targetInfo: { targetId: "current-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: {
              frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl },
            },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "old-session" ? 10 : 20 };
        }
        if (method === "DOM.getFrameOwner") {
          return {};
        }
        if (method === "Runtime.evaluate" && sessionId) {
          evaluatedSessions.push(sessionId);
          if (sessionId === "old-session") {
            return {
              result: {
                value: {
                  completed: true,
                  inProgress: false,
                  textLength: 80,
                  text: "OLD_REPORT https://example.com/old",
                },
              },
            };
          }
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 90,
                text: "CURRENT_REPORT https://example.com/current",
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
      1,
      undefined,
      mockClient as never,
      { ignoredTargetKeys: ["old-target"], targetBaselineCaptured: true },
    );

    expect(result.text).toBe("CURRENT_REPORT https://example.com/current");
    expect(evaluatedSessions).toContain("old-session");
    expect(evaluatedSessions).toContain("current-session");
    expect(mockClient.send).not.toHaveBeenCalledWith(
      "DOM.getFrameOwner",
      expect.anything(),
      "page-session",
    );
  });

  it("scopes reattached OOPIF reports to their owning conversation turn", async () => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      oraclePageSessionId: "page-session",
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // Emit the current report first so target order alone would incorrectly
          // let the later stale completion win.
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "current-session",
              targetInfo: { targetId: "current-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          listeners.get("Target.attachedToTarget")?.(
            {
              sessionId: "old-session",
              targetInfo: { targetId: "old-target", type: "iframe", url: deepResearchUrl },
            },
            "page-session",
          );
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "DOM.getFrameOwner") {
          const frameId = (params as { frameId?: string }).frameId;
          return { backendNodeId: frameId === "current-session-frame" ? 20 : 10 };
        }
        if (method === "DOM.resolveNode") {
          const backendNodeId = (params as { backendNodeId?: number }).backendNodeId;
          return { object: { objectId: backendNodeId === 20 ? "current-owner" : "old-owner" } };
        }
        if (method === "Runtime.callFunctionOn" && sessionId === "page-session") {
          const objectId = (params as { objectId?: string }).objectId;
          return { result: { value: objectId === "current-owner" ? 2 : 0 } };
        }
        if (method === "Runtime.evaluate" && sessionId) {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text:
                  sessionId === "current-session"
                    ? "CURRENT_REPORT https://example.com/current"
                    : "OLD_REPORT https://example.com/old",
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
      1,
      undefined,
      mockClient as never,
      { requireScopedTargetOwner: true },
    );

    expect(result.text).toBe("CURRENT_REPORT https://example.com/current");
    expect(mockClient.send).toHaveBeenCalledWith(
      "DOM.getFrameOwner",
      { frameId: "current-session-frame" },
      "page-session",
    );
  });

  it("prefers a completed page target over an earlier in-progress one", async () => {
    // A page can expose more than one Deep Research iframe target (e.g. a stale
    // in-progress one attached before the completed report). Scanning must not
    // return the first in-progress target and miss the later completed OOPIF.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          // In-progress target attaches FIRST, completed target SECOND.
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "incomplete-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "complete-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: sessionId === "complete-session" ? 22 : 11 };
        }
        if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "current-owner" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: 1 } };
        if (method === "Runtime.evaluate" && sessionId === "complete-session") {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "REPORT_OK https://example.com/report",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "incomplete-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 12, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    // Bound the loop so a future regression (returning the in-progress target)
    // fails fast via timeout instead of spinning.
    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 12 ? 1_000 : 2_000;
    });
    try {
      const result = await waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        1,
        undefined,
        mockClient as never,
      );
      expect(result.text).toBe("REPORT_OK https://example.com/report");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it.each([
    ["empty", { completed: false, inProgress: false, textLength: 0 }],
    ["in-progress", { completed: false, inProgress: true, textLength: 12 }],
  ])("does not let a later %s target mask a completed report", async (_label, laterStatus) => {
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
      },
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "complete-session",
            targetInfo: { targetId: "complete-target", type: "iframe", url: deepResearchUrl },
          });
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "empty-session",
            targetInfo: { targetId: "empty-target", type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: `${sessionId}-frame`, name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "current-owner" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: 1 } };
        if (method === "Runtime.evaluate" && sessionId === "complete-session") {
          return {
            result: {
              value: {
                completed: true,
                inProgress: false,
                textLength: 80,
                text: "REPORT_OK https://example.com/report",
              },
            },
          };
        }
        if (method === "Runtime.evaluate" && sessionId === "empty-session") {
          return { result: { value: laterStatus } };
        }
        return {};
      }),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      1,
      undefined,
      mockClient as never,
    );

    expect(result.text).toBe("REPORT_OK https://example.com/report");
  });

  it("falls back to a completed in-page frame when the target read is only in-progress", async () => {
    // Legacy/inline rendering: the target-attach read is in-progress, but the
    // in-page frame path has a completed report. An incomplete target read must
    // not suppress the frame fallback.
    mockRuntime.evaluate.mockImplementation(async (params?: { contextId?: number }) => {
      if (params?.contextId === 77) {
        return {
          result: {
            value: {
              completed: true,
              inProgress: false,
              textLength: 80,
              text: "FRAME_REPORT https://example.com/report",
            },
          },
        };
      }
      return {
        result: {
          value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
        },
      };
    });

    const listeners = new Map<string, (params: unknown, sessionId?: string) => void>();
    const deepResearchUrl =
      "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/";

    // Target-attach path returns an in-progress read (no completed target).
    const mockClient = {
      on: vi.fn((event: string, listener: (params: unknown, sessionId?: string) => void) => {
        listeners.set(event, listener);
      }),
      removeListener: vi.fn(),
      send: vi.fn(async (method: string, params?: unknown, sessionId?: string) => {
        if (method === "Target.setAutoAttach" && (params as { autoAttach?: boolean })?.autoAttach) {
          listeners.get("Target.attachedToTarget")?.({
            sessionId: "t-session",
            targetInfo: { type: "iframe", url: deepResearchUrl },
          });
          return {};
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: "t-frame", name: "root", url: deepResearchUrl } },
          };
        }
        if (method === "Page.createIsolatedWorld") {
          return { executionContextId: 33 };
        }
        if (method === "Runtime.evaluate" && sessionId === "t-session") {
          return {
            result: {
              value: { completed: false, inProgress: true, textLength: 15, text: undefined },
            },
          };
        }
        return {};
      }),
    };

    // In-page frame path has the completed report (isolated world contextId 77).
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [{ frame: { id: "deep-frame", url: deepResearchUrl } }],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 77 }),
    };

    // Unscoped run so the frame-completed result is not gated by the main-DOM
    // hasActiveScopedResearch heuristic (this is the legacy inline path).
    // Date.now bound so a future regression (frame fallback suppressed) fails
    // fast via timeout instead of spinning.
    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 12 ? 1_000 : 2_000;
    });
    try {
      const result = await waitForDeepResearchCompletion(
        mockRuntime as never,
        mockLogger,
        100,
        undefined,
        mockPage as never,
        mockClient as never,
      );
      expect(result.text).toBe("FRAME_REPORT https://example.com/report");
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns a fresh OOPIF report when the main DOM has no assistant turn", async () => {
    // Regression: ChatGPT renders the Deep Research report inside an
    // out-of-process iframe that is invisible to the main page's frame tree.
    // The main-DOM poll therefore shows no assistant turn and
    // hasActiveScopedResearch=false, while the target-attach path reads the
    // completed report directly. Both Page and client are passed (production
    // shape), the run is scoped (minTurnIndex>=0), and the pre-submit target
    // baseline is present. The target-confirmed completion must be returned
    // without requiring frame-owner resolution, which OOPIFs may not support.
    mockRuntime.evaluate.mockResolvedValue({
      result: {
        value: {
          finished: false,
          stopVisible: false,
          textLength: 0,
          hasIframe: true,
          hasActiveScopedResearch: false,
        },
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
        if (method === "DOM.getFrameOwner") return { backendNodeId: 7 };
        if (method === "DOM.resolveNode") return { object: { objectId: "current-owner" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: 1 } };
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
                text: "OOPIF_REPORT https://example.com/report",
              },
            },
          };
        }
        return {};
      }),
    };

    // Main page frame tree exposes no Deep Research frame (the OOPIF is hidden),
    // so the in-page frame path can never find the report on its own.
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [{ frame: { id: "blank", url: "about:blank" } }],
        },
      }),
      createIsolatedWorld: vi.fn(),
    };

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      1,
      mockPage as never,
      mockClient as never,
      { ignoredTargetKeys: [], targetBaselineCaptured: true },
    );

    expect(result.text).toBe("OOPIF_REPORT https://example.com/report");
    expect(mockClient.send).not.toHaveBeenCalledWith(
      "DOM.getFrameOwner",
      { frameId: "sandbox" },
      undefined,
    );
  });

  it("does not complete from an unscoped frame result during a scoped run", async () => {
    mockRuntime.evaluate.mockImplementation(async (params?: { contextId?: number }) => {
      if (typeof params?.contextId === "number") {
        return {
          result: {
            value: {
              completed: true,
              inProgress: false,
              textLength: 80,
              text: "OLD_REPORT_SHOULD_NOT_BE_RETURNED https://example.com/report",
            },
          },
        };
      }
      return {
        result: {
          value: { finished: false, stopVisible: false, textLength: 0, hasIframe: true },
        },
      };
    });
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [
            {
              frame: {
                id: "old-deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
            },
          ],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 42 }),
    };
    const mockClient = createFrameOwnerClient(0);
    let nowCalls = 0;
    const dateNowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
      nowCalls += 1;
      return nowCalls < 6 ? 1_000 : 2_000;
    });

    try {
      await expect(
        waitForDeepResearchCompletion(
          mockRuntime as never,
          mockLogger,
          100,
          1,
          mockPage as never,
          mockClient as never,
        ),
      ).rejects.toThrow(/did not complete/);
      expect(mockPage.createIsolatedWorld).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("accepts a frame result during a scoped run after a fresh Deep Research turn appears", async () => {
    mockRuntime.evaluate.mockImplementation(async (params?: { contextId?: number }) => {
      if (typeof params?.contextId === "number") {
        return {
          result: {
            value: {
              completed: true,
              inProgress: false,
              textLength: 80,
              text: "FRESH_REPORT https://example.com/report",
            },
          },
        };
      }
      return {
        result: {
          value: {
            finished: false,
            stopVisible: false,
            textLength: 0,
            hasIframe: true,
            hasActiveScopedResearch: true,
          },
        },
      };
    });
    const mockPage = {
      getFrameTree: vi.fn().mockResolvedValue({
        frameTree: {
          frame: { id: "root", url: "https://chatgpt.com/" },
          childFrames: [
            {
              frame: {
                id: "old-deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/old",
              },
            },
            {
              frame: {
                id: "fresh-deep-frame",
                url: "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/",
              },
            },
          ],
        },
      }),
      createIsolatedWorld: vi.fn().mockResolvedValue({ executionContextId: 42 }),
    };
    const mockClient = createFrameOwnerClient((frameId) =>
      frameId === "fresh-deep-frame" ? 1 : 0,
    );

    const result = await waitForDeepResearchCompletion(
      mockRuntime as never,
      mockLogger,
      60_000,
      1,
      mockPage as never,
      mockClient as never,
    );

    expect(result.text).toBe("FRESH_REPORT https://example.com/report");
    expect(mockPage.createIsolatedWorld).toHaveBeenCalledTimes(1);
    expect(mockPage.createIsolatedWorld).toHaveBeenCalledWith(
      expect.objectContaining({ frameId: "fresh-deep-frame" }),
    );
  });

  it("does not fall back to an older completed turn when scoped to new turns", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(2);
    const priorFinishedTurn = {
      textContent: "Earlier complete Deep Research report with enough text to look finished.",
      querySelector: () => ({}),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"]') {
            return [priorFinishedTurn];
          }
          return [];
        },
      },
    }) as { finished?: boolean; textLength?: number; isToolStub?: boolean };

    expect(result.finished).toBe(false);
    expect(result.textLength).toBe(0);
    expect(result.isToolStub).toBe(false);
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
        value: {
          completed: true,
          inProgress: false,
          hasIframe: false,
          textLength: 5000,
          placeholderOnly: false,
        },
      },
    });
    const status = await checkDeepResearchStatus(mockRuntime as never, mockLogger);
    expect(status.completed).toBe(true);
    expect(status.inProgress).toBe(false);
    expect(status.textLength).toBe(5000);
    expect(status.placeholderOnly).toBe(false);
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
    expect(status.placeholderOnly).toBe(false);
  });

  it("does not report completed for a tool-only Deep Research placeholder", () => {
    const expression = buildDeepResearchStatusExpressionForTest();
    const assistantTurn = {
      textContent: "Called tool",
      querySelector: () => ({}),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        querySelector: (selector: string) => (selector.includes("copy") ? {} : null),
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"]') return [assistantTurn];
          return [];
        },
      },
    }) as { completed?: boolean; placeholderOnly?: boolean; textLength?: number };

    expect(result.completed).toBe(false);
    expect(result.placeholderOnly).toBe(true);
    expect(result.textLength).toBe("Called tool".length);
  });

  it("does not report completed for a Deep Research planning panel", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest();
    const assistantTurn = {
      textContent:
        "project root-cause analysis\nUpdate\nInspect the adapter.\nDetermining steps for creating a report...\nStop research",
      querySelector: () => ({}),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { finished?: boolean; incompleteResult?: boolean };

    expect(result.finished).toBe(false);
    expect(result.incompleteResult).toBe(true);
  });

  it("keeps short scoped iframe turns active", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(0);
    const iframe = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getAttribute: (name: string) =>
        name === "src"
          ? "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/"
          : null,
    };
    const assistantTurn = {
      textContent: "ChatGPT said:",
      innerText: "ChatGPT said:",
      dataset: {},
      getAttribute: (name: string) => (name === "data-message-author-role" ? "assistant" : null),
      querySelector: () => null,
      querySelectorAll: (selector: string) => (selector === "iframe" ? [iframe] : []),
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") {
            return [iframe];
          }
          if (selector.includes("conversation-turn")) return [assistantTurn];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { hasActiveScopedResearch?: boolean };

    expect(result.hasActiveScopedResearch).toBe(true);
  });

  it("does not treat a page-global stale iframe as scoped activity", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(0);
    const iframe = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getAttribute: (name: string) =>
        name === "src"
          ? "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/old"
          : null,
    };
    const assistantTurn = {
      textContent: "ChatGPT said:",
      innerText: "ChatGPT said:",
      dataset: {},
      getAttribute: (name: string) => (name === "data-message-author-role" ? "assistant" : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [iframe];
          if (selector.includes("conversation-turn")) return [assistantTurn];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { hasActiveScopedResearch?: boolean };

    expect(result.hasActiveScopedResearch).toBe(false);
  });

  it("does not treat a bare tool stub as Deep Research evidence", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(0);
    const staleIframe = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      getAttribute: (name: string) =>
        name === "src"
          ? "https://connector_openai_deep_research.web-sandbox.oaiusercontent.com/old"
          : null,
    };
    const assistantTurn = {
      textContent: "Called tool",
      innerText: "Called tool",
      dataset: {},
      getAttribute: (name: string) => (name === "data-message-author-role" ? "assistant" : null),
      querySelector: () => null,
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: { innerText: assistantTurn.textContent },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [staleIframe];
          if (selector.includes("conversation-turn")) return [assistantTurn];
          if (selector.includes("data-message-author-role")) return [assistantTurn];
          return [];
        },
      },
    }) as { researchActivity?: boolean; hasActiveScopedResearch?: boolean };

    expect(result.researchActivity).toBe(false);
    expect(result.hasActiveScopedResearch).toBe(false);
  });

  it("detects ChatGPT account security blocks during completion polling", () => {
    const expression = buildDeepResearchCompletionPollExpressionForTest(1);
    const result = new vm.Script(expression).runInNewContext({
      document: {
        body: {
          innerText:
            "Suspicious activity detected. Please secure your account to regain access to all features.",
        },
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"], [data-turn="assistant"]') {
            return [];
          }
          return [];
        },
      },
    }) as { accountBlocked?: boolean };

    expect(result.accountBlocked).toBe(true);
  });

  it("scopes completion actions to the latest assistant turn", () => {
    const expression = buildDeepResearchStatusExpressionForTest();
    const priorFinishedTurn = {
      textContent: "Earlier complete answer with enough text to look finished.",
      querySelector: () => ({}),
    };
    const currentResearchTurn = {
      textContent:
        "Researching current browser support and collecting citations, but not complete yet.",
      querySelector: () => null,
    };
    const result = new vm.Script(expression).runInNewContext({
      document: {
        querySelector: (selector: string) => (selector.includes("copy") ? {} : null),
        querySelectorAll: (selector: string) => {
          if (selector === "iframe") return [];
          if (selector === '[data-message-author-role="assistant"]') {
            return [priorFinishedTurn, currentResearchTurn];
          }
          return [];
        },
      },
    }) as { completed?: boolean; placeholderOnly?: boolean; textLength?: number };

    expect(result.completed).toBe(false);
    expect(result.placeholderOnly).toBe(false);
    expect(result.textLength).toBe(currentResearchTurn.textContent.length);
  });
});
