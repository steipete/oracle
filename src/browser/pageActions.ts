import type { ChromeClient, BrowserLogger } from './types.js';
import {
  ANSWER_SELECTORS,
  COPY_BUTTON_SELECTOR,
  INPUT_SELECTORS,
  MODEL_BUTTON_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from './constants.js';
import { delay } from './utils.js';

export async function navigateToChatGPT(
  Page: ChromeClient['Page'],
  Runtime: ChromeClient['Runtime'],
  url: string,
  logger: BrowserLogger,
) {
  logger(`Navigating to ${url}`);
  await Page.navigate({ url });
  await waitForDocumentReady(Runtime, 45_000);
}

export async function ensureNotBlocked(Runtime: ChromeClient['Runtime'], headless: boolean, logger: BrowserLogger) {
  if (await isCloudflareInterstitial(Runtime)) {
    const message = headless
      ? 'Cloudflare challenge detected in headless mode. Re-run with --headful so you can solve the challenge.'
      : 'Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.';
    logger('Cloudflare anti-bot page detected');
    throw new Error(message);
  }
}

async function isCloudflareInterstitial(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const { result: titleResult } = await Runtime.evaluate({ expression: 'document.title', returnByValue: true });
  const title = typeof titleResult.value === 'string' ? titleResult.value : '';
  if (title.toLowerCase().includes('just a moment')) {
    return true;
  }

  const { result } = await Runtime.evaluate({
    expression: `Boolean(document.querySelector('script[src*="/challenge-platform/"]'))`,
    returnByValue: true,
  });
  return Boolean(result.value);
}

async function waitForDocumentReady(Runtime: ChromeClient['Runtime'], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `document.readyState`,
      returnByValue: true,
    });
    if (result?.value === 'complete' || result?.value === 'interactive') {
      return;
    }
    await delay(100);
  }
  throw new Error('Page did not reach ready state in time');
}

export async function ensurePromptReady(Runtime: ChromeClient['Runtime'], timeoutMs: number, logger: BrowserLogger) {
  const ready = await waitForPrompt(Runtime, timeoutMs);
  if (!ready) {
    throw new Error('Prompt textarea did not appear before timeout');
  }
  logger('Prompt textarea ready');
}

