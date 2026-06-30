import { describe, expect, test } from "vitest";
import {
  buildChatGptConversationUrl,
  normalizeChatGptConversationUrl,
  recoverConversationUrlFromSnapshot,
} from "../../src/browser/actions/conversationUrl.js";

describe("conversation URL recovery", () => {
  test("accepts exact ChatGPT conversation URLs and rejects shell URLs", () => {
    expect(normalizeChatGptConversationUrl("https://chatgpt.com/c/abc-12345")).toBe(
      "https://chatgpt.com/c/abc-12345",
    );
    expect(
      normalizeChatGptConversationUrl("https://chatgpt.com/g/g-p-demo/project/c/abc-12345"),
    ).toBe("https://chatgpt.com/g/g-p-demo/project/c/abc-12345");
    expect(normalizeChatGptConversationUrl("https://chatgpt.com/")).toBeNull();
    expect(normalizeChatGptConversationUrl("https://evil.example.com/c/abc-12345")).toBeNull();
  });

  test("rebuilds a URL from a conversation id and ChatGPT base", () => {
    expect(buildChatGptConversationUrl("abc-12345", "https://chatgpt.com/")).toBe(
      "https://chatgpt.com/c/abc-12345",
    );
    expect(buildChatGptConversationUrl("abc-12345", "https://chatgpt.com/g/g-p-demo/project")).toBe(
      "https://chatgpt.com/g/g-p-demo/project/c/abc-12345",
    );
    expect(buildChatGptConversationUrl("abc-12345", "https://evil.example.com/")).toBeNull();
  });

  test("uses backend conversation resource entries when location stays on home", () => {
    expect(
      recoverConversationUrlFromSnapshot({
        href: "https://chatgpt.com/",
        performanceUrls: [
          "https://chatgpt.com/backend-api/conversations?offset=0",
          "https://chatgpt.com/backend-api/conversation/recovered-12345",
        ],
      }),
    ).toBe("https://chatgpt.com/c/recovered-12345");
  });
});
