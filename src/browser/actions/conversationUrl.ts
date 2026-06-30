import type { ChromeClient } from "../types.js";

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{8,}$/;

export interface ConversationUrlSnapshot {
  href?: string | null;
  canonicalHref?: string | null;
  activeHrefs?: string[];
  activeConversationIds?: string[];
  performanceUrls?: string[];
}

export function normalizeChatGptConversationUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.indexOf("c");
    const conversationId = index >= 0 ? parts[index + 1] : null;
    if (index < 0 || index !== parts.length - 2 || !conversationId?.match(CONVERSATION_ID_RE)) {
      return null;
    }
    return `${url.origin}/${parts.join("/")}`;
  } catch {
    return null;
  }
}

export function buildChatGptConversationUrl(
  conversationId: string | null | undefined,
  baseHref: string | null | undefined,
): string | null {
  const id = conversationId?.trim();
  if (!id?.match(CONVERSATION_ID_RE)) {
    return null;
  }
  let base: URL;
  try {
    base = new URL(baseHref || "https://chatgpt.com/");
  } catch {
    base = new URL("https://chatgpt.com/");
  }
  if (base.protocol !== "https:" || base.hostname !== "chatgpt.com" || base.port) {
    return null;
  }
  const parts = base.pathname.split("/").filter(Boolean);
  const cIndex = parts.indexOf("c");
  const prefix = cIndex >= 0 ? parts.slice(0, cIndex) : parts;
  return normalizeChatGptConversationUrl(`${base.origin}/${[...prefix, "c", id].join("/")}`);
}

function conversationIdFromBackendUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port) {
      return null;
    }
    const match = url.pathname.match(/^\/backend-api\/conversation\/([^/?#]+)/);
    const id = match?.[1] ? decodeURIComponent(match[1]) : null;
    return id?.match(CONVERSATION_ID_RE) ? id : null;
  } catch {
    return null;
  }
}

export function recoverConversationUrlFromSnapshot(
  snapshot: ConversationUrlSnapshot | null | undefined,
): string | null {
  if (!snapshot) {
    return null;
  }
  const baseHref = snapshot.href || "https://chatgpt.com/";
  for (const candidate of [
    snapshot.href,
    snapshot.canonicalHref,
    ...(snapshot.activeHrefs ?? []),
    ...(snapshot.performanceUrls ?? []),
  ]) {
    const exact = normalizeChatGptConversationUrl(candidate);
    if (exact) {
      return exact;
    }
  }
  for (const id of snapshot.activeConversationIds ?? []) {
    const exact = buildChatGptConversationUrl(id, baseHref);
    if (exact) {
      return exact;
    }
  }
  for (const candidate of snapshot.performanceUrls ?? []) {
    const exact = buildChatGptConversationUrl(conversationIdFromBackendUrl(candidate), baseHref);
    if (exact) {
      return exact;
    }
  }
  return null;
}

export function buildConversationUrlSnapshotExpression(): string {
  return `(() => {
    const pick = (node, attr) => {
      try {
        return node?.getAttribute?.(attr) || null;
      } catch {
        return null;
      }
    };
    const hrefsForNode = (node) => {
      const nearest = node?.closest?.('a[href], [data-href], [data-url]') || node;
      return [
        pick(node, 'href'),
        pick(node, 'data-href'),
        pick(node, 'data-url'),
        pick(nearest, 'href'),
        pick(nearest, 'data-href'),
        pick(nearest, 'data-url'),
      ].filter(Boolean);
    };
    const idsForNode = (node) => {
      const nearest = node?.closest?.('[data-conversation-id]') || node;
      return [
        node?.dataset?.conversationId,
        pick(node, 'data-conversation-id'),
        nearest?.dataset?.conversationId,
        pick(nearest, 'data-conversation-id'),
      ].filter(Boolean);
    };
    const activeNodes = Array.from(document.querySelectorAll([
      '[aria-current="page"]',
      '[aria-selected="true"]',
      '[data-active="true"]',
      '[data-selected="true"]',
    ].join(','))).slice(0, 25);
    const performanceUrls = typeof performance?.getEntriesByType === 'function'
      ? performance.getEntriesByType('resource').slice(-250).map((entry) => entry.name).filter(Boolean).reverse()
      : [];
    return {
      href: location.href,
      canonicalHref: document.querySelector('link[rel="canonical"]')?.href || null,
      activeHrefs: activeNodes.flatMap(hrefsForNode),
      activeConversationIds: activeNodes.flatMap(idsForNode),
      performanceUrls,
    };
  })()`;
}

export async function readConversationUrl(
  Runtime: ChromeClient["Runtime"],
): Promise<string | null> {
  try {
    const snapshot = await Runtime.evaluate({
      expression: buildConversationUrlSnapshotExpression(),
      returnByValue: true,
    });
    return recoverConversationUrlFromSnapshot(
      snapshot.result?.value as ConversationUrlSnapshot | null | undefined,
    );
  } catch {
    return null;
  }
}
