import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";
const PROMPT_TRUNCATION_CHECK_THRESHOLD = 20_000;
const PROMPT_TRUNCATION_TOLERANCE = 500;
const COMPOSER_HEALTH_SENTINEL = "__oracle_healthcheck__";

interface ComposerSnapshot {
  editorText: string;
  fallbackValue: string;
  activeValue: string;
  activeExists: boolean;
  activeVisible: boolean;
  activeDisabled: boolean;
  activeReadOnly: boolean;
  activeTagName: string;
  activeRole: string;
  href: string;
}

interface ComposerHealthState {
  healthy: boolean;
  reason?: string;
  activeExists: boolean;
  activeVisible: boolean;
  activeDisabled: boolean;
  activeReadOnly: boolean;
  activeTagName: string;
  activeRole: string;
  href: string;
}

function normalizeComposerSnapshot(
  value: Partial<ComposerSnapshot> | undefined,
): ComposerSnapshot {
  return {
    editorText: typeof value?.editorText === "string" ? value.editorText : "",
    fallbackValue: typeof value?.fallbackValue === "string" ? value.fallbackValue : "",
    activeValue: typeof value?.activeValue === "string" ? value.activeValue : "",
    activeExists: Boolean(value?.activeExists),
    activeVisible: Boolean(value?.activeVisible),
    activeDisabled: Boolean(value?.activeDisabled),
    activeReadOnly: Boolean(value?.activeReadOnly),
    activeTagName: typeof value?.activeTagName === "string" ? value.activeTagName : "",
    activeRole: typeof value?.activeRole === "string" ? value.activeRole : "",
    href: typeof value?.href === "string" ? value.href : "",
  };
}

function buildComposerSnapshotExpression(): string {
  return `(() => {
    const editor = document.querySelector(${JSON.stringify(PROMPT_PRIMARY_SELECTOR)});
    const fallback = document.querySelector(${JSON.stringify(PROMPT_FALLBACK_SELECTOR)});
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const readValue = (node) => {
      if (!node) return '';
      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
      return node.innerText ?? '';
    };
    const isVisible = (node) => {
      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const candidates = inputSelectors
      .map((selector) => document.querySelector(selector))
      .filter((node) => Boolean(node));
    const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
    return {
      editorText: editor?.innerText ?? '',
      fallbackValue: fallback instanceof HTMLTextAreaElement ? fallback.value ?? '' : '',
      activeValue: active ? readValue(active) : '',
      activeExists: Boolean(active),
      activeVisible: isVisible(active),
      activeDisabled: Boolean(
        active &&
          (((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
            active.disabled) ||
            active.getAttribute?.('aria-disabled') === 'true' ||
            active.getAttribute?.('disabled') !== null),
      ),
      activeReadOnly: Boolean(
        active &&
          (((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
            active.readOnly) ||
            active.getAttribute?.('readonly') !== null ||
            active.getAttribute?.('contenteditable') === 'false'),
      ),
      activeTagName: active?.tagName?.toLowerCase?.() ?? '',
      activeRole: active?.getAttribute?.('role') ?? '',
      href: typeof location === 'object' && location.href ? location.href : '',
    };
  })()`;
}

async function readComposerSnapshot(
  runtime: ChromeClient["Runtime"],
): Promise<ComposerSnapshot> {
  const result = await runtime.evaluate({
    expression: buildComposerSnapshotExpression(),
    returnByValue: true,
  });
  return normalizeComposerSnapshot(result.result?.value as Partial<ComposerSnapshot> | undefined);
}

