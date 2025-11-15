import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';

export async function submitPrompt(
  deps: { runtime: ChromeClient['Runtime']; input: ChromeClient['Input'] },
  prompt: string,
  logger: BrowserLogger,
) {
  const { runtime, input } = deps;
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const dispatchPointer = (target) => {
        if (!(target instanceof HTMLElement)) {
          return;
        }
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        }
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        dispatchPointer(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
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
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, 'focus-textarea');
    throw new Error('Failed to focus prompt textarea');
  }

  await input.insertText({ text: prompt });

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
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
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector(${primarySelectorLiteral});
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

  await verifyPromptCommitted(runtime, prompt, 30_000, logger);
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

async function verifyPromptCommitted(
  Runtime: ChromeClient['Runtime'],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
) {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const script = `(() => {
    const editor = document.querySelector(${primarySelectorLiteral});
    const fallback = document.querySelector(${fallbackSelectorLiteral});
    const normalize = (value) => value?.toLowerCase?.().replace(/\\s+/g, ' ').trim() ?? '';
    const normalizedPrompt = normalize(${encodedPrompt});
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const userMatched = articles.some((node) => normalize(node?.innerText).includes(normalizedPrompt));
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
  if (logger) {
    await logDomFailure(Runtime, logger, 'prompt-commit');
  }
  throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}

