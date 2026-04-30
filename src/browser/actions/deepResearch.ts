import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  DEEP_RESEARCH_PLUS_BUTTON,
  DEEP_RESEARCH_DROPDOWN_ITEM_TEXT,
  DEEP_RESEARCH_PILL_LABEL,
  DEEP_RESEARCH_POLL_INTERVAL_MS,
  DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
  DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { delay } from "../utils.js";
import { buildClickDispatcher } from "./domEvents.js";
import { captureAssistantMarkdown, readAssistantSnapshot } from "./assistantResponse.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

type ActivateOutcome =
  | { status: "activated" }
  | { status: "already-active" }
  | { status: "plus-button-missing" }
  | { status: "dropdown-item-missing"; available?: string[] }
  | { status: "pill-not-confirmed" };

/**
 * Activates Deep Research mode through ChatGPT's slash command, with the
 * composer tools menu as a fallback for older UI variants.
 */
export async function activateDeepResearch(
  Runtime: ChromeClient["Runtime"],
  _Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<void> {
  const expression = buildActivateDeepResearchExpression();
  const outcome = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const result = outcome.result?.value as ActivateOutcome | undefined;

  switch (result?.status) {
    case "activated":
      logger("Deep Research mode activated");
      return;
    case "already-active":
      logger("Deep Research mode already active");
      return;
    case "plus-button-missing":
      throw new BrowserAutomationError(
        "Could not find the composer plus button to activate Deep Research.",
        { stage: "deep-research-activate", code: "plus-button-missing" },
      );
    case "dropdown-item-missing": {
      const hint = result.available?.length
        ? ` Available options: ${result.available.join(", ")}`
        : "";
      throw new BrowserAutomationError(
        `"Deep research" option not found in composer dropdown.${hint} ` +
          "This feature may require a ChatGPT Plus or Pro subscription.",
        { stage: "deep-research-activate", code: "dropdown-item-missing" },
      );
    }
    case "pill-not-confirmed":
      throw new BrowserAutomationError(
        "Deep Research pill did not appear after selection. The UI may have changed.",
        { stage: "deep-research-activate", code: "pill-not-confirmed" },
      );
    default:
      throw new BrowserAutomationError("Unexpected result from Deep Research activation.", {
        stage: "deep-research-activate",
      });
  }
}

/**
 * After prompt submission, waits for the research plan to appear and
 * auto-confirm (~60s countdown + 10s safety margin).
 */
export async function waitForResearchPlanAutoConfirm(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
): Promise<void> {
  // Phase A: Detect research plan appearance (up to 60s)
  const planDeadline = Date.now() + 60_000;
  let planDetected = false;

  while (Date.now() < planDeadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasResearchIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const assistantText = (document.querySelector('[data-message-author-role="assistant"]')?.textContent || '').toLowerCase();
        const hasResearchText = assistantText.includes('researching') ||
          assistantText.includes('research plan') ||
          assistantText.includes('survey') ||
          assistantText.includes('analyze');
        return { hasResearchIframe, hasResearchText };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as
      | { hasResearchIframe?: boolean; hasResearchText?: boolean }
      | undefined;
    if (val?.hasResearchIframe || val?.hasResearchText) {
      planDetected = true;
      logger("Research plan detected, waiting for auto-confirm countdown...");
      break;
    }
    await delay(2_000);
  }

  if (!planDetected) {
    logger(
      "Warning: Research plan not detected within 60s; continuing (may have auto-confirmed already)",
    );
    return;
  }

  // Phase B: Wait for auto-confirm countdown
  const confirmStart = Date.now();
  while (Date.now() - confirmStart < autoConfirmWaitMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const iframes = document.querySelectorAll('iframe');
        const hasLargeIframe = Array.from(iframes).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        const text = (document.body?.innerText || '').toLowerCase();
        const isResearching = text.includes('researching...') ||
          text.includes('reading sources') ||
          text.includes('considering');
        return { hasLargeIframe, isResearching };
      })()`,
      returnByValue: true,
    });
    const val = result?.value as { hasLargeIframe?: boolean; isResearching?: boolean } | undefined;

    if (val?.isResearching) {
      logger("Research plan confirmed, execution started");
      return;
    }

    await delay(5_000);
  }

  logger("Auto-confirm wait complete, proceeding to monitor research progress");
}

/**
 * Polls for Deep Research completion over 5-30+ minutes.
 * Returns the full response text, optional HTML, and turn metadata.
 */
export async function waitForDeepResearchCompletion(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number = DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  let lastLogTime = start;
  let lastTextLength = 0;
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);

  logger(`Monitoring Deep Research (timeout: ${Math.round(timeoutMs / 60_000)}min)...`);

  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const finished = Boolean(document.querySelector(${finishedSelector}));
        const stopVisible = Boolean(document.querySelector(${stopSelector}));
        const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
        const lastTurn = turns[turns.length - 1];
        const textLength = (lastTurn?.textContent || '').length;
        const hasIframe = Array.from(document.querySelectorAll('iframe')).some(f => {
          const rect = f.getBoundingClientRect();
          return rect.width > 200 && rect.height > 200;
        });
        return { finished, stopVisible, textLength, hasIframe };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as
      | {
          finished?: boolean;
          stopVisible?: boolean;
          textLength?: number;
          hasIframe?: boolean;
        }
      | undefined;

    // Completion detected
    if (val?.finished) {
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return await extractDeepResearchResult(Runtime, logger);
    }

    // Progress logging every 60 seconds
    const now = Date.now();
    if (now - lastLogTime >= 60_000) {
      const elapsed = Math.round((now - start) / 1000);
      const chars = val?.textLength ?? 0;
      const phase = val?.hasIframe ? "researching" : val?.stopVisible ? "generating" : "waiting";
      logger(`Deep Research ${phase}... ${elapsed}s elapsed, ~${chars} chars`);
      lastLogTime = now;
    }

    lastTextLength = val?.textLength ?? lastTextLength;
    await delay(DEEP_RESEARCH_POLL_INTERVAL_MS);
  }

  // Timeout — throw with metadata for potential reattach
  const elapsed = Math.round((Date.now() - start) / 1000);
  throw new BrowserAutomationError(
    `Deep Research did not complete within ${Math.round(timeoutMs / 60_000)} minutes (${elapsed}s elapsed). ` +
      "Use 'oracle session <id>' to reattach later, or increase --timeout.",
    {
      stage: "deep-research-timeout",
      code: "deep-research-timeout",
      elapsedMs: Date.now() - start,
      lastTextLength,
    },
  );
}

/**
 * Extracts the Deep Research result using existing assistant response
 * extraction logic (readAssistantSnapshot + captureAssistantMarkdown).
 */
export async function extractDeepResearchResult(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const snapshot = await readAssistantSnapshot(Runtime);
  const meta = {
    turnId: snapshot?.turnId ?? null,
    messageId: snapshot?.messageId ?? null,
  };

  // Try the copy-button approach first for clean markdown
  const markdown = await captureAssistantMarkdown(Runtime, meta, logger);
  if (markdown) {
    return { text: markdown, html: snapshot?.html ?? undefined, meta };
  }

  // Fall back to snapshot text
  if (snapshot?.text) {
    return { text: snapshot.text, html: snapshot.html ?? undefined, meta };
  }

  throw new BrowserAutomationError(
    "Deep Research completed but failed to extract the response text.",
    { stage: "deep-research-extract", code: "extraction-failed" },
  );
}

/**
 * Quick status check for Deep Research — used during reattach to determine
 * whether research has completed, is still in progress, or is in an unknown state.
 */
export async function checkDeepResearchStatus(
  Runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
): Promise<{
  completed: boolean;
  inProgress: boolean;
  hasIframe: boolean;
  textLength: number;
}> {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);

  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const finished = Boolean(document.querySelector(${finishedSelector}));
      const stopVisible = Boolean(document.querySelector(${stopSelector}));
      const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
        const rect = f.getBoundingClientRect();
        return rect.width > 200 && rect.height > 200;
      });
      const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastTurn = turns[turns.length - 1];
      const textLength = (lastTurn?.textContent || '').length;
      return {
        completed: finished,
        inProgress: stopVisible || iframes.length > 0,
        hasIframe: iframes.length > 0,
        textLength,
      };
    })()`,
    returnByValue: true,
  });

  const val = result?.value as
    | {
        completed?: boolean;
        inProgress?: boolean;
        hasIframe?: boolean;
        textLength?: number;
      }
    | undefined;

  return {
    completed: val?.completed ?? false,
    inProgress: val?.inProgress ?? false,
    hasIframe: val?.hasIframe ?? false,
    textLength: val?.textLength ?? 0,
  };
}

