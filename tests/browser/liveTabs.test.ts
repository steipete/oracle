import { describe, expect, test } from "vitest";
import {
  buildTabInspectionExpressionForTest,
  classifyTabState,
  formatBrowserTabState,
  resolveChatGptTabFromSummariesForTest,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../../src/browser/liveTabs.js";
import type { SessionMetadata } from "../../src/sessionStore.js";
import { FakeDocument, FakeElement } from "./domFixture.js";

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
    assistantFollowsLatestUser: true,
    lastAssistantTurnIndex: 1,
    lastUserTurnIndex: 0,
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
  test("keeps speaker labels and controls out of the raw user fingerprint text", () => {
    const text = "if active:\n  run()";
    const user = new FakeElement(
      "div",
      { "data-message-author-role": "user", "data-message-id": "current-message" },
      [],
      text,
    );
    const speaker = new FakeElement("span", {}, [], "You said:");
    const copy = new FakeElement("button", {}, [], "Copy");
    const turn = new FakeElement(
      "article",
      { "data-testid": "conversation-turn-0", "data-turn": "user" },
      [speaker, user, copy],
    );
    const order = [turn, speaker, user, copy];
    for (const node of order)
      Object.assign(node, {
        compareDocumentPosition: (other: FakeElement) =>
          order.indexOf(other) > order.indexOf(node) ? 4 : 2,
        contains: (other: FakeElement) => node === other || node.children.includes(other),
      });
    const observed = new Function(
      "document",
      "Element",
      "window",
      "location",
      `return ${buildTabInspectionExpressionForTest()}`,
    )(
      new FakeDocument([turn]),
      FakeElement,
      { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      { href: "https://chatgpt.com/c/test" },
    );
    expect(observed.lastUserTextRaw).toBe(text);
    expect(observed.lastUserMessageId).toBe("current-message");
  });

  test("separates the user content from a later provider error notice", () => {
    const text = "Explain: Something went wrong. Please try again.";
    const content = new FakeElement("div", { class: "whitespace-pre-wrap" }, [], text);
    const notice = new FakeElement("div", {}, [], "Something went wrong. Please try again.");
    const user = new FakeElement(
      "div",
      { "data-message-author-role": "user", "data-message-id": "saved" },
      [content, notice],
    );
    const observed = new Function(
      "document",
      "Element",
      "window",
      "location",
      `return ${buildTabInspectionExpressionForTest()}`,
    )(
      new FakeDocument([user]),
      FakeElement,
      { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      { href: "https://chatgpt.com/c/saved" },
    );
    expect(observed.lastUserContentText).toBe(text);
    expect(observed.lastUserTextRaw).toContain(text);
    expect(observed.lastUserTextRaw).not.toBe(text);
  });

  test("keeps a visible composer stop control running even behind a hidden legacy control", () => {
    const hidden = new FakeElement("button", { "data-testid": "stop-button" });
    hidden.getBoundingClientRect = () => ({ width: 0, height: 0, x: 0, y: 0 });
    const visible = new FakeElement("button", { "data-testid": "composer-stop-button" });
    const document = new FakeDocument([hidden, visible]);
    const observed = new Function(
      "document",
      "Element",
      "window",
      "location",
      `return ${buildTabInspectionExpressionForTest()}`,
    )(
      document,
      FakeElement,
      { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      { href: "https://chatgpt.com/c/test" },
    );
    expect(observed.stopExists).toBe(true);
    expect(classifyTabState(observed)).toBe("running");
  });
  test("excludes fallback answer nodes contained by the latest user turn", () => {
    const expression = buildTabInspectionExpressionForTest();
    expect(expression).toContain("!lastUserTurn.contains?.(node)");
    expect(expression).toContain("!node.contains?.(lastUserTurn)");
    expect(expression).toContain("assistantCandidates.reduce");
  });

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

  test("resolves current/id/url/conversation/title refs against live tabs", () => {
    const tabs = [
      makeTab({
        targetId: "target-1",
        title: "Review A",
        url: "https://chatgpt.com/c/a",
        conversationId: "a",
      }),
      makeTab({
        targetId: "target-2",
        title: "Review B",
        url: "https://chatgpt.com/c/b",
        conversationId: "b",
      }),
    ];
    expect(resolveChatGptTabFromSummariesForTest(tabs, "current").targetId).toBe("target-1");
    expect(resolveChatGptTabFromSummariesForTest(tabs, "target-2").url).toBe(
      "https://chatgpt.com/c/b",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "https://chatgpt.com/c/a").targetId).toBe(
      "target-1",
    );
    expect(resolveChatGptTabFromSummariesForTest(tabs, "b").targetId).toBe("target-2");
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
