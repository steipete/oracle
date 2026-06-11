import type { BrowserRuntimeMetadata } from "../sessionStore.js";

/**
 * True when the URL points at a specific ChatGPT conversation (`/c/<id>`) on
 * chatgpt.com or chat.openai.com. Rejects home, project shell, and external
 * URLs — anything else would be unsafe to auto-reopen in a persistent
 * signed-in browser profile.
 */
export function isRecoverableChatGptConversationUrl(candidate: string | null | undefined): boolean {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.port) {
      return false;
    }
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") {
      return false;
    }
    return /(?:^|\/)c\/[^/]+/.test(url.pathname);
  } catch {
    return false;
  }
}

export function hasRecoverableChatGptConversation(
  runtime: BrowserRuntimeMetadata | null | undefined,
): boolean {
  if (!runtime) {
    return false;
  }
  if (runtime.conversationId?.trim()) {
    return true;
  }
  return isRecoverableChatGptConversationUrl(runtime.tabUrl);
}
