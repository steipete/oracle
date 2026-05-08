import { describe, expect, test, vi } from "vitest";
import {
  archiveChatGptConversation,
  buildArchiveConversationExpressionForTest,
  isProjectChatgptUrl,
  isTemporaryChatgptUrl,
  resolveBrowserArchiveDecision,
} from "../../src/browser/actions/archiveConversation.js";

describe("browser conversation archive policy", () => {
  test("archives successful non-project one-shots in auto mode", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "off",
        followUpCount: 0,
      }),
    ).toMatchObject({
      mode: "auto",
      shouldArchive: true,
      reason: "successful-one-shot",
    });
  });

  test("does not auto-archive project, Temporary Chat, Deep Research, multi-turn, or missing-url runs", () => {
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "project-conversation" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/",
        conversationUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "project-conversation" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        chatgptUrl: "https://chatgpt.com/?temporary-chat=true",
        conversationUrl: "https://chatgpt.com/?temporary-chat=true",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "temporary-chat" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
      }),
    ).toMatchObject({ shouldArchive: false, reason: "deep-research" });
    expect(
      resolveBrowserArchiveDecision({
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
        followUpCount: 1,
      }),
    ).toMatchObject({ shouldArchive: false, reason: "multi-turn" });
    expect(resolveBrowserArchiveDecision({ mode: "auto" })).toMatchObject({
      shouldArchive: false,
      reason: "missing-conversation-url",
    });
  });

  test("honors explicit always and never modes", () => {
    expect(resolveBrowserArchiveDecision({ mode: "never", conversationUrl: "x" })).toMatchObject({
      shouldArchive: false,
      reason: "disabled",
    });
    expect(
      resolveBrowserArchiveDecision({
        mode: "always",
        chatgptUrl: "https://chatgpt.com/g/g-p-demo/project",
        conversationUrl: "https://chatgpt.com/c/abc",
        researchMode: "deep",
        followUpCount: 2,
      }),
    ).toMatchObject({ shouldArchive: true, reason: "forced" });
  });

  test("detects ChatGPT project URLs", () => {
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/g/g-p-demo/project?model=gpt-5")).toBe(true);
    expect(isProjectChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });

  test("detects ChatGPT temporary chat URLs", () => {
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=true")).toBe(true);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/?temporary-chat=false")).toBe(false);
    expect(isTemporaryChatgptUrl("https://chatgpt.com/c/abc")).toBe(false);
  });
});

describe("archiveChatGptConversation", () => {
  test("returns archived result when the DOM action succeeds", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "archived", conversationUrl: "https://chatgpt.com/c/abc" } },
      }),
    };
    const logger = vi.fn();

    await expect(
      archiveChatGptConversation(runtime as never, logger as never, {
        mode: "auto",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "auto",
      attempted: true,
      archived: true,
      conversationUrl: "https://chatgpt.com/c/abc",
    });
    expect(runtime.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ awaitPromise: true, returnByValue: true }),
    );
  });

  test("returns a non-archived result when the DOM action is not confirmed", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            status: "skipped",
            reason: "archive-not-confirmed",
            conversationUrl: "https://chatgpt.com/c/abc",
          },
        },
      }),
    };

    await expect(
      archiveChatGptConversation(runtime as never, vi.fn() as never, {
        mode: "always",
        conversationUrl: "https://chatgpt.com/c/abc",
      }),
    ).resolves.toMatchObject({
      mode: "always",
      attempted: true,
      archived: false,
      reason: "archive-not-confirmed",
      conversationUrl: "https://chatgpt.com/c/abc",
    });
  });

  test("keeps the archive expression scoped to Archive actions", () => {
    const expression = buildArchiveConversationExpressionForTest();
    expect(expression).toContain("findConversationMenuButton");
    expect(expression).toContain("visibleMenuCandidates");
    expect(expression).toContain("findArchiveMenuItem");
    expect(expression).toContain("findArchiveConfirmationButton");
    expect(expression).toContain("hasUnarchiveMenuItem");
    expect(expression).toContain("PointerEvent");
    expect(expression).toContain("waitForArchiveConfirmation");
    expect(expression).toContain("archive-not-confirmed");
    expect(expression).toContain("archive");
    expect(expression).not.toContain("delete");
  });
});
