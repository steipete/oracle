import type { ChromeClient, BrowserLogger } from './types.js';
import { CONVERSATION_TURN_SELECTOR } from './constants.js';

export function buildConversationDebugExpression(): string {
  return `(() => {
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    return turns.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText?.slice(0, 200),
      testid: node.getAttribute('data-testid'),
    }));
  })()`;
}

export async function logConversationSnapshot(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  const expression = buildConversationDebugExpression();
  const { result } = await Runtime.evaluate({ expression, returnByValue: true });
  if (Array.isArray(result.value)) {
    const recent = (result.value as Array<Record<string, unknown>>).slice(-3);
    logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
  }
}

export async function logDomFailure(Runtime: ChromeClient['Runtime'], logger: BrowserLogger, context: string) {
  if (!logger?.verbose) {
    return;
  }
  try {
    const entry = `Browser automation failure (${context}); capturing DOM snapshot for debugging...`;
    logger(entry);
    if (logger.sessionLog && logger.sessionLog !== logger) {
      logger.sessionLog(entry);
    }
    await logConversationSnapshot(Runtime, logger);
  } catch {
    // ignore snapshot failures
  }
}

