import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from '../constants.js';
import { logDomFailure } from '../domDebug.js';

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
    | { status: 'switched-best-effort'; label?: string | null }
    | { status: 'option-not-found' }
    | { status: 'button-missing' }
    | undefined;

  switch (result?.status) {
    case 'already-selected':
    case 'switched':
    case 'switched-best-effort': {
      const label = result.label ?? desiredModel;
      logger(`Model picker: ${label}`);
      return;
    }
    case 'option-not-found': {
      await logDomFailure(Runtime, logger, 'model-switcher-option');
      throw new Error(`Unable to find model option matching "${desiredModel}" in the model switcher.`);
    }
    default: {
      await logDomFailure(Runtime, logger, 'model-switcher-button');
      throw new Error('Unable to locate the ChatGPT model selector button.');
    }
  }
}

/**
 * Builds the DOM expression that runs inside the ChatGPT tab to select a model.
 * The string is evaluated inside Chrome, so keep it self-contained and well-commented.
 */
function buildModelSelectionExpression(targetModel: string): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  return `(() => {
    // Capture the selectors and matcher literals up front so the browser expression stays pure.
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const INITIAL_WAIT_MS = 150;
    const REOPEN_INTERVAL_MS = 400;
    const MAX_WAIT_MS = 20000;
    const normalizeText = (value) => {
      if (!value) {
        return '';
      }
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    };
    // Normalize every candidate token to keep fuzzy matching deterministic.
    const normalizedTarget = normalizeText(PRIMARY_LABEL);
    const normalizedTokens = Array.from(new Set([normalizedTarget, ...LABEL_TOKENS]))
      .map((token) => normalizeText(token))
      .filter(Boolean);
    const targetWords = normalizedTarget.split(' ').filter(Boolean);

    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      return { status: 'button-missing' };
    }

    let lastPointerClick = 0;
    const pointerClick = () => {
      // Some menus ignore synthetic click events.
      const down = new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const up = new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' });
      const click = new MouseEvent('click', { bubbles: true });
      button.dispatchEvent(down);
      button.dispatchEvent(up);
      button.dispatchEvent(click);
      lastPointerClick = performance.now();
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

    const scoreOption = (normalizedText, testid) => {
      // Assign a score to every node so we can pick the most likely match without brittle equality checks.
      if (!normalizedText && !testid) {
        return 0;
      }
      let score = 0;
      const normalizedTestId = (testid ?? '').toLowerCase();
      if (normalizedTestId && TEST_IDS.some((id) => normalizedTestId.includes(id))) {
        score += 1000;
      }
      if (normalizedText && normalizedTarget) {
        if (normalizedText === normalizedTarget) {
          score += 500;
        } else if (normalizedText.startsWith(normalizedTarget)) {
          score += 420;
        } else if (normalizedText.includes(normalizedTarget)) {
          score += 380;
        }
      }
      for (const token of normalizedTokens) {
        // Reward partial matches to the expanded label/token set.
        if (token && normalizedText.includes(token)) {
          const tokenWeight = Math.min(120, Math.max(10, token.length * 4));
          score += tokenWeight;
        }
      }
      if (targetWords.length > 1) {
        let missing = 0;
        for (const word of targetWords) {
          if (!normalizedText.includes(word)) {
            missing += 1;
          }
        }
        score -= missing * 12;
      }
      return Math.max(score, 0);
    };

    const findBestOption = () => {
      // Walk through every menu item and keep whichever earns the highest score.
      let bestMatch = null;
      const menus = Array.from(document.querySelectorAll(${menuContainerLiteral}));
      for (const menu of menus) {
        const buttons = Array.from(menu.querySelectorAll(${menuItemLiteral}));
        for (const option of buttons) {
          const text = option.textContent ?? '';
          const normalizedText = normalizeText(text);
          const testid = option.getAttribute('data-testid') ?? '';
          const score = scoreOption(normalizedText, testid);
          if (score <= 0) {
            continue;
          }
          const label = getOptionLabel(option);
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { node: option, label, score };
          }
        }
      }
      return bestMatch;
    };

    return new Promise((resolve) => {
      const start = performance.now();
      const ensureMenuOpen = () => {
        const menuOpen = document.querySelector('[role="menu"], [data-radix-collection-root]');
        if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {
          pointerClick();
        }
      };

      // Open once and wait a tick before first scan.
      pointerClick();
      const openDelay = () => new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
      let initialized = false;
      const attempt = async () => {
        if (!initialized) {
          initialized = true;
          await openDelay();
        }
        ensureMenuOpen();
        const match = findBestOption();
        if (match) {
          if (optionIsSelected(match.node)) {
            resolve({ status: 'already-selected', label: match.label });
            return;
          }
          match.node.click();
          resolve({ status: 'switched', label: match.label });
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({ status: 'option-not-found' });
          return;
        }
        setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
      };
      attempt();
    });
  })()`;
}

export function buildModelMatchersLiteralForTest(targetModel: string) {
  return buildModelMatchersLiteral(targetModel);
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
  // Numeric variations (5.1 ↔ 51 ↔ gpt-5-1)
  if (base.includes('5.1') || base.includes('5-1') || base.includes('51')) {
    push('5.1', labelTokens);
    push('gpt-5.1', labelTokens);
    push('gpt5.1', labelTokens);
    push('gpt-5-1', labelTokens);
    push('gpt5-1', labelTokens);
    push('gpt51', labelTokens);
    push('chatgpt 5.1', labelTokens);
    testIdTokens.add('gpt-5-1');
    testIdTokens.add('gpt5-1');
    testIdTokens.add('gpt51');
  }
  // Numeric variations (5.0 ↔ 50 ↔ gpt-5-0)
  if (base.includes('5.0') || base.includes('5-0') || base.includes('50')) {
    push('5.0', labelTokens);
    push('gpt-5.0', labelTokens);
    push('gpt5.0', labelTokens);
    push('gpt-5-0', labelTokens);
    push('gpt5-0', labelTokens);
    push('gpt50', labelTokens);
    push('chatgpt 5.0', labelTokens);
    testIdTokens.add('gpt-5-0');
    testIdTokens.add('gpt5-0');
    testIdTokens.add('gpt50');
  }
  // Pro / research variants
  if (base.includes('pro')) {
    push('proresearch', labelTokens);
    push('research grade', labelTokens);
    push('advanced reasoning', labelTokens);
    if (base.includes('5.1') || base.includes('5-1') || base.includes('51')) {
      testIdTokens.add('gpt-5.1-pro');
      testIdTokens.add('gpt-5-1-pro');
      testIdTokens.add('gpt51pro');
    }
    if (base.includes('5.0') || base.includes('5-0') || base.includes('50')) {
      testIdTokens.add('gpt-5.0-pro');
      testIdTokens.add('gpt-5-0-pro');
      testIdTokens.add('gpt50pro');
    }
    testIdTokens.add('pro');
    testIdTokens.add('proresearch');
  }
  base
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      push(token, labelTokens);
    });

  const hyphenated = base.replace(/\s+/g, '-');
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  // data-testid values observed in the ChatGPT picker (e.g., model-switcher-gpt-5.1-pro)
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);
  push(`model-switcher-${dotless}`, testIdTokens);

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

export function buildModelSelectionExpressionForTest(targetModel: string): string {
  return buildModelSelectionExpression(targetModel);
}
