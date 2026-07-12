import { BrowserAutomationError } from "../../oracle/errors.js";
import type { BrowserLogger, BrowserPinResult, ChromeClient } from "../types.js";
import { delay } from "../utils.js";

export async function pinCurrentConversation(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs = 20_000,
): Promise<BrowserPinResult> {
  const deadline = Date.now() + timeoutMs;
  let clicked = false;
  let lastStatus: string | undefined;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: buildPinConversationExpression(lastStatus === "ready" && !clicked),
      returnByValue: true,
    });
    const value = result.value as
      | { status?: string; title?: string; conversationId?: string }
      | undefined;
    lastStatus = value?.status;
    if (value?.status === "pinned") {
      logger(
        value.title
          ? `[browser] Pinned ChatGPT conversation: ${value.title}`
          : "[browser] Pinned ChatGPT conversation",
      );
      return {
        attempted: true,
        pinned: true,
        alreadyPinned: !clicked,
        title: value.title,
      };
    }
    if (value?.status === "clicked") {
      clicked = true;
    }
    await delay(150);
  }

  throw new BrowserAutomationError("ChatGPT conversation pinning could not be verified.", {
    stage: "pin-conversation",
    code: "conversation-pin-timeout",
    status: lastStatus,
    timeoutMs,
  });
}

function buildPinConversationExpression(click: boolean): string {
  return `(() => {
    const match = location.pathname.match(/\\/c\\/([^/?#]+)/);
    const conversationId = match?.[1] || '';
    if (!conversationId) return { status: 'waiting-for-conversation' };
    const anchors = Array.from(document.querySelectorAll('a[href*="/c/"]'));
    const anchor = anchors.find((node) => {
      try {
        return new URL(node.href, location.href).pathname.includes('/c/' + conversationId);
      } catch {
        return false;
      }
    });
    if (!(anchor instanceof HTMLElement)) {
      return { status: 'waiting-for-sidebar', conversationId };
    }
    const title = String(anchor.textContent || anchor.getAttribute('aria-label') || '').trim();
    const buttons = Array.from(anchor.querySelectorAll('button[aria-label]'));
    const unpin = buttons.find((node) => String(node.getAttribute('aria-label') || '').startsWith('Unpin '));
    const anchorLabel = String(anchor.getAttribute('aria-label') || '');
    if (unpin || anchorLabel.includes('pinned conversation')) {
      return { status: 'pinned', title, conversationId };
    }
    const pin = buttons.find((node) => String(node.getAttribute('aria-label') || '').startsWith('Pin '));
    if (!(pin instanceof HTMLElement)) {
      return { status: 'waiting-for-pin-control', title, conversationId };
    }
    if (!${JSON.stringify(click)}) return { status: 'ready', title, conversationId };
    pin.click();
    return { status: 'clicked', title, conversationId };
  })()`;
}

export function buildPinConversationExpressionForTest(click: boolean): string {
  return buildPinConversationExpression(click);
}