// ---------------------------------------------------------------------------
// DOM expression builder
// ---------------------------------------------------------------------------

function buildActivateDeepResearchExpression(): string {
  const plusBtnSelector = JSON.stringify(DEEP_RESEARCH_PLUS_BUTTON);
  const targetText = JSON.stringify(DEEP_RESEARCH_DROPDOWN_ITEM_TEXT);
  const pillLabel = JSON.stringify(DEEP_RESEARCH_PILL_LABEL);

  // pillLabel is used inside the expression for verification
  void pillLabel;

  return `(async () => {
    ${buildClickDispatcher()}

    const waitForPill = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        const pills = document.querySelectorAll('.__composer-pill-composite');
        for (const pill of pills) {
          const text = pill.textContent?.trim() || '';
          const aria = pill.querySelector('button')?.getAttribute('aria-label') || '';
          if (text.toLowerCase().includes('deep research') ||
              aria.toLowerCase().includes('deep research')) {
            resolve(true); return;
          }
        }
        elapsed += 200;
        if (elapsed > 5000) { resolve(false); return; }
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    });

    const clearComposer = (composer) => {
      if (!composer) return;
      if ('value' in composer) composer.value = '';
      else composer.textContent = '';
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
    };

    const setComposerText = (composer, text) => {
      composer.focus?.();
      if ('value' in composer) composer.value = text;
      else composer.textContent = text;
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    };

    const findDeepResearchItem = () => {
      const target = ${targetText}.toLowerCase();
      const candidates = Array.from(document.querySelectorAll('[data-radix-collection-item], [role="option"], [cmdk-item], button, [role="menuitem"]'));
      return candidates.find(item => (item.textContent || '').trim().toLowerCase() === target) || null;
    };

    // Step 0: Check if already active
    const existingPill = document.querySelector('.__composer-pill-composite');
    if (existingPill) {
      const pillText = existingPill.textContent?.trim() || '';
      const pillAria = existingPill.querySelector('button')?.getAttribute('aria-label') || '';
      if (pillText.toLowerCase().includes('deep research') ||
          pillAria.toLowerCase().includes('deep research')) {
        return { status: 'already-active' };
      }
    }

    // Step 1: Prefer the official slash command flow.
    const composer = document.querySelector('[contenteditable="true"], textarea');
    if (composer) {
      setComposerText(composer, '/Deepresearch');
      await new Promise(resolve => setTimeout(resolve, 600));
      const slashItem = findDeepResearchItem();
      if (slashItem) {
        dispatchClickSequence(slashItem);
        if (await waitForPill()) return { status: 'activated' };
      }
      clearComposer(composer);
    }

    // Step 2: Fall back to the composer tools menu.
    const plusBtn = document.querySelector(${plusBtnSelector}) ||
      Array.from(document.querySelectorAll('button')).find(
        b => (b.getAttribute('aria-label') || '').toLowerCase().includes('add files')
      );
    if (!plusBtn) return { status: 'plus-button-missing' };
    dispatchClickSequence(plusBtn);

    // Step 3: Wait for dropdown
    const waitForDropdown = () => new Promise((resolve) => {
      let elapsed = 0;
      const tick = () => {
        const items = document.querySelectorAll('[data-radix-collection-item]');
        if (items.length > 0) { resolve(items); return; }
        elapsed += 150;
        if (elapsed > 3000) { resolve(null); return; }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
    const items = await waitForDropdown();
    if (!items) return { status: 'dropdown-item-missing', available: [] };

    // Step 4: Find "Deep research" item
    const target = ${targetText}.toLowerCase();
    let match = null;
    const available = [];
    for (const item of items) {
      const text = (item.textContent || '').trim();
      available.push(text);
      if (text.toLowerCase() === target) {
        match = item;
      }
    }
    if (!match) return { status: 'dropdown-item-missing', available };

    // Step 5: Click it
    dispatchClickSequence(match);

    // Step 6: Verify pill appeared
    const pillConfirmed = await waitForPill();
    return pillConfirmed ? { status: 'activated' } : { status: 'pill-not-confirmed' };
  })()`;
}

export function buildActivateDeepResearchExpressionForTest(): string {
  return buildActivateDeepResearchExpression();
}
