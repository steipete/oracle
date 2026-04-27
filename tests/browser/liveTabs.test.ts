import { describe, expect, test } from "vitest";
import {
  classifyTabState,
  formatBrowserTabState,
  resolveChatGptTabFromSummariesForTest,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";

function makeTab(overrides: Partial<ChatGptTabSummary> = {}): ChatGptTabSummary {
  return {
    targetId: "target-1",
    title: "ChatGPT",
    url: "https://chatgpt.com/c/abc",
    currentModelLabel: "ChatGPT + Pro",
    stopExists: false,
    sendExists: true,
    promptReady: true,
    loginButtonExists: false,
    authenticated: true,
    assistantCount: 1,
    lastAssistantText: "Answer",
    lastAssistantSnippet: "Answer",
    lastUserText: "Question",
    lastUserSnippet: "Question",
    focused: true,
    visibilityState: "visible",
    conversationId: "abc",
    fingerprint: "fp",
    state: "completed",
    lastAssistantMarkdown: "Answer",
    ...overrides,
  };
}

describe("liveTabs helpers", () => {
  test("classifies running/completed/detached states", () => {
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: true,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("running");
    expect(
      classifyTabState({
        authenticated: true,
        stopExists: false,
        sendExists: true,
        promptReady: true,
        assistantCount: 1,
      }),
    ).toBe("completed");
    expect(
      classifyTabState({
        authenticated: false,
        stopExists: false,
        sendExists: false,
        promptReady: false,
        assistantCount: 0,
      }),
    ).toBe("detached");
  });

  test("formats the stored state when present", () => {
    expect(formatBrowserTabState(makeTab({ state: "stalled" }))).toBe("stalled");
  });

  test("resolves current/id/url/title refs against live tabs", () => {
    const tabs = [
      makeTab({ targetId: "target-1", title: "Review A", url: "https://chatgpt.com/c/a" }),
      makeTab({ targetId: "target-2", title: "Review B", url: "https://chatgpt.com/c/b" }),
    ];
    expect(resolveChatGptTabFromSummariesForTest(tabs, "current").targetId).toBe("target-1");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "target-2").url).toBe(
      "https://chatgpt.com/c/b",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/c/a").targetId).toBe(
      "target-1",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "Review B").targetId).toBe("target-2");
  });

  test("throws on ambiguous title matches", () => {
    const tabs = [
      makeTab({ targetId: "target-1", title: "Routing Review", url: "https://chatgpt.com/c/a" }),
      makeTab({
        targetId: "target-2",
        title: "Routing Review Followup",
        url: "https://chatgpt.com/c/b",
      }),
    ];
    expect(() => resolveChatGptTabFromSummariesForTest(tabs, "Routing Review")).toThrow(
      /Multiple ChatGPT tabs match/i,
    );
  });

  test("matches sessions by target id, url, and conversation id", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-03-27T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        },
      },
    } as SessionMetadata;
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-1",
        url: "https://chatgpt.com/c/abc",
        conversationId: "abc",
      }),
    ).toBe(true);
    expect(
      sessionMatchesTab(meta, {
        host: "127.0.0.1",
        port: 9222,
        targetId: "target-2",
        url: "https://chatgpt.com/c/def",
        conversationId: "def",
      }),
    ).toBe(false);
  });
});