async function ensureComposerHealthy(
  runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<void> {
  const result = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const selectors = ${JSON.stringify(INPUT_SELECTORS)};
      const sentinel = ${JSON.stringify(COMPOSER_HEALTH_SENTINEL)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        return node.innerText ?? '';
      };
      const candidates = selectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      const active = candidates.find((node) => isVisible(node)) || candidates[0] || null;
      const href = typeof location === 'object' && location.href ? location.href : '';
      if (!active) {
        return {
          healthy: false,
          reason: 'missing-active-input',
          activeExists: false,
          activeVisible: false,
          activeDisabled: false,
          activeReadOnly: false,
          activeTagName: '',
          activeRole: '',
          href,
        };
      }
      dispatchClickSequence(active);
      if (typeof active.focus === 'function') {
        active.focus();
      }
      const activeDisabled =
        ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
          active.disabled) ||
        active.getAttribute?.('aria-disabled') === 'true' ||
        active.getAttribute?.('disabled') !== null;
      const activeReadOnly =
        ((active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
          active.readOnly) ||
        active.getAttribute?.('readonly') !== null ||
        active.getAttribute?.('contenteditable') === 'false';
      if (activeDisabled || activeReadOnly) {
        return {
          healthy: false,
          reason: activeDisabled ? 'active-input-disabled' : 'active-input-readonly',
          activeExists: true,
          activeVisible: isVisible(active),
          activeDisabled: Boolean(activeDisabled),
          activeReadOnly: Boolean(activeReadOnly),
          activeTagName: active.tagName?.toLowerCase?.() ?? '',
          activeRole: active.getAttribute?.('role') ?? '',
          href,
        };
      }
      const before = readValue(active);
      const probe = before + sentinel;
      let after = before;
      try {
        if (active instanceof HTMLTextAreaElement) {
          active.value = probe;
          active.dispatchEvent(new InputEvent('input', { bubbles: true, data: sentinel, inputType: 'insertText' }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
          after = active.value ?? '';
          active.value = before;
          active.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          active.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          active.textContent = probe;
          active.dispatchEvent(new InputEvent('input', { bubbles: true, data: sentinel, inputType: 'insertText' }));
          after = readValue(active);
          active.textContent = before;
          active.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        }
      } catch (error) {
        return {
          healthy: false,
          reason: error instanceof Error ? error.message : String(error),
          activeExists: true,
          activeVisible: isVisible(active),
          activeDisabled: Boolean(activeDisabled),
          activeReadOnly: Boolean(activeReadOnly),
          activeTagName: active.tagName?.toLowerCase?.() ?? '',
          activeRole: active.getAttribute?.('role') ?? '',
          href,
        };
      }
      return {
        healthy: typeof after === 'string' && after.includes(sentinel),
        reason:
          typeof after === 'string' && after.includes(sentinel)
            ? ''
            : 'active-input-roundtrip-failed',
        activeExists: true,
        activeVisible: isVisible(active),
        activeDisabled: Boolean(activeDisabled),
        activeReadOnly: Boolean(activeReadOnly),
        activeTagName: active.tagName?.toLowerCase?.() ?? '',
        activeRole: active.getAttribute?.('role') ?? '',
        href,
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  const state = result.result?.value as ComposerHealthState | undefined;
  if (state?.healthy) {
    return;
  }
  await logDomFailure(runtime, logger, "dead-composer");
  throw new BrowserAutomationError("ChatGPT composer is present but not accepting input.", {
    stage: "submit-prompt",
    code: "dead-composer",
    composerState: {
      reason: state?.reason ?? "unknown",
      activeExists: Boolean(state?.activeExists),
      activeVisible: Boolean(state?.activeVisible),
      activeDisabled: Boolean(state?.activeDisabled),
      activeReadOnly: Boolean(state?.activeReadOnly),
      activeTagName: state?.activeTagName ?? "",
      activeRole: state?.activeRole ?? "",
      href: state?.href ?? "",
    },
  });
}

function isPromptTooLarge(promptLength: number, observedLength: number): boolean {
  return (
    promptLength >= PROMPT_TRUNCATION_CHECK_THRESHOLD &&
    observedLength > 0 &&
    observedLength < promptLength - PROMPT_TRUNCATION_TOLERANCE
  );
}

export async function submitPrompt(
  deps: {
    runtime: ChromeClient["Runtime"];
    input: ChromeClient["Input"];
    attachmentNames?: string[];
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  await ensureComposerHealthy(runtime, logger);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
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

      const candidates = [];
      for (const selector of SELECTORS) {
        const node = document.querySelector(selector);
        if (node) {
          candidates.push(node);
        }
      }
      const preferred = candidates.find((node) => isVisible(node)) || candidates[0];
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, "focus-textarea");
    throw new Error("Failed to focus prompt textarea");
  }

  await input.insertText({ text: prompt });

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await readComposerSnapshot(runtime);
  const editorTextTrimmed = verification.editorText.trim();
  const fallbackValueTrimmed = verification.fallbackValue.trim();
  const activeValueTrimmed = verification.activeValue.trim();
  let usedDirectDomWrite = false;
  if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
    usedDirectDomWrite = true;
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
  const postVerification = await readComposerSnapshot(runtime);
  const observedEditor = postVerification.editorText;
  const observedFallback = postVerification.fallbackValue;
  const observedActive = postVerification.activeValue;
  const observedLength = Math.max(
    observedEditor.length,
    observedFallback.length,
    observedActive.length,
  );
  const trustedObservedLength = usedDirectDomWrite ? observedActive.length : observedLength;
  if (usedDirectDomWrite && trustedObservedLength === 0 && observedLength > 0) {
    await logDomFailure(runtime, logger, "dead-composer");
    throw new BrowserAutomationError("Prompt text only reached the DOM fallback, not the active composer.", {
      stage: "submit-prompt",
      code: "dead-composer",
      promptLength,
      composerState: postVerification,
    });
  }
  if (isPromptTooLarge(promptLength, trustedObservedLength)) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength: trustedObservedLength,
        usedDirectDomWrite,
        composerState: postVerification,
      },
    );
  }

  const clicked = await attemptSendButton(runtime, logger, deps?.attachmentNames);
  if (!clicked) {
    await input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: "keyUp",
      ...ENTER_KEY_EVENT,
    });
    logger("Submitted prompt via Enter key");
  } else {
    logger("Clicked send button");
  }

  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  return await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    deps.baselineTurns ?? undefined,
  );
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const inputSelectors = ${inputSelectorsLiteral};
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
      const nodes = inputSelectors
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of nodes) {
        if (!node) continue;
        if (node instanceof HTMLTextAreaElement) {
          node.value = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          cleared = true;
          continue;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          node.textContent = '';
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
          cleared = true;
        }
      }
      return { cleared };
    })()`,
    returnByValue: true,
  });
  if (!result.result?.value?.cleared) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
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
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
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
  Runtime: ChromeClient["Runtime"],
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
    if (result.value === "clicked") {
      return true;
    }
    if (result.value === "missing") {
      break;
    }
    await delay(100);
  }
  return false;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const turnSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  let baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  if (baseline === null) {
    try {
      const { result } = await Runtime.evaluate({
        expression: `document.querySelectorAll(${turnSelectorLiteral}).length`,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (Number.isFinite(raw)) {
        baseline = Math.max(0, Math.floor(raw));
      }
    } catch {
      // ignore; baseline stays unknown
    }
  }
  const baselineLiteral = baseline ?? -1;
  // Learned: ChatGPT can echo/format text; normalize markdown and use prefix matches to detect the sent prompt.
  const script = `(() => {
		    const editor = document.querySelector(${primarySelectorLiteral});
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
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
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
	    const inputs = inputSelectors
	      .map((selector) => document.querySelector(selector))
	      .filter((node) => Boolean(node));
	    const visibleInputs = inputs.filter((node) => isVisible(node));
	    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
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
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Learned: composer clearing + stop button or assistant presence is a reliable fallback signal.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
	      const activeEmpty =
	        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
	      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
	      const activeInput = activeInputs[0] ?? null;
	      const activeInputValue = activeInput ? String(readValue(activeInput)) : '';
	      const activeInputDisabled = Boolean(
	        activeInput &&
	          (((activeInput instanceof HTMLInputElement || activeInput instanceof HTMLTextAreaElement) &&
	            activeInput.disabled) ||
	            activeInput.getAttribute?.('aria-disabled') === 'true' ||
	            activeInput.getAttribute?.('disabled') !== null)
	      );
	      const activeInputReadOnly = Boolean(
	        activeInput &&
	          (((activeInput instanceof HTMLInputElement || activeInput instanceof HTMLTextAreaElement) &&
	            activeInput.readOnly) ||
	            activeInput.getAttribute?.('readonly') !== null ||
	            activeInput.getAttribute?.('contenteditable') === 'false')
	      );
	      const href = typeof location === 'object' && location.href ? location.href : '';
	      const inConversation = /\\/c\\//.test(href);
			    return {
        baseline,
	      userMatched,
	      prefixMatched,
	      lastMatched,
	      hasNewTurn,
	      stopVisible,
      assistantVisible,
	      composerCleared,
	      inConversation,
	      href,
	      activeInputExists: Boolean(activeInput),
	      activeInputVisible: Boolean(activeInput && isVisible(activeInput)),
	      activeInputDisabled,
	      activeInputReadOnly,
	      activeInputValueLength: activeInputValue.length,
	      activeInputTagName: activeInput?.tagName?.toLowerCase?.() ?? '',
	      activeInputRole: activeInput?.getAttribute?.('role') ?? '',
	      fallbackValue,
	      editorValue,
	      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as {
      baseline?: number;
      userMatched?: boolean;
      prefixMatched?: boolean;
      lastMatched?: boolean;
      hasNewTurn?: boolean;
      stopVisible?: boolean;
      assistantVisible?: boolean;
      composerCleared?: boolean;
      inConversation?: boolean;
      href?: string;
      activeInputExists?: boolean;
      activeInputVisible?: boolean;
      activeInputDisabled?: boolean;
      activeInputReadOnly?: boolean;
      activeInputValueLength?: number;
      activeInputTagName?: string;
      activeInputRole?: string;
      turnsCount?: number;
    };
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    const matchesPrompt = Boolean(info?.lastMatched || info?.userMatched || info?.prefixMatched);
    const baselineUnknown =
      typeof info?.baseline === "number" ? info.baseline < 0 : baselineLiteral < 0;
    if (matchesPrompt && (baselineUnknown || info?.hasNewTurn)) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    const fallbackCommit =
      info?.composerCleared &&
      Boolean(info?.hasNewTurn) &&
      ((info?.stopVisible ?? false) || info?.assistantVisible || info?.inConversation);
    if (fallbackCommit) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${await Runtime.evaluate({
        expression: script,
        returnByValue: true,
      })
        .then((res) => JSON.stringify(res?.result?.value))
        .catch(() => "unavailable")}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  const finalStateResult = await Runtime.evaluate({
    expression: script,
    returnByValue: true,
  }).catch(() => null);
  const finalState = (finalStateResult?.result?.value ?? {}) as {
    href?: string;
    turnsCount?: number;
    composerCleared?: boolean;
    stopVisible?: boolean;
    assistantVisible?: boolean;
    hasNewTurn?: boolean;
    activeInputExists?: boolean;
    activeInputVisible?: boolean;
    activeInputDisabled?: boolean;
    activeInputReadOnly?: boolean;
    activeInputValueLength?: number;
    activeInputTagName?: string;
    activeInputRole?: string;
  };
  const composerState = {
    href: typeof finalState.href === "string" ? finalState.href : "",
    turnsCount:
      typeof finalState.turnsCount === "number" && Number.isFinite(finalState.turnsCount)
        ? finalState.turnsCount
        : null,
    composerCleared: Boolean(finalState.composerCleared),
    stopVisible: Boolean(finalState.stopVisible),
    assistantVisible: Boolean(finalState.assistantVisible),
    hasNewTurn: Boolean(finalState.hasNewTurn),
    activeInputExists: Boolean(finalState.activeInputExists),
    activeInputVisible: Boolean(finalState.activeInputVisible),
    activeInputDisabled: Boolean(finalState.activeInputDisabled),
    activeInputReadOnly: Boolean(finalState.activeInputReadOnly),
    activeInputValueLength:
      typeof finalState.activeInputValueLength === "number" &&
      Number.isFinite(finalState.activeInputValueLength)
        ? finalState.activeInputValueLength
        : 0,
    activeInputTagName: finalState.activeInputTagName ?? "",
    activeInputRole: finalState.activeInputRole ?? "",
  };
  const likelyDeadComposer =
    composerState.activeInputExists &&
    (!composerState.activeInputVisible ||
      composerState.activeInputDisabled ||
      composerState.activeInputReadOnly ||
      (!composerState.hasNewTurn &&
        !composerState.stopVisible &&
        !composerState.assistantVisible &&
        !composerState.composerCleared));
  if (prompt.trim().length >= PROMPT_TRUNCATION_CHECK_THRESHOLD) {
    throw new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength: prompt.trim().length,
        timeoutMs,
        composerState,
      },
    );
  }
  if (likelyDeadComposer) {
    throw new BrowserAutomationError("Prompt did not appear because the ChatGPT composer is unresponsive.", {
      stage: "submit-prompt",
      code: "dead-composer",
      timeoutMs,
      composerState,
    });
  }
  throw new BrowserAutomationError("Prompt did not appear in conversation before timeout (send may have failed).", {
    stage: "submit-prompt",
    code: "prompt-commit-timeout",
    timeoutMs,
    composerState,
  });
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  ensureComposerHealthy,
  readComposerSnapshot,
  isPromptTooLarge,
  verifyPromptCommitted,
};
