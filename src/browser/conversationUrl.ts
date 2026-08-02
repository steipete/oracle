const CONVERSATION_ID_PATH = /\/c\/([a-zA-Z0-9-]+)(?=[/?#]|$)/;

/**
 * Extract a durable ChatGPT conversation id from a URL.
 *
 * ChatGPT can briefly expose client-created routes such as `/c/WEB:<request-id>`
 * before replacing them with the persisted conversation URL. Those transient
 * routes must not be used to scope assistant-response capture or reattachment.
 */
export function extractStableConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  return url.match(CONVERSATION_ID_PATH)?.[1];
}

export function isStableConversationUrl(url: string): boolean {
  return extractStableConversationIdFromUrl(url) !== undefined;
}
