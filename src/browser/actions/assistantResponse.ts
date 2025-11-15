import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure, logConversationSnapshot, buildConversationDebugExpression } from '../domDebug.js';

const ASSISTANT_POLL_TIMEOUT_ERROR = 'assistant-response-watchdog-timeout';

export async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } }> {
  logger('Waiting for ChatGPT response');
  const expression = buildResponseObserverExpression(timeoutMs);
  const evaluationPromise = Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: 'evaluation' as const, value }),
    (error) => {
      throw { source: 'evaluation' as const, error };
    },
  );
  const pollerPromise = pollAssistantCompletion(Runtime, timeoutMs).then(
    (value) => {
      if (!value) {
        throw { source: 'poll' as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      return { kind: 'poll' as const, value };
    },
    (error) => {
      throw { source: 'poll' as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === 'poll') {
      logger('Captured assistant response via snapshot watchdog');
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    evaluation = winner.value;
  } catch (wrappedError) {
    if (wrappedError && typeof wrappedError === 'object' && 'source' in wrappedError && 'error' in wrappedError) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (source === 'poll' && error instanceof Error && error.message === ASSISTANT_POLL_TIMEOUT_ERROR) {
        evaluation = await evaluationPromise;
      } else if (source === 'poll') {
        throw error;
      } else if (source === 'evaluation') {
        const recovered = await recoverAssistantResponse(Runtime, timeoutMs, logger);
        if (recovered) {
          return recovered;
        }
        await logDomFailure(Runtime, logger, 'assistant-response');
        throw error ?? new Error('Failed to capture assistant response');
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    await logDomFailure(Runtime, logger, 'assistant-response');
    throw new Error('Failed to capture assistant response');
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, timeoutMs, logger);
  if (parsed) {
    return parsed;
  }
  await logDomFailure(Runtime, logger, 'assistant-response');
  throw new Error('Unable to capture assistant response');
}

export async function readAssistantSnapshot(Runtime: ChromeClient['Runtime']): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({ expression: buildAssistantSnapshotExpression(), returnByValue: true });
  const value = result?.value;
  if (value && typeof value === 'object') {
    return value as AssistantSnapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient['Runtime'],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === 'string') {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== 'missing-button') {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, 'copy-markdown');
  }
  if (!status) {
    await logDomFailure(Runtime, logger, 'copy-markdown');
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

async function recoverAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const snapshot = await waitForAssistantSnapshot(Runtime, Math.min(timeoutMs, 10_000));
  const recovered = normalizeAssistantSnapshot(snapshot);
  if (recovered) {
    logger('Recovered assistant response via polling fallback');
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  Runtime: ChromeClient['Runtime'],
  evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>>,
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const { result } = evaluation;
  if (result.type === 'object' && result.value && typeof result.value === 'object' && 'text' in result.value) {
    const html =
      typeof (result.value as { html?: unknown }).html === 'string'
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === 'string'
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === 'string'
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    return {
      text: String((result.value as { text: unknown }).text ?? ''),
      html,
      meta: { turnId, messageId },
    };
  }
  const fallbackText = typeof result.value === 'string' ? (result.value as string) : '';
  if (!fallbackText) {
    const recovered = await recoverAssistantResponse(Runtime, Math.min(timeoutMs, 10_000), logger);
    if (recovered) {
      return recovered;
    }
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function terminateRuntimeExecution(Runtime: ChromeClient['Runtime']): Promise<void> {
  if (typeof Runtime.terminateExecution !== 'function') {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  let previousLength = 0;
  let stableCycles = 0;
  const requiredStableCycles = 6;
  while (Date.now() < watchdogDeadline) {
    const snapshot = await readAssistantSnapshot(Runtime);
    const normalized = normalizeAssistantSnapshot(snapshot);
    if (normalized) {
      const currentLength = normalized.text.length;
      if (currentLength > previousLength) {
        previousLength = currentLength;
        stableCycles = 0;
      } else {
        stableCycles += 1;
      }
      const stopVisible = await isStopButtonVisible(Runtime);
      if (!stopVisible && stableCycles >= requiredStableCycles) {
        return normalized;
      }
    } else {
      previousLength = 0;
      stableCycles = 0;
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `Boolean(document.querySelector('${STOP_BUTTON_SELECTOR}'))`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

function normalizeAssistantSnapshot(
  snapshot: AssistantSnapshot | null,
): { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null {
  const text = snapshot?.text?.trim();
  if (!text) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

async function waitForAssistantSnapshot(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<AssistantSnapshot | null> {
  return waitForCondition(() => readAssistantSnapshot(Runtime), timeoutMs);
}

async function waitForCondition<T>(getter: () => Promise<T | null>, timeoutMs: number, pollIntervalMs = 400): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildAssistantSnapshotExpression(): string {
  return `(() => {
    ${buildAssistantExtractor('extractAssistantTurn')}
    return extractAssistantTurn();
  })()`;
}

function buildResponseObserverExpression(timeoutMs: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  return `(() => {
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const settleDelayMs = 800;
    ${buildAssistantExtractor('extractFromTurns')}

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let stopInterval = null;
        const observer = new MutationObserver(() => {
          const extracted = extractFromTurns();
          if (extracted) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            resolve(extracted);
          } else if (Date.now() > deadline) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            reject(new Error('Response timeout'));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        stopInterval = setInterval(() => {
          const stop = document.querySelector(STOP_SELECTOR);
          if (!stop) {
            return;
          }
          const ariaLabel = stop.getAttribute('aria-label') || '';
          if (ariaLabel.toLowerCase().includes('stop')) {
            return;
          }
          stop.click();
        }, 500);
        setTimeout(() => {
          if (stopInterval) {
            clearInterval(stopInterval);
          }
          observer.disconnect();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    const waitForSettle = async (snapshot) => {
      const settleWindowMs = 5000;
      const settleIntervalMs = 400;
      const deadline = Date.now() + settleWindowMs;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshed = extractFromTurns();
        if (refreshed && (refreshed.text?.length ?? 0) >= lastLength) {
          latest = refreshed;
          lastLength = refreshed.text?.length ?? lastLength;
        }
        const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        if (!stopVisible) {
          break;
        }
      }
      return latest ?? snapshot;
    };

    const extracted = extractFromTurns();
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          button.click();
        }
      }
    };

    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred =
        messageRoot.querySelector('.markdown') ||
        messageRoot.querySelector('[data-message-content]') ||
        messageRoot;
      const text = preferred?.innerText ?? '';
      const html = preferred?.innerHTML ?? '';
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      if (text.trim()) {
        return { text, html, messageId, turnId };
      }
    }
    return null;
  };`;
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 5000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      return all.at(-1) ?? null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '' };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (types.includes('text/plain') && typeof item.getType === 'function') {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              state.text = text ?? '';
              break;
            }
          }
        } catch {
          state.text = '';
        }
        return Promise.resolve();
      };
      return {
        state,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const button = locateButton();
      if (!button) {
        resolve({ success: false, status: 'missing-button' });
        return;
      }
      const interception = interceptClipboard();
      let settled = false;
      let pollId = null;
      let timeoutId = null;
      const finish = (payload) => {
        if (settled) {
          return;
        }
        settled = true;
        if (pollId) {
          clearInterval(pollId);
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        button.removeEventListener('copy', handleCopy, true);
        interception.restore?.();
        resolve(payload);
      };

      const readIntercepted = () => {
        const markdown = interception.state.text ?? '';
        return { success: Boolean(markdown.trim()), markdown };
      };

      const handleCopy = () => {
        finish(readIntercepted());
      };

      button.addEventListener('copy', handleCopy, true);
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      button.click();
      pollId = setInterval(() => {
        const payload = readIntercepted();
        if (payload.success) {
          finish(payload);
        }
      }, 100);
      timeoutId = setTimeout(() => {
        button.removeEventListener('copy', handleCopy, true);
        finish({ success: false, status: 'timeout' });
      }, TIMEOUT_MS);
    });
  })()`;
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
}