async function waitForPrompt(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const selectors = ${JSON.stringify(INPUT_SELECTORS)};
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (node && !node.hasAttribute('disabled')) {
            return true;
          }
        }
        return false;
      })()`,
      returnByValue: true,
    });
    if (result?.value) {
      return true;
    }
    await delay(200);
  }
  return false;
}

export async function ensureModelSelection(
  Runtime: ChromeClient['Runtime'],
  desiredModel: string,
  logger: BrowserLogger,
) {
  const outcome = await Runtime.evaluate({
    expression: buildModelSelectionExpression(desiredModel),
    awaitPromise: true,
    returnByValue: true,
  });

  const result = outcome.result?.value as
    | { status: 'already-selected'; label?: string | null }
    | { status: 'switched'; label?: string | null }
    | { status: 'option-not-found' }
    | { status: 'button-missing' }
    | undefined;

  switch (result?.status) {
    case 'already-selected':
    case 'switched': {
      const label = result.label ?? desiredModel;
      logger(`Model picker: ${label}`);
      return;
    }
    case 'option-not-found': {
      throw new Error(`Unable to find model option matching "${desiredModel}" in the model switcher.`);
    }
    case 'button-missing':
    default: {
      throw new Error('Unable to locate the ChatGPT model selector button.');
    }
  }
}

function buildModelSelectionExpression(targetModel: string): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  return `(() => {
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const CLICK_INTERVAL_MS = 50;
    const MAX_WAIT_MS = 12000;

    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      return { status: 'button-missing' };
    }

    const pointerClick = () => {
      const down = new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const up = new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const click = new MouseEvent('click', { bubbles: true });
      button.dispatchEvent(down);
      button.dispatchEvent(up);
      button.dispatchEvent(click);
    };

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
        return true;
      }
      return false;
    };

    const findOption = () => {
      const menus = Array.from(document.querySelectorAll('[role="menu"], [data-radix-collection-root]'));
      for (const menu of menus) {
        const buttons = Array.from(
          menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]'),
        );
        for (const option of buttons) {
          const testid = (option.getAttribute('data-testid') ?? '').toLowerCase();
          const text = option.textContent?.toLowerCase() ?? '';
          const matchesTestId = testid && TEST_IDS.some((id) => testid.includes(id));
          const matchesText = LABEL_TOKENS.some((token) => text.includes(token));
          if (matchesTestId || matchesText) {
            return option;
          }
        }
      }
      return null;
    };

    pointerClick();
    return new Promise((resolve) => {
      const start = performance.now();
      const attempt = () => {
        const option = findOption();
        if (option) {
          if (optionIsSelected(option)) {
            resolve({ status: 'already-selected', label: getOptionLabel(option) });
            return;
          }
          option.click();
          resolve({ status: 'switched', label: getOptionLabel(option) });
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({ status: 'option-not-found' });
          return;
        }
        setTimeout(attempt, CLICK_INTERVAL_MS);
      };
      attempt();
    });
  })()`;
}

function buildModelMatchersLiteral(targetModel: string): { labelTokens: string[]; testIdTokens: string[] } {
  const base = targetModel.trim().toLowerCase();
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, ' '), labelTokens);
  const collapsed = base.replace(/\s+/g, '');
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, '');
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);

  const hyphenated = base.replace(/\s+/g, '-');
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, '-'));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
  };
}

export async function submitPrompt(
  deps: { runtime: ChromeClient['Runtime']; input: ChromeClient['Input'] },
  prompt: string,
  logger: BrowserLogger,
) {
  const { runtime, input } = deps;
  const encodedPrompt = JSON.stringify(prompt);
  await runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const focusNode = (node) => {
        if (!node) return false;
        if (node.contentEditable === 'true' && typeof node.focus === 'function') {
          node.focus();
          return true;
        }
        if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
          node.focus();
          return true;
        }
        const range = document.createRange();
        const selection = window.getSelection();
        if (selection && range) {
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (!node) continue;
        if (focusNode(node)) {
          return { focused: true };
        }
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

    await input.insertText({ text: prompt });

  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector('#prompt-textarea');
      const fallback = document.querySelector('textarea[name="prompt-textarea"]');
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
      };
    })()`,
    returnByValue: true,
  });

  const editorText = verification.result?.value?.editorText?.trim?.() ?? '';
  const fallbackValue = verification.result?.value?.fallbackValue?.trim?.() ?? '';
  if (!editorText && !fallbackValue) {
      await runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector('textarea[name="prompt-textarea"]');
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector('#prompt-textarea');
        if (editor) {
          editor.textContent = ${encodedPrompt};
        }
      })()`,
    });
  }

  const clicked = await attemptSendButton(runtime);
  if (!clicked) {
    await input.dispatchKeyEvent({
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await input.dispatchKeyEvent({
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    logger('Submitted prompt via Enter key');
  } else {
    logger('Clicked send button');
  }

  await verifyPromptCommitted(runtime, prompt, 30_000);
}

async function verifyPromptCommitted(Runtime: ChromeClient['Runtime'], prompt: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const script = `(() => {
    const editor = document.querySelector('#prompt-textarea');
    const fallback = document.querySelector('textarea[name="prompt-textarea"]');
    const normalizedPrompt = ${encodedPrompt}.toLowerCase();
    const articles = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    const userMatched = articles.some((node) => node?.innerText?.toLowerCase().includes(normalizedPrompt));
    return {
      userMatched,
      fallbackValue: fallback?.value ?? '',
      editorValue: editor?.innerText ?? '',
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as { userMatched: boolean };
    if (info?.userMatched) {
      return;
    }
    await delay(100);
  }
  throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}

async function attemptSendButton(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  const script = `(() => {
    const button = document.querySelector('${SEND_BUTTON_SELECTOR}');
    if (!button) {
      return 'missing';
    }
    const ariaDisabled = button.getAttribute('aria-disabled');
    const disabled = button.hasAttribute('disabled') || ariaDisabled === 'true';
    if (disabled || window.getComputedStyle(button).display === 'none') {
      return 'disabled';
    }
    button.click();
    return 'clicked';
  })()`;

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    if (result.value === 'clicked') {
      return true;
    }
    if (result.value === 'missing') {
      break;
    }
    await delay(100);
  }
  return false;
}

