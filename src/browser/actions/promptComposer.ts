import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from '../constants.js';
import { delay, isGrokUrl } from '../utils.js';
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

async function ensureGrokHardMode(Runtime: ChromeClient['Runtime'], logger?: BrowserLogger) {
  const hrefResult = await Runtime.evaluate({
    expression: 'typeof location === "object" && location.href ? location.href : ""',
    returnByValue: true,
  });
  const url = typeof hrefResult?.result?.value === 'string' ? hrefResult.result.value : '';
  if (!url || !isGrokUrl(url)) {
    return;
  }
  const deadline = Date.now() + 2_500;
  let payload: { clicked?: boolean; reason?: string; label?: string } | undefined;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const labels = ['think harder', 'deepsearch', 'deep search'];
        const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('button,[role="button"]'));
        let best = null;
        let bestRank = labels.length + 1;
        let bestLabel = '';
        for (const node of candidates) {
          const label = normalize(node.textContent || node.getAttribute('aria-label') || '');
          if (!label) continue;
          const rank = labels.findIndex((needle) => label === needle || label.includes(needle));
          if (rank === -1) continue;
          if (rank < bestRank) {
            best = node;
            bestRank = rank;
            bestLabel = label;
          }
        }
        if (!best) {
          return { clicked: false, reason: 'missing' };
        }
        const ariaPressed = best.getAttribute('aria-pressed');
        const dataState = best.getAttribute('data-state');
        const className = best.className || '';
        const active =
          ariaPressed === 'true' ||
          dataState === 'active' ||
          dataState === 'on' ||
          dataState === 'selected' ||
          className.includes('bg-button-filled') ||
          className.includes('text-fg-invert');
        if (active) {
          return { clicked: false, reason: 'already-active', label: bestLabel };
        }
        best.click();
        return { clicked: true, label: bestLabel };
      })()`,
      returnByValue: true,
    });
    payload = result?.value as { clicked?: boolean; reason?: string; label?: string } | undefined;
    if (payload?.clicked || payload?.reason === 'already-active') {
      break;
    }
    if (payload?.reason !== 'missing') {
      break;
    }
    await delay(250);
  }
  if (payload?.clicked) {
    logger?.(`Enabled Grok hard mode (${payload.label ?? 'unknown'})`);
    return;
  }
  if (logger?.verbose) {
    if (payload?.reason === 'already-active') {
      logger(`Grok hard mode already active (${payload.label ?? 'unknown'})`);
    } else if (payload?.reason === 'missing') {
      logger('Grok hard mode control not found; continuing.');
    }
  }
}

export async function submitPrompt(
  deps: {
    runtime: ChromeClient['Runtime'];
    input: ChromeClient['Input'];
    attachmentNames?: string[];
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
  },
  prompt: string,
  logger: BrowserLogger,
) : Promise<number | null> {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  await ensureGrokHardMode(runtime, logger);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
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
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${inputSelectorsLiteral};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value ?? '';
        }
        if (node.getAttribute && node.getAttribute('contenteditable') === 'true') {
          return node.textContent ?? node.innerText ?? '';
        }
        return node.textContent ?? '';
      };
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const active = document.activeElement;
      const input = SELECTORS.map((selector) => document.querySelector(selector)).find(Boolean) || null;
      const activeMatches = active && SELECTORS.some((selector) => active.matches?.(selector));
      const activeText = activeMatches ? readValue(active) : '';
      return {
        editorText: readValue(editor),
        fallbackValue: readValue(fallback),
        activeText,
        inputText: readValue(input),
      };
    })()`,
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? '';
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? '';
  const activeTextRaw = verification.result?.value?.activeText ?? '';
  const inputTextRaw = verification.result?.value?.inputText ?? '';
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? '';
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? '';
  const activeTextTrimmed = activeTextRaw?.trim?.() ?? '';
  const inputTextTrimmed = inputTextRaw?.trim?.() ?? '';
  const hasContent = Boolean(editorTextTrimmed || fallbackValueTrimmed || activeTextTrimmed || inputTextTrimmed);
  if (!hasContent) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force text/value + input events.
    await runtime.evaluate({
      expression: `(() => {
        const SELECTORS = ${inputSelectorsLiteral};
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
        const setContentEditable = (node) => {
          if (!node) return false;
          if (node.getAttribute && node.getAttribute('contenteditable') === 'true') {
            node.textContent = ${encodedPrompt};
            node.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
            return true;
          }
          return false;
        };
        for (const selector of SELECTORS) {
          const node = document.querySelector(selector);
          if (setContentEditable(node)) {
            break;
          }
        }
      })()`,
    });
  }

  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${inputSelectorsLiteral};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          return node.value ?? '';
        }
        if (node.getAttribute && node.getAttribute('contenteditable') === 'true') {
          return node.textContent ?? node.innerText ?? '';
        }
        return node.textContent ?? '';
      };
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const active = document.activeElement;
      const input = SELECTORS.map((selector) => document.querySelector(selector)).find(Boolean) || null;
      const activeMatches = active && SELECTORS.some((selector) => active.matches?.(selector));
      const activeText = activeMatches ? readValue(active) : '';
      return {
        editorText: readValue(editor),
        fallbackValue: readValue(fallback),
        activeText,
        inputText: readValue(input),
      };
    })()`,
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? '';
  const observedFallback = postVerification.result?.value?.fallbackValue ?? '';
  const observedActive = postVerification.result?.value?.activeText ?? '';
  const observedInput = postVerification.result?.value?.inputText ?? '';
  const observedLength = Math.max(observedEditor.length, observedFallback.length, observedActive.length, observedInput.length);
  if (promptLength >= 50_000 && observedLength > 0 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
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

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  return await verifyPromptCommitted(runtime, prompt, commitTimeoutMs, logger, deps.baselineTurns ?? undefined);
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
      const editable = document.querySelector('[contenteditable="true"]');
      if (editable) {
        editable.textContent = '';
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
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

async function waitForDomReady(Runtime: ChromeClient['Runtime'], logger?: BrowserLogger, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
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
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

function buildAttachmentReadyExpression(attachmentNames: string[]): string {
  const namesLiteral = JSON.stringify(attachmentNames.map((name) => name.toLowerCase()));
  return `(() => {
    const names = ${namesLiteral};
    const composer =
      document.querySelector('[data-testid*="composer"]') ||
      document.querySelector('form') ||
      document.body ||
      document;
    const match = (node, name) => (node?.textContent || '').toLowerCase().includes(name);

    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[aria-label="Remove file"]',
      'button[aria-label="Remove file"]',
    ];

    const chipsReady = names.every((name) =>
      Array.from(composer.querySelectorAll(attachmentSelectors.join(','))).some((node) => match(node, name)),
    );
    const inputsReady = names.every((name) =>
      Array.from(composer.querySelectorAll('input[type="file"]')).some((el) =>
        Array.from((el instanceof HTMLInputElement ? el.files : []) || []).some((file) =>
          file?.name?.toLowerCase?.().includes(name),
        ),
      ),
    );

    return chipsReady || inputsReady;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(attachmentNames: string[]) {
  return buildAttachmentReadyExpression(attachmentNames);
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
    // Learned: some send buttons render but are inert; only click when truly enabled.
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
        expression: buildAttachmentReadyExpression(attachmentNames),
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

async function verifyPromptCommitted(
  Runtime: ChromeClient['Runtime'],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const baselineLiteral =
    typeof baselineTurns === 'number' && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
	    const editor = document.querySelector(${primarySelectorLiteral});
	    const fallback = document.querySelector(${fallbackSelectorLiteral});
	    const editable = document.querySelector('[contenteditable="true"]');
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
	        return node.value ?? '';
	      }
	      if (node.getAttribute && node.getAttribute('contenteditable') === 'true') {
	        return node.textContent ?? node.innerText ?? '';
	      }
	      return node.textContent ?? '';
	    };
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
	    const lastMatched =
	      normalizedPrompt.length > 0 &&
	      (lastTurn.includes(normalizedPrompt) ||
	        (normalizedPromptPrefix.length > 30 && lastTurn.includes(normalizedPromptPrefix)));
	    const baseline = ${baselineLiteral};
	    const hasNewTurn = baseline < 0 ? true : normalizedTurns.length > baseline;
      const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
      const assistantVisible = Boolean(
        document.querySelector(${assistantSelectorLiteral}) ||
        document.querySelector('[data-testid*="assistant"]'),
      );
      // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = readValue(editor);
      const fallbackValue = readValue(fallback);
      const editableValue = readValue(editable);
      const composerCleared =
        !(String(editorValue).trim() || String(fallbackValue).trim() || String(editableValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
	    return {
      userMatched,
      prefixMatched,
      lastMatched,
      hasNewTurn,
      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      editableValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as {
      userMatched?: boolean;
      prefixMatched?: boolean;
      lastMatched?: boolean;
      hasNewTurn?: boolean;
      stopVisible?: boolean;
      assistantVisible?: boolean;
      composerCleared?: boolean;
      inConversation?: boolean;
      turnsCount?: number;
    };
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    if (info?.hasNewTurn && (info?.lastMatched || info?.userMatched || info?.prefixMatched)) {
      return typeof turnsCount === 'number' && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      ((info?.stopVisible ?? false) ||
        (info?.hasNewTurn && (info?.assistantVisible || info?.inConversation)));
    if (fallbackCommit) {
      return typeof turnsCount === 'number' && Number.isFinite(turnsCount) ? turnsCount : null;
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
