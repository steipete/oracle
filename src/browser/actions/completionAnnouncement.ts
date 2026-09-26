import { buildConversationTurnListExpression } from "../conversationTurns.js";

const TRACKER_KEY = "__oracleCurrentTurnCompletionV1";

/** Start before prompt dispatch so even a fast answer has a turn-scoped completion signal. */
export function buildInstallCompletionAnnouncementExpression(
  baselineTurns?: number | null,
): string {
  const baselineLiteral =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : "null";
  return `(() => {
    const key = ${JSON.stringify(TRACKER_KEY)};
    window[key]?.observer?.disconnect?.();
    const turns = () => ${buildConversationTurnListExpression()};
    const baseline = ${baselineLiteral} ?? turns().length;
    const completeNode = () => Array.from(
      document.querySelectorAll('[role="status"][aria-live="polite"]'),
    ).find((node) => (node.textContent || '').trim() === 'Response complete') ?? null;
    const isAssistant = (node) => {
      const key = (node.getAttribute?.('data-content-search-unit-key') || '').toLowerCase();
      if (key.endsWith(':user')) return false;
      if (key.endsWith(':assistant')) return true;
      const role = (node.getAttribute?.('data-message-author-role') || node.getAttribute?.('data-turn') || '').toLowerCase();
      if (role === 'user') return false;
      if (role === 'assistant') return true;
      return Boolean(node.querySelector?.('[data-content-search-unit-key$=":assistant"], [data-message-author-role="assistant"], [data-turn="assistant"]'));
    };
    const tracker = {
      baseline,
      priorCompleteNode: completeNode(),
      sawIncomplete: false,
      completedTurnIndex: null,
      observer: null,
    };
    tracker.sawIncomplete = !tracker.priorCompleteNode;
    const observe = () => {
      const currentCompleteNode = completeNode();
      if (!currentCompleteNode) {
        tracker.sawIncomplete = true;
        tracker.priorCompleteNode = null;
        return;
      }
      if (!tracker.sawIncomplete && currentCompleteNode === tracker.priorCompleteNode) return;
      const currentTurns = turns();
      for (let index = currentTurns.length - 1; index >= baseline; index -= 1) {
        if (!isAssistant(currentTurns[index])) continue;
        tracker.completedTurnIndex = index;
        tracker.sawIncomplete = false;
        tracker.priorCompleteNode = currentCompleteNode;
        tracker.observer?.disconnect();
        return;
      }
    };
    tracker.observer = new MutationObserver(observe);
    tracker.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window[key] = tracker;
    return { baseline };
  })()`;
}

export function buildReadCompletionAnnouncementExpression(turnIndex: number): string {
  return `(() => {
    const tracker = window[${JSON.stringify(TRACKER_KEY)}];
    return tracker?.completedTurnIndex === ${Math.floor(turnIndex)} &&
      tracker.completedTurnIndex >= tracker.baseline;
  })()`;
}
