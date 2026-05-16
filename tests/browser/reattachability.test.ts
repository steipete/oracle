import { describe, expect, test } from "vitest";
import { hasRecoverableChatGptConversation } from "../../src/browser/reattachability.js";

describe("hasRecoverableChatGptConversation", () => {
  test("accepts explicit conversation ids", () => {
    expect(hasRecoverableChatGptConversation({ conversationId: "abc" })).toBe(true);
  });

  test("accepts ChatGPT conversation URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/c/abc123" })).toBe(
      true,
    );
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/g/g-p-demo/project/c/abc123",
      }),
    ).toBe(true);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chat.openai.com/c/abc123" })).toBe(
      true,
    );
  });

  test("rejects ChatGPT home and project shell URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://chatgpt.com/" })).toBe(false);
    expect(
      hasRecoverableChatGptConversation({
        tabUrl: "https://chatgpt.com/g/g-p-demo/project",
      }),
    ).toBe(false);
  });

  test("rejects malformed or non-ChatGPT URLs", () => {
    expect(hasRecoverableChatGptConversation({ tabUrl: "not a url" })).toBe(false);
    expect(hasRecoverableChatGptConversation({ tabUrl: "https://example.com/c/abc" })).toBe(false);
  });
});
