import type { BrowserRuntimeMetadata } from "../sessionStore.js";

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  if (!runtime) {
    return false;
  }
  if (runtime.conversationId?.trim()) {
    return true;
  }
  const tabUrl = runtime.tabUrl?.trim();
  if (!tabUrl) {
    return false;
  }
  try {
    const url = new URL(tabUrl);
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return false;
    }
    return /(?:^|\/)c\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}