export async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } }> {
  logger('Waiting for ChatGPT response');
  const expression = buildResponseObserverExpression(timeoutMs);
  let evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>>;
  try {
    evaluation = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  } catch (error) {
    await logConversationSnapshot(Runtime, logger).catch(() => undefined);
    throw error;
  }
  const { result } = evaluation;
  if (result.type === 'object' && result.value && typeof result.value === 'object' && 'text' in result.value) {
    const html = typeof (result.value as { html?: unknown }).html === 'string' ? ((result.value as { html?: string }).html ?? undefined) : undefined;
    const turnId = typeof (result.value as { turnId?: unknown }).turnId === 'string' ? ((result.value as { turnId?: string }).turnId ?? undefined) : undefined;
    const messageId = typeof (result.value as { messageId?: unknown }).messageId === 'string' ? ((result.value as { messageId?: string }).messageId ?? undefined) : undefined;
    return {
      text: String((result.value as { text: unknown }).text ?? ''),
      html,
      meta: { turnId, messageId },
    };
  }
  const fallbackText = typeof result.value === 'string' ? (result.value as string) : '';
  if (!fallbackText) {
    await logConversationSnapshot(Runtime, logger).catch(() => undefined);
    throw new Error('Unable to capture assistant response');
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function logConversationSnapshot(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  const debugExpression = buildConversationDebugExpression();
  const { result } = await Runtime.evaluate({ expression: debugExpression, returnByValue: true });
  if (Array.isArray(result.value)) {
    const recent = (result.value as Array<Record<string, unknown>>).slice(-3);
    logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
  }
}

function buildResponseObserverExpression(timeoutMs: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  return `(() => {
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const CONVERSATION_SELECTOR = 'article[data-testid^="conversation-turn"]';

    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = node.getAttribute('data-testid') || '';
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector('[data-message-author-role="assistant"], [data-testid*="assistant"]'));
    };

    const extractFromTurns = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        const turn = turns[index];
        if (!isAssistantTurn(turn)) {
          continue;
        }
        const messageRoot = turn.querySelector('[data-message-author-role="assistant"]') ?? turn;
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
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        const observer = new MutationObserver(() => {
          const extracted = extractFromTurns();
          if (extracted) {
            observer.disconnect();
            resolve(extracted);
          } else if (Date.now() > deadline) {
            observer.disconnect();
            reject(new Error('Response timeout'));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        const stopInterval = setInterval(() => {
          const stop = document.querySelector('${STOP_BUTTON_SELECTOR}');
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
          clearInterval(stopInterval);
          observer.disconnect();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    const extracted = extractFromTurns();
    if (extracted) {
      return extracted;
    }
    return captureViaObserver();
  })()`;
}

function buildConversationDebugExpression(): string {
  return `(() => {
    const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn"]'));
    return turns.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText?.slice(0, 200),
      testid: node.getAttribute('data-testid'),
    }));
  })()`;
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
  }
  return null;
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 5000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const button = node?.querySelector('${COPY_BUTTON_SELECTOR}') ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const button = node?.querySelector('${COPY_BUTTON_SELECTOR}') ?? null;
        if (button) {
          return button;
        }
      }
      return document.querySelector(BUTTON_SELECTOR);
    };

    const getPayload = () => {
      return navigator.clipboard?.read?.()
        ?.then((items) => Promise.all(items.map((item) => item.getType('text/plain').then((blob) => blob.text()))))
        ?.then((values) => ({
          markdown: values?.[0] ?? '',
          success: Boolean(values?.[0]),
          payloads: values,
        }));
    };

    return new Promise((resolve) => {
      const button = locateButton();
      if (!button) {
        resolve({ success: false, status: 'missing-button' });
        return;
      }
      const finish = (payload) => resolve(payload);

      const handleCopy = async () => {
        button.removeEventListener('copy', handleCopy, true);
        const payloads = await Promise.allSettled([getPayload()]);
        const markdown =
          payloads.find((entry) => entry.status === 'fulfilled' && entry.value?.markdown)?.value?.markdown ?? '';
        finish({ success: Boolean(markdown.trim()), markdown });
      };

      button.addEventListener('copy', handleCopy, true);
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      button.click();
      setTimeout(() => {
        button.removeEventListener('copy', handleCopy, true);
        resolve({ success: false, status: 'timeout' });
      }, TIMEOUT_MS);
    });
  })()`;
}
