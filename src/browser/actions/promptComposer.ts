import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';
import { BrowserAutomationError } from '../../oracle/errors.js';

const ENTER_KEY_EVENT = {
  key: 'Enter',
  code: 'Enter',
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = '\r';

export async function submitPrompt(
  deps: { runtime: ChromeClient['Runtime']; input: ChromeClient['Input']; attachmentNames?: string[] },
  prompt: string,
  logger: BrowserLogger,
) {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        dispatchClickSequence(node);
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

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

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

  const editorTextRaw = verification.result?.value?.editorText ?? '';
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? '';
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? '';
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? '';
  if (!editorTextTrimmed && !fallbackValueTrimmed) {
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
          // Nudge ProseMirror to register the textContent write so its state/send-button updates
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
    });
  }

  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
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
  const observedEditor = postVerification.result?.value?.editorText ?? '';
  const observedFallback = postVerification.result?.value?.fallbackValue ?? '';
  const observedLength = Math.max(observedEditor.length, observedFallback.length);
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    await logDomFailure(runtime, logger, 'prompt-too-large');
    throw new BrowserAutomationError('Prompt appears truncated in the composer (likely too large).', {
      stage: 'submit-prompt',
      code: 'prompt-too-large',
      promptLength,
      observedLength,
    });
  }

  const clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames);
  if (!clicked) {
    await input.dispatchKeyEvent({
      type: 'keyDown',
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: 'keyUp',
      ...ENTER_KEY_EVENT,
    });
    logger('Submitted prompt via Enter key');
  } else {
    logger('Clicked send button');
  }

  await verifyPromptCommitted(runtime, prompt, 30_000, logger);

  await clickAnswerNowIfPresent(runtime, logger);
}

export async function clearPromptComposer(Runtime: ChromeClient['Runtime'], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      let cleared = false;
      if (fallback) {
        fallback.value = '';
        fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        fallback.dispatchEvent(new Event('change', { bubbles: true }));
        cleared = true;
      }
      if (editor) {
        editor.textContent = '';
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        cleared = true;
      }
      return { cleared };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value?.cleared) {
    await logDomFailure(Runtime, logger, 'clear-composer');
    throw new Error('Failed to clear prompt composer');
  }
  await delay(250);
}

async function waitForDomReady(Runtime: ChromeClient['Runtime'], logger?: BrowserLogger) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as { ready?: boolean; composer?: boolean; fileInput?: boolean } | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.('Page did not reach ready/composer state within 10s; continuing cautiously.');
}

async function attemptSendButton(
  Runtime: ChromeClient['Runtime'],
  _logger?: BrowserLogger,
  attachmentNames?: string[],
): Promise<boolean> {
  const script = `(() => {
    ${buildClickDispatcher()}
    const selectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    let button = null;
    for (const selector of selectors) {
      button = document.querySelector(selector);
      if (button) break;
    }
    if (!button) return 'missing';
    const ariaDisabled = button.getAttribute('aria-disabled');
    const dataDisabled = button.getAttribute('data-disabled');
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      ariaDisabled === 'true' ||
      dataDisabled === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none';
    if (disabled) return 'disabled';
    // Use unified pointer/mouse sequence to satisfy React handlers.
    dispatchClickSequence(button);
    return 'clicked';
  })()`;

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
    if (needAttachment) {
      const ready = await Runtime.evaluate({
        expression: `(() => {
          const names = ${JSON.stringify(attachmentNames.map((n) => n.toLowerCase()))};
          const match = (n, name) => (n?.textContent || '').toLowerCase().includes(name);
          const chipsReady = names.every((name) =>
            Array.from(document.querySelectorAll('[data-testid*="chip"],[data-testid*="attachment"],a,div,span')).some((node) => match(node, name)),
          );
          const inputsReady = names.every((name) =>
            Array.from(document.querySelectorAll('input[type="file"]')).some((el) =>
              Array.from(el.files || []).some((f) => f?.name?.toLowerCase?.().includes(name)),
            ),
          );
          return chipsReady || inputsReady;
        })()`,
        returnByValue: true,
      });
      if (!ready?.result?.value) {
        await delay(150);
        continue;
      }
    }
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

async function clickAnswerNowIfPresent(Runtime: ChromeClient['Runtime'], logger?: BrowserLogger) {
  const script = `(() => {
    ${buildClickDispatcher()}
    const matchesText = (el) => (el?.textContent || '').trim().toLowerCase() === 'answer now';
    const candidate = Array.from(document.querySelectorAll('button,span')).find(matchesText);
    if (!candidate) return 'missing';
    const button = candidate.closest('button') ?? candidate;
    const style = window.getComputedStyle(button);
    const disabled =
      button.hasAttribute('disabled') ||
      button.getAttribute('aria-disabled') === 'true' ||
      style.pointerEvents === 'none' ||
      style.display === 'none';
    if (disabled) return 'disabled';
    dispatchClickSequence(button);
    return 'clicked';
  })()`;

  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const status = result.value as string;
    if (status === 'clicked') {
      logger?.('Clicked "Answer now" gate');
      await delay(500);
      return;
    }
    if (status === 'missing') return;
    await delay(100);
  }
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
	    const normalize = (value) => {
	      let text = value?.toLowerCase?.() ?? '';
	      // Strip markdown *markers* but keep content (ChatGPT renders fence markers differently).
	      text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
	      text = text.replace(/\`\`\`/g, ' ');
	      text = text.replace(/\`([^\`]*)\`/g, '$1');
	      return text.replace(/\\s+/g, ' ').trim();
	    };
	    const normalizedPrompt = normalize(${encodedPrompt});
	    const normalizedPromptPrefix = normalizedPrompt.slice(0, 120);
	    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
	    const articles = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
	    const normalizedTurns = articles.map((node) => normalize(node?.innerText));
	    const userMatched =
	      normalizedPrompt.length > 0 && normalizedTurns.some((text) => text.includes(normalizedPrompt));
	    const prefixMatched =
	      normalizedPromptPrefix.length > 30 &&
	      normalizedTurns.some((text) => text.includes(normalizedPromptPrefix));
	    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
	    return {
      userMatched,
      prefixMatched,
      fallbackValue: fallback?.value ?? '',
      editorValue: editor?.innerText ?? '',
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as { userMatched: boolean; prefixMatched?: boolean };
    if (info?.userMatched || info?.prefixMatched) {
      return;
    }
    await delay(100);
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${await Runtime.evaluate({
        expression: script,
        returnByValue: true,
      }).then((res) => JSON.stringify(res?.result?.value)).catch(() => 'unavailable')}`,
    );
    await logDomFailure(Runtime, logger, 'prompt-commit');
  }
  if (prompt.trim().length >= 50_000) {
    throw new BrowserAutomationError('Prompt did not appear in conversation before timeout (likely too large).', {
      stage: 'submit-prompt',
      code: 'prompt-too-large',
      promptLength: prompt.trim().length,
      timeoutMs,
    });
  }
  throw new Error('Prompt did not appear in conversation before timeout (send may have failed)');
}
