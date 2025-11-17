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
      await logDomFailure(Runtime, logger, 'model-switcher-option');
      throw new Error(`Unable to find model option matching "${desiredModel}" in the model switcher.`);
    }
    default: {
      await logDomFailure(Runtime, logger, 'model-switcher-button');
      throw new Error('Unable to locate the ChatGPT model selector button.');
    }
  }
}

function buildModelSelectionExpression(targetModel: string): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  return `(() => {
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const CLICK_INTERVAL_MS = 50;
    const MAX_WAIT_MS = 12000;
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

    pointerClick();
    return new Promise((resolve) => {
      const start = performance.now();
      const ensureMenuOpen = () => {
        const menuOpen = document.querySelector('[role="menu"], [data-radix-collection-root]');
        if (!menuOpen && performance.now() - lastPointerClick > 300) {
          pointerClick();
        }
      };
      const attempt = () => {
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
        if (performance.now() - lastPointerClick > 500) {
          pointerClick();
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
